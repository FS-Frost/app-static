/**
 * Sirve `build/` bajo /app-static/, que es la forma que tiene el sitio en GitHub
 * Pages. Los tests de subruta y de modo offline corren contra esto: servir en la
 * raíz esconde justo los errores de rutas relativas y de alcance del service
 * worker.
 */

const BASE = "/app-static";
const PORT = Number(process.env.SUBPATH_PORT ?? 5055);

const tipos: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".ico": "image/x-icon",
	".y4m": "video/x-yuv4mpegvideo",
};

function tipoDe(ruta: string): string {
	const punto = ruta.lastIndexOf(".");
	return tipos[ruta.slice(punto)] ?? "application/octet-stream";
}

Bun.serve({
	port: PORT,
	async fetch(request) {
		const url = new URL(request.url);

		if (url.pathname === BASE) {
			return Response.redirect(`${BASE}/`, 301);
		}

		if (!url.pathname.startsWith(`${BASE}/`)) {
			return new Response("fuera de la base del sitio", { status: 404 });
		}

		let relativa = url.pathname.slice(BASE.length + 1);
		if (relativa === "" || relativa.endsWith("/")) {
			relativa += "index.html";
		}

		const archivo = Bun.file(`build/${relativa}`);
		if (!(await archivo.exists())) {
			return new Response("no existe", { status: 404 });
		}

		return new Response(archivo, {
			headers: {
				"content-type": tipoDe(relativa),
				// Sin caché HTTP: así el modo offline depende del service worker y no de
				// que el navegador se haya guardado algo por su cuenta.
				"cache-control": "no-store",
			},
		});
	},
});

console.log(`sirviendo build/ en http://localhost:${PORT}${BASE}/`);
