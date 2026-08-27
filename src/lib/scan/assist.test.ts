import { describe, expect, it } from "vitest";
import type { Quad } from "./geometry";
import { areaRatio, guidance, nextZoom, quadBounds, roiFor, shouldAutoShoot, targetRect, TARGET_FILL } from "./assist";

const frame = { width: 1000, height: 1400 };

function quadOf(x: number, y: number, width: number, height: number): Quad {
	return {
		topLeft: { x, y },
		topRight: { x: x + width, y },
		bottomRight: { x: x + width, y: y + height },
		bottomLeft: { x, y: y + height },
	};
}

describe("targetRect", () => {
	it("centra un rectángulo con la proporción de la hoja", () => {
		const rect = targetRect(frame, 0.7);
		expect(rect.width).toBeCloseTo(820, 3);
		expect(rect.height).toBeCloseTo(574, 3);
		expect(rect.x).toBeCloseTo(90, 3);
	});

	it("limita por el alto cuando la hoja es más alta que ancha", () => {
		const rect = targetRect({ width: 1000, height: 600 }, 1.4);
		expect(rect.height).toBeCloseTo(600 * TARGET_FILL, 3);
		expect(rect.width).toBeCloseTo((600 * TARGET_FILL) / 1.4, 3);
	});
});

describe("roiFor", () => {
	it("agranda la última posición conocida sin salirse del frame", () => {
		const roi = roiFor(quadOf(400, 500, 200, 140), frame, 0.5);
		expect(roi.x).toBe(300);
		expect(roi.y).toBe(430);
		expect(roi.width).toBe(400);
		expect(roi.height).toBe(280);
	});

	it("recorta contra el borde", () => {
		const roi = roiFor(quadOf(0, 0, 200, 140), frame, 0.5);
		expect(roi.x).toBe(0);
		expect(roi.y).toBe(0);
		// El margen que se pierde por la izquierda se gana por la derecha.
		expect(roi.width).toBe(400);
	});
});

describe("nextZoom", () => {
	const range = { min: 1, max: 8, step: 0.1 };

	it("acerca cuando la hoja ocupa poco", () => {
		const zoom = nextZoom(1, 0.25, range);
		expect(zoom).toBeGreaterThan(1);
		// Avanza de a poco: no salta directo al zoom ideal (2x).
		expect(zoom).toBeLessThan(1.8);
	});

	it("aleja cuando la hoja se sale", () => {
		expect(nextZoom(2, 2, range)).toBeLessThan(2);
	});

	it("no pasa de 4x ni baja del mínimo", () => {
		expect(nextZoom(4, 0.1, range)).toBeLessThanOrEqual(4);
		expect(nextZoom(1, 4, range)).toBeGreaterThanOrEqual(1);
	});
});

describe("guidance", () => {
	const aspect = 0.7;

	it("pide apuntar cuando no ve nada", () => {
		const guia = guidance({ quad: null, marks: [], frame, aspect });
		expect(guia.message).toBe("apunta a la hoja completa");
		expect(guia.framed).toBe(false);
	});

	it("empuja hacia las marcas cuando la hoja se salió", () => {
		const guia = guidance({ quad: null, marks: [{ x: 900, y: 1200 }], frame, aspect });
		expect(guia.message).toBe("centra la hoja en el cuadro");
		expect(guia.nudge?.x).toBeGreaterThan(0);
		expect(guia.nudge?.y).toBeGreaterThan(0);
	});

	it("informa marcas parciales cuando ya están centradas", () => {
		const guia = guidance({ quad: null, marks: [{ x: 500, y: 700 }], frame, aspect });
		expect(guia.message).toContain("faltan marcas");
		expect(guia.nudge).toBeNull();
	});

	it("pide acercarse cuando la hoja se ve chica", () => {
		const guia = guidance({ quad: quadOf(400, 600, 200, 140), marks: [], frame, aspect });
		expect(guia.message).toBe("acércate a la hoja");
	});

	it("avisa cuando el bloque se sale del cuadro y empuja al revés", () => {
		// Se sale por la derecha: hay que mover el teléfono hacia la derecha, o sea
		// empujar la imagen a la izquierda.
		const guia = guidance({ quad: quadOf(400, 480, 780, 546), marks: [], frame, aspect });
		expect(guia.message).toBe("la hoja se sale del cuadro");
		expect(guia.nudge?.x).toBeGreaterThan(0);
	});

	it("no exige centrar el bloque, que siempre queda bajo el centro de la hoja", () => {
		// Bloque en los dos tercios de abajo, como en una hoja real vista completa.
		const guia = guidance({ quad: quadOf(100, 700, 800, 560), marks: [], frame, aspect });
		expect(guia.framed).toBe(true);
	});

	it("pide mirar de frente con mucha perspectiva", () => {
		const guia = guidance({
			quad: {
				topLeft: { x: 90, y: 420 },
				topRight: { x: 910, y: 420 },
				bottomRight: { x: 800, y: 990 },
				bottomLeft: { x: 200, y: 990 },
			},
			marks: [],
			frame,
			aspect,
		});

		expect(guia.message).toBe("mira la hoja de frente");
	});

	it("da el encuadre por bueno cuando entra completo, grande y de frente", () => {
		const guia = guidance({ quad: quadOf(90, 413, 820, 574), marks: [], frame, aspect });
		expect(guia.framed).toBe(true);
		expect(guia.message).toBe("sostén la hoja quieta");
	});
});

describe("shouldAutoShoot", () => {
	it("dispara con dos lecturas quietas y encuadre bueno", () => {
		expect(shouldAutoShoot(2, true)).toBe(true);
	});

	it("no dispara con una sola, ni sin encuadre", () => {
		expect(shouldAutoShoot(1, true)).toBe(false);
		expect(shouldAutoShoot(5, false)).toBe(false);
	});
});

describe("areaRatio", () => {
	it("da 1 cuando lo detectado calza con el objetivo", () => {
		const target = targetRect(frame, 0.7);
		expect(areaRatio(target, target)).toBeCloseTo(1, 6);
	});
});

describe("quadBounds", () => {
	it("toma los extremos", () => {
		const bounds = quadBounds({
			topLeft: { x: 10, y: 20 },
			topRight: { x: 110, y: 15 },
			bottomRight: { x: 120, y: 90 },
			bottomLeft: { x: 5, y: 100 },
		});

		expect(bounds).toEqual({ x: 5, y: 15, width: 115, height: 85 });
	});
});
