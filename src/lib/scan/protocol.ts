import type { Rect } from "./assist";
import type { FormatId } from "./format";
import type { Point, Quad } from "./geometry";
import type { Anchor } from "./strategy";

export type ScanRequest =
	| {
			type: "init";
			/** URL del build custom de OpenCV, resuelta con la base del sitio. */
			opencvUrl: string;
	  }
	| {
			type: "frame";
			frameId: number;
			formatId: FormatId;
			anchor: Anchor;
			debug: boolean;
			/**
			 * Zona del frame donde buscar la hoja. La manda el hilo principal con la
			 * última posición conocida: además de ahorrar trabajo, agranda las marcas en
			 * la imagen analizada y mejora la detección.
			 */
			roi: Rect | null;
			/**
			 * false para sondear el encuadre sin leer respuestas: ubica la hoja y mide el
			 * movimiento, y se salta la rectificación y la grilla. Es lo que corre mientras
			 * el usuario encuadra en modo foto.
			 */
			read: boolean;
			bitmap: ImageBitmap;
	  };

export type FrameTiming = {
	total: number;
	locate: number;
	warp: number;
	read: number;
};

export type FrameResult = {
	ok: boolean;
	/** Motivo del descarte, en español, listo para mostrar como guía al usuario. */
	reason: string;
	/** Respuesta leída por pregunta; "" cuando quedó en blanco. */
	answers: string[];
	/** Relleno de cada burbuja, por pregunta. Sirve para depurar umbrales. */
	fills: number[][];
	/** Esquinas de la hoja en coordenadas del frame de video, para el overlay. */
	quad: Quad | null;
	frameWidth: number;
	frameHeight: number;
	/** Centros de las marcas detectadas, en coordenadas del frame, para el overlay. */
	marks: Point[];
	/** Esquinas del QR en coordenadas del frame, si se buscó y se encontró. */
	qrQuad: Quad | null;
	/** Cuánto cambió la imagen respecto del frame anterior, entre 0 y 1. */
	motion: number;
	/** Zona analizada, para saber si el seguimiento está activo. */
	searchRect: Rect | null;
	timing: FrameTiming;
};

export type ScanResponse =
	| {
			type: "ready";
	  }
	| {
			type: "error";
			message: string;
	  }
	| {
			type: "result";
			frameId: number;
			result: FrameResult;
			/** Hoja rectificada con la grilla dibujada; sólo en modo depuración. */
			debugImage: ImageBitmap | null;
	  };
