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

import { roiFor, type Rect } from "./assist";
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
import { answersQuadFromQr, findQr, pointInQrFrame, qrTemplates, snapQuadToMarks, type QrSighting } from "./qr";
import { looseTolerance, toleranceFor } from "./strategy";
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

/**
 * Ancho de la hoja rectificada.
 *
 * Con 760 px las burbujas quedan en ~18 px, de sobra para medir relleno, y la
 * rectificación, el umbral y los contornos cuestan un 30% menos que con 900. En un
 * teléfono eso se nota: la lectura era la etapa más cara de cada frame.
 */
const PAGE_WIDTH = 760;

/** Cuánto más oscuro que su vecindario tiene que ser un píxel para contar como marca. */
const LOCATE_THRESHOLD_C = 25;

/** Lo mismo, para los anillos impresos de las burbujas en la hoja rectificada. */
const PAGE_THRESHOLD_C = 10;

/**
 * Umbrales de reserva para buscar marcas.
 *
 * Se prueban en el mismo frame cuando el de siempre no encuentra nada: uno más
 * blando para hojas con poco contraste (fotocopia clara, poca luz) y uno más duro
 * para papel con brillo. Cada reintento cuesta un umbral y unos contornos sobre una
 * imagen de 640 px — bastante menos que hacer esperar al usuario otro segundo.
 */
const ALTERNATE_THRESHOLD_C = [12, 40];

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
		hintRoi: null,
		source: "",
		attempts: 0,
		timing: {
			total: 0,
			locate: 0,
			warp: 0,
			read: 0,
		},
	};
}

/**
 * Caja envolvente de un contorno, leída de los primeros 8 bytes.
 *
 * El build custom de OpenCV **antepone el bounding rect al contorno**: cuatro
 * uint16 big-endian (x, y, ancho, alto) ocupando el primer par de int32, y los
 * puntos reales empiezan en `data32S[2]`. Es una optimización del build —ahorra una
 * llamada a `boundingRect` por contorno— y acá se aprovecha entera: leer 8 bytes
 * es O(1), mientras recorrer los puntos de cada contorno costaba la mitad del
 * tiempo de cada frame (una hoja llena da ~1500 contornos).
 *
 * Si el rect viene vacío se recalcula desde los puntos, para no depender de ese
 * detalle del build si algún día cambia.
 */
function contourBox(contour: CvMat): Box | null {
	const bytes = contour.data;
	if (bytes.length < 8) {
		return null;
	}

	const width = (bytes[4] << 8) | bytes[5];
	const height = (bytes[6] << 8) | bytes[7];

	if (width > 0 && height > 0) {
		return {
			x: (bytes[0] << 8) | bytes[1],
			y: (bytes[2] << 8) | bytes[3],
			w: width,
			h: height,
		};
	}

	const points = contour.data32S;
	if (points.length < 4) {
		return null;
	}

	let minX = points[2];
	let maxX = points[2];
	let minY = points[3];
	let maxY = points[3];

	for (let i = 2; i < points.length; i += 2) {
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
	}

	return {
		x: minX,
		y: minY,
		w: maxX - minX + 1,
		h: maxY - minY + 1,
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
let rgbaBuffer: Uint8ClampedArray | null = null;

function rgbaFromGray(gray: CvMat): Uint8ClampedArray {
	const source = gray.data;

	// El búfer se reutiliza: son 4 bytes por píxel y a 1080x1080 son 4,6 MB por
	// frame, que el recolector de basura acaba pagando en tirones.
	if (rgbaBuffer == null || rgbaBuffer.length !== source.length * 4) {
		rgbaBuffer = new Uint8ClampedArray(source.length * 4);
	}

	const rgba = rgbaBuffer;
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

function collectBoxes(module: CvModule, mask: CvMat, mode: number): Box[] {
	if (pool == null) {
		return [];
	}

	const contours = new module.MatVector();
	const boxes: Box[] = [];

	try {
		module.findContours(mask, contours, pool.hierarchy, mode, module.CHAIN_APPROX_SIMPLE);
		const total = contours.size();
		for (let i = 0; i < total; i++) {
			const contour = contours.get(i);
			const box = contourBox(contour);
			contour.delete();
			if (box != null) {
				boxes.push(box);
			}
		}
	} finally {
		contours.delete();
	}

	return boxes;
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

type Attempt = {
	/** De dónde salió el cuadrilátero: sirve para saber qué vía funcionó. */
	label: string;
	/** Esquinas en coordenadas del frame. */
	quad: Quad;
	aspect: number;
	/**
	 * Qué tan respaldado está por lo que se vio. Los intentos se leen en este orden:
	 * leer cuesta la mitad del frame, así que conviene empezar por el que más
	 * probablemente cierre.
	 */
	confidence: number;
};

type ReadOutcome = {
	ok: boolean;
	reason: string;
	answers: string[];
	fills: number[][];
	grid: GridModel | null;
	gridDebug: string;
	pageWidth: number;
	pageHeight: number;
};

/**
 * Rectifica con un cuadrilátero y trata de leer. Devuelve el motivo si no cierra,
 * para que quien llama pueda probar la vía siguiente.
 */
/**
 * Grilla de la última lectura buena, para no reconstruirla en cada frame.
 *
 * Entre dos frames consecutivos la hoja se mueve unos píxeles, y la grilla se
 * rectifica al mismo rectángulo: reconstruirla cuesta un umbral adaptativo y ~1500
 * contornos, la mitad del costo de leer. Se reutiliza mientras el cuadrilátero
 * apenas se mueva, y se rehace igual cada cierto número de frames para no arrastrar
 * un error si la hoja fue derivando de a poco.
 */
const gridCache: {
	grid: GridModel | null;
	quad: Quad | null;
	formatId: string;
	pageWidth: number;
	pageHeight: number;
	reuses: number;
} = { grid: null, quad: null, formatId: "", pageWidth: 0, pageHeight: 0, reuses: 0 };

/** Cuántas veces seguidas se puede reutilizar una grilla antes de rehacerla. */
const MAX_GRID_REUSES = 6;

function quadDrift(a: Quad, b: Quad): number {
	return Math.max(
		Math.hypot(a.topLeft.x - b.topLeft.x, a.topLeft.y - b.topLeft.y),
		Math.hypot(a.topRight.x - b.topRight.x, a.topRight.y - b.topRight.y),
		Math.hypot(a.bottomRight.x - b.bottomRight.x, a.bottomRight.y - b.bottomRight.y),
		Math.hypot(a.bottomLeft.x - b.bottomLeft.x, a.bottomLeft.y - b.bottomLeft.y)
	);
}

function tryRead(module: CvModule, format: SheetFormat, attempt: Attempt): ReadOutcome {
	const failed: ReadOutcome = {
		ok: false,
		reason: "no se pudo rectificar la hoja",
		answers: [],
		fills: [],
		grid: null,
		gridDebug: "",
		pageWidth: 0,
		pageHeight: 0,
	};

	if (pool == null) {
		return failed;
	}

	const warped = warpPage(module, pool.gray, attempt.quad, attempt.aspect);
	if (warped == null) {
		return failed;
	}

	// ¿Sirve la grilla del frame anterior? El cuadrilátero tiene que haberse movido
	// menos de un tercio de burbuja, que es donde el muestreo sigue cayendo dentro.
	const cachePutoAlDia =
		gridCache.grid != null &&
		gridCache.quad != null &&
		gridCache.formatId === format.id &&
		gridCache.pageWidth === warped.pageWidth &&
		gridCache.pageHeight === warped.pageHeight &&
		gridCache.reuses < MAX_GRID_REUSES &&
		quadDrift(gridCache.quad, attempt.quad) <= gridCache.grid.radius * 0.6;

	if (cachePutoAlDia && gridCache.grid != null) {
		gridCache.reuses++;
		gridCache.quad = attempt.quad;
		const reading = readAnswers(format, gridCache.grid, pool.page);

		return {
			ok: true,
			reason: "",
			answers: reading.answers,
			fills: reading.fills,
			grid: gridCache.grid,
			gridDebug: `grilla reutilizada (${gridCache.reuses}/${MAX_GRID_REUSES})`,
			pageWidth: warped.pageWidth,
			pageHeight: warped.pageHeight,
		};
	}

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

	const pageBoxes = collectBoxes(module, pool.pageEdges, module.RETR_LIST);
	const gridResult = buildGrid(
		pageBoxes,
		format,
		{
			pageWidth: warped.pageWidth,
			pageHeight: warped.pageHeight,
		}
	);

	if (gridResult.grid == null) {
		gridCache.grid = null;
		return {
			...failed,
			reason: gridResult.reason,
			gridDebug: gridResult.debug,
			pageWidth: warped.pageWidth,
			pageHeight: warped.pageHeight,
		};
	}

	const reading = readAnswers(format, gridResult.grid, pool.page);
	gridCache.grid = gridResult.grid;
	gridCache.quad = attempt.quad;
	gridCache.formatId = format.id;
	gridCache.pageWidth = warped.pageWidth;
	gridCache.pageHeight = warped.pageHeight;
	gridCache.reuses = 0;

	return {
		ok: true,
		reason: "",
		answers: reading.answers,
		fills: reading.fills,
		grid: gridResult.grid,
		gridDebug: gridResult.debug,
		pageWidth: warped.pageWidth,
		pageHeight: warped.pageHeight,
	};
}

/** Tiempos por etapa. Sólo se miran depurando, y son la forma de no optimizar a ciegas. */
const etapas = { gris: 0, mascara: 0, qr: 0, lectura: 0, movimiento: 0 };

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

	const tGris = performance.now();
	const imageData = context.getImageData(0, 0, frameWidth, frameHeight);
	const source = module.matFromImageData(imageData);

	try {
		module.cvtColor(source, pool.gray, module.COLOR_RGBA2GRAY);
	} finally {
		source.delete();
	}

	etapas.gris = performance.now() - tGris;

	const search = clampRect(request.roi, frameWidth, frameHeight);
	const region =
		search == null ? pool.gray : pool.gray.roi(new module.Rect(search.x, search.y, search.width, search.height));
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

	module.GaussianBlur(pool.small, pool.small, new module.Size(3, 3), 0);

	etapas.mascara = 0;
	etapas.qr = 0;
	const result = emptyResult("", frameWidth, frameHeight, format);
	const tMovimiento = performance.now();
	result.motion = measureMotion(module, pool.gray);
	etapas.movimiento = performance.now() - tMovimiento;
	result.searchRect = search;

	const scale = LOCATE_WIDTH / searchWidth;
	const offsetX = search?.x ?? 0;
	const offsetY = search?.y ?? 0;
	const aFrame = (point: Point): Point => ({ x: offsetX + point.x / scale, y: offsetY + point.y / scale });
	const aSmall = (point: Point): Point => ({ x: (point.x - offsetX) * scale, y: (point.y - offsetY) * scale });
	const quadAFrame = (quad: Quad): Quad => ({
		topLeft: aFrame(quad.topLeft),
		topRight: aFrame(quad.topRight),
		bottomRight: aFrame(quad.bottomRight),
		bottomLeft: aFrame(quad.bottomLeft),
	});

	const tolerance = toleranceFor(request.anchor);
	const rowTolerance = pool.small.rows * 0.04;
	const attempts: Attempt[] = [];
	let lastReason = "no se ven las marcas de la hoja";

	/** Busca las marcas con un umbral dado y agrega el intento si el cuadrilátero sirve. */
	const intentarMarcas = (thresholdC: number, label: string): Box[] => {
		if (pool == null) {
			return [];
		}

		const inicio = performance.now();

		const locateBlock = Math.max(3, Math.round(pool.small.cols * 0.1) | 1);
		module.adaptiveThreshold(
			pool.small,
			pool.smallBin,
			255,
			module.ADAPTIVE_THRESH_MEAN_C,
			module.THRESH_BINARY_INV,
			locateBlock,
			// OpenCV umbraliza contra `media - C`: para marcar lo OSCURO el C va positivo.
			thresholdC
		);

			const marks = findRegistrationMarks(collectBoxes(module, pool.smallBin, module.RETR_LIST), pool.smallBin);

		const quad = findAnswersQuad(marks, {
			rowTolerance,
			frameWidth: pool.small.cols,
			frameHeight: pool.small.rows,
			tolerance,
		});

		etapas.mascara += performance.now() - inicio;

		if (quad != null) {
			const check = checkQuad(quad.quad, pool.small.cols, pool.small.rows, answersBlockAspect, tolerance);
			if (check.valid) {
				attempts.push({
					label: quad.deduced ? `${label} (esquina deducida)` : label,
					quad: quadAFrame(quad.quad),
					aspect: check.aspect,
					// Una esquina deducida es una apuesta: si además hay QR, conviene leer
					// primero la vía del QR, que sí vio dónde está la hoja.
					confidence: quad.deduced ? 1.5 : 3,
				});
			} else {
				lastReason = check.reason;
			}
		}

		return marks;
	};

	// Con ancla QR el símbolo manda, pero las marcas se buscan igual: son el respaldo
	// cuando el QR está sucio, tapado o fuera del cuadro. Un ancla que deja la app
	// inservible cuando falta su referencia no sirve de omisión.
	const qrPrimero = request.anchor === "qr";
	const usaMarcas = true;
	const markers = usaMarcas ? intentarMarcas(LOCATE_THRESHOLD_C, "marcas") : [];
	result.marks = markers.map((box) => aFrame({ x: box.x + box.w / 2, y: box.y + box.h / 2 }));

	// El estado del QR va en un objeto y no en variables sueltas: se asigna dentro de
	// una función y TypeScript, que no sigue asignaciones en closures, daría por nula
	// una variable que sí tiene valor.
	const qr: { sighting: QrSighting | null; scale: number; snapped: number; searched: boolean } = {
		sighting: null,
		scale: 1,
		snapped: 0,
		searched: false,
	};

	/**
	 * Busca el QR y, si aparece, agrega su estimación como una vía más.
	 *
	 * Es perezoso a propósito: buscar el símbolo cuesta un resize a 1280 px y un
	 * pasada de jsQR, y la mayoría de los frames se resuelven con las marcas. Se llama
	 * cuando las marcas no dan nada Y también cuando dan algo que después no se puede
	 * leer, que es el caso de una hoja cortada por abajo: las marcas producen un
	 * cuadrilátero plausible, la grilla no cierra, y el QR sí sabe dónde está el bloque.
	 */
	const buscarQr = (): void => {
		if (qr.searched || pool == null) {
			return;
		}

		qr.searched = true;
		const inicioQr = performance.now();
		const qrWidth = Math.min(frameWidth, QR_WIDTH);
		qr.scale = qrWidth / frameWidth;
		module.resize(
			pool.gray,
			pool.qr,
			new module.Size(qrWidth, Math.max(1, Math.round(frameHeight * qr.scale))),
			0,
			0,
			module.INTER_AREA
		);

		qr.sighting = findQr(rgbaFromGray(pool.qr), pool.qr.cols, pool.qr.rows);
		etapas.qr = performance.now() - inicioQr;
		const visto = qr.sighting;

		if (visto == null) {
			if (request.anchor === "qr") {
				lastReason = "no se ve el QR de la cabecera";
			}

			return;
		}

		result.qrQuad = {
			topLeft: { x: visto.quad.topLeft.x / qr.scale, y: visto.quad.topLeft.y / qr.scale },
			topRight: { x: visto.quad.topRight.x / qr.scale, y: visto.quad.topRight.y / qr.scale },
			bottomRight: { x: visto.quad.bottomRight.x / qr.scale, y: visto.quad.bottomRight.y / qr.scale },
			bottomLeft: { x: visto.quad.bottomLeft.x / qr.scale, y: visto.quad.bottomLeft.y / qr.scale },
		};

		const estimado = answersQuadFromQr(visto.quad, qrTemplates[format.id]);
		if (estimado == null) {
			return;
		}

		const enFrame: Quad = {
			topLeft: { x: estimado.topLeft.x / qr.scale, y: estimado.topLeft.y / qr.scale },
			topRight: { x: estimado.topRight.x / qr.scale, y: estimado.topRight.y / qr.scale },
			bottomRight: { x: estimado.bottomRight.x / qr.scale, y: estimado.bottomRight.y / qr.scale },
			bottomLeft: { x: estimado.bottomLeft.x / qr.scale, y: estimado.bottomLeft.y / qr.scale },
		};

		// La estimación del QR se desvía varios píxeles: cada marca cercana a una
		// esquina la corrige a su valor exacto.
		const ajuste = snapQuadToMarks(
			{
				topLeft: aSmall(enFrame.topLeft),
				topRight: aSmall(enFrame.topRight),
				bottomRight: aSmall(enFrame.bottomRight),
				bottomLeft: aSmall(enFrame.bottomLeft),
			},
			markers.map((box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 })),
			pool.small.cols * 0.06
		);

		qr.snapped = ajuste.snapped;

		// El QR también sirve como pista de dónde buscar en el frame siguiente: si nada
		// funciona, el hilo principal acota ahí la búsqueda y las marcas aparecen más
		// grandes en la imagen analizada.
		result.hintRoi = roiFor(quadAFrame(ajuste.quad), { width: frameWidth, height: frameHeight }, 0.12);

		const check = checkQuad(ajuste.quad, pool.small.cols, pool.small.rows, answersBlockAspect, looseTolerance);
		if (check.valid) {
			attempts.push({
				label: `qr (${qr.snapped}/4 afinadas)`,
				quad: quadAFrame(ajuste.quad),
				aspect: check.aspect,
				// Con ancla QR su vía se lee primero; en las demás compite por lo que se vio.
				confidence: (qrPrimero ? 4 : 1) + qr.snapped * 0.4,
			});
		} else {
			lastReason = check.reason;
		}
	};

	const usaQr = qrPrimero || request.anchor === "auto" || request.debug;

	if (usaQr && (qrPrimero || attempts.length === 0 || request.debug)) {
		buscarQr();
	}

	// Última vía: umbrales alternativos. Una hoja con poco contraste o con brillo
	// puede no dar marcas con el umbral por omisión, y probar otros dos sale más
	// barato que hacer esperar al usuario un segundo más.
	if (attempts.length === 0 && usaMarcas && request.anchor !== "marcas-estricto") {
		for (const thresholdC of ALTERNATE_THRESHOLD_C) {
			const marcas = intentarMarcas(thresholdC, `marcas C${thresholdC}`);
			if (attempts.length > 0) {
				result.marks = marcas.map((box) => aFrame({ x: box.x + box.w / 2, y: box.y + box.h / 2 }));
				break;
			}
		}
	}

	attempts.sort((a, b) => b.confidence - a.confidence);
	result.timing.locate = performance.now() - startedAt;
	result.attempts = attempts.length;

	if (attempts.length === 0) {
		result.reason = lastReason;

		if (request.debug) {
			const filas = markRows(markers, rowTolerance, tolerance.completeCorners ? 1 : 2)
				.map((row) => `y=${row.center.toFixed(0)} n=${row.count} w=${row.width.toFixed(0)}`)
				.join(" | ");
			result.reason += ` · marcas ${markers.length} · filas ${filas}${qr.sighting == null ? "" : " · qr visto"}`;
			const mask = renderMaskImage(pool.smallBin, markers);
			result.timing.total = performance.now() - startedAt;
			post({ type: "result", frameId: request.frameId, result, debugImage: mask }, mask == null ? [] : [mask]);
			return;
		}

		result.timing.total = performance.now() - startedAt;
		post({ type: "result", frameId: request.frameId, result, debugImage: null });
		return;
	}

	// Sondeo de encuadre: con la hoja ubicada ya está todo lo que necesita la
	// asistencia. Rectificar y leer sería gastar batería en un frame que nadie va a
	// usar.
	result.quad = attempts[0].quad;
	result.source = attempts[0].label;

	if (!request.read) {
		result.timing.total = performance.now() - startedAt;
		post({ type: "result", frameId: request.frameId, result, debugImage: null });
		return;
	}

	const readStartedAt = performance.now();
	let outcome: ReadOutcome | null = null;

	for (let i = 0; i < attempts.length; i++) {
		const attempt = attempts[i];
		const intento = tryRead(module, format, attempt);
		if (intento.ok) {
			result.quad = attempt.quad;
			result.source = attempt.label;
			outcome = intento;
			break;
		}

		if (outcome == null || !outcome.ok) {
			outcome = intento;
			result.quad = attempt.quad;
			result.source = attempt.label;
		}

		// Se agotaron las vías conocidas: el QR puede aportar una más. Pasa con una
		// hoja cortada por abajo, donde las marcas dan un cuadrilátero que parece
		// bueno y la grilla no cierra.
		if (i === attempts.length - 1 && usaQr && !qr.searched) {
			buscarQr();
		}
	}

	result.attempts = attempts.length;

	result.timing.read = performance.now() - readStartedAt;
	let debugImage: ImageBitmap | null = null;

	if (outcome == null || !outcome.ok) {
		result.reason = request.debug
			? `${outcome?.reason ?? "no se pudo leer"} · vías ${attempts.map((a) => a.label).join(", ")} · ${outcome?.gridDebug ?? ""}`
			: (outcome?.reason ?? "no se pudo leer la hoja");

		result.timing.total = performance.now() - startedAt;
		if (request.debug && outcome != null && outcome.pageWidth > 0) {
			debugImage = renderDebugImage(pool.page, null, 0);
		}

		post({ type: "result", frameId: request.frameId, result, debugImage }, debugImage == null ? [] : [debugImage]);
		return;
	}

	result.ok = true;
	result.answers = outcome.answers;
	result.fills = outcome.fills;

	if (request.debug) {
		const grid = outcome.grid;
		let plantilla = request.anchor === "qr" ? ` · esquinas afinadas ${qr.snapped}/4` : "";

		// Con el QR y las marcas en el mismo frame se puede medir la plantilla del QR:
		// son las coordenadas de las esquinas del bloque en el marco del símbolo.
		const visto = qr.sighting;
		if (visto != null && result.quad != null && result.source.startsWith("marcas")) {
			const aQr = (punto: Point): Point => ({ x: punto.x * qr.scale, y: punto.y * qr.scale });
			const esquinas = [result.quad.topLeft, result.quad.topRight, result.quad.bottomRight, result.quad.bottomLeft]
				.map((punto) => pointInQrFrame(visto.quad, aQr(punto)))
				.map((punto) => `(${punto.x.toFixed(2)},${punto.y.toFixed(2)})`)
				.join(" ");
			// El contenido del QR identifica la prueba y el alumno: no se escribe nunca.
			plantilla = ` · plantillaQR ${esquinas} · qr ${visto.text.length} chars`;
		}

		result.reason =
			`vía ${result.source} · etapas gris ${etapas.gris.toFixed(0)} máscaras ${etapas.mascara.toFixed(0)} qr ${etapas.qr.toFixed(0)} mov ${etapas.movimiento.toFixed(0)} · ${outcome.gridDebug}${plantilla} · warp ${warpConvention?.label ?? "?"} · ` +
			`hoja ${outcome.pageWidth}x${outcome.pageHeight} · r=${grid?.radius.toFixed(1) ?? "?"} · ` +
			`frame ${frameWidth}x${frameHeight}`;

		debugImage = renderDebugImage(pool.page, grid, (grid?.radius ?? 0) * SAMPLE_RADIUS_FACTOR);
	}

	result.timing.total = performance.now() - startedAt;
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
