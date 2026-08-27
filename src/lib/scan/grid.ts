import { bubblesPerRow, questionNumber, type SheetFormat } from "./format";
import { boxCenter, cluster1d, mean, median, type Box, type Cluster } from "./geometry";

export type BubbleFilter = {
	/** Ancho de la hoja rectificada, en píxeles. */
	pageWidth: number;
	/** Alto de la hoja rectificada, en píxeles. */
	pageHeight: number;
};

/**
 * Se queda con los contornos que pueden ser burbujas de alternativa: cuadrados y
 * de un tamaño coherente con el ancho del bloque.
 *
 * No hace falta descartar la cabecera por altura: lo rectificado es el bloque de
 * respuestas, que empieza bajo la fila superior de marcas.
 */
export function filterBubbleCandidates(boxes: Box[], format: SheetFormat, page: BubbleFilter): Box[] {
	const minSide = page.pageWidth * 0.012;
	const maxSide = page.pageWidth * 0.05;
	const rough: Box[] = [];

	for (const box of boxes) {
		if (box.w < minSide || box.w > maxSide || box.h < minSide || box.h > maxSide) {
			continue;
		}

		const aspect = box.w / box.h;
		if (aspect < 0.6 || aspect > 1.6) {
			continue;
		}

		rough.push(box);
	}

	if (rough.length === 0) {
		return rough;
	}

	// Segundo filtro, ahora contra la mediana observada: las burbujas de una hoja
	// son todas del mismo tamaño, así que lo que se sale de esa medida es texto o
	// ruido del papel.
	const medianWidth = median(rough.map((box) => box.w));
	const medianHeight = median(rough.map((box) => box.h));

	return rough.filter(
		(box) =>
			box.w >= medianWidth * 0.65 &&
			box.w <= medianWidth * 1.45 &&
			box.h >= medianHeight * 0.65 &&
			box.h <= medianHeight * 1.45
	);
}

/**
 * Paso de una serie regular con huecos: la moda de los saltos.
 *
 * Ni la mediana ni el mínimo sirven. La mediana se va al doble si faltan filas
 * (con centros 100, 140 y 220 da 60 cuando el paso real es 40); el mínimo se va a
 * cero con un grupo espurio pegado a otro. La moda aguanta las dos cosas: los
 * saltos "normales" son mayoría, los dobles y los espurios son excepciones.
 */
export function estimateSpacing(centers: number[]): number {
	if (centers.length < 2) {
		return 0;
	}

	const sorted = [...centers].sort((a, b) => a - b);
	const gaps: number[] = [];
	for (let i = 1; i < sorted.length; i++) {
		const gap = sorted[i] - sorted[i - 1];
		if (gap > 0) {
			gaps.push(gap);
		}
	}

	if (gaps.length === 0) {
		return 0;
	}

	let best = gaps[0];
	let bestCount = 0;

	for (const candidate of gaps) {
		const similar = gaps.filter((gap) => Math.abs(gap - candidate) <= candidate * 0.2);
		// Empate: gana el salto más chico, que es el paso de la serie y no su doble.
		if (similar.length > bestCount || (similar.length === bestCount && candidate < best)) {
			best = mean(similar);
			bestCount = similar.length;
		}
	}

	return best;
}

export type AxisFit = {
	positions: number[];
	ok: boolean;
};

/**
 * Ajusta una serie regular de `expected` posiciones a los grupos detectados.
 * Tolera filas o columnas no detectadas (se interpolan) y grupos de sobra (se
 * elige la ventana con más burbujas), que es justo lo que falla cuando la hoja
 * viene impresa con un offset y el scanner confía en factores fijos.
 */
export function fitAxis(clusters: Cluster[], expected: number): AxisFit {
	const failed: AxisFit = {
		positions: [],
		ok: false,
	};

	if (expected <= 0 || clusters.length === 0) {
		return failed;
	}

	const sorted = [...clusters].sort((a, b) => a.center - b.center);
	if (sorted.length === 1) {
		return expected === 1 ? { positions: [sorted[0].center], ok: true } : failed;
	}

	const spacing = estimateSpacing(sorted.map((cluster) => cluster.center));
	if (spacing <= 0) {
		return failed;
	}

	const first = sorted[0].center;
	const indexed = sorted.map((cluster) => ({
		index: Math.round((cluster.center - first) / spacing),
		center: cluster.center,
		weight: cluster.values.length,
	}));

	// Ventana de `expected` índices consecutivos con más burbujas dentro.
	let bestStart = 0;
	let bestWeight = -1;
	const lastIndex = indexed[indexed.length - 1].index;
	for (let start = 0; start + expected - 1 <= Math.max(lastIndex, expected - 1); start++) {
		let weight = 0;
		for (const item of indexed) {
			if (item.index >= start && item.index <= start + expected - 1) {
				weight += item.weight;
			}
		}

		if (weight > bestWeight) {
			bestWeight = weight;
			bestStart = start;
		}
	}

	const inWindow = indexed.filter((item) => item.index >= bestStart && item.index <= bestStart + expected - 1);
	if (inWindow.length < 2) {
		return failed;
	}

	// Regresión lineal de la posición contra el índice: promedia el error de todos
	// los grupos en vez de arrastrar el de la primera fila.
	let sumIndex = 0;
	let sumCenter = 0;
	let sumIndexCenter = 0;
	let sumIndexSquared = 0;
	let totalWeight = 0;
	for (const item of inWindow) {
		const index = item.index - bestStart;
		const weight = item.weight;
		sumIndex += index * weight;
		sumCenter += item.center * weight;
		sumIndexCenter += index * item.center * weight;
		sumIndexSquared += index * index * weight;
		totalWeight += weight;
	}

	const denominator = totalWeight * sumIndexSquared - sumIndex * sumIndex;
	if (denominator === 0) {
		return failed;
	}

	const slope = (totalWeight * sumIndexCenter - sumIndex * sumCenter) / denominator;
	const intercept = (sumCenter - slope * sumIndex) / totalWeight;
	if (slope <= 0) {
		return failed;
	}

	const positions: number[] = [];
	for (let i = 0; i < expected; i++) {
		positions.push(intercept + slope * i);
	}

	return {
		positions,
		ok: true,
	};
}

export type GridModel = {
	/** Centro vertical de cada fila de preguntas. */
	rowCenters: number[];
	/** Centro horizontal de cada alternativa, por bloque de preguntas. */
	blockColumns: number[][];
	/** Radio de muestreo de una burbuja, en píxeles de la hoja rectificada. */
	radius: number;
};

export type GridResult = {
	grid: GridModel | null;
	reason: string;
	/** Resumen de las filas detectadas, para la vista de depuración. */
	debug: string;
	/** Burbujas que sobrevivieron los filtros, para depuración. */
	candidates: Box[];
};

/** Reconstruye la grilla de respuestas a partir de las burbujas detectadas. */
export function buildGrid(boxes: Box[], format: SheetFormat, page: BubbleFilter): GridResult {
	const candidates = filterBubbleCandidates(boxes, format, page);
	const expectedPerRow = bubblesPerRow(format);
	const result: GridResult = {
		grid: null,
		reason: "",
		debug: "",
		candidates,
	};

	if (candidates.length < expectedPerRow) {
		result.reason = "pocas burbujas visibles";
		return result;
	}

	const centers = candidates.map(boxCenter);
	const medianHeight = median(candidates.map((box) => box.h));
	const medianWidth = median(candidates.map((box) => box.w));

	// Una fila de preguntas trae 12 o 20 burbujas. Con un mínimo laxo entran también
	// las filas de marcas negras que rodean cada bloque (6 en la hoja de 45: dos por
	// bloque), y como quedan arriba y abajo del bloque estiran el paso vertical un
	// 7%: las respuestas salen corridas una fila desde la tercera pregunta.
	const rowClusters = cluster1d(
		centers.map((point) => point.y),
		medianHeight * 0.6
	).filter((cluster) => cluster.values.length >= Math.ceil(expectedPerRow * 0.75));

	if (rowClusters.length === 0) {
		result.reason = "no se distinguen filas";
		return result;
	}

	// Si están todas las filas, sus centros ya son el modelo: ajustar de más sólo
	// mete error donde no había.
	const rowFit =
		rowClusters.length === format.rows
			? {
					ok: true,
					positions: [...rowClusters].sort((a, b) => a.center - b.center).map((cluster) => cluster.center),
				}
			: fitAxis(rowClusters, format.rows);

	if (!rowFit.ok) {
		result.reason = "no cuadran las filas";
		return result;
	}

	// El ajuste siempre devuelve `format.rows` posiciones, incluso si el paso quedó
	// mal estimado. Se exige que la mayoría caiga sobre filas que se detectaron de
	// verdad; si no, es mejor descartar el frame que entregar respuestas corridas.
	const matched = rowFit.positions.filter((position) =>
		rowClusters.some((cluster) => Math.abs(cluster.center - position) <= medianHeight * 0.6)
	).length;

	if (matched < Math.ceil(format.rows * 0.7)) {
		result.reason = "las filas no calzan con la hoja";
		return result;
	}

	// Sólo las burbujas que caen en las filas elegidas aportan a las columnas: así
	// el ejemplo de la cabecera no desplaza el modelo horizontal.
	const rowTolerance = medianHeight * 0.8;
	const columnCenters: number[] = [];
	for (let i = 0; i < centers.length; i++) {
		const y = centers[i].y;
		const inSomeRow = rowFit.positions.some((position) => Math.abs(position - y) <= rowTolerance);
		if (inSomeRow) {
			columnCenters.push(centers[i].x);
		}
	}

	const blockColumns = fitBlockColumns(columnCenters, format, medianWidth);
	if (blockColumns == null) {
		result.reason = "no cuadran las columnas";
		return result;
	}

	result.debug = `filas detectadas ${rowClusters.length} [${rowClusters
		.map((cluster) => `${cluster.center.toFixed(0)}x${cluster.values.length}`)
		.join(" ")}]`;

	result.grid = {
		rowCenters: rowFit.positions,
		blockColumns,
		radius: Math.min(medianWidth, medianHeight) / 2,
	};

	return result;
}

/**
 * Separa las columnas en bloques y ajusta las alternativas dentro de cada uno.
 *
 * El corte NO se decide con un umbral de "salto grande": en la hoja de 80 el
 * espacio entre bloques es apenas mayor que el que hay entre alternativas, y
 * cualquier umbral falla en uno de los dos formatos. Se usa lo que sí se sabe: el
 * formato dice cuántos bloques hay, así que los cortes son los `bloques - 1`
 * saltos más grandes.
 */
export function fitBlockColumns(columnCenters: number[], format: SheetFormat, medianWidth: number): number[][] | null {
	const clusters = cluster1d(columnCenters, medianWidth * 0.5).filter((cluster) => cluster.values.length >= 2);
	const expected = format.blocks * format.alternatives;
	if (clusters.length < format.alternatives) {
		return null;
	}

	const sorted = [...clusters].sort((a, b) => a.center - b.center);

	// Caso normal de una hoja legible: están las 12 o 20 columnas, en orden.
	if (sorted.length === expected) {
		const blockColumns: number[][] = [];
		for (let block = 0; block < format.blocks; block++) {
			const start = block * format.alternatives;
			blockColumns.push(sorted.slice(start, start + format.alternatives).map((cluster) => cluster.center));
		}

		return blockColumns;
	}

	const gaps = sorted.slice(1).map((cluster, index) => ({
		index: index + 1,
		gap: cluster.center - sorted[index].center,
	}));

	const cortes = gaps
		.sort((a, b) => b.gap - a.gap)
		.slice(0, format.blocks - 1)
		.map((item) => item.index)
		.sort((a, b) => a - b);

	const groups: Cluster[][] = [];
	let start = 0;
	for (const corte of [...cortes, sorted.length]) {
		groups.push(sorted.slice(start, corte));
		start = corte;
	}

	if (groups.length !== format.blocks) {
		return null;
	}

	const blockColumns: number[][] = [];
	for (const group of groups) {
		const fit = fitAxis(group, format.alternatives);
		if (!fit.ok) {
			return null;
		}

		blockColumns.push(fit.positions);
	}

	return blockColumns;
}

export type GridCell = {
	question: number;
	letter: string;
	x: number;
	y: number;
};

/** Aplana la grilla a la lista de burbujas a muestrear. */
export function gridCells(grid: GridModel, format: SheetFormat): GridCell[] {
	const cells: GridCell[] = [];
	for (let block = 0; block < grid.blockColumns.length; block++) {
		const columns = grid.blockColumns[block];
		for (let row = 0; row < grid.rowCenters.length; row++) {
			for (let alternative = 0; alternative < columns.length; alternative++) {
				cells.push({
					question: questionNumber(format, block, row),
					letter: format.letters[alternative] ?? "",
					x: columns[alternative],
					y: grid.rowCenters[row],
				});
			}
		}
	}

	return cells;
}
