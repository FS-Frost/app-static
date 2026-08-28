import { compareVersions, fetchVersion, VERSION_URL, type VersionInfo, type VersionState } from "./version";

/** Cada cuánto se vuelve a mirar la marca de versión, en ms. */
const POLL_INTERVAL = 5 * 60 * 1000;

const STORAGE_KEY = "version-sha";

/**
 * Vigila la marca de versión del despliegue.
 *
 * Se mira al arrancar, cada cinco minutos y cada vez que la app vuelve al frente:
 * en un colegio la app queda abierta media mañana, y ese es justo el momento en que
 * un despliegue nuevo pasa desapercibido.
 */
export class VersionWatcher {
	/** Versión que corresponde al código que está corriendo. */
	running = $state<string>("");
	/** Última versión vista en el servidor. */
	latest = $state<string>("");
	state = $state<VersionState>("sin-cambios");

	#timer: ReturnType<typeof setInterval> | null = null;
	#url: string;

	constructor(url: string = VERSION_URL) {
		this.#url = url;
	}

	async start(): Promise<void> {
		const info = await this.#read();
		if (info == null) {
			return;
		}

		this.running = info.sha;
		this.latest = info.sha;

		const seen = this.#readStored();
		this.state = compareVersions(seen, this.running, this.latest);
		this.#store(info.sha);

		this.#timer ??= setInterval(() => void this.check(), POLL_INTERVAL);
		document.addEventListener("visibilitychange", this.#onVisible);
	}

	stop(): void {
		if (this.#timer != null) {
			clearInterval(this.#timer);
			this.#timer = null;
		}

		document.removeEventListener("visibilitychange", this.#onVisible);
	}

	/** Vuelve a leer la marca. Devuelve true si hay algo nuevo que avisar. */
	async check(): Promise<boolean> {
		const info = await this.#read();
		if (info == null) {
			return false;
		}

		this.latest = info.sha;
		const estado = compareVersions(this.#readStored(), this.running, this.latest);
		if (estado === "sin-cambios") {
			return false;
		}

		this.state = estado;
		return true;
	}

	dismiss(): void {
		this.state = "sin-cambios";
		this.#store(this.running);
	}

	#onVisible = (): void => {
		if (document.visibilityState === "visible") {
			void this.check();
		}
	};

	async #read(): Promise<VersionInfo | null> {
		return fetchVersion(this.#url);
	}

	#readStored(): string | null {
		try {
			return localStorage.getItem(STORAGE_KEY);
		} catch {
			return null;
		}
	}

	#store(sha: string): void {
		try {
			localStorage.setItem(STORAGE_KEY, sha);
		} catch {
			// Modo incógnito con almacenamiento bloqueado: se pierde el aviso, no la app.
		}
	}
}
