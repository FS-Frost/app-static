import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		port: 5000,
	},
	preview: {
		port: 5000,
	},
	// jsQR es UMD: si el build del servidor lo deja como externo, avisa que no sabe
	// con qué nombre global resolverlo. El sitio es estático y ese bundle no se
	// ejecuta nunca, pero el aviso ensucia la salida.
	ssr: {
		noExternal: ["jsqr"],
	},
	worker: {
		// El worker carga OpenCV con importScripts, que no existe en un module
		// worker. Formato clásico o el scanner no arranca.
		format: 'iife',
	},
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts'],
	},
});
