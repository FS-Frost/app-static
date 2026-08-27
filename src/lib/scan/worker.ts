/// <reference lib="webworker" />

/**
 * Worker de detección. Todo el trabajo de OpenCV pasa acá: el hilo principal
 * sólo bombea frames y pinta, así que la vista previa nunca se congela (el
 * scanner original pausaba el `<video>` en cada intento, y eso se ve).
 *
 * Pipeline por frame:
 *   1. ImageBitmap -> ImageData -> Mat RGBA -> gris.
 *   2. Copia reducida (640 px) para ubicar las marcas de registro impresas.
 *   3. Homografía de las cuatro marcas que encierran el bloque de respuestas a un
 *      rectángulo de ancho fijo: lo rectificado es el bloque, sin cabecera.
 *   4. Contornos sobre la hoja rectificada para reconstruir la grilla real de
 *      burbujas (filas, bloques y alternativas salen de la hoja, no de factores
 *      hardcodeados).
 *   5. Relleno de cada burbuja por conteo de píxeles oscuros y clasificación.
 */

import type { Rect } from "./assist";
import { classifyQuestion, type CellFill } from "./classify";
import { getFormat, questionNumber, type SheetFormat } from "./format";
import {
	answersBlockAspect,
	checkQuad,
	findAnswersQuad,
	markRows,
	median,
	type Box,
	type Point,
	type Quad,
} from "./geometry";
import { homographyRectToQuad, homographyToRect } from "./homography";
import { detectWarpConvention, matrixForWarp, type WarpConvention } from "./warpConvention";
import { buildGrid, type GridModel } from "./grid";
import { loadOpenCv, type CvMat, type CvModule } from "./opencv";
import { answersQuadFromQr, findQr, pointInQrFrame, qrTemplates, snapQuadToMarks } from "./qr";
import { toleranceFor } from "./strategy";
import type { FrameResult, ScanRequest, ScanResponse } from "./protocol";

/** Ancho al que se reduce el frame para buscar las marcas de esquina. */
const LOCATE_WIDTH = 640;

/**
 * Ancho al que se reduce el frame para buscar el QR.
 *
 * Más grande que para las marcas y por un motivo concreto: el error en las esquinas
 * del símbolo se multiplica por la distancia al bloque de respuestas, así que un
 * píxel de más en un QR de 85 px (a 640) se convierte en 50 px de desvío en la
 * esquina inferior de la hoja.
 */
const QR_WIDTH = 1280;

/** Ancho de la hoja rectificada. Deja las burbujas en ~24 px, suficiente para medir relleno. */
const PAGE_WIDTH = 900;

/** Cuánto más oscuro que su vecindario tiene que ser un píxel para contar como marca. */
const LOCATE_THRESHOLD_C = 25;

/** Lo mismo, para los anillos impresos de las burbujas en la hoja rectificada. */
const PAGE_THRESHOLD_C = 10;

/** Radio de muestreo dentro de la burbuja, como fracción del radio detectado. */
const SAMPLE_RADIUS_FACTOR = 0.62;

let cv: CvModule | null = null;

type MatPool = {
	gray: CvMat;
	small: CvMat;
	qr: CvMat;
	tiny: CvMat;
	smallBin: CvMat;
	page: CvMat;
	pageEdges: CvMat;
	hierarchy: CvMat;
};

let pool: MatPool | null = null;
let warpConvention: WarpConvention | null = null;
let previousTiny: Uint8Array | null = null;

/** Lado de la miniatura con la que se mide el movimiento entre frames. */
const MOTION_SIZE = 32;

/**
 * Cuánto cambió la imagen respecto del frame anterior.
 *
 * Se mide sobre una miniatura de 32 px: alcanza para distinguir "la mano está
 * quieta" de "el teléfono se está moviendo", que es lo único que hace falta para
 * decidir si vale la pena disparar una foto, y cuesta nada.
 */
function measureMotion(module: CvModule, gray: CvMat): number {
	if (pool == null) {
		return 1;
	}

	module.resize(
		gray,
		pool.tiny,
		new module.Size(MOTION_SIZE, MOTION_SIZE),
		0,
		0,
		module.INTER_AREA
	);

	const current = new Uint8Array(pool.tiny.data);
	const previous = previousTiny;
	previousTiny = current;

	if (previous == null || previous.length !== current.length) {
		return 1;
	}

	let total = 0;
	for (let i = 0; i < current.length; i++) {
		total += Math.abs(current[i] - previous[i]);
	}

	return total / current.length / 255;
}


function post(message: ScanResponse, transfer: Transferable[] = []): void {
	(self as unknown as Worker).postMessage(message, transfer);
}

function emptyResult(reason: string, frameWidth: number, frameHeight: number, format: SheetFormat): FrameResult {
	return {
		ok: false,
		reason,
		answers: new Array(format.questions).fill(""),
		fills: [],
		quad: null,
		frameWidth,
		frameHeight,
		marks: [],
		qrQuad: null,
		motion: 0,
		searchRect: null,
		timing: {
			total: 0,
			locate: 0,
			warp: 0,
			read: 0,
		},
	};
}

export type Shape = {
	box: Box;
	/** Esquinas del contorno por extremos de suma y diferencia de coordenadas. */
	quad: Quad;
};

/**
 * Caja y esquinas de un contorno, leídas directo del heap.
 *
 * OJO con el build custom de OpenCV: `findContours` **antepone el bounding rect
 * al contorno**, ocupando el primer par de int32 (x, y, ancho y alto como cuatro
 * uint16 big-endian). Es una optimización del build — ahorra una llamada a
 * `boundingRect` por contorno — pero significa que `data32S[0]` y `data32S[1]` NO
 * son un punto: los puntos reales empiezan en el índice 2. Leer desde 0 mete una
 * esquina en (-234736896, 234884352) y no encuentra hoja alguna.
 *
 * La caja se recalcula desde los puntos igual: sale gratis en el mismo recorrido y
 * no depende de ese detalle del build.
 */
function contourShape(contour: CvMat): Shape | null {
	const points = contour.data32S;

	// 2 valores del bounding rect que antepone el build + al menos 3 puntos.
	if (points.length < 8) {
		return null;
	}

	const first = 2;
	let minX = points[first];
	let maxX = points[first];
	let minY = points[first + 1];
	let maxY = points[first + 1];
	let topLeft = first;
	let bottomRight = first;
	let topRight = first;
	let bottomLeft = first;

	for (let i = first; i < points.length; i += 2) {
		const x = points[i];
		const y = points[i + 1];

		if (x < minX) {
			minX = x;
		}

		if (x > maxX) {
			maxX = x;
		}

		if (y < minY) {
			minY = y;
		}

		if (y > maxY) {
			maxY = y;
		}

		if (x + y < points[topLeft] + points[topLeft + 1]) {
			topLeft = i;
		}

		if (x + y > points[bottomRight] + points[bottomRight + 1]) {
			bottomRight = i;
		}

		if (x - y > points[topRight] - points[topRight + 1]) {
			topRight = i;
		}

		if (x - y < points[bottomLeft] - points[bottomLeft + 1]) {
			bottomLeft = i;
		}
	}

	return {
		box: {
			x: minX,
			y: minY,
			w: maxX - minX + 1,
			h: maxY - minY + 1,
		},
		quad: {
			topLeft: { x: points[topLeft], y: points[topLeft + 1] },
			topRight: { x: points[topRight], y: points[topRight + 1] },
			bottomRight: { x: points[bottomRight], y: points[bottomRight + 1] },
			bottomLeft: { x: points[bottomLeft], y: points[bottomLeft + 1] },
		},
	};
}

/** Fracción de píxeles marcados (255) dentro de la caja, sobre una máscara binaria. */
function boxFill(mask: CvMat, box: Box): number {
	const data = mask.data;
	const width = mask.cols;
	const x0 = Math.max(0, Math.floor(box.x));
	const y0 = Math.max(0, Math.floor(box.y));
	const x1 = Math.min(mask.cols - 1, Math.floor(box.x + box.w - 1));
	const y1 = Math.min(mask.rows - 1, Math.floor(box.y + box.h - 1));
	if (x1 < x0 || y1 < y0) {
		return 0;
	}

	let marked = 0;
	for (let y = y0; y <= y1; y++) {
		const rowOffset = y * width;
		for (let x = x0; x <= x1; x++) {
			if (data[rowOffset + x] !== 0) {
				marked++;
			}
		}
	}

	return marked / ((x1 - x0 + 1) * (y1 - y0 + 1));
}

/** Promedio de gris dentro de un anillo (o disco, si `inner` es 0). */
function ringMean(gray: CvMat, centerX: number, centerY: number, inner: number, outer: number): number {
	const data = gray.data;
	const width = gray.cols;
	const height = gray.rows;
	const x0 = Math.max(0, Math.ceil(centerX - outer));
	const x1 = Math.min(width - 1, Math.floor(centerX + outer));
	const y0 = Math.max(0, Math.ceil(centerY - outer));
	const y1 = Math.min(height - 1, Math.floor(centerY + outer));
	const innerSquared = inner * inner;
	const outerSquared = outer * outer;
	let total = 0;
	let sum = 0;

	for (let y = y0; y <= y1; y++) {
		const dy = y - centerY;
		const rowOffset = y * width;
		for (let x = x0; x <= x1; x++) {
			const dx = x - centerX;
			const distance = dx * dx + dy * dy;
			if (distance > outerSquared || distance < innerSquared) {
				continue;
			}

			total++;
			sum += data[rowOffset + x];
		}
	}

	return total === 0 ? 255 : sum / total;
}

/**
 * Copia RGBA de una máscara/gris de un canal, que es lo que espera jsQR.
 */
function rgbaFromGray(gray: CvMat): Uint8ClampedArray {
	const source = gray.data;
	const rgba = new Uint8ClampedArray(source.length * 4);
	for (let i = 0; i < source.length; i++) {
		const offset = i * 4;
		const value = source[i];
		rgba[offset] = value;
		rgba[offset + 1] = value;
		rgba[offset + 2] = value;
		rgba[offset + 3] = 255;
	}

	return rgba;
}

function collectShapes(module: CvModule, mask: CvMat, mode: number): Shape[] {
	if (pool == null) {
		return [];
	}

	const contours = new module.MatVector();
	const shapes: Shape[] = [];

	try {
		module.findContours(mask, contours, pool.hierarchy, mode, module.CHAIN_APPROX_SIMPLE);
		const total = contours.size();
		for (let i = 0; i < total; i++) {
			const contour = contours.get(i);
			const shape = contourShape(contour);
			contour.delete();
			if (shape != null) {
				shapes.push(shape);
			}
		}
	} finally {
		contours.delete();
	}

	return shapes;
}

/**
 * Marcas de registro: los cuadrados negros macizos que la hoja trae impresos
 * alrededor de la cabecera y de cada bloque de preguntas.
 *
 * Son el ancla de la hoja. El contorno grande del marco impreso parece más
 * cómodo, pero no es fiable: una franja oscura del escáner en el borde de la
 * imagen se fusiona con el marco y el "marco" pasa a ser el encuadre completo,
 * con lo que la hoja rectificada sale mal y las respuestas salen corridas.
 */
function findRegistrationMarks(boxes: Box[], mask: CvMat): Box[] {
	const minSide = mask.cols * 0.008;
	const maxSide = mask.cols * 0.05;
	const rough: Box[] = [];

	for (const box of boxes) {
		if (box.w < minSide || box.w > maxSide || box.h < minSide || box.h > maxSide) {
			continue;
		}

		// Cuadradas de verdad: los números de fila ("01", "02") miden 9x7 en la copia
		// reducida y, borrosos, llenan su caja igual que una marca; lo único que los
		// delata es que no son cuadrados.
		const aspect = box.w / box.h;
		if (aspect < 0.85 || aspect > 1.18) {
			continue;
		}

		// Una marca es un cuadrado macizo y llena su caja; una burbuja rellena es un
		// círculo y llena el 78% (π/4), y un número de fila menos todavía. Con el
		// umbral en 0,6 entraban las burbujas marcadas y las esquinas del bloque
		// terminaban puestas sobre respuestas.
		if (boxFill(mask, box) < 0.85) {
			continue;
		}

		rough.push(box);
	}

	if (rough.length < 4) {
		return rough;
	}

	// Todas las marcas de una hoja miden lo mismo. Se toma como referencia la moda
	// de los tamaños y no la mediana: la mediana la arrastra cualquier ruido que
	// quede y deja fuera a las marcas de verdad.
	const sides = rough.map((box) => (box.w + box.h) / 2);
	let reference = sides[0];
	let bestCount = 0;
	for (const candidate of sides) {
		const similar = sides.filter((side) => Math.abs(side - candidate) <= candidate * 0.25).length;
		if (similar > bestCount || (similar === bestCount && candidate > reference)) {
			reference = candidate;
			bestCount = similar;
		}
	}

	return rough.filter((box) => {
		const side = (box.w + box.h) / 2;
		return side >= reference * 0.7 && side <= reference * 1.35;
	});
}

type WarpResult = {
	pageWidth: number;
	pageHeight: number;
};

function warpPage(module: CvModule, source: CvMat, quad: Quad, aspect: number): WarpResult | null {
	if (pool == null) {
		return null;
	}

	const pageWidth = PAGE_WIDTH;
	const pageHeight = Math.round(PAGE_WIDTH * aspect);
	if (pageHeight <= 0) {
		return null;
	}

	const inverse = homographyRectToQuad(quad, pageWidth, pageHeight);
	const forward = homographyToRect(quad, pageWidth, pageHeight);
	if (inverse == null || forward == null || warpConvention == null) {
		return null;
	}


	const transform = module.matFromArray(3, 3, module.CV_64F, matrixForWarp(warpConvention, forward, inverse));

	try {
		module.warpPerspective(
			source,
			pool.page,
			transform,
			new module.Size(pageWidth, pageHeight),
			module.INTER_LINEAR,
			module.BORDER_CONSTANT,
			new module.Scalar(255, 255, 255, 255)
		);
	} finally {
		transform.delete();
	}

	return {
		pageWidth,
		pageHeight,
	};
}

type CellSample = {
	inside: number;
	paper: number;
};

/**
 * Relleno de una burbuja como contraste contra el papel que la rodea.
 *
 * Contar píxeles de una máscara binaria no sirve para las dos cosas a la vez: con
 * el umbral duro se pierden las marcas de lápiz claro (aparecen como pregunta en
 * blanco, que es el peor error posible en una corrección) y con el umbral blando
 * el gris del papel escaneado empieza a contar como marca. La razón contra el
 * papel de al lado no depende ni de la iluminación ni de la intensidad del lápiz:
 * papel 230 con marca 150 da 0,35 igual que papel 120 con marca 78.
 */
function cellFill(sample: CellSample): number {
	if (sample.paper <= 1) {
		return 0;
	}

	const ratio = (sample.paper - sample.inside) / sample.paper;
	return Math.min(1, Math.max(0, ratio));
}

function readAnswers(format: SheetFormat, grid: GridModel, gray: CvMat): { answers: string[]; fills: number[][] } {
	const answers: string[] = new Array(format.questions).fill("");
	const fills: number[][] = new Array(format.questions).fill(null).map(() => []);
	const radius = grid.radius * SAMPLE_RADIUS_FACTOR;
	const paperInner = grid.radius * 1.3;
	const paperOuter = grid.radius * 1.75;

	for (let block = 0; block < grid.blockColumns.length; block++) {
		const columns = grid.blockColumns[block];
		for (let row = 0; row < grid.rowCenters.length; row++) {
			const question = questionNumber(format, block, row);
			if (question > format.questions) {
				continue;
			}

			const y = grid.rowCenters[row];
			const samples: CellSample[] = columns.map((x) => ({
				inside: ringMean(gray, x, y, 0, radius),
				paper: ringMean(gray, x, y, paperInner, paperOuter),
			}));

			// El papel se toma de la fila completa, no de cada burbuja: el anillo de una
			// burbuja rellena con lápiz que se sale del círculo saldría oscuro y haría
			// parecer que no hay marca.
			const paper = median(samples.map((sample) => sample.paper));
			const cells: CellFill[] = samples.map((sample, index) => ({
				letter: format.letters[index] ?? "",
				fill: cellFill({ inside: sample.inside, paper }),
			}));

			answers[question - 1] = classifyQuestion(cells);
			fills[question - 1] = cells.map((cell) => cell.fill);
		}
	}

	return {
		answers,
		fills,
	};
}

/**
 * Pinta una máscara binaria con las cajas candidatas encima. Es la única forma
 * práctica de ver por qué un frame no encontró las marcas de esquina.
 */
function renderMaskImage(mask: CvMat, boxes: Box[]): ImageBitmap | null {
	const canvas = new OffscreenCanvas(mask.cols, mask.rows);
	const context = canvas.getContext("2d");
	if (context == null) {
		return null;
	}

	const image = context.createImageData(mask.cols, mask.rows);
	const data = mask.data;
	for (let i = 0; i < data.length; i++) {
		const offset = i * 4;
		const value = data[i] === 0 ? 255 : 0;
		image.data[offset] = value;
		image.data[offset + 1] = value;
		image.data[offset + 2] = value;
		image.data[offset + 3] = 255;
	}

	context.putImageData(image, 0, 0);
	context.strokeStyle = "rgba(255, 0, 128, 0.9)";
	context.lineWidth = 1;
	for (const box of boxes) {
		context.strokeRect(box.x, box.y, box.w, box.h);
	}

	return canvas.transferToImageBitmap();
}

function renderDebugImage(page: CvMat, grid: GridModel | null, radius: number): ImageBitmap | null {
	const canvas = new OffscreenCanvas(page.cols, page.rows);
	const context = canvas.getContext("2d");
	if (context == null) {
		return null;
	}

	const image = context.createImageData(page.cols, page.rows);
	const gray = page.data;
	for (let i = 0; i < gray.length; i++) {
		const offset = i * 4;
		image.data[offset] = gray[i];
		image.data[offset + 1] = gray[i];
		image.data[offset + 2] = gray[i];
		image.data[offset + 3] = 255;
	}

	context.putImageData(image, 0, 0);

	if (grid != null) {
		context.strokeStyle = "rgba(255, 0, 128, 0.9)";
		context.lineWidth = 1;
		for (const columns of grid.blockColumns) {
			for (const x of columns) {
				for (const y of grid.rowCenters) {
					context.beginPath();
					context.arc(x, y, radius, 0, Math.PI * 2);
					context.stroke();
				}
			}
		}
	}

	return canvas.transferToImageBitmap();
}

/** Recorta la zona pedida contra el frame y la redondea a píxeles enteros. */
function clampRect(rect: Rect | null, frameWidth: number, frameHeight: number): Rect | null {
	if (rect == null) {
		return null;
	}

	const x = Math.max(0, Math.floor(rect.x));
	const y = Math.max(0, Math.floor(rect.y));
	const width = Math.min(frameWidth - x, Math.ceil(rect.width));
	const height = Math.min(frameHeight - y, Math.ceil(rect.height));

	// Una zona diminuta no sirve para nada y además rompe el resize.
	if (width < frameWidth * 0.15 || height < frameHeight * 0.1) {
		return null;
	}

	return { x, y, width, height };
}

function processFrame(module: CvModule, request: Extract<ScanRequest, { type: "frame" }>): void {
	const format = getFormat(request.formatId);
	const bitmap = request.bitmap;
	const frameWidth = bitmap.width;
	const frameHeight = bitmap.height;
	const startedAt = performance.now();

	const canvas = new OffscreenCanvas(frameWidth, frameHeight);
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (context == null) {
		bitmap.close();
		post({
			type: "result",
			frameId: request.frameId,
			result: emptyResult("no se pudo leer el frame", frameWidth, frameHeight, format),
			debugImage: null,
		});
		return;
	}

	context.drawImage(bitmap, 0, 0);
	bitmap.close();

	if (pool == null) {
		pool = {
			gray: new module.Mat(),
			small: new module.Mat(),
			qr: new module.Mat(),
			tiny: new module.Mat(),
			smallBin: new module.Mat(),
			page: new module.Mat(),
			pageEdges: new module.Mat(),
			hierarchy: new module.Mat(),
		};
	}

	const imageData = context.getImageData(0, 0, frameWidth, frameHeight);
	const source = module.matFromImageData(imageData);

	try {
		module.cvtColor(source, pool.gray, module.COLOR_RGBA2GRAY);
	} finally {
		source.delete();
	}

	const search = clampRect(request.roi, frameWidth, frameHeight);
	const region = search == null ? pool.gray : pool.gray.roi(new module.Rect(search.x, search.y, search.width, search.height));
	const searchWidth = search?.width ?? frameWidth;
	const searchHeight = search?.height ?? frameHeight;

	try {
		module.resize(
			region,
			pool.small,
			new module.Size(LOCATE_WIDTH, Math.max(1, Math.round((searchHeight * LOCATE_WIDTH) / searchWidth))),
			0,
			0,
			module.INTER_AREA
		);
	} finally {
		if (search != null) {
			region.delete();
		}
	}

	// Umbral adaptativo con bloque de ~2,5 veces la marca y un C alto.
	//
	// El bloque tiene que superar a la marca (si no, el promedio local se vuelve
	// negro dentro del cuadrado y la marca se borra) pero no puede ser tan grande
	// como para que una sombra suave del ambiente entre como "oscuro": con bloque
	// gigante las fotos con sombra se llenan de manchas que se fusionan con las
	// marcas. El C alto es lo que deja fuera esa sombra.
	module.GaussianBlur(pool.small, pool.small, new module.Size(3, 3), 0);
	const locateBlock = Math.max(3, Math.round(pool.small.cols * 0.1) | 1);
	module.adaptiveThreshold(
		pool.small,
		pool.smallBin,
		255,
		module.ADAPTIVE_THRESH_MEAN_C,
		module.THRESH_BINARY_INV,
		locateBlock,
		// OpenCV umbraliza contra `media - C`, así que para marcar lo OSCURO el C va
		// positivo: un C negativo baja el umbral por debajo del papel y marca la hoja
		// entera.
		LOCATE_THRESHOLD_C
	);

	const smallShapes = collectShapes(module, pool.smallBin, module.RETR_LIST);
	const markers = findRegistrationMarks(
		smallShapes.map((shape) => shape.box),
		pool.smallBin
	);

	const result = emptyResult("", frameWidth, frameHeight, format);
	result.motion = measureMotion(module, pool.gray);
	result.searchRect = search;
	const scale = LOCATE_WIDTH / searchWidth;
	const offsetX = search?.x ?? 0;
	const offsetY = search?.y ?? 0;
	const aFrame = (point: Point): Point => ({ x: offsetX + point.x / scale, y: offsetY + point.y / scale });
	// Y la vuelta: el QR se busca sobre el frame completo, así que su estimación hay
	// que traerla al sistema de la copia recortada donde viven las marcas.
	const aSmall = (point: Point): Point => ({ x: (point.x - offsetX) * scale, y: (point.y - offsetY) * scale });
	const quadAFrame = (quad: Quad): Quad => ({
		topLeft: aFrame(quad.topLeft),
		topRight: aFrame(quad.topRight),
		bottomRight: aFrame(quad.bottomRight),
		bottomLeft: aFrame(quad.bottomLeft),
	});

	// Las marcas van siempre al resultado, no sólo depurando: el overlay las dibuja
	// para que el usuario vea qué está viendo la app mientras encuadra.
	result.marks = markers.map((box) => aFrame({ x: box.x + box.w / 2, y: box.y + box.h / 2 }));

	const tolerance = toleranceFor(request.anchor);
	const buscaQr = request.anchor === "qr" || request.debug;
	let qrSighting: ReturnType<typeof findQr> = null;
	let qrScale = 1;

	if (buscaQr) {
		const qrWidth = Math.min(frameWidth, QR_WIDTH);
		qrScale = qrWidth / frameWidth;
		module.resize(
			pool.gray,
			pool.qr,
			new module.Size(qrWidth, Math.max(1, Math.round(frameHeight * qrScale))),
			0,
			0,
			module.INTER_AREA
		);

		qrSighting = findQr(rgbaFromGray(pool.qr), pool.qr.cols, pool.qr.rows);
		if (qrSighting != null) {
			result.qrQuad = {
				topLeft: { x: qrSighting.quad.topLeft.x / qrScale, y: qrSighting.quad.topLeft.y / qrScale },
				topRight: { x: qrSighting.quad.topRight.x / qrScale, y: qrSighting.quad.topRight.y / qrScale },
				bottomRight: { x: qrSighting.quad.bottomRight.x / qrScale, y: qrSighting.quad.bottomRight.y / qrScale },
				bottomLeft: { x: qrSighting.quad.bottomLeft.x / qrScale, y: qrSighting.quad.bottomLeft.y / qrScale },
			};
		}
	}

	const marksQuad = findAnswersQuad(markers, {
		rowTolerance: pool.small.rows * 0.04,
		frameWidth: pool.small.cols,
		frameHeight: pool.small.rows,
		tolerance,
	});

	// Con ancla QR: el QR estima dónde está el bloque y las marcas que se vean
	// corrigen las esquinas. Sin esa corrección la estimación se desvía lo suficiente
	// para que la grilla no cierre; con ella, basta que aparezca alguna marca.
	let qrSnapped = 0;
	let smallQuad: Quad | null = marksQuad;

	if (request.anchor === "qr") {
		smallQuad = null;

		if (qrSighting != null) {
			const estimado = answersQuadFromQr(qrSighting.quad, qrTemplates[format.id]);
			if (estimado != null) {
				const enSmall: Quad = {
					topLeft: aSmall({ x: estimado.topLeft.x / qrScale, y: estimado.topLeft.y / qrScale }),
					topRight: aSmall({ x: estimado.topRight.x / qrScale, y: estimado.topRight.y / qrScale }),
					bottomRight: aSmall({ x: estimado.bottomRight.x / qrScale, y: estimado.bottomRight.y / qrScale }),
					bottomLeft: aSmall({ x: estimado.bottomLeft.x / qrScale, y: estimado.bottomLeft.y / qrScale }),
				};

				const ajuste = snapQuadToMarks(
					enSmall,
					markers.map((box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 })),
					pool.small.cols * 0.06
				);

				qrSnapped = ajuste.snapped;
				smallQuad = ajuste.quad;
			}
		}
	}

	result.timing.locate = performance.now() - startedAt;

	if (smallQuad == null) {
		result.reason =
			request.anchor === "qr" ? "no se ve el QR de la cabecera" : "no se ven las marcas de la hoja";

		if (request.debug) {
			const filas = markRows(markers, pool.small.rows * 0.04, tolerance.completeCorners ? 1 : 2)
				.map((row) => `y=${row.center.toFixed(0)} n=${row.count} w=${row.width.toFixed(0)}`)
				.join(" | ");
			result.reason += ` · contornos ${smallShapes.length} · marcas ${markers.length} · filas ${filas}`;
			const mask = renderMaskImage(pool.smallBin, markers);
			result.timing.total = performance.now() - startedAt;
			post({ type: "result", frameId: request.frameId, result, debugImage: mask }, mask == null ? [] : [mask]);
			return;
		}

		result.timing.total = performance.now() - startedAt;
		post({ type: "result", frameId: request.frameId, result, debugImage: null });
		return;
	}

	const check = checkQuad(smallQuad, pool.small.cols, pool.small.rows, answersBlockAspect, tolerance);
	if (!check.valid) {
		result.reason = check.reason;
		result.timing.total = performance.now() - startedAt;
		post({ type: "result", frameId: request.frameId, result, debugImage: null });
		return;
	}

	const quad: Quad = quadAFrame(smallQuad);
	result.quad = quad;

	// Sondeo de encuadre: con la hoja ubicada ya está todo lo que necesita la
	// asistencia. Rectificar y leer sería gastar batería en un frame que nadie va a
	// usar.
	if (!request.read) {
		result.timing.total = performance.now() - startedAt;
		post({ type: "result", frameId: request.frameId, result, debugImage: null });
		return;
	}

	const warpStartedAt = performance.now();
	const warped = warpPage(module, pool.gray, quad, check.aspect);
	result.timing.warp = performance.now() - warpStartedAt;
	if (warped == null) {
		result.reason = "no se pudo rectificar la hoja";
		result.timing.total = performance.now() - startedAt;
		post({ type: "result", frameId: request.frameId, result, debugImage: null });
		return;
	}

	const readStartedAt = performance.now();

	// Umbral adaptativo de bloque chico (~3% del ancho) sólo para la geometría:
	// resalta los anillos impresos aunque la foto tenga sombra. El relleno NO se
	// mide sobre esta máscara — se mide en gris, contra el papel de alrededor.
	const blockSize = Math.max(3, Math.round(warped.pageWidth * 0.03) | 1);
	module.adaptiveThreshold(
		pool.page,
		pool.pageEdges,
		255,
		module.ADAPTIVE_THRESH_MEAN_C,
		module.THRESH_BINARY_INV,
		blockSize,
		PAGE_THRESHOLD_C
	);

	const pageShapes = collectShapes(module, pool.pageEdges, module.RETR_LIST);
	const gridResult = buildGrid(
		pageShapes.map((shape) => shape.box),
		format,
		{
			pageWidth: warped.pageWidth,
			pageHeight: warped.pageHeight,
		}
	);

	let debugImage: ImageBitmap | null = null;

	if (gridResult.grid == null) {
		result.reason = request.debug
			? `${gridResult.reason} · ${gridResult.debug} · hoja ${pool.page.cols}x${pool.page.rows} · esquinas ` +
				[quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft]
					.map((punto) => `(${punto.x.toFixed(0)},${punto.y.toFixed(0)})`)
					.join(" ") +
				` · candidatas ${gridResult.candidates.length}`
			: gridResult.reason;
		result.timing.read = performance.now() - readStartedAt;
		result.timing.total = performance.now() - startedAt;
		if (request.debug) {
			debugImage = renderDebugImage(pool.page, null, 0);
		}

		post(
			{ type: "result", frameId: request.frameId, result, debugImage },
			debugImage == null ? [] : [debugImage]
		);
		return;
	}

	const reading = readAnswers(format, gridResult.grid, pool.page);
	result.ok = true;
	if (request.debug) {
		const grid = gridResult.grid;
		const filas = `${grid.rowCenters[0].toFixed(1)}..${grid.rowCenters[grid.rowCenters.length - 1].toFixed(1)}`;
		const columnas = grid.blockColumns.map((columns) => columns.map((x) => x.toFixed(1)).join("/")).join(" | ");
		// Con el QR y las marcas en el mismo frame se puede medir la plantilla del QR:
		// son las coordenadas de las esquinas del bloque en el marco del símbolo.
		let plantilla = request.anchor === "qr" ? ` · esquinas afinadas ${qrSnapped}/4` : "";
		if (qrSighting != null && marksQuad != null) {
			// Las marcas vienen en coordenadas de la copia de 640 y el QR en las de su
			// propia copia: hay que llevar unas al espacio de las otras o la medición sale
			// escalada.
			const aQr = (punto: Point): Point => {
				const enFrame = aFrame(punto);
				return { x: enFrame.x * qrScale, y: enFrame.y * qrScale };
			};
			const esquinas = [marksQuad.topLeft, marksQuad.topRight, marksQuad.bottomRight, marksQuad.bottomLeft]
				.map((punto) => pointInQrFrame(qrSighting.quad, aQr(punto)))
				.map((punto) => `(${punto.x.toFixed(2)},${punto.y.toFixed(2)})`)
				.join(" ");
			// El contenido del QR identifica la prueba y el alumno: no se escribe en
			// ninguna salida, ni siquiera depurando.
			plantilla = ` · plantillaQR ${esquinas} · qr ${qrSighting.text.length} chars`;
		}

		result.reason =
			`${gridResult.debug}${plantilla} · warp ${warpConvention?.label ?? "?"} · hoja ${pool.page.cols}x${pool.page.rows} · r=${grid.radius.toFixed(1)} · ` +
			`filas ${filas} · cols ${columnas} · esquinas (${quad.topLeft.x.toFixed(0)},${quad.topLeft.y.toFixed(0)}) ` +
			`(${quad.topRight.x.toFixed(0)},${quad.topRight.y.toFixed(0)}) (${quad.bottomRight.x.toFixed(0)},${quad.bottomRight.y.toFixed(0)}) ` +
			`(${quad.bottomLeft.x.toFixed(0)},${quad.bottomLeft.y.toFixed(0)}) · frame ${frameWidth}x${frameHeight} · asp ${check.aspect.toFixed(2)}`;
	}

	result.answers = reading.answers;
	result.fills = reading.fills;
	result.timing.read = performance.now() - readStartedAt;
	result.timing.total = performance.now() - startedAt;

	if (request.debug) {
		debugImage = renderDebugImage(pool.page, gridResult.grid, gridResult.grid.radius * SAMPLE_RADIUS_FACTOR);
	}

	post({ type: "result", frameId: request.frameId, result, debugImage }, debugImage == null ? [] : [debugImage]);
}

self.onmessage = async (event: MessageEvent<ScanRequest>): Promise<void> => {
	const request = event.data;

	if (request.type === "init") {
		try {
			cv = await loadOpenCv(request.opencvUrl);
			warpConvention = detectWarpConvention(cv);
			post({ type: "ready" });
		} catch (error) {
			post({ type: "error", message: error instanceof Error ? error.message : String(error) });
		}

		return;
	}

	if (cv == null) {
		request.bitmap.close();
		post({ type: "error", message: "el worker recibió un frame antes de cargar OpenCV" });
		return;
	}

	try {
		processFrame(cv, request);
	} catch (error) {
		post({ type: "error", message: error instanceof Error ? error.message : String(error) });
	}
};
