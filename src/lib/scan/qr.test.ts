import { describe, expect, it } from "vitest";
import type { Quad } from "./geometry";
import { answersQuadFromQr, pointInQrFrame, qrTemplates, snapQuadToMarks } from "./qr";

const qr: Quad = {
	topLeft: { x: 100, y: 200 },
	topRight: { x: 200, y: 200 },
	bottomRight: { x: 200, y: 300 },
	bottomLeft: { x: 100, y: 300 },
};

describe("answersQuadFromQr", () => {
	it("ubica el bloque según la plantilla del formato", () => {
		const quad = answersQuadFromQr(qr, qrTemplates["45"]);

		// Con un QR de 100 px de lado, u = 100 px: la plantilla se lee directo.
		expect(quad?.topLeft.x).toBeCloseTo(100 + 100 * qrTemplates["45"].topLeft.x, 3);
		expect(quad?.topLeft.y).toBeCloseTo(200 + 100 * qrTemplates["45"].topLeft.y, 3);
		expect(quad?.bottomRight.y).toBeCloseTo(200 + 100 * qrTemplates["45"].bottomRight.y, 3);
	});

	it("es la inversa de pointInQrFrame", () => {
		const quad = answersQuadFromQr(qr, qrTemplates["80"]);
		expect(quad).not.toBeNull();

		const medido = pointInQrFrame(qr, quad!.bottomLeft);
		expect(medido.x).toBeCloseTo(qrTemplates["80"].bottomLeft.x, 3);
		expect(medido.y).toBeCloseTo(qrTemplates["80"].bottomLeft.y, 3);
	});
});

describe("snapQuadToMarks", () => {
	const estimado: Quad = {
		topLeft: { x: 100, y: 100 },
		topRight: { x: 500, y: 100 },
		bottomRight: { x: 500, y: 400 },
		bottomLeft: { x: 100, y: 400 },
	};

	it("corrige las esquinas que tienen una marca cerca", () => {
		const ajuste = snapQuadToMarks(estimado, [{ x: 106, y: 94 }, { x: 494, y: 108 }], 20);

		expect(ajuste.snapped).toBe(2);
		expect(ajuste.quad.topLeft).toEqual({ x: 106, y: 94 });
		expect(ajuste.quad.topRight).toEqual({ x: 494, y: 108 });
		// Sin marca cerca, la esquina estimada se conserva.
		expect(ajuste.quad.bottomLeft).toEqual({ x: 100, y: 400 });
	});

	it("ignora marcas lejanas", () => {
		const ajuste = snapQuadToMarks(estimado, [{ x: 300, y: 250 }], 20);
		expect(ajuste.snapped).toBe(0);
		expect(ajuste.quad).toEqual(estimado);
	});
});
