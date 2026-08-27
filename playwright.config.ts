import { defineConfig, devices } from "@playwright/test";
import { FAKE_CAMERA_FILE } from "./tests/global-setup";

// El navegador puede venir de la instalación local de Playwright o de un Chromium
// ya presente en la máquina (CHROMIUM_PATH), para no bajar 150 MB en cada CI.
const executablePath = process.env.CHROMIUM_PATH;
const launchOptions = executablePath == null ? {} : { executablePath };

export default defineConfig({
	testDir: "tests",
	timeout: 60_000,
	fullyParallel: false,
	reporter: process.env.CI ? "line" : "list",
	globalSetup: "./tests/global-setup.ts",
	use: {
		baseURL: "http://localhost:5000",
	},
	webServer: [
		{
			command: "bun run build && bun run preview",
			url: "http://localhost:5000",
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
		},
		{
			// El sitio en producción cuelga de /app-static/. Servirlo así en los tests es
			// lo único que detecta rutas relativas mal resueltas y un service worker con
			// alcance equivocado.
			command: "bun run serve:subpath",
			url: "http://localhost:5055/app-static/",
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
		},
	],
	projects: [
		{
			name: "chromium",
			testIgnore: /camara\.spec\.ts/,
			use: {
				...devices["Desktop Chrome"],
				launchOptions,
			},
		},
		{
			// Es el escenario real: Chrome en un teléfono. La cámara se alimenta con un
			// video de una hoja, así que el camino de captura se prueba de verdad y no
			// sólo el de "elegir una imagen".
			name: "movil",
			testMatch: /camara\.spec\.ts/,
			use: {
				...devices["Pixel 5"],
				permissions: ["camera"],
				launchOptions: {
					...launchOptions,
					args: [
						"--use-fake-ui-for-media-stream",
						"--use-fake-device-for-media-stream",
						`--use-file-for-fake-video-capture=${FAKE_CAMERA_FILE}`,
					],
				},
			},
		},
	],
});
