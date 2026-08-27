import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { FAKE_CAMERA_FILE } from "./global-setup";

/**
 * Guardia de velocidad: con la hoja dentro del cuadro, la app tiene que leerla en
 * pocos segundos. Los umbrales son generosos porque acá corre en un headless
 * compartido con el resto de la suite; en el banco en serie, esta misma hoja se lee
 * en ~1,5 s y la primera lectura llega a los ~0,65 s.
 *
 * Para medir en serio (varios casos, medianas) se corre este archivo con
 * `BENCH_VIDEO` apuntando a otro video y sin el resto de la suite en paralelo.
 */

test.use({
	launchOptions: {
		executablePath: process.env.CHROMIUM_PATH,
		args: [
			"--use-fake-ui-for-media-stream",
			"--use-fake-device-for-media-stream",
			`--use-file-for-fake-video-capture=${process.env.BENCH_VIDEO ?? FAKE_CAMERA_FILE}`,
		],
	},
});

test.skip(!existsSync(FAKE_CAMERA_FILE), "requiere ffmpeg para generar el video de la cámara falsa");

test("lee la hoja en pocos segundos desde que se abre la cámara", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: /^45 preguntas/ }).click();

	const inicio = performance.now();
	await page.getByRole("button", { name: "Abrir cámara" }).click();
	await expect(page.getByRole("button", { name: "Escanear otra" })).toBeVisible({ timeout: 20_000 });
	const total = Math.round(performance.now() - inicio);

	const primera = Number(await page.locator(".estado").getAttribute("data-primera"));
	console.log(`velocidad: total ${total} ms · primera lectura ${primera} ms`);

	expect(total).toBeLessThan(9000);
	expect(primera).toBeGreaterThan(0);
	expect(primera).toBeLessThan(5000);
});
