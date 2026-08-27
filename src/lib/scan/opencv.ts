/**
 * Tipos mínimos del build custom de OpenCV.js que usa esta app.
 *
 * El build está recortado a `core.countNonZero` + `imgproc` (ver
 * `opencv_js.config.py` del repo original), así que aquí sólo se declara lo que
 * existe de verdad: pedir `contourArea`, `minAreaRect`, `moments` o
 * `morphologyEx` falla en runtime, no en compilación, y por eso conviene que el
 * tipo sea la lista blanca.
 */

export type CvRect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type CvSize = {
	width: number;
	height: number;
};

export type CvPoint = {
	x: number;
	y: number;
};

export type CvMat = {
	rows: number;
	cols: number;
	data: Uint8Array;
	data32S: Int32Array;
	data32F: Float32Array;
	data64F: Float64Array;
	delete(): void;
	clone(): CvMat;
	roi(rect: CvRect): CvMat;
	isDeleted(): boolean;
};

export type CvMatVector = {
	size(): number;
	get(index: number): CvMat;
	delete(): void;
};

export type CvScalar = number[];

export type CvModule = {
	Mat: {
		new (): CvMat;
		new (rows: number, cols: number, type: number): CvMat;
	};
	MatVector: {
		new (): CvMatVector;
	};
	Rect: {
		new (x: number, y: number, width: number, height: number): CvRect;
	};
	Size: {
		new (width: number, height: number): CvSize;
	};
	Point: {
		new (x: number, y: number): CvPoint;
	};
	Scalar: {
		new (v0?: number, v1?: number, v2?: number, v3?: number): CvScalar;
	};

	matFromImageData(imageData: ImageData): CvMat;
	matFromArray(rows: number, cols: number, type: number, array: number[]): CvMat;

	cvtColor(src: CvMat, dst: CvMat, code: number, channels?: number): void;
	resize(src: CvMat, dst: CvMat, size: CvSize, fx?: number, fy?: number, interpolation?: number): void;
	threshold(src: CvMat, dst: CvMat, thresh: number, maxval: number, type: number): number;
	adaptiveThreshold(
		src: CvMat,
		dst: CvMat,
		maxValue: number,
		adaptiveMethod: number,
		thresholdType: number,
		blockSize: number,
		c: number
	): void;
	GaussianBlur(src: CvMat, dst: CvMat, size: CvSize, sigmaX: number, sigmaY?: number, borderType?: number): void;
	findContours(image: CvMat, contours: CvMatVector, hierarchy: CvMat, mode: number, method: number): void;
	getPerspectiveTransform(src: CvMat, dst: CvMat): CvMat;
	warpPerspective(
		src: CvMat,
		dst: CvMat,
		m: CvMat,
		size: CvSize,
		flags?: number,
		borderMode?: number,
		borderValue?: CvScalar
	): void;
	countNonZero(src: CvMat): number;

	CV_8UC1: number;
	CV_8UC4: number;
	CV_32FC2: number;
	CV_64F: number;
	COLOR_RGBA2GRAY: number;
	THRESH_BINARY: number;
	THRESH_BINARY_INV: number;
	THRESH_OTSU: number;
	ADAPTIVE_THRESH_MEAN_C: number;
	ADAPTIVE_THRESH_GAUSSIAN_C: number;
	RETR_LIST: number;
	RETR_EXTERNAL: number;
	CHAIN_APPROX_SIMPLE: number;
	INTER_AREA: number;
	INTER_NEAREST: number;
	INTER_LINEAR: number;
	BORDER_CONSTANT: number;
};

/**
 * Valores de los enums de OpenCV que la app necesita. Van duplicados a propósito:
 * si el build recortado no registró alguna constante, el pipeline sigue
 * funcionando en vez de multiplicar por `undefined` y devolver hojas en blanco.
 */
const enumFallbacks: Record<string, number> = {
	CV_8UC1: 0,
	CV_8UC4: 24,
	CV_32FC2: 13,
	CV_64F: 6,
	COLOR_RGBA2GRAY: 11,
	THRESH_BINARY: 0,
	THRESH_BINARY_INV: 1,
	THRESH_OTSU: 8,
	ADAPTIVE_THRESH_MEAN_C: 0,
	ADAPTIVE_THRESH_GAUSSIAN_C: 1,
	RETR_LIST: 1,
	RETR_EXTERNAL: 0,
	CHAIN_APPROX_SIMPLE: 2,
	INTER_AREA: 3,
	INTER_NEAREST: 0,
	INTER_LINEAR: 1,
	BORDER_CONSTANT: 0,
};

type OpenCvGlobal = {
	cv?: unknown;
	window?: unknown;
	importScripts?: (url: string) => void;
};

/**
 * Carga el build custom dentro de un worker clásico.
 *
 * Dos detalles del bundle que no se pueden evitar:
 * 1. Los helpers (`matFromImageData`, `matFromArray`) están escritos contra
 *    `window.cv`, que en un worker no existe: hay que apuntar `window` a `self`
 *    y dejar ahí el módulo ya resuelto.
 * 2. `self.cv` queda como Promise (el bundle está modularizado), así que hay que
 *    esperarla antes de tocar cualquier función.
 */
export async function loadOpenCv(url: string): Promise<CvModule> {
	const scope = self as unknown as OpenCvGlobal;
	if (scope.window == null) {
		scope.window = scope;
	}

	if (scope.importScripts == null) {
		throw new Error("loadOpenCv requiere un worker clásico (importScripts)");
	}

	scope.importScripts(url);

	const pending = scope.cv;
	if (pending == null) {
		throw new Error("el build de OpenCV no expuso el módulo");
	}

	// El bundle devuelve una Promise del módulo; el cast es la única forma de
	// tiparlo sin arrastrar los tipos completos de Emscripten.
	const module = (await (pending as Promise<CvModule>)) as CvModule;
	scope.cv = module;

	const record = module as unknown as Record<string, number | undefined>;
	for (const [name, value] of Object.entries(enumFallbacks)) {
		if (typeof record[name] !== "number") {
			record[name] = value;
		}
	}

	if (typeof module.matFromImageData !== "function") {
		throw new Error("el build de OpenCV no trae matFromImageData");
	}

	return module;
}
