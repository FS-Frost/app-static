export type Point = {
	x: number;
	y: number;
};

export type Box = {
	x: number;
	y: number;
	w: number;
	h: number;
};

export type Quad = {
	topLeft: Point;
	topRight: Point;
	bottomRight: Point;
	bottomLeft: Point;
};

export function boxCenter(box: Box): Point {
	return {
		x: box.x + box.w / 2,
		y: box.y + box.h / 2,
	};
}

export function distance(a: Point, b: Point): number {
	return Math.hypot(b.x - a.x, b.y - a.y);
}

export function median(values: number[]): number {
	if (values.length === 0) {
		return 0;
	}

	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) {
		return sorted[middle];
	}

	return (sorted[middle - 1] + sorted[middle]) / 2;
}

export function mean(values: number[]): number {
	if (values.length === 0) {
		return 0;
	}

	let total = 0;
	for (const value of values) {
		total += value;
	}

	return total / values.length;
}

/**
 * Ordena cuatro puntos como esquinas de un cuadrilátero. Usa suma y diferencia
 * de coordenadas en vez del ángulo respecto al centroide: es exacto mientras la
 * hoja no esté rotada más de ~45°, y a esa altura la foto no sirve igual.
 */
export function orderQuad(points: Point[]): Quad | null {
	if (points.length !== 4) {
		return null;
	}

	const bySum = [...points].sort((a, b) => a.x + a.y - (b.x + b.y));
	const byDiff = [...points].sort((a, b) => a.x - a.y - (b.x - b.y));
	const quad: Quad = {
		topLeft: bySum[0],
		bottomRight: bySum[3],
		bottomLeft: byDiff[0],
		topRight: byDiff[3],
	};

	const corners = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
	for (let i = 0; i < corners.length; i++) {
		for (let j = i + 1; j < corners.length; j++) {
			if (corners[i] === corners[j]) {
				return null;
			}
		}
	}

	return quad;
}

/**
 * Elige, entre los candidatos a marca de esquina, los cuatro que están más lejos
 * en cada diagonal. Si dos esquinas terminan siendo el mismo candidato, no hay
 * cuadrilátero y se descarta el frame.
 */
export function pickCornerMarkers(boxes: Box[]): Quad | null {
	if (boxes.length < 4) {
		return null;
	}

	const centers = boxes.map(boxCenter);
	let topLeft = 0;
	let topRight = 0;
	let bottomRight = 0;
	let bottomLeft = 0;

	for (let i = 1; i < centers.length; i++) {
		const point = centers[i];
		if (point.x + point.y < centers[topLeft].x + centers[topLeft].y) {
			topLeft = i;
		}

		if (point.x + point.y > centers[bottomRight].x + centers[bottomRight].y) {
			bottomRight = i;
		}

		if (point.x - point.y > centers[topRight].x - centers[topRight].y) {
			topRight = i;
		}

		if (point.x - point.y < centers[bottomLeft].x - centers[bottomLeft].y) {
			bottomLeft = i;
		}
	}

	const indexes = [topLeft, topRight, bottomRight, bottomLeft];
	const unique = new Set(indexes);
	if (unique.size !== 4) {
		return null;
	}

	return {
		topLeft: centers[topLeft],
		topRight: centers[topRight],
		bottomRight: centers[bottomRight],
		bottomLeft: centers[bottomLeft],
	};
}

export type MarkRow = {
	center: number;
	left: Point;
	right: Point;
	width: number;
	count: number;
};

/** Agrupa las marcas por altura y devuelve las filas con al menos dos marcas. */
export function markRows(marks: Box[], rowTolerance: number): MarkRow[] {
	const centers = marks.map(boxCenter);

	return cluster1d(
		centers.map((point) => point.y),
		rowTolerance
	)
		.filter((cluster) => cluster.indexes.length >= 2)
		.map((cluster) => {
			const points = cluster.indexes.map((index) => centers[index]);
			const left = points.reduce((best, point) => (point.x < best.x ? point : best), points[0]);
			const right = points.reduce((best, point) => (point.x > best.x ? point : best), points[0]);
			return {
				center: cluster.center,
				left,
				right,
				width: right.x - left.x,
				count: points.length,
			};
		})
		.sort((a, b) => a.center - b.center);
};

export type QuadCheck = {
	valid: boolean;
	reason: string;
	/** Alto / ancho observado del cuadrilátero. */
	aspect: number;
	/** Fracción del área del frame que ocupa el cuadrilátero. */
	coverage: number;
};

export type AspectRange = {
	min: number;
	max: number;
};

/**
 * Proporción esperada (alto / ancho) del bloque de respuestas encerrado por las
 * marcas: 0,70 en la hoja de 45 y 0,75 en la de 80, con holgura para la
 * perspectiva de una foto a mano.
 */
export const answersBlockAspect: AspectRange = {
	min: 0.5,
	max: 1.1,
};

/**
 * Valida que el cuadrilátero pueda ser el bloque de respuestas visto de frente:
 * lados opuestos de largo parecido (poca perspectiva), tamaño suficiente en el
 * frame y proporción dentro de lo esperado.
 */
export function checkQuad(
	quad: Quad,
	frameWidth: number,
	frameHeight: number,
	aspectRange: AspectRange = answersBlockAspect
): QuadCheck {
	const top = distance(quad.topLeft, quad.topRight);
	const bottom = distance(quad.bottomLeft, quad.bottomRight);
	const left = distance(quad.topLeft, quad.bottomLeft);
	const right = distance(quad.topRight, quad.bottomRight);
	const horizontal = (top + bottom) / 2;
	const vertical = (left + right) / 2;
	const aspect = horizontal === 0 ? 0 : vertical / horizontal;
	const area = horizontal * vertical;
	const coverage = frameWidth * frameHeight === 0 ? 0 : area / (frameWidth * frameHeight);
	const result: QuadCheck = {
		valid: false,
		reason: "",
		aspect,
		coverage,
	};

	if (horizontal < frameWidth * 0.2 || vertical < frameHeight * 0.15) {
		result.reason = "hoja muy chica en el cuadro";
		return result;
	}

	if (coverage < 0.08) {
		result.reason = "acerca la cámara";
		return result;
	}

	const horizontalSkew = Math.abs(top - bottom) / Math.max(top, bottom);
	const verticalSkew = Math.abs(left - right) / Math.max(left, right);
	if (horizontalSkew > 0.25 || verticalSkew > 0.25) {
		result.reason = "mira la hoja de frente";
		return result;
	}

	if (aspect < aspectRange.min || aspect > aspectRange.max) {
		result.reason = "proporción de hoja inesperada";
		return result;
	}

	result.valid = true;
	return result;
}

/**
 * Cuadrilátero del bloque de respuestas a partir de las marcas de registro.
 *
 * No sirve tomar los extremos de todas las marcas: la hoja trae también marcas
 * junto a la cabecera, y con una de ellas de menos —o tapada por un pulgar— el
 * "cuadrilátero" sale trapecio y la hoja rectificada queda torcida. Tampoco sirve
 * quedarse con las dos filas más anchas: en la hoja de 45 la fila de la cabecera
 * es un poco más ancha que las del bloque.
 *
 * Lo que sí distingue al bloque es su proporción, que viene impresa: se prueban
 * todos los pares de filas y gana el primero que la cumple, prefiriendo las filas
 * con más marcas.
 */
export function findAnswersQuad(marks: Box[], options: AnswersQuadOptions): Quad | null {
	if (marks.length < 4) {
		return null;
	}

	const rows = markRows(marks, options.rowTolerance);
	if (rows.length < 2) {
		return null;
	}

	type Candidate = {
		quad: Quad;
		score: number;
	};

	const candidates: Candidate[] = [];

	for (let top = 0; top < rows.length; top++) {
		for (let bottom = top + 1; bottom < rows.length; bottom++) {
			const upper = rows[top];
			const lower = rows[bottom];
			if (upper.width <= 0 || lower.width <= 0) {
				continue;
			}

			// Las dos filas encierran el mismo bloque, así que miden lo mismo de ancho.
			const widthRatio = Math.min(upper.width, lower.width) / Math.max(upper.width, lower.width);
			if (widthRatio < 0.85) {
				continue;
			}

			const quad: Quad = {
				topLeft: upper.left,
				topRight: upper.right,
				bottomRight: lower.right,
				bottomLeft: lower.left,
			};

			if (!checkQuad(quad, options.frameWidth, options.frameHeight, options.aspectRange).valid) {
				continue;
			}

			candidates.push({
				quad,
				score: upper.count + lower.count,
			});
		}
	}

	if (candidates.length === 0) {
		return null;
	}

	candidates.sort((a, b) => b.score - a.score);
	return candidates[0].quad;
}

export type AnswersQuadOptions = {
	/** Distancia máxima en y para que dos marcas cuenten como la misma fila. */
	rowTolerance: number;
	frameWidth: number;
	frameHeight: number;
	aspectRange?: AspectRange;
};

export type Cluster = {
	center: number;
	values: number[];
	indexes: number[];
};

/**
 * Agrupa valores en una dimensión: dos valores caen en el mismo grupo si están a
 * menos de `tolerance`. Es el reemplazo de los factores hardcodeados del scanner
 * original: las filas y columnas salen de la propia hoja detectada.
 */
export function cluster1d(values: number[], tolerance: number): Cluster[] {
	const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
	const clusters: Cluster[] = [];

	for (const item of order) {
		const last = clusters[clusters.length - 1];
		if (last != null && item.value - last.values[last.values.length - 1] <= tolerance) {
			last.values.push(item.value);
			last.indexes.push(item.index);
			last.center = mean(last.values);
			continue;
		}

		clusters.push({
			center: item.value,
			values: [item.value],
			indexes: [item.index],
		});
	}

	return clusters;
}

/** Espaciado típico entre centros consecutivos de una lista ordenada. */
export function medianSpacing(centers: number[]): number {
	if (centers.length < 2) {
		return 0;
	}

	const sorted = [...centers].sort((a, b) => a - b);
	const gaps: number[] = [];
	for (let i = 1; i < sorted.length; i++) {
		gaps.push(sorted[i] - sorted[i - 1]);
	}

	return median(gaps);
}
