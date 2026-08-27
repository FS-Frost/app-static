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
