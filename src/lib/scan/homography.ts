import type { Quad } from "./geometry";

/**
 * Homografía que lleva el rectángulo de destino al cuadrilátero de origen, o sea
 * el mapa INVERSO, que es el que consume `warpPerspective` de este build.
 *
 * OpenCV estándar invierte la matriz por dentro, pero este build no: pasarle el
 * mapa directo deja la hoja encogida y torcida dentro del recorte, con el fondo
 * asomando en las esquinas. Devolver el inverso directamente también ahorra la
 * inversión, que es justo lo que el build parece querer.
 */
export function homographyRectToQuad(quad: Quad, width: number, height: number): number[] | null {
	return homographyFor(
		[
			[0, 0],
			[width - 1, 0],
			[width - 1, height - 1],
			[0, height - 1],
		],
		[
			[quad.topLeft.x, quad.topLeft.y],
			[quad.topRight.x, quad.topRight.y],
			[quad.bottomRight.x, quad.bottomRight.y],
			[quad.bottomLeft.x, quad.bottomLeft.y],
		]
	);
}

/**
 * Homografía que lleva un cuadrilátero a un rectángulo, resuelta en JS.
 *
 * El build custom de OpenCV trae `getPerspectiveTransform`, pero devuelve una
 * matriz que no manda las cuatro esquinas a su destino: con la hoja en
 * (115,70) (1329,16) (1383,1760) (40,1793) hacia un rectángulo de 900x1220, la
 * esquina inferior izquierda cae en y=1356 en vez de 1219, y la "hoja
 * rectificada" queda torcida. Ocho ecuaciones y una eliminación gaussiana son
 * baratas y sí dan la matriz exacta.
 */
export function homographyToRect(quad: Quad, width: number, height: number): number[] | null {
	return homographyFor(
		[
			[quad.topLeft.x, quad.topLeft.y],
			[quad.topRight.x, quad.topRight.y],
			[quad.bottomRight.x, quad.bottomRight.y],
			[quad.bottomLeft.x, quad.bottomLeft.y],
		],
		[
			[0, 0],
			[width - 1, 0],
			[width - 1, height - 1],
			[0, height - 1],
		]
	);
}

/** Homografía de cuatro puntos a cuatro puntos, en orden por filas. */
export function homographyFor(source: [number, number][], target: [number, number][]): number[] | null {
	// Para cada par de puntos, dos filas:
	//   x*h0 + y*h1 + h2 - u*x*h6 - u*y*h7 = u
	//   x*h3 + y*h4 + h5 - v*x*h6 - v*y*h7 = v
	const matrix: number[][] = [];
	for (let i = 0; i < 4; i++) {
		const [x, y] = source[i];
		const [u, v] = target[i];
		matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
		matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
	}

	const solution = solve(matrix);
	if (solution == null) {
		return null;
	}

	return [...solution, 1];
}

/** Eliminación gaussiana con pivoteo parcial sobre una matriz aumentada n x (n+1). */
export function solve(matrix: number[][]): number[] | null {
	const size = matrix.length;
	const rows = matrix.map((row) => [...row]);

	for (let column = 0; column < size; column++) {
		let pivot = column;
		for (let row = column + 1; row < size; row++) {
			if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) {
				pivot = row;
			}
		}

		if (Math.abs(rows[pivot][column]) < 1e-12) {
			return null;
		}

		[rows[column], rows[pivot]] = [rows[pivot], rows[column]];

		const pivotValue = rows[column][column];
		for (let row = 0; row < size; row++) {
			if (row === column) {
				continue;
			}

			const factor = rows[row][column] / pivotValue;
			if (factor === 0) {
				continue;
			}

			for (let k = column; k <= size; k++) {
				rows[row][k] -= factor * rows[column][k];
			}
		}
	}

	const solution: number[] = [];
	for (let i = 0; i < size; i++) {
		solution.push(rows[i][size] / rows[i][i]);
	}

	return solution;
}

/** Aplica una homografía 3x3 (en orden por filas) a un punto. */
export function applyHomography(matrix: number[], x: number, y: number): { x: number; y: number } {
	const w = matrix[6] * x + matrix[7] * y + matrix[8];
	if (w === 0) {
		return { x: 0, y: 0 };
	}

	return {
		x: (matrix[0] * x + matrix[1] * y + matrix[2]) / w,
		y: (matrix[3] * x + matrix[4] * y + matrix[5]) / w,
	};
}
