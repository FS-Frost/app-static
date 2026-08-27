import { describe, expect, it } from "vitest";
import { FORMAT_45, FORMAT_80, type SheetFormat } from "./format";
import type { Box } from "./geometry";
import { buildGrid, fitAxis, gridCells } from "./grid";

const PAGE_WIDTH = 900;
const PAGE_HEIGHT = 1180;
const BUBBLE = 22;

type Layout = {
	format: SheetFormat;
	firstRowY: number;
	rowSpacing: number;
	blockX: number[];
	columnSpacing: number;
};

function layoutFor(format: SheetFormat): Layout {
	const blockWidth = PAGE_WIDTH / format.blocks;
	return {
		format,
		firstRowY: PAGE_HEIGHT * 0.5,
		rowSpacing: (PAGE_HEIGHT * 0.45) / format.rows,
		blockX: Array.from({ length: format.blocks }, (_, block) => blockWidth * block + 60),
		columnSpacing: 30,
	};
}

/** Genera las cajas que devolvería `findContours` sobre una hoja rectificada limpia. */
function syntheticBoxes(layout: Layout, options: { skipRows?: number[]; header?: boolean } = {}): Box[] {
	const boxes: Box[] = [];
	const skip = new Set(options.skipRows ?? []);

	for (let row = 0; row < layout.format.rows; row++) {
		if (skip.has(row)) {
			continue;
		}

		const y = layout.firstRowY + row * layout.rowSpacing;
		for (let block = 0; block < layout.format.blocks; block++) {
			for (let alternative = 0; alternative < layout.format.alternatives; alternative++) {
				const x = layout.blockX[block] + alternative * layout.columnSpacing;
				boxes.push({
					x: x - BUBBLE / 2,
					y: y - BUBBLE / 2,
					w: BUBBLE,
					h: BUBBLE,
				});
			}
		}
	}

	if (options.header === true) {
		// Cabecera: RUT (8 columnas x 10 filas) y el ejemplo de "forma de llenar los
		// círculos", que están sobre la línea de respuestas y no deben entrar.
		for (let row = 0; row < 10; row++) {
			for (let column = 0; column < 8; column++) {
				boxes.push({
					x: 500 + column * 40 - BUBBLE / 2,
					y: 100 + row * 35 - BUBBLE / 2,
					w: BUBBLE,
					h: BUBBLE,
				});
			}
		}

		boxes.push({ x: 80, y: 380, w: BUBBLE, h: BUBBLE });
		boxes.push({ x: 120, y: 380, w: BUBBLE, h: BUBBLE });
		boxes.push({ x: 160, y: 380, w: BUBBLE, h: BUBBLE });
	}

	return boxes;
}

const page = {
	pageWidth: PAGE_WIDTH,
	pageHeight: PAGE_HEIGHT,
};

describe("fitAxis", () => {
	it("interpola las posiciones faltantes", () => {
		const clusters = [
			{ center: 100, values: [100, 100], indexes: [0, 1] },
			{ center: 140, values: [140, 140], indexes: [2, 3] },
			// falta la de 180
			{ center: 220, values: [220, 220], indexes: [4, 5] },
		];

		const fit = fitAxis(clusters, 4);
		expect(fit.ok).toBe(true);
		expect(fit.positions).toHaveLength(4);
		expect(fit.positions[2]).toBeCloseTo(180, 1);
	});

	it("elige la ventana con más burbujas cuando hay grupos de sobra", () => {
		const clusters = [
			{ center: 10, values: [10], indexes: [0] },
			{ center: 100, values: [100, 100, 100], indexes: [1, 2, 3] },
			{ center: 130, values: [130, 130, 130], indexes: [4, 5, 6] },
		];

		const fit = fitAxis(clusters, 2);
		expect(fit.ok).toBe(true);
		expect(fit.positions[0]).toBeCloseTo(100, 1);
		expect(fit.positions[1]).toBeCloseTo(130, 1);
	});
});

describe("buildGrid", () => {
	it("reconstruye la grilla de 45 preguntas", () => {
		const layout = layoutFor(FORMAT_45);
		const result = buildGrid(syntheticBoxes(layout), FORMAT_45, page);

		expect(result.reason).toBe("");
		expect(result.grid?.rowCenters).toHaveLength(15);
		expect(result.grid?.blockColumns).toHaveLength(3);
		expect(result.grid?.blockColumns[0]).toHaveLength(4);
		expect(result.grid?.rowCenters[0]).toBeCloseTo(layout.firstRowY, 0);
		expect(result.grid?.blockColumns[2][3]).toBeCloseTo(layout.blockX[2] + 3 * layout.columnSpacing, 0);
		expect(result.grid?.radius).toBeCloseTo(BUBBLE / 2, 5);
	});

	it("reconstruye la grilla de 80 preguntas", () => {
		const layout = layoutFor(FORMAT_80);
		const result = buildGrid(syntheticBoxes(layout), FORMAT_80, page);

		expect(result.grid?.rowCenters).toHaveLength(20);
		expect(result.grid?.blockColumns).toHaveLength(4);
		expect(result.grid?.blockColumns[0]).toHaveLength(5);
	});

	it("ignora las burbujas de la cabecera", () => {
		const layout = layoutFor(FORMAT_45);
		const conCabecera = buildGrid(syntheticBoxes(layout, { header: true }), FORMAT_45, page);
		const sinCabecera = buildGrid(syntheticBoxes(layout), FORMAT_45, page);

		expect(conCabecera.grid?.rowCenters[0]).toBeCloseTo(sinCabecera.grid?.rowCenters[0] ?? 0, 3);
		expect(conCabecera.grid?.blockColumns[0][0]).toBeCloseTo(sinCabecera.grid?.blockColumns[0][0] ?? 0, 3);
	});

	it("interpola una fila que no se detectó", () => {
		const layout = layoutFor(FORMAT_45);
		const result = buildGrid(syntheticBoxes(layout, { skipRows: [7] }), FORMAT_45, page);

		expect(result.grid?.rowCenters).toHaveLength(15);
		expect(result.grid?.rowCenters[7]).toBeCloseTo(layout.firstRowY + 7 * layout.rowSpacing, 0);
	});

	it("falla con motivo cuando no hay burbujas suficientes", () => {
		const result = buildGrid([{ x: 10, y: 900, w: 20, h: 20 }], FORMAT_45, page);
		expect(result.grid).toBeNull();
		expect(result.reason).toBe("pocas burbujas visibles");
	});
});

describe("gridCells", () => {
	it("numera las preguntas bajando por cada bloque", () => {
		const layout = layoutFor(FORMAT_45);
		const result = buildGrid(syntheticBoxes(layout), FORMAT_45, page);
		expect(result.grid).not.toBeNull();

		const cells = gridCells(result.grid!, FORMAT_45);
		expect(cells).toHaveLength(45 * 4);

		const primera = cells.find((cell) => cell.question === 1 && cell.letter === "A");
		const ultima = cells.find((cell) => cell.question === 45 && cell.letter === "D");
		expect(primera?.y).toBeCloseTo(layout.firstRowY, 0);
		expect(ultima?.x).toBeCloseTo(layout.blockX[2] + 3 * layout.columnSpacing, 0);

		const dieciseis = cells.find((cell) => cell.question === 16 && cell.letter === "A");
		expect(dieciseis?.y).toBeCloseTo(layout.firstRowY, 0);
		expect(dieciseis?.x).toBeCloseTo(layout.blockX[1], 0);
	});
});
