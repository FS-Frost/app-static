import type { CvModule } from "./opencv";

/**
 * Qué espera `warpPerspective` de este build de OpenCV.
 *
 * No se asume: se mide. El build es una versión recortada y parcheada, y ya se
 * sabe que `findContours` antepone el bounding rect al contorno y que
 * `getPerspectiveTransform` devuelve una matriz que no manda las esquinas a su
 * destino. Con esos antecedentes, dar por buena la convención de OpenCV estándar
 * (matriz directa, por filas, invertida internamente) es una apuesta; y si la
 * apuesta falla, la hoja sale torcida y las respuestas salen mal sin que nada
 * reporte un error.
 *
 * La prueba: se traslada una imagen conocida un píxel a la derecha y se mira
 * dónde cayó.
 */
export type WarpConvention = {
	/** true si hay que pasar el mapa directo (origen -> destino), como OpenCV estándar. */
	forward: boolean;
	/** true si la matriz se lee por columnas y hay que transponerla. */
	transposed: boolean;
	/** Descripción corta para la vista de depuración. */
	label: string;
};

const PROBE_SIZE = 5;

/** Traslación de un píxel en x, como mapa directo y por filas. */
const translation = [1, 0, 1, 0, 1, 0, 0, 0, 1];

function transpose(matrix: number[]): number[] {
	return [matrix[0], matrix[3], matrix[6], matrix[1], matrix[4], matrix[7], matrix[2], matrix[5], matrix[8]];
}

/**
 * Devuelve la posición x donde quedó el píxel marcado tras el warp, o -1 si se
 * perdió.
 */
function probe(module: CvModule, matrix: number[]): number {
	const pixels: number[] = new Array(PROBE_SIZE * PROBE_SIZE).fill(0);
	const row = 2;
	const column = 2;
	pixels[row * PROBE_SIZE + column] = 255;

	const source = module.matFromArray(PROBE_SIZE, PROBE_SIZE, module.CV_8UC1, pixels);
	const transform = module.matFromArray(3, 3, module.CV_64F, matrix);
	const destination = new module.Mat();

	try {
		module.warpPerspective(
			source,
			destination,
			transform,
			new module.Size(PROBE_SIZE, PROBE_SIZE),
			module.INTER_NEAREST,
			module.BORDER_CONSTANT,
			new module.Scalar(0, 0, 0, 0)
		);

		const data = destination.data;
		for (let x = 0; x < PROBE_SIZE; x++) {
			if (data[row * PROBE_SIZE + x] > 127) {
				return x;
			}
		}

		return -1;
	} finally {
		source.delete();
		transform.delete();
		destination.delete();
	}
}

export function detectWarpConvention(module: CvModule): WarpConvention {
	// Mapa directo por filas: si el build invierte por dentro (OpenCV estándar), el
	// píxel de la columna 2 aparece en la 3.
	if (probe(module, translation) === 3) {
		return {
			forward: true,
			transposed: false,
			label: "directa por filas",
		};
	}

	// Sin inversión interna: el mapa directo mueve el píxel al lado contrario, así
	// que hay que pasarle el inverso.
	if (probe(module, translation) === 1) {
		return {
			forward: false,
			transposed: false,
			label: "inversa por filas",
		};
	}

	const transposed = transpose(translation);
	if (probe(module, transposed) === 3) {
		return {
			forward: true,
			transposed: true,
			label: "directa por columnas",
		};
	}

	if (probe(module, transposed) === 1) {
		return {
			forward: false,
			transposed: true,
			label: "inversa por columnas",
		};
	}

	// Ninguna combinación movió el píxel donde se esperaba: se sigue con la
	// convención estándar y la vista de depuración lo deja anotado.
	return {
		forward: true,
		transposed: false,
		label: "desconocida (se asume estándar)",
	};
}

/** Prepara la matriz que hay que pasarle a `warpPerspective` en este build. */
export function matrixForWarp(convention: WarpConvention, forward: number[], inverse: number[]): number[] {
	const matrix = convention.forward ? forward : inverse;
	return convention.transposed ? transpose(matrix) : matrix;
}
