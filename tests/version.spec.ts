import { expect, test, type Page } from "@playwright/test";

/**
 * La marca de versión la escribe el workflow al desplegar. Acá se sirve a mano para
 * poder cambiarla a mitad de la sesión, que es justo el caso que importa: la app
 * queda abierta media mañana y el despliegue nuevo pasaría desapercibido.
 */
async function servidorDeVersion(page: Page, inicial: string): Promise<(sha: string) => void> {
	// Un solo manejador con el sha mutable: reemplazar la ruta a mitad de test deja
	// una ventana en la que la petición se va al archivo real.
	let actual = inicial;

	await page.route("**/version.json", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ sha: actual, date: "2026-08-28T12:00:00Z" }),
		})
	);

	return (sha: string) => {
		actual = sha;
	};
}

/** Espera a que la app haya leído y guardado la marca: si no, la comparación se corre antes de tiempo. */
async function esperarMarca(page: Page, sha: string): Promise<void> {
	await page.waitForFunction((esperado) => localStorage.getItem("version-sha") === esperado, sha, { timeout: 10_000 });
}

test("no avisa nada en la primera visita", async ({ page }) => {
	await servidorDeVersion(page, "aaaa111");
	await page.goto("/");
	await esperarMarca(page, "aaaa111");
	await expect(page.getByTestId("toast")).toHaveCount(0);
});

test("avisa que la app se actualizó cuando vuelve con otro sha", async ({ page }) => {
	const cambiarA = await servidorDeVersion(page, "aaaa111");
	await page.goto("/");
	await esperarMarca(page, "aaaa111");

	cambiarA("bbbb222");
	await page.reload();

	await expect(page.getByTestId("toast")).toContainText("Se actualizó la app a la versión bbbb222");
});

test("ofrece recargar cuando aparece una versión nueva con la app abierta", async ({ page }) => {
	const cambiarA = await servidorDeVersion(page, "aaaa111");
	await page.goto("/");
	await esperarMarca(page, "aaaa111");

	cambiarA("cccc333");

	// La app revisa al volver al frente: es cuando el usuario retoma el teléfono.
	await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

	const toast = page.getByTestId("toast");
	await expect(toast).toContainText("Hay una versión nueva (cccc333)");
	await expect(toast.getByRole("button", { name: "Recargar" })).toBeVisible();
});

test("el aviso se puede cerrar", async ({ page }) => {
	const cambiarA = await servidorDeVersion(page, "aaaa111");
	await page.goto("/");
	await esperarMarca(page, "aaaa111");

	cambiarA("dddd444");
	await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

	await expect(page.getByTestId("toast")).toBeVisible();
	await page.getByRole("button", { name: "Cerrar aviso" }).click();
	await expect(page.getByTestId("toast")).toHaveCount(0);
});
