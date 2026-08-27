import jsQR from "jsqr";
import type { FormatId } from "./format";
import type { Point, Quad } from "./geometry";
import { homographyFor } from "./homography";

export type QrSighting = {
	/** Esquinas del símbolo en el mismo sistema que la imagen analizada. */
	quad: Quad;
	text: string;
};

/**
 * Busca el QR de la cabecera. Se le pasa RGBA porque es lo que jsQR entiende.
 */
export function findQr(data: Uint8ClampedArray, width: number, height: number): QrSighting | null {
	const found = jsQR(data, width, height, { inversionAttempts: "dontInvert" });
	if (found == null) {
		return null;
	}

	const location = found.location;

	return {
		quad: {
			topLeft: location.topLeftCorner,
			topRight: location.topRightCorner,
			bottomRight: location.bottomRightCorner,
			bottomLeft: location.bottomLeftCorner,
		},
		text: found.data,
	};
}

/**
 * Dónde está el bloque de respuestas respecto del QR, en unidades del propio QR:
 * `u` corre a lo largo del lado superior del símbolo y `v` a lo largo del
 * izquierdo, así que (1, 0) es la esquina superior derecha del QR.
 *
 * Son constantes de impresión: el QR y las marcas vienen fijos en la plantilla de
 * la hoja. Se midieron sobre escaneos planos comparando, en el mismo frame, las
 * esquinas que reporta jsQR con las marcas que detecta el escáner.
 */
export type QrTemplate = {
	topLeft: Point;
	topRight: Point;
	bottomRight: Point;
	bottomLeft: Point;
};

export const qrTemplates: Record<FormatId, QrTemplate> = {
	"45": {
		topLeft: { x: -2.17, y: 1.47 },
		topRight: { x: 3.98, y: 1.46 },
		bottomRight: { x: 3.99, y: 5.88 },
		bottomLeft: { x: -2.17, y: 5.91 },
	},
	"80": {
		topLeft: { x: -2.22, y: 1.51 },
		topRight: { x: 3.99, y: 1.52 },
		bottomRight: { x: 3.99, y: 6.26 },
		bottomLeft: { x: -2.22, y: 6.25 },
	},
};

/**
 * Estima el cuadrilátero del bloque de respuestas a partir del QR.
 *
 * El QR es chico y está lejos del bloque, así que el error angular se amplifica:
 * la estimación queda con varios píxeles de desvío. No importa tanto como parece,
 * porque la grilla no se toma de esta estimación — se reconstruye de las burbujas
 * que aparecen en la hoja rectificada, y un desplazamiento pequeño se absorbe ahí.
 * Lo que aporta el QR es poder leer sin ver las marcas.
 */
export function answersQuadFromQr(qr: Quad, template: QrTemplate): Quad | null {
	const matrix = homographyFor(
		[
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
		],
		[
			[qr.topLeft.x, qr.topLeft.y],
			[qr.topRight.x, qr.topRight.y],
			[qr.bottomRight.x, qr.bottomRight.y],
			[qr.bottomLeft.x, qr.bottomLeft.y],
		]
	);

	if (matrix == null) {
		return null;
	}

	const map = (point: Point): Point => {
		const w = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
		if (w === 0) {
			return { x: 0, y: 0 };
		}

		return {
			x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / w,
			y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / w,
		};
	};

	return {
		topLeft: map(template.topLeft),
		topRight: map(template.topRight),
		bottomRight: map(template.bottomRight),
		bottomLeft: map(template.bottomLeft),
	};
}

/**
 * Afina un cuadrilátero estimado desde el QR con las marcas que sí se vean.
 *
 * El QR mide una fracción de la hoja y está lejos del bloque, así que el error
 * angular se amplifica: medido sobre una hoja real, la esquina inferior derecha
 * estimada cae ~90 px del sitio correcto, suficiente para que la grilla no cierre.
 * Cada marca que aparezca cerca de una esquina estimada la corrige a su valor
 * exacto, y con eso el QR pasa de "ubicación aproximada" a "ubicación buena aunque
 * falten marcas".
 */
export function snapQuadToMarks(quad: Quad, marks: Point[], tolerance: number): { quad: Quad; snapped: number } {
	let snapped = 0;

	const snap = (corner: Point): Point => {
		let best: Point | null = null;
		let bestDistance = tolerance;

		for (const mark of marks) {
			const distance = Math.hypot(mark.x - corner.x, mark.y - corner.y);
			if (distance <= bestDistance) {
				best = mark;
				bestDistance = distance;
			}
		}

		if (best == null) {
			return corner;
		}

		snapped++;
		return best;
	};

	return {
		quad: {
			topLeft: snap(quad.topLeft),
			topRight: snap(quad.topRight),
			bottomRight: snap(quad.bottomRight),
			bottomLeft: snap(quad.bottomLeft),
		},
		snapped,
	};
}

/**
 * Coordenadas de un punto en el marco del QR. Es la operación inversa de
 * `answersQuadFromQr` y sirve para medir la plantilla: con un escaneo plano donde
 * se ven el QR y las marcas, da los números que van en `qrTemplates`.
 */
export function pointInQrFrame(qr: Quad, point: Point): Point {
	const ux = qr.topRight.x - qr.topLeft.x;
	const uy = qr.topRight.y - qr.topLeft.y;
	const vx = qr.bottomLeft.x - qr.topLeft.x;
	const vy = qr.bottomLeft.y - qr.topLeft.y;
	const determinant = ux * vy - uy * vx;
	if (determinant === 0) {
		return { x: 0, y: 0 };
	}

	const dx = point.x - qr.topLeft.x;
	const dy = point.y - qr.topLeft.y;

	return {
		x: (dx * vy - dy * vx) / determinant,
		y: (dy * ux - dx * uy) / determinant,
	};
}
