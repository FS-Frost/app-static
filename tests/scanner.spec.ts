import { expect, test, type Page } from "@playwright/test";
import { RESPUESTAS_45, RESPUESTAS_80 } from "./esperado";

/**
 * Estos tests corren el pipeline completo — OpenCV en el worker incluido — contra
 * hojas reales escaneadas. Son los únicos que comprueban que la homografía y la
 * grilla siguen calzando: los unitarios sólo ven geometría sintética.
 *
 * Las fixtures salen de `examples/`, con la cabecera censurada (nombre,
 * establecimiento, RUT y QR) porque son datos de alumnos reales.
 */

type Formato = "45" | "80";

async function leerHoja(page: Page, formato: Formato, fixture: string): Promise<string[]> {
	await page.goto("/");
	await page.getByRole("button", { name: new RegExp(`^${formato} preguntas`) }).click();
	await page.locator("input[type=file]").setInputFiles(fixture);

	await expect(page.getByRole("button", { name: "Escanear otra" })).toBeVisible({ timeout: 30_000 });

	return page.$$eval("li .respuesta", (celdas) =>
		celdas.map((celda) => {
			const texto = celda.textContent?.trim() ?? "";
			return texto === "—" ? "" : texto;
		})
	);
}

test("lee una hoja de 45 preguntas escaneada", async ({ page }) => {
	const respuestas = await leerHoja(page, "45", "tests/fixtures/hoja-45.png");
	expect(respuestas).toEqual(RESPUESTAS_45);
});

test("lee la misma hoja de 45 fotografiada en ángulo y con sombra", async ({ page }) => {
	const respuestas = await leerHoja(page, "45", "tests/fixtures/foto-45.jpg");
	expect(respuestas).toEqual(RESPUESTAS_45);
});

test("lee una hoja de 80 preguntas", async ({ page }) => {
	const respuestas = await leerHoja(page, "80", "tests/fixtures/hoja-80-marcada.png");
	expect(respuestas).toEqual(RESPUESTAS_80);
});

test("no inventa respuestas en una hoja sin marcar", async ({ page }) => {
	const respuestas = await leerHoja(page, "80", "tests/fixtures/hoja-80.png");
	expect(respuestas).toEqual(new Array(80).fill(""));
});

test("avisa cuando la imagen no tiene una hoja", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: /^45 preguntas/ }).click();
	await page.locator("input[type=file]").setInputFiles("tests/fixtures/sin-hoja.png");

	await expect(page.locator(".error")).toContainText(/hoja|burbujas|filas|columnas/, { timeout: 30_000 });
});
