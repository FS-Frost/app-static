/// <reference types="vite/client" />

declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface Platform {}
	}

	interface MediaTrackConstraintSet {
		/** Flash de la cámara. No está en el estándar, pero Android lo implementa. */
		torch?: boolean;
		/** Zoom del sensor, para el auto-encuadre. */
		zoom?: number;
		/** Punto donde enfocar y medir, en coordenadas 0..1 del frame. */
		pointsOfInterest?: { x: number; y: number }[];
		/** Enfoque continuo: la hoja está a una distancia que cambia todo el tiempo. */
		focusMode?: string;
		/** Exposición continua, para que el blanco del papel no se queme. */
		exposureMode?: string;
	}
}

export {};
