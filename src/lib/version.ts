/**
 * Marca de versión del despliegue.
 *
 * El workflow escribe `version.json` con el short-sha del commit. La app lo lee al
 * arrancar y cada tanto: si cambió respecto de lo que tiene cargado, avisa. Es la
 * única forma de enterarse en una PWA — el service worker sirve el cascarón desde
 * caché y el usuario puede pasar días con la versión vieja sin notarlo.
 */

export type VersionInfo = {
	/** Short-sha del commit desplegado. */
	sha: string;
	/** Cuándo se generó, en ISO. Vacío si el despliegue no lo puso. */
	date: string;
};

export function parseVersion(raw: unknown): VersionInfo | null {
	if (raw == null || typeof raw !== "object") {
		return null;
	}

	const objeto = raw as Record<string, unknown>;
	const sha = typeof objeto.sha === "string" ? objeto.sha.trim() : "";
	if (sha === "") {
		return null;
	}

	return {
		sha,
		date: typeof objeto.date === "string" ? objeto.date : "",
	};
}

/**
 * Qué avisar según lo que se leyó.
 *
 * - `actualizada`: el código que corre es más nuevo que la última visita. Ya está
 *   aplicada, así que sólo se informa.
 * - `disponible`: apareció una versión nueva mientras la app estaba abierta. Esa sí
 *   necesita recargar.
 */
export type VersionState = "sin-cambios" | "actualizada" | "disponible";

export function compareVersions(seen: string | null, running: string, latest: string): VersionState {
	if (latest !== "" && running !== "" && latest !== running) {
		return "disponible";
	}

	if (seen != null && seen !== "" && running !== "" && seen !== running) {
		return "actualizada";
	}

	return "sin-cambios";
}

/** Dónde vive la marca, relativo al documento: el sitio cuelga de un subdirectorio. */
export const VERSION_URL = "version.json";

/**
 * Lee la marca saltándose la caché HTTP.
 *
 * Sin `no-store` el navegador puede devolver la copia vieja durante minutos y el
 * aviso llegaría tarde o nunca.
 */
export async function fetchVersion(url: string = VERSION_URL): Promise<VersionInfo | null> {
	try {
		const response = await fetch(url, { cache: "no-store" });
		if (!response.ok) {
			return null;
		}

		return parseVersion(await response.json());
	} catch {
		// Sin red no hay nada que comparar, y no es un error que valga la pena mostrar.
		return null;
	}
}
