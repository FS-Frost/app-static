import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { RESPUESTAS_45 } from "./esperado";
import { FAKE_CAMERA_FILE } from "./global-setup";

test.skip(!existsSync(FAKE_CAMERA_FILE), "requiere ffmpeg para generar el video de la cámara falsa");

test("lee la hoja desde la cámara en un teléfono", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: /^45 preguntas/ }).click();
	await page.getByRole("button", { name: "Abrir cámara" }).click();

	await expect(page.getByRole("button", { name: "Escanear otra" })).toBeVisible({ timeout: 40_000 });

	const respuestas = await page.$$eval("li .respuesta", (celdas) =>
		celdas.map((celda) => {
			const texto = celda.textContent?.trim() ?? "";
			return texto === "—" ? "" : texto;
		})
	);

	expect(respuestas).toEqual(RESPUESTAS_45);

	// La vista previa no puede quedar recortada: el usuario tiene que ver la hoja
	// completa para saber si está encuadrada.
	const marco = page.locator(".marco");
	const caja = await marco.boundingBox();
	const video = await page.locator(".marco video").evaluate((element) => {
		const media = element as HTMLVideoElement;
		return { width: media.videoWidth, height: media.videoHeight };
	});

	expect(video.width).toBeGreaterThan(0);
	expect(caja).not.toBeNull();
	expect((caja?.height ?? 0) / (caja?.width ?? 1)).toBeCloseTo(video.height / video.width, 1);
});
