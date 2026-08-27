import { distance, type Point, type Quad } from "./geometry";

/**
 * Asistencia de encuadre: qué decirle al usuario, cuánto acercar la cámara y dónde
 * buscar la hoja en el frame siguiente.
 *
 * Todo esto es cálculo puro sobre lo que el detector ya devolvió. Vive aparte del
 * worker y del componente a propósito: son las decisiones que más se van a ajustar
 * probando en la mano, y conviene poder ajustarlas con tests y no con el teléfono.
 */

export type Rect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type Frame = {
	width: number;
	height: number;
};

/** Fracción del frame que debería ocupar el bloque de respuestas. */
export const TARGET_FILL = 0.82;

/**
 * Rectángulo donde conviene que caiga el bloque: centrado, con la proporción que
 * tiene impresa y ocupando la mayor parte del cuadro sin llegar a los bordes.
 */
export function targetRect(frame: Frame, aspect: number): Rect {
	if (frame.width <= 0 || frame.height <= 0 || aspect <= 0) {
		return { x: 0, y: 0, width: 0, height: 0 };
	}

	let width = frame.width * TARGET_FILL;
	let height = width * aspect;

	if (height > frame.height * TARGET_FILL) {
		height = frame.height * TARGET_FILL;
		width = height / aspect;
	}

	return {
		x: (frame.width - width) / 2,
		y: (frame.height - height) / 2,
		width,
		height,
	};
}

/** Cuánto del rectángulo objetivo ocupa lo detectado. 1 es el encuadre ideal. */
export function areaRatio(bounds: Rect, target: Rect): number {
	const objetivo = target.width * target.height;
	if (objetivo <= 0) {
		return 0;
	}

	return (bounds.width * bounds.height) / objetivo;
}

export function quadBounds(quad: Quad): Rect {
	const xs = [quad.topLeft.x, quad.topRight.x, quad.bottomRight.x, quad.bottomLeft.x];
	const ys = [quad.topLeft.y, quad.topRight.y, quad.bottomRight.y, quad.bottomLeft.y];
	const x = Math.min(...xs);
	const y = Math.min(...ys);

	return {
		x,
		y,
		width: Math.max(...xs) - x,
		height: Math.max(...ys) - y,
	};
}

export function rectCenter(rect: Rect): Point {
	return {
		x: rect.x + rect.width / 2,
		y: rect.y + rect.height / 2,
	};
}

/**
 * Zona donde buscar la hoja en el frame siguiente: la última posición conocida con
 * holgura.
 *
 * Recortar la búsqueda no es sólo velocidad. Al recortar antes de reducir a 640 px,
 * las marcas quedan más grandes en la imagen analizada, así que también se detecta
 * mejor — es un zoom digital para el detector, gratis y sin tocar la cámara.
 */
export function roiFor(quad: Quad, frame: Frame, padding: number = 0.3): Rect {
	const bounds = quadBounds(quad);
	const padX = bounds.width * padding;
	const padY = bounds.height * padding;
	const x = Math.max(0, bounds.x - padX);
	const y = Math.max(0, bounds.y - padY);

	return {
		x,
		y,
		width: Math.min(frame.width - x, bounds.width + padX * 2),
		height: Math.min(frame.height - y, bounds.height + padY * 2),
	};
}

export type ZoomRange = {
	min: number;
	max: number;
	step: number;
};

/**
 * Siguiente valor de zoom óptico/digital de la cámara.
 *
 * `ratio` es cuánto del rectángulo objetivo ocupa la hoja: 1 es el encuadre ideal,
 * 0,25 es que se ve a la mitad de lo que debería.
 *
 * Se mueve de a poco (un tercio del camino) porque un salto de zoom desenfoca y
 * mueve la hoja de golpe: el detector pierde el enganche justo cuando lo tenía. Y
 * nunca pasa de 4x, que es donde el recorte digital de la mayoría de los teléfonos
 * empieza a inventar detalle.
 */
export function nextZoom(current: number, ratio: number, range: ZoomRange): number {
	if (ratio <= 0.01) {
		return current;
	}

	const deseado = current * Math.sqrt(1 / ratio);
	const suave = current + (deseado - current) / 3;
	const techo = Math.min(range.max, range.min * 4);
	const limitado = Math.min(techo, Math.max(range.min, suave));

	return Math.round(limitado / range.step) * range.step;
}

export type Guidance = {
	/** Qué hacer, en imperativo y corto: se lee de un vistazo mientras se mueve el teléfono. */
	message: string;
	/** Hacia dónde mover el teléfono, en fracción del frame. null si no hay que moverse. */
	nudge: Point | null;
	/** true cuando el encuadre ya sirve y sólo falta sostener. */
	framed: boolean;
};

export type GuidanceInput = {
	quad: Quad | null;
	marks: Point[];
	frame: Frame;
	aspect: number;
};

/**
 * Diagnóstico de encuadre.
 *
 * El criterio NO es centrar el bloque de respuestas: quien encuadra ve la hoja
 * entera, y el bloque vive en los dos tercios de abajo, así que su centro siempre
 * queda bajo el centro del cuadro. Pedir centrado ahí es pedir algo imposible y
 * bloquea el autodisparo. Lo que de verdad hace falta es que el bloque entre
 * completo, se vea grande y esté de frente.
 */
export function guidance(input: GuidanceInput): Guidance {
	const { quad, marks, frame } = input;

	if (frame.width <= 0) {
		return { message: "apunta a la hoja", nudge: null, framed: false };
	}

	const centroFrame = rectCenter({ x: 0, y: 0, width: frame.width, height: frame.height });

	if (quad == null) {
		if (marks.length === 0) {
			return { message: "apunta a la hoja completa", nudge: null, framed: false };
		}

		// Se ven marcas pero no cierran un bloque: lo más útil es decir hacia dónde
		// están, porque casi siempre la hoja se salió por un lado.
		const centroide = {
			x: marks.reduce((total, mark) => total + mark.x, 0) / marks.length,
			y: marks.reduce((total, mark) => total + mark.y, 0) / marks.length,
		};

		const nudge = {
			x: (centroide.x - centroFrame.x) / frame.width,
			y: (centroide.y - centroFrame.y) / frame.height,
		};

		const lejos = Math.hypot(nudge.x, nudge.y) > 0.08;

		return {
			message: lejos ? "centra la hoja en el cuadro" : `faltan marcas (${marks.length} a la vista)`,
			nudge: lejos ? nudge : null,
			framed: false,
		};
	}

	const bounds = quadBounds(quad);
	const margen = Math.min(frame.width, frame.height) * 0.015;

	// ¿Se sale por algún lado? Se empuja al revés de por donde se sale.
	const fuera = {
		x: Math.max(0, margen - bounds.x) - Math.max(0, bounds.x + bounds.width - (frame.width - margen)),
		y: Math.max(0, margen - bounds.y) - Math.max(0, bounds.y + bounds.height - (frame.height - margen)),
	};

	if (Math.abs(fuera.x) > margen || Math.abs(fuera.y) > margen) {
		return {
			message: "la hoja se sale del cuadro",
			nudge: { x: -fuera.x / frame.width, y: -fuera.y / frame.height },
			framed: false,
		};
	}

	const ratio = areaRatio(bounds, targetRect(frame, input.aspect));

	if (ratio < 0.45) {
		return { message: "acércate a la hoja", nudge: null, framed: false };
	}

	const arriba = distance(quad.topLeft, quad.topRight);
	const abajo = distance(quad.bottomLeft, quad.bottomRight);
	const izquierda = distance(quad.topLeft, quad.bottomLeft);
	const derecha = distance(quad.topRight, quad.bottomRight);
	const sesgo = Math.max(
		Math.abs(arriba - abajo) / Math.max(arriba, abajo),
		Math.abs(izquierda - derecha) / Math.max(izquierda, derecha)
	);

	if (sesgo > 0.18) {
		return { message: "mira la hoja de frente", nudge: null, framed: false };
	}

	return { message: "sostén la hoja quieta", nudge: null, framed: true };
}

/** Umbral de movimiento bajo el cual se considera que el teléfono está quieto. */
export const STILL_THRESHOLD = 0.012;

/**
 * Decide si conviene disparar la foto solo: hoja encuadrada y teléfono quieto en
 * dos lecturas seguidas.
 *
 * Dos y no una porque el primer frame quieto suele ser el que llega justo cuando la
 * mano se detiene, y todavía trae arrastre.
 */
export function shouldAutoShoot(stillFrames: number, framed: boolean): boolean {
	return framed && stillFrames >= 2;
}
