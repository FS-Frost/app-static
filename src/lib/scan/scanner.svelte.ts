import {
	areaRatio,
	guidance,
	nextZoom,
	quadBounds,
	roiFor,
	shouldAutoShoot,
	STILL_THRESHOLD,
	targetRect,
	type Guidance,
	type Rect,
	type ZoomRange,
} from "./assist";
import { lastTwoAgree, voteAnswers, type VoteResult } from "./classify";
import { getFormat, type FormatId, type SheetFormat } from "./format";
import type { Point, Quad } from "./geometry";
import { defaultAnchor, defaultCapture, type Anchor, type Capture } from "./strategy";

/**
 * Proporción del bloque de respuestas que se usa para la guía en pantalla: 0,70 en
 * la hoja de 45 y 0,75 en la de 80, así que un valor intermedio sirve para dibujar
 * el objetivo sin cambiarlo al vuelo.
 */
const ASPECT_GUIA = 0.72;
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

/** En modo foto sólo se sondea el encuadre, y para eso alcanza con menos frames. */
const PROBE_FPS = 6;

/** Ancho máximo del frame enviado al worker: sobre esto sólo se paga memoria. */
const MAX_FRAME_WIDTH = 1600;

/** Frames fallidos seguidos antes de soltar el seguimiento y volver a buscar en todo el cuadro. */
const TRACK_MISSES = 2;

/** Cada cuánto se toca el zoom de la cámara, en ms. Tocarlo seguido desenfoca. */
const ZOOM_INTERVAL = 500;

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
	/** Auto-encuadre: seguimiento, zoom, enfoque dirigido, guía y autodisparo. */
	assist = $state<boolean>(true);
	/** Cámara a pantalla completa mientras se escanea. */
	fullscreen = $state<boolean>(true);
	/** Vibrar al enganchar la hoja y al terminar la lectura. */
	vibration = $state<boolean>(true);
	/** Qué hacer para encuadrar mejor. */
	guidance = $state<Guidance>({ message: "", framed: false });
	/** Rectángulo donde conviene que caiga la hoja, en coordenadas del frame. */
	target = $state<Rect | null>(null);
	/** Zona que el worker analizó: si es distinta del frame, el seguimiento está activo. */
	searchRect = $state<Rect | null>(null);
	zoom = $state<number>(0);
	/** Frames procesados desde que se abrió la cámara. */
	framesTried = $state<number>(0);
	/** Milisegundos hasta la primera lectura válida. Es la métrica que importa al encuadrar. */
	msToFirstRead = $state<number>(0);
	/** Milisegundos desde que se pidió la cámara hasta tener la hoja leída. */
	msSinceCameraStart = $state<number>(0);
	/** Milisegundos entre capturar la imagen que sirvió y tener las respuestas. */
	msToDetect = $state<number>(0);
	/** true mientras el worker procesa un frame. */
	busy = $state<boolean>(false);

	format = $derived<SheetFormat>(getFormat(this.formatId));
	minVotes = $derived<number>(this.capture === "foto" ? MIN_VOTES_PHOTO : MIN_VOTES);

	#worker: Worker | null = null;
	#workerReady: Promise<void> | null = null;
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
	#roi: Rect | null = null;
	#misses = 0;
	#zoomRange: ZoomRange | null = null;
	#lastZoomAt = 0;
	#stillFrames = 0;
	#autoShotDone = false;
	#hadQuad = false;
	#scanStartedAt = 0;
	#cameraStartedAt = 0;
	#frameSentAt = 0;
	#lastFrameMs = 0;

	/**
	 * Arranca el worker antes de que haga falta.
	 *
	 * El detector son 2,5 MB de wasm: cargarlo recién al abrir la cámara le sumaba
	 * casi un segundo al tiempo hasta la primera lectura. Se llama al entrar a la app,
	 * mientras el usuario elige el formato.
	 */
	preload(): void {
		void this.#ensureWorker().catch(() => {
			// Si falla acá se reintenta al abrir la cámara, y ahí sí se avisa.
		});
	}

	/**
	 * Devuelve la promesa de que el worker esté listo, creándolo si hace falta.
	 *
	 * Una sola promesa compartida: si cada llamada resolviera por su cuenta al ver
	 * que el worker ya existe, mandaría frames mientras OpenCV todavía se carga y el
	 * worker los rechazaría.
	 */
	#ensureWorker(): Promise<void> {
		if (this.#workerReady == null) {
			this.#workerReady = this.#startWorker();
			this.#workerReady.catch(() => {
				this.#workerReady = null;
			});
		}

		return this.#workerReady;
	}

	async start(video: HTMLVideoElement, formatId: FormatId): Promise<void> {
		this.#stopScanning();
		this.formatId = formatId;
		this.reset();
		this.status = "cargando";
		this.message = "abriendo la cámara";
		this.#video = video;
		this.#cameraStartedAt = performance.now();

		// Cámara y detector se preparan en paralelo: son dos esperas independientes y
		// juntas eran la mayor parte del tiempo hasta la primera lectura.
		try {
			await Promise.all([this.#openCamera(video), this.#ensureWorker()]);
		} catch (error) {
			this.status = "error";
			this.message = error instanceof Error ? error.message : "no se pudo abrir la cámara";
			return;
		}

		this.status = "escaneando";
		this.#running = true;
		this.#scanStartedAt = performance.now();
		void this.#keepScreenAwake();

		if (this.capture === "foto") {
			this.message = this.assist ? "encuadra: disparo solo al estar quieta" : "encuadra y dispara";

			// Con asistencia el video igual se analiza, pero sólo para encuadrar: así se
			// puede decidir cuándo disparar. Sin asistencia no se toca la cámara hasta que
			// el usuario aprieta.
			if (this.assist) {
				this.#pump();
			}

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
		this.#stopScanning();
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
			await this.#ensureWorker();
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

	/** Detiene el escaneo y libera la cámara, pero conserva el worker ya cargado. */
	#cancelPump(): void {
		this.#running = false;

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
	}

	#stopScanning(): void {
		this.#imageSource?.close();
		this.#imageSource = null;
		this.#imageFramesLeft = 0;
		this.#releaseCamera();
		this.busy = false;

		if (this.status === "escaneando" || this.status === "cargando") {
			this.status = "idle";
		}
	}

	/** Cierra todo, worker incluido. Se usa al salir de la vista de escaneo. */
	stop(): void {
		this.#stopScanning();
		this.#worker?.terminate();
		this.#worker = null;
		this.#workerReady = null;
	}

	reset(): void {
		this.#history = [];
		this.answers = new Array(this.format.questions).fill("");
		this.votes = new Array(this.format.questions).fill(0);
		this.fills = [];
		this.progress = 0;
		this.framesTried = 0;
		this.msToFirstRead = 0;
		this.msSinceCameraStart = 0;
		this.msToDetect = 0;
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

		const video = this.#video;
		if (video == null) {
			return;
		}

		this.message = "apunta a la hoja completa";

		// Tras una lectura la cámara queda cerrada: hay que volver a pedirla. El worker
		// sigue cargado, así que esto es mucho más rápido que el primer arranque.
		if (this.#stream == null) {
			this.status = "cargando";
			this.message = "abriendo la cámara";
			this.#cameraStartedAt = performance.now();

			void this.#openCamera(video)
				.then(() => {
					this.status = "escaneando";
					this.message = "apunta a la hoja completa";
					this.#scanStartedAt = performance.now();
					void this.#keepScreenAwake();
					this.#pump();
				})
				.catch((error: unknown) => {
					this.status = "error";
					this.message = error instanceof Error ? error.message : "no se pudo abrir la cámara";
				});

			return;
		}

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
		this.#frameSentAt = performance.now();
		this.message = "leyendo la foto";

		try {
			const bitmap = await this.#grabPhoto(track, video);
			const request: ScanRequest = {
				type: "frame",
				frameId: ++this.#frameId,
				formatId: this.formatId,
				anchor: this.anchor,
				debug: this.debug,
				// La foto viene a otra resolución que el video, así que la zona de
				// seguimiento —medida en coordenadas del video— apuntaría a otro trozo de
				// la imagen. En una foto a resolución completa buscar en todo el cuadro
				// tampoco cuesta tanto.
				roi: null,
				read: true,
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
		const capabilities = track?.getCapabilities?.() as
			| { torch?: boolean; zoom?: ZoomRange; focusMode?: string[]; exposureMode?: string[] }
			| undefined;

		this.torch = {
			available: capabilities?.torch === true,
			on: false,
		};

		this.#zoomRange = capabilities?.zoom != null ? capabilities.zoom : null;
		this.zoom = (track?.getSettings?.() as { zoom?: number } | undefined)?.zoom ?? this.#zoomRange?.min ?? 0;

		// Enfoque y exposición continuos: buena parte de los "no se ven las marcas" es
		// la cámara enfocando el fondo o quemando el blanco del papel, no un encuadre
		// malo.
		const advanced: MediaTrackConstraintSet[] = [];
		if (capabilities?.focusMode?.includes("continuous") === true) {
			advanced.push({ focusMode: "continuous" });
		}

		if (capabilities?.exposureMode?.includes("continuous") === true) {
			advanced.push({ exposureMode: "continuous" });
		}

		if (advanced.length > 0) {
			try {
				await track.applyConstraints({ advanced });
			} catch {
				// Si el aparato no las acepta, se escanea igual.
			}
		}
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

					// Un fallo del detector se muestra: antes sólo se guardaba el mensaje y en
					// modo imagen, que no dibuja la barra de estado, el escaneo se quedaba
					// callado para siempre.
					this.status = "error";
					this.message = response.message;
					this.busy = false;
					this.#running = false;
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
		this.#frameSentAt = performance.now();
		this.busy = true;

		void createImageBitmap(source).then((bitmap) => {
			const request: ScanRequest = {
				type: "frame",
				frameId: ++this.#frameId,
				formatId: this.formatId,
				anchor: this.anchor,
				debug: this.debug,
				roi: this.assist ? this.#roi : null,
				read: true,
				bitmap,
			};

			worker.postMessage(request, [bitmap]);
		});
	}

	#onResult(result: FrameResult, debugImage: ImageBitmap | null): void {
		this.busy = false;
		this.framesTried++;

		// Cuánto tomó este frame desde que se capturó la imagen: incluye pasarla al
		// worker, no sólo el trabajo de OpenCV, que es lo que el usuario percibe.
		this.#lastFrameMs = this.#frameSentAt > 0 ? Math.round(performance.now() - this.#frameSentAt) : 0;

		if (result.ok && this.msToFirstRead === 0 && this.#scanStartedAt > 0) {
			this.msToFirstRead = Math.round(performance.now() - this.#scanStartedAt);
		}

		this.quad = result.quad;
		this.marks = result.marks;
		this.qrQuad = result.qrQuad;
		this.searchRect = result.searchRect;
		this.#updateAssist(result);
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

		// Un sondeo de encuadre no trae respuestas: no es una lectura fallida.
		if (this.capture === "foto" && !this.busy && result.fills.length === 0 && result.quad != null) {
			return;
		}

		if (!result.ok) {
			this.message = result.reason;

			// Si la foto no se pudo leer, se rearma el autodisparo para volver a intentar
			// cuando la mano se quede quieta otra vez.
			if (this.capture === "foto") {
				this.#autoShotDone = false;
				this.#stillFrames = 0;
			}

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

		// Atajo con asistencia: teléfono quieto y dos lecturas idénticas. Ahorra el
		// tercer voto, que es medio segundo de espera con la hoja ya leída.
		if (this.assist && result.motion <= STILL_THRESHOLD && lastTwoAgree(this.#history)) {
			this.answers = this.#history[this.#history.length - 1];
			this.progress = 1;
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

	/**
	 * Auto-encuadre. Todo se decide con lo que trajo el frame: dónde buscar el
	 * siguiente, cuánto acercar la cámara, qué decirle al usuario y si disparar.
	 */
	#updateAssist(result: FrameResult): void {
		const frame = { width: result.frameWidth, height: result.frameHeight };
		this.target = targetRect(frame, ASPECT_GUIA);

		// Con una imagen fija no hay nada que asistir: el encuadre ya está decidido, y
		// seguir la hoja o pedir "acércate" sólo estorbaría.
		if (this.#imageSource != null) {
			this.guidance = { message: "", framed: result.ok };
			this.#roi = null;
			return;
		}

		if (!this.assist) {
			this.guidance = { message: "", framed: result.ok };
			this.#roi = null;
			return;
		}

		this.guidance = guidance({
			quad: result.quad,
			marks: result.marks,
			frame,
			aspect: ASPECT_GUIA,
		});

		// Seguimiento: la próxima búsqueda se acota a donde estaba la hoja, y se suelta
		// después de dos frames sin encontrarla para no quedar pegado a una zona vacía.
		if (result.quad != null) {
			this.#roi = roiFor(result.quad, frame);
			this.#misses = 0;
		} else if (result.hintRoi != null) {
			// No se ubicó la hoja pero sí el QR, que se ve de más lejos: la próxima
			// búsqueda se acota a donde el QR dice que está el bloque, y ahí las marcas
			// aparecen mucho más grandes en la imagen analizada.
			this.#roi = result.hintRoi;
			this.#misses = 0;
		} else {
			this.#misses++;
			if (this.#misses >= TRACK_MISSES) {
				this.#roi = null;
			}
		}

		if (result.quad != null && !this.#hadQuad) {
			// Un toque corto al enganchar la hoja: permite encuadrar sin mirar la pantalla.
			this.#vibrate(25);
		}

		this.#hadQuad = result.quad != null;

		this.#stillFrames = result.motion <= STILL_THRESHOLD ? this.#stillFrames + 1 : 0;

		if (result.quad != null) {
			void this.#followWithCamera(result.quad, frame);
		}

		if (
			this.capture === "foto" &&
			!this.#autoShotDone &&
			shouldAutoShoot(this.#stillFrames, this.guidance.framed)
		) {
			this.#autoShotDone = true;
			void this.shoot();
		}
	}

	/**
	 * Acerca la cámara y le dice dónde enfocar.
	 *
	 * El zoom se mueve de a poco y no más de dos veces por segundo: cada cambio
	 * reenfoca y mueve la imagen, y hacerlo seguido es peor que no hacerlo.
	 */
	async #followWithCamera(quad: Quad, frame: { width: number; height: number }): Promise<void> {
		const track = this.#stream?.getVideoTracks()[0];
		if (track == null) {
			return;
		}

		const bounds = quadBounds(quad);
		const centro = {
			x: Math.min(1, Math.max(0, (bounds.x + bounds.width / 2) / frame.width)),
			y: Math.min(1, Math.max(0, (bounds.y + bounds.height / 2) / frame.height)),
		};

		const advanced: MediaTrackConstraintSet[] = [{ pointsOfInterest: [centro] }];

		const now = performance.now();
		if (this.#zoomRange != null && now - this.#lastZoomAt > ZOOM_INTERVAL) {
			const ratio = areaRatio(bounds, targetRect(frame, ASPECT_GUIA));
			const siguiente = nextZoom(this.zoom || this.#zoomRange.min, ratio, this.#zoomRange);
			if (Math.abs(siguiente - this.zoom) >= this.#zoomRange.step) {
				this.zoom = siguiente;
				this.#lastZoomAt = now;
				advanced.push({ zoom: siguiente });
			}
		}

		try {
			await track.applyConstraints({ advanced });
		} catch {
			// Muchos teléfonos anuncian estas capacidades y rechazan la constraint. No es
			// motivo para dejar de escanear: la asistencia es ayuda, no requisito.
		}
	}

	#finish(): void {
		this.#running = false;
		this.msToDetect = this.#lastFrameMs;
		this.msSinceCameraStart =
			this.#cameraStartedAt > 0 ? Math.round(performance.now() - this.#cameraStartedAt) : 0;

		// Con la hoja leída la cámara no aporta nada y sí gasta batería y calienta el
		// teléfono. Se suelta acá; "Escanear otra" la vuelve a abrir, y para entonces
		// el detector ya está cargado.
		this.#releaseCamera();

		this.status = "listo";
		this.message = "lectura estable";

		// Dos toques al terminar: se distingue del toque corto de "enganché la hoja"
		// sin mirar la pantalla.
		this.#vibrate([60, 60, 120]);
	}

	/**
	 * Vibra si el usuario lo dejó activado y el aparato lo soporta.
	 *
	 * iOS no implementa `navigator.vibrate`, así que esto es silencioso ahí: la
	 * vibración es refuerzo, nunca la única señal de que algo pasó.
	 */
	#vibrate(pattern: number | number[]): void {
		if (!this.vibration) {
			return;
		}

		navigator.vibrate?.(pattern);
	}

	/** Suelta la cámara y el bombeo de frames, sin tocar el worker ni el resultado. */
	#releaseCamera(): void {
		this.#cancelPump();

		for (const track of this.#stream?.getTracks() ?? []) {
			track.stop();
		}

		this.#stream = null;
		this.torch = { available: false, on: false };
		void this.#wakeLock?.release();
		this.#wakeLock = null;

		if (this.#video != null) {
			this.#video.srcObject = null;
		}
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

		const probe = this.capture === "foto";
		const now = performance.now();
		if (now - this.#lastSentAt < 1000 / (probe ? PROBE_FPS : TARGET_ANALYSIS_FPS)) {
			return;
		}

		this.#lastSentAt = now;
		this.#frameSentAt = now;
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
				roi: this.assist ? this.#roi : null,
				read: !probe,
				bitmap,
			};

			worker.postMessage(request, [bitmap]);
		} catch {
			this.busy = false;
		}
	}
}
