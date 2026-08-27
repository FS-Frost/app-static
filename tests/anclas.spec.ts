import { expect, test, type Page } from "@playwright/test";
import { RESPUESTAS_45 } from "./esperado";

/**
 * Cada ancla se prueba con la hoja que la justifica. La comparación no es de
 * gustos: son escenarios distintos de encuadre.
 */

const ETIQUETAS = {
	tolerante: /^Marcas, tolerante/,
	estricto: /^Marcas, estricto/,
	qr: /^QR de la cabecera/,
};

async function escanear(page: Page, ancla: RegExp, archivo: string): Promise<void> {
	await page.goto("/");
	await page.getByRole("button", { name: /^45 preguntas/ }).click();
	await page.getByRole("button", { name: ancla }).click();
	await page.locator("input[type=file]").setInputFiles(archivo);
}

async function respuestas(page: Page): Promise<string[]> {
	await expect(page.getByRole("button", { name: "Escanear otra" })).toBeVisible({ timeout: 40_000 });

	return page.$$eval("li .respuesta", (celdas) =>
		celdas.map((celda) => {
			const texto = celda.textContent?.trim() ?? "";
			return texto === "—" ? "" : texto;
		})
	);
}

test("el ancla QR lee la hoja con el QR de la cabecera", async ({ page }) => {
	await escanear(page, ETIQUETAS.qr, "tests/fixtures/hoja-45-qr.png");
	expect(await respuestas(page)).toEqual(RESPUESTAS_45);
});

test("el ancla QR lee aunque las marcas de abajo queden fuera del cuadro", async ({ page }) => {
	// Es el caso que motiva el ancla QR: encuadrar la hoja entera a pulso es
	// incómodo, y acá falta la fila inferior de marcas completa.
	await escanear(page, ETIQUETAS.qr, "tests/fixtures/hoja-45-qr-recortada.png");
	expect(await respuestas(page)).toEqual(RESPUESTAS_45);
});

test("el ancla tolerante lee con una marca de esquina tapada", async ({ page }) => {
	await escanear(page, ETIQUETAS.tolerante, "tests/fixtures/hoja-45-sin-marca.png");
	expect(await respuestas(page)).toEqual(RESPUESTAS_45);
});

test("el ancla estricta prefiere no leer si falta una marca", async ({ page }) => {
	await escanear(page, ETIQUETAS.estricto, "tests/fixtures/hoja-45-sin-marca.png");
	await expect(page.locator(".error")).toContainText("no se ven las marcas", { timeout: 30_000 });
});
