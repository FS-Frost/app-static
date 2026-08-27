import { describe, expect, it } from "vitest";
import {
	checkQuad,
	cluster1d,
	findAnswersQuad,
	median,
	medianSpacing,
	orderQuad,
	pickCornerMarkers,
	quadFromRows,
	type Box,
} from "./geometry";

function marker(x: number, y: number): Box {
	return {
		x,
		y,
		w: 30,
		h: 30,
	};
}

describe("orderQuad", () => {
	it("ordena las esquinas aunque lleguen desordenadas", () => {
		const quad = orderQuad([
			{ x: 100, y: 900 },
			{ x: 100, y: 100 },
			{ x: 700, y: 900 },
			{ x: 700, y: 100 },
		]);

		expect(quad).not.toBeNull();
		expect(quad?.topLeft).toEqual({ x: 100, y: 100 });
		expect(quad?.topRight).toEqual({ x: 700, y: 100 });
		expect(quad?.bottomRight).toEqual({ x: 700, y: 900 });
		expect(quad?.bottomLeft).toEqual({ x: 100, y: 900 });
	});

	it("rechaza puntos que no forman cuatro esquinas distintas", () => {
		const quad = orderQuad([
			{ x: 100, y: 100 },
			{ x: 100, y: 100 },
			{ x: 100, y: 100 },
			{ x: 100, y: 100 },
		]);

		expect(quad).toBeNull();
	});
});

describe("pickCornerMarkers", () => {
	it("elige las cuatro marcas extremas e ignora las del interior", () => {
		const quad = pickCornerMarkers([
			marker(40, 40),
			marker(600, 40),
			marker(40, 800),
			marker(600, 800),
			// Marca interior: el logo de la hoja, que también es un cuadrado oscuro.
			marker(300, 400),
		]);

		expect(quad?.topLeft).toEqual({ x: 55, y: 55 });
		expect(quad?.bottomRight).toEqual({ x: 615, y: 815 });
	});

	it("descarta el frame si hay menos de cuatro marcas", () => {
		expect(pickCornerMarkers([marker(10, 10), marker(100, 10)])).toBeNull();
	});
});

describe("checkQuad", () => {
	const frameWidth = 640;
	const frameHeight = 853;

	it("acepta un bloque de respuestas visto de frente", () => {
		const check = checkQuad(
			{
				topLeft: { x: 60, y: 180 },
				topRight: { x: 580, y: 180 },
				bottomRight: { x: 580, y: 560 },
				bottomLeft: { x: 60, y: 560 },
			},
			frameWidth,
			frameHeight
		);

		expect(check.valid).toBe(true);
		expect(check.aspect).toBeCloseTo(380 / 520, 2);
	});

	it("rechaza una proporción que no es la del bloque", () => {
		const check = checkQuad(
			{
				topLeft: { x: 60, y: 40 },
				topRight: { x: 580, y: 40 },
				bottomRight: { x: 580, y: 720 },
				bottomLeft: { x: 60, y: 720 },
			},
			frameWidth,
			frameHeight
		);

		expect(check.valid).toBe(false);
		expect(check.reason).toBe("proporción de hoja inesperada");
	});

	it("rechaza una hoja con mucha perspectiva", () => {
		const check = checkQuad(
			{
				topLeft: { x: 60, y: 180 },
				topRight: { x: 580, y: 180 },
				bottomRight: { x: 460, y: 560 },
				bottomLeft: { x: 180, y: 560 },
			},
			frameWidth,
			frameHeight
		);

		expect(check.valid).toBe(false);
		expect(check.reason).toBe("mira la hoja de frente");
	});

	it("rechaza una hoja demasiado lejos", () => {
		const check = checkQuad(
			{
				topLeft: { x: 300, y: 400 },
				topRight: { x: 380, y: 400 },
				bottomRight: { x: 380, y: 500 },
				bottomLeft: { x: 300, y: 500 },
			},
			frameWidth,
			frameHeight
		);

		expect(check.valid).toBe(false);
		expect(check.reason).toBe("hoja muy chica en el cuadro");
	});
});

describe("cluster1d", () => {
	it("agrupa valores cercanos y separa los lejanos", () => {
		const clusters = cluster1d([10, 11, 12, 50, 51, 90], 3);
		expect(clusters).toHaveLength(3);
		expect(clusters[0].values).toEqual([10, 11, 12]);
		expect(clusters[1].center).toBeCloseTo(50.5, 5);
		expect(clusters[2].indexes).toEqual([5]);
	});

	it("conserva el índice original de cada valor", () => {
		const clusters = cluster1d([90, 10, 91], 3);
		expect(clusters[0].indexes).toEqual([1]);
		expect(clusters[1].indexes).toEqual([0, 2]);
	});
});

describe("median y medianSpacing", () => {
	it("calcula la mediana con listas pares e impares", () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 2, 3])).toBe(2.5);
		expect(median([])).toBe(0);
	});

	it("calcula el espaciado típico ignorando el desorden", () => {
		expect(medianSpacing([100, 40, 70, 10])).toBe(30);
		expect(medianSpacing([5])).toBe(0);
	});
});

describe("findAnswersQuad", () => {
	const opciones = {
		rowTolerance: 40,
		frameWidth: 935,
		frameHeight: 1210,
	};

	function mark(x: number, y: number): Box {
		return {
			x: x - 7,
			y: y - 7,
			w: 14,
			h: 14,
		};
	}

	it("usa las filas de marcas que encierran el bloque, no las de la cabecera", () => {
		const quad = findAnswersQuad(
			[
				// Marcas de la cabecera: dos, más arriba, y más separadas que las del
				// bloque, para que no gane la fila más ancha.
				mark(70, 200),
				mark(860, 200),
				// Fila superior del bloque.
				mark(75, 550),
				mark(260, 550),
				mark(670, 550),
				mark(855, 550),
				// Fila inferior del bloque.
				mark(75, 1100),
				mark(260, 1100),
				mark(670, 1100),
				mark(855, 1100),
			],
			opciones
		);

		expect(quad?.topLeft).toEqual({ x: 75, y: 550 });
		expect(quad?.topRight).toEqual({ x: 855, y: 550 });
		expect(quad?.bottomRight).toEqual({ x: 855, y: 1100 });
		expect(quad?.bottomLeft).toEqual({ x: 75, y: 1100 });
	});

	it("descarta el frame si a una fila le falta la marca de una esquina", () => {
		const quad = findAnswersQuad([mark(75, 550), mark(855, 550), mark(75, 1100), mark(500, 1100)], opciones);
		expect(quad).toBeNull();
	});

	it("descarta el frame con menos de dos filas de marcas", () => {
		expect(findAnswersQuad([mark(75, 550), mark(855, 550), mark(300, 552), mark(500, 549)], opciones)).toBeNull();
	});
});

describe("findAnswersQuad con la geometría de la hoja de 80", () => {
	function mark(x: number, y: number): Box {
		return {
			x: x - 7,
			y: y - 7,
			w: 14,
			h: 14,
		};
	}

	it("elige el par de filas cuya proporción es la del bloque", () => {
		// En la hoja de 80 las tres filas traen dos marcas cada una, así que la
		// proporción es lo único que distingue al bloque.
		const quad = findAnswersQuad(
			[mark(55, 180), mark(865, 180), mark(55, 550), mark(865, 550), mark(55, 1160), mark(865, 1160)],
			{
				rowTolerance: 40,
				frameWidth: 935,
				frameHeight: 1210,
			}
		);

		expect(quad?.topLeft).toEqual({ x: 55, y: 550 });
		expect(quad?.bottomRight).toEqual({ x: 865, y: 1160 });
	});
});

describe("quadFromRows", () => {
	function row(left: number, right: number, y: number, count: number) {
		return {
			center: y,
			left: { x: left, y },
			right: { x: right, y },
			width: right - left,
			count,
		};
	}

	it("deduce la marca de punta que falta en una fila", () => {
		// Fila superior sin su marca derecha: 405 de ancho contra 528 de la inferior.
		const quad = quadFromRows(row(75, 480, 550, 5), row(75, 603, 1100, 6), true);
		expect(quad?.topRight).toEqual({ x: 603, y: 550 });
		expect(quad?.topLeft).toEqual({ x: 75, y: 550 });
	});

	it("deduce la esquina cuando una fila trae una sola marca", () => {
		const quad = quadFromRows(row(75, 75, 550, 1), row(75, 603, 1100, 6), true);
		expect(quad?.topRight).toEqual({ x: 603, y: 550 });
	});

	it("no deduce nada si el modo estricto está activo", () => {
		expect(quadFromRows(row(75, 480, 550, 5), row(75, 603, 1100, 6), false)).toBeNull();
		expect(quadFromRows(row(75, 75, 550, 1), row(75, 603, 1100, 6), false)).toBeNull();
	});

	it("no inventa dos esquinas a la vez", () => {
		expect(quadFromRows(row(75, 75, 550, 1), row(603, 603, 1100, 1), true)).toBeNull();
	});
});
