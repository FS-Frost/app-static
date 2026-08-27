import { expect, test, type Page } from "@playwright/test";
import { RESPUESTAS_45 } from "./esperado";

/**
 * El sitio en producción es GitHub Pages: cuelga de /app-static/ y se abre en
 * Chrome de un teléfono, muchas veces con red mala. Estos dos tests cubren
 * justamente eso, que servir en la raíz no comprueba.
 */

const SITIO = "http://localhost:5055/app-static/";

async function leerHoja(page: Page): Promise<string[]> {
	await page.getByRole("button", { name: /^45 preguntas/ }).click();
	await page.locator("input[type=file]").setInputFiles("tests/fixtures/hoja-45.png");
	await expect(page.getByRole("button", { name: "Escanear otra" })).toBeVisible({ timeout: 40_000 });

	return page.$$eval("li .respuesta", (celdas) =>
		celdas.map((celda) => {
			const texto = celda.textContent?.trim() ?? "";
			return texto === "—" ? "" : texto;
		})
	);
}

test("funciona servido desde un subdirectorio", async ({ page }) => {
	const fallos: string[] = [];
	page.on("requestfailed", (request) => fallos.push(`${request.url()} ${request.failure()?.errorText}`));
	page.on("response", (response) => {
		if (response.status() >= 400) {
			fallos.push(`${response.status()} ${response.url()}`);
		}
	});
	page.on("pageerror", (error) => fallos.push(`pageerror ${error.message}`));

	await page.goto(SITIO);
	expect(await leerHoja(page)).toEqual(RESPUESTAS_45);

	const scope = await page.evaluate(async () => {
		const registration = await navigator.serviceWorker.getRegistration();
		return registration?.scope ?? "sin registro";
	});

	// Si el alcance no cubre el subdirectorio, el modo offline no existe.
	expect(scope).toContain("/app-static/");
	expect(fallos).toEqual([]);
});

test("escanea sin conexión después de haber escaneado con red", async ({ page, context }) => {
	await page.goto(SITIO);
	expect(await leerHoja(page)).toEqual(RESPUESTAS_45);

	// El worker guarda lo que esta carga usó de verdad (los bundles tienen nombre
	// hasheado, así que no se pueden precachear a ciegas), y eso toma un momento
	// tras tomar el control.
	await page.waitForFunction(() => navigator.serviceWorker.controller != null, undefined, { timeout: 30_000 });
	await page.waitForTimeout(3000);

	await context.setOffline(true);
	await page.reload();

	expect(await leerHoja(page)).toEqual(RESPUESTAS_45);
});
