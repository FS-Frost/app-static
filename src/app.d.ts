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
	}
}

export {};
