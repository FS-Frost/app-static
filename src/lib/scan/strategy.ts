/**
 * Cómo se ubica la hoja y cómo se captura la imagen.
 *
 * Son dos ejes independientes y ambos seleccionables a propósito: encuadrar una
 * hoja completa a pulso es incómodo, y cuál combinación resulta más rápida en la
 * mano depende del teléfono, de la luz y de la costumbre de quien corrige. Eso se
 * decide probando.
 */

/** Dónde se ancla la detección. */
export type Anchor = "auto" | "marcas-estricto" | "marcas-tolerante" | "qr";

/** Cómo se obtienen los frames. */
export type Capture = "continua" | "foto";

export type AnchorInfo = {
	id: Anchor;
	label: string;
	detail: string;
};

export const ANCHORS: AnchorInfo[] = [
	{
		id: "auto",
		label: "Automático",
		detail:
			"Prueba todas las vías en cada frame: marcas, QR y umbrales alternativos, hasta que una cierra. Es la que detecta más rápido.",
	},
	{
		id: "marcas-tolerante",
		label: "Marcas, tolerante",
		detail: "Se ancla en las marcas negras aguantando ángulo y distancia; si falta una esquina, la deduce.",
	},
	{
		id: "marcas-estricto",
		label: "Marcas, estricto",
		detail: "Exige la hoja completa y de frente. Es la lectura más conservadora.",
	},
	{
		id: "qr",
		label: "QR de la cabecera",
		detail:
			"Se ancla en el QR y deduce dónde están las respuestas: sirve aunque las marcas queden fuera del cuadro. Si el QR no se ve, cae a las marcas.",
	},
];

export type CaptureInfo = {
	id: Capture;
	label: string;
	detail: string;
};

export const CAPTURES: CaptureInfo[] = [
	{
		id: "continua",
		label: "Continua",
		detail: "Analiza el video y termina solo cuando la lectura se repite. Sin botones.",
	},
	{
		id: "foto",
		label: "Una foto",
		detail: "Dispara una foto a máxima resolución y la lee. Más nítida: permite encuadrar de más lejos.",
	},
];

/**
 * El QR va por omisión: es lo que se ve de más lejos y con peor foco, y su
 * estimación se afina igual con las marcas que aparezcan. En terreno resultó el
 * encuadre menos exigente.
 */
export const defaultAnchor: Anchor = "qr";
export const defaultCapture: Capture = "continua";

export function isAnchor(value: string): value is Anchor {
	return value === "auto" || value === "marcas-estricto" || value === "marcas-tolerante" || value === "qr";
}

export function isCapture(value: string): value is Capture {
	return value === "continua" || value === "foto";
}

export type Tolerance = {
	/** Diferencia máxima entre lados opuestos: cuánta perspectiva se acepta. */
	maxSkew: number;
	/** Fracción mínima del frame que debe ocupar la zona detectada. */
	minCoverage: number;
	/** Fracción mínima del ancho y del alto del frame. */
	minSide: number;
	/** Si se deduce la cuarta esquina cuando sólo se ven tres marcas. */
	completeCorners: boolean;
};

export const strictTolerance: Tolerance = {
	maxSkew: 0.25,
	minCoverage: 0.08,
	minSide: 0.2,
	completeCorners: false,
};

/**
 * Tolerante: casi el doble de perspectiva y la mitad de tamaño mínimo.
 *
 * La homografía corrige la perspectiva de todas formas y la grilla se reconstruye
 * de la hoja, así que los límites estrictos no protegían la lectura — sólo
 * obligaban a encuadrar con cuidado. Lo que protege la lectura es el chequeo de la
 * grilla: si las filas no calzan, el frame se descarta igual.
 */
export const looseTolerance: Tolerance = {
	maxSkew: 0.45,
	minCoverage: 0.04,
	minSide: 0.12,
	completeCorners: true,
};

export function toleranceFor(anchor: Anchor): Tolerance {
	return anchor === "marcas-estricto" ? strictTolerance : looseTolerance;
}
