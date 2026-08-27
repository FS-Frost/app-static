/**
 * Service worker del escáner.
 *
 * Dos cachés, porque el contenido tiene naturalezas distintas:
 *
 * - APP: el cascarón (HTML, JS, CSS). "Network first": si hay red se busca la
 *   versión fresca y, si no, se sirve la copia. Un despliegue nuevo se recoge sin
 *   dejar la app inservible en un colegio sin señal.
 *
 * - VENDOR: el build de OpenCV (2,5 MB con el wasm embebido) y los iconos.
 *   "Cache first": es inmutable para una versión dada, y volver a bajarlo en cada
 *   visita es justo lo que hace que el escáner tarde en abrir.
 */

const VERSION = "v1";
const APP_CACHE = `scanner-app-${VERSION}`;
const VENDOR_CACHE = `scanner-vendor-${VERSION}`;

const CURRENT_CACHES = [APP_CACHE, VENDOR_CACHE];

function isVendor(url) {
	return url.pathname.includes("/js/opencv") || url.pathname.endsWith(".png") || url.pathname.endsWith(".ico");
}

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(APP_CACHE);
			await cache.add(new Request("./", { cache: "reload" })).catch(() => {});

			// El detector se precachea aunque pese 2,5 MB: sin él la app abre y no
			// escanea, que es peor que no abrir. Y sólo se descarga cuando el usuario
			// empieza a escanear, así que esperar a que pase por el fetch handler deja
			// sin modo offline a quien instaló la app y todavía no leyó una hoja.
			const vendor = await caches.open(VENDOR_CACHE);
			await vendor
				.add(new Request("./js/opencv-custom-build.js", { cache: "reload" }))
				.catch(() => {});

			await self.skipWaiting();
		})()
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(keys.filter((key) => !CURRENT_CACHES.includes(key)).map((key) => caches.delete(key)));
			await self.clients.claim();
		})()
	);
});

self.addEventListener("message", (event) => {
	const data = event.data;
	if (data == null || data.type !== "warm-cache" || !Array.isArray(data.urls)) {
		return;
	}

	event.waitUntil(
		(async () => {
			for (const raw of data.urls) {
				try {
					const url = new URL(raw, self.location.href);
					const cacheName = isVendor(url) ? VENDOR_CACHE : APP_CACHE;
					const cache = await caches.open(cacheName);
					const hit = await cache.match(url.href);
					if (hit != null) {
						continue;
					}

					await cache.add(new Request(url.href, { cache: "reload" }));
				} catch {
					// Un recurso que no se pudo guardar no debe romper el resto.
				}
			}
		})()
	);
});

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") {
		return;
	}

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) {
		return;
	}

	if (isVendor(url)) {
		event.respondWith(cacheFirst(request, VENDOR_CACHE));
		return;
	}

	event.respondWith(networkFirst(request, APP_CACHE));
});

async function cacheFirst(request, cacheName) {
	const cache = await caches.open(cacheName);
	const hit = await cache.match(request, { ignoreSearch: true });
	if (hit != null) {
		return hit;
	}

	const response = await fetch(request);
	if (response.ok) {
		await cache.put(request, response.clone());
	}

	return response;
}

async function networkFirst(request, cacheName) {
	const cache = await caches.open(cacheName);

	try {
		const response = await fetch(request);
		if (response.ok) {
			await cache.put(request, response.clone());
		}

		return response;
	} catch (error) {
		const hit = await cache.match(request, { ignoreSearch: true });
		if (hit != null) {
			return hit;
		}

		// Navegación offline sin copia exacta: se sirve el documento raíz, que es
		// una SPA y sabe rearmar la vista sola.
		if (request.mode === "navigate") {
			const root = await cache.match("./", { ignoreSearch: true });
			if (root != null) {
				return root;
			}
		}

		throw error;
	}
}
