import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { RESPUESTAS_45 } from "./esperado";
import { FAKE_CAMERA_FILE } from "./global-setup";

test.skip(!existsSync(FAKE_CAMERA_FILE), "requiere ffmpeg para generar el video de la cámara falsa");

/** Los interruptores de la pantalla de formato, por su texto. */
function interruptor(page: Page, texto: string) {
	return page.locator(`.toggle:has-text("${texto}") input`);
}

async function respuestas(page: Page): Promise<string[]> {
	return page.$$eval("li .respuesta", (celdas) =>
		celdas.map((celda) => {
			const texto = celda.textContent?.trim() ?? "";
			return texto === "—" ? "" : texto;
		})
	);
}

test("lee la hoja desde la cámara en un teléfono", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: /^45 preguntas/ }).click();
	await page.getByRole("button", { name: "Abrir cámara" }).click();

	await expect(page.getByRole("button", { name: "Escanear otra" })).toBeVisible({ timeout: 40_000 });
	expect(await respuestas(page)).toEqual(RESPUESTAS_45);

	// Con la hoja leída, la cámara se suelta: el video se queda sin fuente.
	const conFuente = await page.locator(".marco video").evaluate((element) => (element as HTMLVideoElement).srcObject != null);
	expect(conFuente).toBe(false);

	// Y se informan los dos tiempos.
	const tiempos = await page.getByTestId("tiempos").textContent();
	expect(tiempos).toMatch(/Cámara abierta → lectura: [\d.,]+ s/);
	expect(tiempos).toMatch(/Detección desde la captura: \d+ ms/);
});

test("la vista previa no recorta ni deforma la hoja", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: /^45 preguntas/ }).click();
	await interruptor(page, "Cámara a pantalla completa").uncheck();
	await page.getByRole("button", { name: "Abrir cámara" }).click();

	// Se mide con la cámara abierta: al terminar la lectura el video se suelta y
	// `videoWidth` vuelve a cero.
	await page.waitForFunction(
		() => (document.querySelector(".marco video") as HTMLVideoElement | null)?.videoWidth ?? 0 > 0,
		undefined,
		{ timeout: 20_000 }
	);

	const caja = await page.locator(".marco").boundingBox();
	const video = await page.locator(".marco video").evaluate((element) => {
		const media = element as HTMLVideoElement;
		return { width: media.videoWidth, height: media.videoHeight };
	});

	expect(video.width).toBeGreaterThan(0);
	expect((caja?.height ?? 0) / (caja?.width ?? 1)).toBeCloseTo(video.height / video.width, 1);
});

test("a pantalla completa la cámara ocupa el ancho del viewport sin deformarse", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: /^45 preguntas/ }).click();
	await page.getByRole("button", { name: "Abrir cámara" }).click();

	// Mientras escanea, el marco cubre la pantalla…
	const marco = page.locator(".marco.completa");
	await expect(marco).toBeVisible();

	const viewport = page.viewportSize();
	const caja = await marco.boundingBox();
	expect(caja?.width).toBeCloseTo(viewport?.width ?? 0, 0);

	// …y el video se ajusta sin estirarse: `contain` conserva la proporción.
	const ajuste = await page
		.locator(".marco video")
		.evaluate((element) => getComputedStyle(element).objectFit);
	expect(ajuste).toBe("contain");

	// Al terminar, la pantalla completa se suelta para mostrar las respuestas.
	await expect(page.getByRole("button", { name: "Escanear otra" })).toBeVisible({ timeout: 40_000 });
	await expect(page.locator(".marco.completa")).toHaveCount(0);
});

test("modo foto con asistencia: dispara solo al estar quieto", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: /^45 preguntas/ }).click();
	await page.getByRole("button", { name: /^Una foto/ }).click();
	await page.getByRole("button", { name: "Abrir cámara" }).click();

	// No se toca ningún botón: con la hoja encuadrada y la cámara quieta, la app
	// dispara por su cuenta.
	await expect(page.getByRole("button", { name: "Escanear otra" })).toBeVisible({ timeout: 40_000 });
	expect(await respuestas(page)).toEqual(RESPUESTAS_45);
});

test("modo foto sin asistencia: espera el botón", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: /^45 preguntas/ }).click();
	await page.getByRole("button", { name: /^Una foto/ }).click();
	await interruptor(page, "Asistencia de encuadre").uncheck();
	await page.getByRole("button", { name: "Abrir cámara" }).click();

	const disparar = page.getByRole("button", { name: /Tomar foto|Leyendo/ });
	await expect(disparar).toBeVisible({ timeout: 30_000 });
	await expect(page.getByRole("button", { name: "Escanear otra" })).toHaveCount(0);

	await disparar.click();
	await expect(page.getByRole("button", { name: "Escanear otra" })).toBeVisible({ timeout: 40_000 });
});

test("la asistencia engancha el seguimiento a la hoja", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: /^45 preguntas/ }).click();
	await interruptor(page, "Cámara a pantalla completa").uncheck();
	await interruptor(page, "Depurar").check();
	await page.getByRole("button", { name: "Abrir cámara" }).click();

	await expect(page.getByRole("button", { name: "Escanear otra" })).toBeVisible({ timeout: 40_000 });

	// Tras enganchar la hoja, la búsqueda se acota: menos trabajo por frame y marcas
	// más grandes en la imagen analizada.
	const seguimiento = page.getByTestId("seguimiento");
	await expect(seguimiento).toBeVisible();
	const porcentaje = Number((await seguimiento.textContent())?.replace("%", ""));
	expect(porcentaje).toBeGreaterThan(0);
	expect(porcentaje).toBeLessThan(100);
});

test("vuelve a abrir la cámara al escanear otra hoja", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: /^45 preguntas/ }).click();
	await page.getByRole("button", { name: "Abrir cámara" }).click();
	await expect(page.getByRole("button", { name: "Escanear otra" })).toBeVisible({ timeout: 40_000 });

	await page.getByRole("button", { name: "Escanear otra" }).click();

	// La cámara se vuelve a pedir y el escaneo arranca de nuevo, esta vez con el
	// detector ya cargado.
	await expect(page.locator(".marco.completa")).toBeVisible({ timeout: 20_000 });
	await expect(page.getByRole("button", { name: "Escanear otra" })).toBeVisible({ timeout: 40_000 });
});

test("vibra al enganchar la hoja y al terminar, y el interruptor la corta", async ({ page }) => {
	// `navigator.vibrate` no existe en el headless: se instala un espía antes de que
	// cargue la app.
	await page.addInitScript(() => {
		const registro: number[][] = [];
		(window as unknown as { vibraciones: number[][] }).vibraciones = registro;
		Object.defineProperty(navigator, "vibrate", {
			value: (pattern: number | number[]) => {
				registro.push(Array.isArray(pattern) ? pattern : [pattern]);
				return true;
			},
			configurable: true,
		});
	});

	await page.goto("/");
	await page.getByRole("button", { name: /^45 preguntas/ }).click();
	await page.getByRole("button", { name: "Abrir cámara" }).click();
	await expect(page.getByRole("button", { name: "Escanear otra" })).toBeVisible({ timeout: 40_000 });

	const conVibracion = await page.evaluate(() => (window as unknown as { vibraciones: number[][] }).vibraciones);
	expect(conVibracion.length).toBeGreaterThan(0);
	// El último aviso es el de "lectura lista": dos toques, distinto del enganche.
	expect(conVibracion[conVibracion.length - 1].length).toBeGreaterThan(1);

	await page.getByRole("button", { name: "← Formato" }).click();
	await interruptor(page, "Vibrar al enganchar").uncheck();
	await page.evaluate(() => ((window as unknown as { vibraciones: number[][] }).vibraciones.length = 0));

	await page.getByRole("button", { name: "Abrir cámara" }).click();
	await expect(page.getByRole("button", { name: "Escanear otra" })).toBeVisible({ timeout: 40_000 });

	const sinVibracion = await page.evaluate(() => (window as unknown as { vibraciones: number[][] }).vibraciones);
	expect(sinVibracion).toEqual([]);
});

test("al terminar salta a la tabla de respuestas", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: /^45 preguntas/ }).click();
	await page.getByRole("button", { name: "Abrir cámara" }).click();
	await expect(page.getByRole("button", { name: "Escanear otra" })).toBeVisible({ timeout: 40_000 });

	// La tabla tiene que quedar a la vista sin que el usuario deslice: venía de una
	// cámara a pantalla completa y las respuestas estaban abajo de todo.
	const primera = page.locator("li").first();
	await expect(primera).toBeInViewport({ timeout: 10_000 });

	const desplazamiento = await page.evaluate(() => window.scrollY);
	expect(desplazamiento).toBeGreaterThan(0);
});
