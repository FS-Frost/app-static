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

import { classifyQuestion, type CellFill } from "./classify";
import { getFormat, questionNumber, type SheetFormat } from "./format";
import { checkQuad, findAnswersQuad, markRows, median, type Box, type Quad } from "./geometry";
import { homographyRectToQuad, homographyToRect } from "./homography";
import { detectWarpConvention, matrixForWarp, type WarpConvention } from "./warpConvention";
import { buildGrid, type GridModel } from "./grid";
import { loadOpenCv, type CvMat, type CvModule } from "./opencv";
import type { FrameResult, ScanRequest, ScanResponse } from "./protocol";

/** Ancho al que se reduce el frame para buscar las marcas de esquina. */
const LOCATE_WIDTH = 640;

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
	smallBin: CvMat;
	page: CvMat;
	pageEdges: CvMat;
	hierarchy: CvMat;
};

let pool: MatPool | null = null;
let warpConvention: WarpConvention | null = null;


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
		markers: [],
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

	const scale = LOCATE_WIDTH / frameWidth;
	module.resize(
		pool.gray,
		pool.small,
		new module.Size(LOCATE_WIDTH, Math.max(1, Math.round(frameHeight * scale))),
		0,
		0,
		module.INTER_AREA
	);

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
	const locateMs = performance.now() - startedAt;

	const result = emptyResult("", frameWidth, frameHeight, format);
	result.timing.locate = locateMs;
	result.markers = request.debug ? markers : [];

	// La hoja se ubica por sus marcas de registro impresas, no por el contorno del
	// marco: ese contorno se fusiona con cualquier franja oscura del borde de la
	// imagen (los escaneos vienen con una) y entonces la "hoja" pasa a ser el
	// encuadre completo.
	const smallQuad = findAnswersQuad(markers, {
		rowTolerance: pool.small.rows * 0.04,
		frameWidth: pool.small.cols,
		frameHeight: pool.small.rows,
	});
	if (smallQuad == null) {
		if (request.debug) {
			const mask = renderMaskImage(pool.smallBin, markers);
			result.timing.total = performance.now() - startedAt;
			const filas = markRows(markers, pool.small.rows * 0.04)
				.map((row) => `y=${row.center.toFixed(0)} n=${row.count} w=${row.width.toFixed(0)}`)
				.join(" | ");
			result.reason = `no se ven las marcas de la hoja · contornos ${smallShapes.length} · marcas ${markers.length} · filas ${filas}`;
			post({ type: "result", frameId: request.frameId, result, debugImage: mask }, mask == null ? [] : [mask]);
			return;
		}

		result.reason = "no se ven las marcas de la hoja";
		result.timing.total = performance.now() - startedAt;
		post({ type: "result", frameId: request.frameId, result, debugImage: null });
		return;
	}

	const check = checkQuad(smallQuad, pool.small.cols, pool.small.rows);
	if (!check.valid) {
		result.reason = check.reason;
		result.timing.total = performance.now() - startedAt;
		post({ type: "result", frameId: request.frameId, result, debugImage: null });
		return;
	}

	const quad: Quad = {
		topLeft: { x: smallQuad.topLeft.x / scale, y: smallQuad.topLeft.y / scale },
		topRight: { x: smallQuad.topRight.x / scale, y: smallQuad.topRight.y / scale },
		bottomRight: { x: smallQuad.bottomRight.x / scale, y: smallQuad.bottomRight.y / scale },
		bottomLeft: { x: smallQuad.bottomLeft.x / scale, y: smallQuad.bottomLeft.y / scale },
	};

	result.quad = quad;

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
		result.reason = gridResult.reason;
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
		result.reason =
			`${gridResult.debug} · warp ${warpConvention?.label ?? "?"} · hoja ${pool.page.cols}x${pool.page.rows} · r=${grid.radius.toFixed(1)} · ` +
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
