export type FormatId = "45" | "80";

export type SheetFormat = {
	id: FormatId;
	label: string;
	/** Total de preguntas de la hoja. */
	questions: number;
	/** Columnas de preguntas (bloques) impresas en la hoja. */
	blocks: number;
	/** Filas de preguntas dentro de cada bloque. */
	rows: number;
	/** Burbujas por pregunta. */
	alternatives: number;
	/** Letras de las alternativas, en orden de izquierda a derecha. */
	letters: string[];
};

export const FORMAT_45: SheetFormat = {
	id: "45",
	label: "45 preguntas (A-D)",
	questions: 45,
	blocks: 3,
	rows: 15,
	alternatives: 4,
	letters: ["A", "B", "C", "D"],
};

export const FORMAT_80: SheetFormat = {
	id: "80",
	label: "80 preguntas (A-E)",
	questions: 80,
	blocks: 4,
	rows: 20,
	alternatives: 5,
	letters: ["A", "B", "C", "D", "E"],
};

export const FORMATS: SheetFormat[] = [FORMAT_45, FORMAT_80];

export function getFormat(id: FormatId): SheetFormat {
	return id === "80" ? FORMAT_80 : FORMAT_45;
}

export function isFormatId(value: string): value is FormatId {
	return value === "45" || value === "80";
}

/** Burbujas que debe tener una fila de preguntas completa. */
export function bubblesPerRow(format: SheetFormat): number {
	return format.blocks * format.alternatives;
}

/**
 * Número de pregunta a partir de su posición en la hoja. La numeración baja por
 * cada bloque antes de saltar al siguiente (1-15, 16-30, 31-45).
 */
export function questionNumber(format: SheetFormat, blockIndex: number, rowIndex: number): number {
	return blockIndex * format.rows + rowIndex + 1;
}
