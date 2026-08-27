import { voteAnswers, type VoteResult } from "./classify";
import { getFormat, type FormatId, type SheetFormat } from "./format";
import type { Point, Quad } from "./geometry";
import { defaultAnchor, defaultCapture, type Anchor, type Capture } from "./strategy";
import type { FrameResult, FrameTiming, ScanRequest, ScanResponse } from "./protocol";
import ScanWorker from "./worker?worker";

export type ScannerStatus = "idle" | "cargando" | "escaneando" | "listo" | "error";

/** Lecturas que se guardan para votar. */
export const HISTORY_SIZE = 6;

/** Lecturas coincidentes que necesita una pregunta para darse por buena. */
export const MIN_VOTES = 3;

/**
 * En modo foto no hay consenso posible: hay una sola imagen, a máxima resolución y
 * ya enfocada. Repetirla tres veces daría exactamente el mismo resultado.
 */
export const MIN_VOTES_PHOTO = 1;

/** Frames por segundo que se envían al worker. Más que esto no mejora el consenso. */
const TARGET_ANALYSIS_FPS = 12;

/** Ancho máximo del frame enviado al worker: sobre esto sólo se paga memoria. */
const MAX_FRAME_WIDTH = 1600;

/**
 * URL base del sitio, con la barra final.
 *
 * SvelteKit emite rutas relativas al documento, así que el sitio funciona en
 * cualquier subdirectorio de GitHub Pages; el worker, en cambio, necesita una URL
 * absoluta para `importScripts`, y hay que armarla igual que la resolvería el
 * navegador para un `src` relativo.
 */
function siteBaseUrl(): string {
	return document.baseURI.replace(/[^/]*$/, "");
}

type ImageCaptureLike = {
	takePhoto(): Promise<Blob>;
};

export type TorchState = {
	available: boolean;
	on: boolean;
};

export class Scanner {
	status = $state<ScannerStatus>("idle");
	message = $state<string>("");
	/** Motivo o resumen del último frame procesado. Sólo interesa depurando. */
	lastReason = $state<string>("");
	formatId = $state<FormatId>("45");
	anchor = $state<Anchor>(defaultAnchor);
	capture = $state<Capture>(defaultCapture);
	debug = $state<boolean>(false);
	answers = $state<string[]>([]);
	votes = $state<number[]>([]);
	progress = $state<number>(0);
	quad = $state<Quad | null>(null);
	marks = $state<Point[]>([]);
	qrQuad = $state<Quad | null>(null);
	frameSize = $state<{ width: number; height: number }>({ width: 0, height: 0 });
	timing = $state<FrameTiming>({ total: 0, locate: 0, warp: 0, read: 0 });
	analysisFps = $state<number>(0);
	fills = $state<number[][]>([]);
	debugImage = $state<ImageBitmap | null>(null);
	torch = $state<TorchState>({ available: false, on: false });
	/** true mientras el worker procesa un frame. */
	busy = $state<boolean>(false);

	format = $derived<SheetFormat>(getFormat(this.formatId));
	minVotes = $derived<number>(this.capture === "foto" ? MIN_VOTES_PHOTO : MIN_VOTES);

	#worker: Worker | null = null;
	#video: HTMLVideoElement | null = null;
	#stream: MediaStream | null = null;
	#history: string[][] = [];
	#frameId = 0;
	#lastSentAt = 0;
	#lastResultAt = 0;
	#pumpHandle: number | null = null;
	#running = false;
	#imageSource: ImageBitmap | null = null;
	#imageFramesLeft = 0;
	#wakeLock: WakeLockSentinel | null = null;

	async start(video: HTMLVideoElement, formatId: FormatId): Promise<void> {
		this.stop();
		this.formatId = formatId;
		this.reset();
		this.status = "cargando";
		this.message = "abriendo la cámara";
		this.#video = video;

		try {
			await this.#openCamera(video);
		} catch (error) {
			this.status = "error";
			this.message = error instanceof Error ? error.message : "no se pudo abrir la cámara";
			return;
		}

		this.message = "cargando el detector";

		try {
			await this.#startWorker();
		} catch (error) {
			this.status = "error";
			this.message = error instanceof Error ? error.message : "no se pudo cargar el detector";
			return;
		}

		this.status = "escaneando";
		this.#running = true;
		void this.#keepScreenAwake();

		if (this.capture === "foto") {
			this.message = "encuadra y dispara";
			return;
		}

		this.message = "apunta a la hoja completa";
		this.#pump();
	}

	/**
	 * Escanea una imagen fija en vez de la cámara: una foto de la galería o un
	 * escaneo guardado.
	 *
	 * Mismo pipeline y misma votación (la imagen se manda varias veces), así que
	 * también es el modo con el que se prueba el detector sin hoja ni teléfono y una
	 * regresión en la geometría se ve en el escritorio.
	 */
	async startWithImage(file: Blob, formatId: FormatId): Promise<void> {
		this.stop();
		this.formatId = formatId;
		this.reset();
		this.status = "cargando";
		this.message = "cargando la imagen de prueba";

		try {
			this.#imageSource = await createImageBitmap(file);
		} catch (error) {
			this.status = "error";
			this.message = error instanceof Error ? error.message : "no se pudo cargar la imagen";
			return;
		}

		this.message = "cargando el detector";

		try {
			await this.#startWorker();
		} catch (error) {
			this.status = "error";
			this.message = error instanceof Error ? error.message : "no se pudo cargar el detector";
			return;
		}

		this.status = "escaneando";
		this.message = "leyendo la imagen de prueba";
		this.#running = true;
		this.#imageFramesLeft = MIN_VOTES;
		this.#sendImageFrame();
	}

	stop(): void {
		this.#running = false;
		void this.#wakeLock?.release();
		this.#wakeLock = null;
		this.#imageSource?.close();
		this.#imageSource = null;
		this.#imageFramesLeft = 0;

		if (this.#pumpHandle != null && this.#video != null) {
			const video = this.#video as HTMLVideoElement & {
				cancelVideoFrameCallback?: (handle: number) => void;
			};

			if (typeof video.cancelVideoFrameCallback === "function") {
				video.cancelVideoFrameCallback(this.#pumpHandle);
			} else {
				cancelAnimationFrame(this.#pumpHandle);
			}
		}

		this.#pumpHandle = null;

		for (const track of this.#stream?.getTracks() ?? []) {
			track.stop();
		}

		this.#stream = null;

		if (this.#video != null) {
			this.#video.srcObject = null;
		}

		this.#worker?.terminate();
		this.#worker = null;
		this.busy = false;
		this.torch = { available: false, on: false };

		if (this.status === "escaneando" || this.status === "cargando") {
			this.status = "idle";
		}
	}

	reset(): void {
		this.#history = [];
		this.answers = new Array(this.format.questions).fill("");
		this.votes = new Array(this.format.questions).fill(0);
		this.fills = [];
		this.progress = 0;
		this.quad = null;
		this.marks = [];
		this.qrQuad = null;
		this.debugImage?.close();
		this.debugImage = null;
	}

	/** Vuelve a escanear sin reabrir la cámara ni recargar OpenCV. */
	rescan(): void {
		this.reset();
		if (this.#worker == null) {
			return;
		}

		this.status = "escaneando";
		this.#running = true;

		// En modo imagen no hay frames que bombear: se reenvía la misma imagen. Sirve
		// para releer con otra configuración (por ejemplo, con depuración activada).
		if (this.#imageSource != null) {
			this.message = "leyendo la imagen";
			this.#imageFramesLeft = MIN_VOTES;
			this.#sendImageFrame();
			return;
		}

		if (this.#video == null) {
			return;
		}

		this.message = "apunta a la hoja completa";
		this.#pump();
	}

	/**
	 * Dispara una foto y la lee.
	 *
	 * `ImageCapture.takePhoto` da la resolución completa del sensor, muy por encima
	 * de la del stream de video: la hoja puede ocupar bastante menos del cuadro y las
	 * burbujas siguen nítidas, que es justo lo que cuesta al encuadrar a pulso. Si el
	 * navegador no lo trae, se cae al frame de video a resolución completa.
	 */
	async shoot(): Promise<void> {
		const track = this.#stream?.getVideoTracks()[0];
		const video = this.#video;
		if (track == null || video == null || this.busy || this.#worker == null) {
			return;
		}

		this.busy = true;
		this.message = "leyendo la foto";

		try {
			const bitmap = await this.#grabPhoto(track, video);
			const request: ScanRequest = {
				type: "frame",
				frameId: ++this.#frameId,
				formatId: this.formatId,
				anchor: this.anchor,
				debug: this.debug,
				bitmap,
			};

			this.#worker.postMessage(request, [bitmap]);
		} catch (error) {
			this.busy = false;
			this.message = error instanceof Error ? error.message : "no se pudo tomar la foto";
		}
	}

	async #grabPhoto(track: MediaStreamTrack, video: HTMLVideoElement): Promise<ImageBitmap> {
		const constructor = (globalThis as unknown as { ImageCapture?: new (track: MediaStreamTrack) => ImageCaptureLike })
			.ImageCapture;

		if (constructor != null) {
			try {
				const capture = new constructor(track);
				const blob = await capture.takePhoto();
				return await createImageBitmap(blob);
			} catch {
				// Varios teléfonos exponen ImageCapture y fallan al disparar; el frame de
				// video sigue siendo mejor que nada.
			}
		}

		return createImageBitmap(video);
	}

	async toggleTorch(): Promise<void> {
		const track = this.#stream?.getVideoTracks()[0];
		if (track == null || !this.torch.available) {
			return;
		}

		const next = !this.torch.on;

		try {
			// `torch` no está en el tipo estándar de MediaTrackConstraintSet, pero es
			// la única forma de encender el flash en Android.
			await track.applyConstraints({ advanced: [{ torch: next }] } as MediaTrackConstraints);
			this.torch = { available: true, on: next };
		} catch {
			this.torch = { available: false, on: false };
		}
	}

	/**
	 * Evita que la pantalla se apague mientras se escanea: corregir una tanda de
	 * hojas son minutos con el teléfono en la mano y sin tocarlo.
	 */
	async #keepScreenAwake(): Promise<void> {
		try {
			this.#wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
		} catch {
			// No todos los navegadores lo permiten; no es motivo para no escanear.
			this.#wakeLock = null;
		}
	}

	async #openCamera(video: HTMLVideoElement): Promise<void> {
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: false,
			video: {
				facingMode: { ideal: "environment" },
				width: { ideal: 1920 },
				height: { ideal: 1080 },
				frameRate: { ideal: 30 },
			},
		});

		this.#stream = stream;
		video.srcObject = stream;
		video.playsInline = true;
		video.muted = true;
		await video.play();

		const track = stream.getVideoTracks()[0];
		const capabilities = track?.getCapabilities?.() as { torch?: boolean } | undefined;
		this.torch = {
			available: capabilities?.torch === true,
			on: false,
		};
	}

	#startWorker(): Promise<void> {
		return new Promise((resolve, reject) => {
			const worker = new ScanWorker();
			this.#worker = worker;

			worker.onmessage = (event: MessageEvent<ScanResponse>) => {
				const response = event.data;

				if (response.type === "ready") {
					resolve();
					return;
				}

				if (response.type === "error") {
					if (this.status === "cargando") {
						reject(new Error(response.message));
						return;
					}

					this.message = response.message;
					this.busy = false;
					return;
				}

				this.#onResult(response.result, response.debugImage);
			};

			worker.onerror = (event: ErrorEvent) => {
				reject(new Error(event.message || "el worker del detector falló"));
			};

			const request: ScanRequest = {
				type: "init",
				opencvUrl: `${siteBaseUrl()}js/opencv-custom-build.js`,
			};

			worker.postMessage(request);
		});
	}

	/**
	 * Manda una copia del ImageBitmap de prueba. Hay que clonarlo porque el envío
	 * al worker lo transfiere y lo deja inservible en este lado.
	 */
	#sendImageFrame(): void {
		const worker = this.#worker;
		const source = this.#imageSource;
		if (worker == null || source == null || this.#imageFramesLeft <= 0) {
			return;
		}

		this.#imageFramesLeft--;
		this.busy = true;

		void createImageBitmap(source).then((bitmap) => {
			const request: ScanRequest = {
				type: "frame",
				frameId: ++this.#frameId,
				formatId: this.formatId,
				anchor: this.anchor,
				debug: this.debug,
				bitmap,
			};

			worker.postMessage(request, [bitmap]);
		});
	}

	#onResult(result: FrameResult, debugImage: ImageBitmap | null): void {
		this.busy = false;
		this.quad = result.quad;
		this.marks = result.marks;
		this.qrQuad = result.qrQuad;
		this.timing = result.timing;
		this.frameSize = { width: result.frameWidth, height: result.frameHeight };

		const now = performance.now();
		if (this.#lastResultAt > 0) {
			const delta = now - this.#lastResultAt;
			this.analysisFps = delta > 0 ? Math.round(1000 / delta) : 0;
		}

		this.#lastResultAt = now;

		if (debugImage != null) {
			this.debugImage?.close();
			this.debugImage = debugImage;
		}

		this.lastReason = result.reason;

		if (!result.ok) {
			this.message = result.reason;
			if (this.#imageSource != null) {
				this.#imageFramesLeft = 0;
				this.status = "error";
			}

			return;
		}

		this.fills = result.fills;
		this.#history.push(result.answers);
		if (this.#history.length > HISTORY_SIZE) {
			this.#history.shift();
		}

		const vote: VoteResult = voteAnswers(this.#history, this.format.questions, this.minVotes);
		this.answers = vote.answers;
		this.votes = vote.votes;
		this.progress = vote.progress;

		if (vote.stable) {
			this.#finish();
			return;
		}

		if (this.#imageSource != null) {
			this.#sendImageFrame();
			this.message = "leyendo la imagen de prueba";
			return;
		}

		this.message = this.capture === "foto" ? "vuelve a disparar" : "sostén la hoja quieta";
	}

	#finish(): void {
		this.#running = false;
		this.status = "listo";
		this.message = "lectura estable";
		navigator.vibrate?.(120);
	}

	#pump(): void {
		const video = this.#video;
		if (video == null) {
			return;
		}

		const step = (): void => {
			if (!this.#running) {
				return;
			}

			void this.#maybeSendFrame(video);
			this.#scheduleNextFrame(video, step);
		};

		this.#scheduleNextFrame(video, step);
	}

	#scheduleNextFrame(video: HTMLVideoElement, step: () => void): void {
		const withCallback = video as HTMLVideoElement & {
			requestVideoFrameCallback?: (callback: () => void) => number;
		};

		if (typeof withCallback.requestVideoFrameCallback === "function") {
			this.#pumpHandle = withCallback.requestVideoFrameCallback(step);
			return;
		}

		this.#pumpHandle = requestAnimationFrame(step);
	}

	async #maybeSendFrame(video: HTMLVideoElement): Promise<void> {
		const worker = this.#worker;
		if (worker == null || this.busy || video.readyState < 2) {
			return;
		}

		const now = performance.now();
		if (now - this.#lastSentAt < 1000 / TARGET_ANALYSIS_FPS) {
			return;
		}

		this.#lastSentAt = now;
		this.busy = true;

		try {
			const width = Math.min(video.videoWidth, MAX_FRAME_WIDTH);
			const height = Math.round((width / video.videoWidth) * video.videoHeight);
			const bitmap = await createImageBitmap(video, {
				resizeWidth: width,
				resizeHeight: height,
				resizeQuality: "medium",
			});

			const request: ScanRequest = {
				type: "frame",
				frameId: ++this.#frameId,
				formatId: this.formatId,
				anchor: this.anchor,
				debug: this.debug,
				bitmap,
			};

			worker.postMessage(request, [bitmap]);
		} catch {
			this.busy = false;
		}
	}
}
