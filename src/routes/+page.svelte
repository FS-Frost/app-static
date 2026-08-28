<script lang="ts">
	import AnswerSheet from "$lib/gui/AnswerSheet.svelte";
	import CameraView from "$lib/gui/CameraView.svelte";
	import DebugPanel from "$lib/gui/DebugPanel.svelte";
	import FormatPicker from "$lib/gui/FormatPicker.svelte";
	import { answersToCsv, answersToText } from "$lib/scan/classify";
	import { ANCHORS, type Anchor } from "$lib/scan/strategy";
	import { isFormatId, type FormatId } from "$lib/scan/format";
	import { Scanner } from "$lib/scan/scanner.svelte";
	import { isAnchor, isCapture } from "$lib/scan/strategy";
	import Toast from "$lib/gui/Toast.svelte";
	import { VersionWatcher } from "$lib/version.svelte";
	import { onMount, tick } from "svelte";

	type Vista = "formato" | "camara" | "imagen";

	const scanner = new Scanner();
	const version = new VersionWatcher();

	let vista = $state<Vista>("formato");
	let formatId = $state<FormatId>("45");
	let camara = $state<CameraView | null>(null);
	let iniciado = $state<boolean>(false);
	let copiado = $state<boolean>(false);
	let imagen = $state<File | null>(null);
	let resultado = $state<HTMLDivElement | null>(null);
	let desplazado = $state<boolean>(false);

	// Formato y preferencias sobreviven a un cierre de la app: en un colegio se
	// corrigen muchas hojas seguidas y nadie quiere volver a elegir todo.
	$effect(() => {
		const formatoGuardado = localStorage.getItem("formato");
		if (formatoGuardado != null && isFormatId(formatoGuardado)) {
			formatId = formatoGuardado;
		}

		const anclaGuardada = localStorage.getItem("ancla");
		if (anclaGuardada != null && isAnchor(anclaGuardada)) {
			scanner.anchor = anclaGuardada;
		}

		const capturaGuardada = localStorage.getItem("captura");
		if (capturaGuardada != null && isCapture(capturaGuardada)) {
			scanner.capture = capturaGuardada;
		}

		const asistenciaGuardada = localStorage.getItem("asistencia");
		if (asistenciaGuardada != null) {
			scanner.assist = asistenciaGuardada === "1";
		}

		const pantallaGuardada = localStorage.getItem("pantalla-completa");
		if (pantallaGuardada != null) {
			scanner.fullscreen = pantallaGuardada === "1";
		}

		const vibracionGuardada = localStorage.getItem("vibracion");
		if (vibracionGuardada != null) {
			scanner.vibration = vibracionGuardada === "1";
		}
	});

	$effect(() => {
		localStorage.setItem("formato", formatId);
		localStorage.setItem("ancla", scanner.anchor);
		localStorage.setItem("captura", scanner.capture);
		localStorage.setItem("asistencia", scanner.assist ? "1" : "0");
		localStorage.setItem("pantalla-completa", scanner.fullscreen ? "1" : "0");
		localStorage.setItem("vibracion", scanner.vibration ? "1" : "0");
	});

	onMount(() => {
		void version.start();
		return () => version.stop();
	});

	// El detector se empieza a cargar en cuanto se abre la app: son 2,5 MB de wasm y
	// si se espera al "Abrir cámara", ese segundo lo paga el usuario mirando la
	// pantalla.
	$effect(() => {
		scanner.preload();
	});

	$effect(() => {
		if (iniciado) {
			return;
		}

		if (vista === "imagen" && imagen != null) {
			iniciado = true;
			void scanner.startWithImage(imagen, formatId);
			return;
		}

		if (vista === "camara" && camara != null) {
			iniciado = true;
			void scanner.start(camara.getVideo(), formatId);
		}
	});

	function getAnchor(id: Anchor) {
		return ANCHORS.find((opcion) => opcion.id === id) ?? ANCHORS[0];
	}

	/**
	 * Al terminar la lectura, la vista salta a las respuestas.
	 *
	 * Con la cámara a pantalla completa el salto es obligatorio: el video ocupaba
	 * todo y la tabla queda fuera de la pantalla. Se espera a que el DOM se
	 * reacomode —la sección deja de ser fija— o se desplaza a la posición vieja. Y se
	 * respeta `prefers-reduced-motion`, que para algunas personas un scroll animado
	 * es mareo.
	 */
	$effect(() => {
		if (scanner.status !== "listo") {
			desplazado = false;
			return;
		}

		if (desplazado || resultado == null) {
			return;
		}

		desplazado = true;
		const suave = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

		void tick().then(() => {
			resultado?.scrollIntoView({ behavior: suave ? "smooth" : "auto", block: "start" });
		});
	});

	// Pantalla completa sólo mientras se escanea: al terminar hay que ver las
	// respuestas, no el video.
	const aPantallaCompleta = $derived<boolean>(
		vista === "camara" && scanner.fullscreen && scanner.status !== "listo"
	);

	function volver(): void {
		scanner.stop();
		iniciado = false;
		vista = "formato";
	}

	async function copiar(): Promise<void> {
		await navigator.clipboard.writeText(answersToText(scanner.answers));
		copiado = true;
		setTimeout(() => (copiado = false), 1500);
	}

	function descargar(): void {
		const csv = answersToCsv(scanner.answers);
		const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
		const enlace = document.createElement("a");
		enlace.href = url;
		enlace.download = `respuestas-${scanner.format.questions}.csv`;
		enlace.click();
		URL.revokeObjectURL(url);
	}
</script>

<svelte:head>
	<title>Escáner de respuestas</title>
	<meta name="description" content="Lectura de hojas de respuestas con la cámara, sin servidor." />
</svelte:head>

{#if version.state !== "sin-cambios"}
	<Toast
		message={version.state === "disponible"
			? `Hay una versión nueva (${version.latest}). Recarga para usarla.`
			: `Se actualizó la app a la versión ${version.running}.`}
		actionLabel={version.state === "disponible" ? "Recargar" : undefined}
		onaction={version.state === "disponible" ? () => location.reload() : undefined}
		ondismiss={() => version.dismiss()}
	/>
{/if}

{#if vista === "formato"}
	<FormatPicker
		bind:formatId
		bind:anchor={scanner.anchor}
		bind:capture={scanner.capture}
		bind:assist={scanner.assist}
		bind:fullscreen={scanner.fullscreen}
		bind:vibration={scanner.vibration}
		bind:debug={scanner.debug}
		onstart={() => (vista = "camara")}
		ontest={(archivo) => {
			imagen = archivo;
			vista = "imagen";
		}}
	/>
{:else}
	<section class="escaneo" class:completa={aPantallaCompleta}>
		<header>
			<button type="button" class="secundario" onclick={volver}>← Formato</button>
			<span class="titulo">
				{scanner.format.questions} preguntas · {vista === "imagen" ? "imagen" : getAnchor(scanner.anchor).label}
			</span>
			<label class="toggle">
				<input type="checkbox" bind:checked={scanner.debug} />
				<span>Depurar</span>
			</label>
		</header>

		{#if vista === "camara"}
			<CameraView bind:this={camara} {scanner} fill={aPantallaCompleta} />
		{/if}

		<div class="acciones">
			{#if aPantallaCompleta}
				<button type="button" class="secundario" onclick={volver}>← Formato</button>
			{/if}

			<!-- El botón sólo aparece con la cámara ya abierta: apretarlo mientras carga
			     no hacía nada y parecía que la app se colgaba. -->
			{#if vista === "camara" && scanner.capture === "foto" && scanner.status === "escaneando"}
				<button type="button" class="primario" disabled={scanner.busy} onclick={() => scanner.shoot()}>
					{scanner.busy ? "Leyendo…" : scanner.assist ? "Disparar ahora" : "Tomar foto"}
				</button>
			{/if}

			{#if scanner.torch.available}
				<button type="button" class="secundario" onclick={() => scanner.toggleTorch()}>
					{scanner.torch.on ? "Apagar flash" : "Encender flash"}
				</button>
			{/if}

			{#if scanner.status === "listo"}
				<button type="button" class="primario" onclick={() => scanner.rescan()}>Escanear otra</button>
				<button type="button" class="secundario" onclick={copiar}>{copiado ? "Copiado" : "Copiar"}</button>
				<button type="button" class="secundario" onclick={descargar}>CSV</button>
			{/if}

		</div>

		<div class="resultado" bind:this={resultado}>
			{#if scanner.status === "listo"}
				<!-- Con la hoja leída la cámara ya se cerró: quedan los tiempos, que son lo
				     que se mira para decidir si el encuadre valió la pena. -->
				<p class="tiempos" data-testid="tiempos">
					<span>Cámara abierta → lectura: <strong>{(scanner.msSinceCameraStart / 1000).toFixed(1)} s</strong></span>
					<span>Detección desde la captura: <strong>{scanner.msToDetect} ms</strong></span>
				</p>
			{/if}

			{#if scanner.status === "error"}
				<p class="error">{scanner.message}</p>
			{/if}

			<AnswerSheet
				format={scanner.format}
				answers={scanner.answers}
				votes={scanner.votes}
				minVotes={scanner.minVotes}
			/>
		</div>

		{#if scanner.debug}
			<DebugPanel {scanner} />
		{/if}
	</section>
{/if}

<style>
	/* Pantalla completa: la sección tapa todo y sólo quedan el video y los botones
	   flotando abajo. El resto (cabecera, tabla de respuestas, panel de depuración) se
	   esconde hasta que haya lectura. */
	.escaneo.completa {
		position: fixed;
		inset: 0;
		z-index: 10;
		max-width: none;
		padding: 0;
		gap: 0;
		background: #000;
		justify-content: center;
	}

	.escaneo.completa header,
	.escaneo.completa .resultado {
		display: none;
	}

	.resultado {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.escaneo.completa :global(.debug) {
		display: none;
	}

	.escaneo.completa .acciones {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		justify-content: center;
		padding: 0.75rem 0.75rem calc(0.75rem + env(safe-area-inset-bottom));
		background: linear-gradient(to top, rgba(15, 23, 42, 0.85), transparent);
	}

	.tiempos {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		margin: 0;
		padding: 0.6rem 0.75rem;
		border-radius: var(--radio);
		background: var(--fondo-panel);
		color: var(--texto-suave);
		font-size: 0.8125rem;
	}

	.tiempos strong {
		color: var(--texto);
		font-variant-numeric: tabular-nums;
	}

	.escaneo {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.75rem;
		max-width: 48rem;
		margin: 0 auto;
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.titulo {
		font-weight: 700;
	}

	.toggle {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.8125rem;
		color: var(--texto-suave);
	}

	.acciones {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.primario,
	.secundario {
		padding: 0.6rem 0.9rem;
		border-radius: var(--radio);
		border: 1px solid var(--borde);
		background: var(--fondo-panel);
	}

	.primario {
		border-color: transparent;
		background: var(--acento);
		color: #06121f;
		font-weight: 700;
	}

	.error {
		margin: 0;
		padding: 0.75rem;
		border-radius: var(--radio);
		background: rgba(248, 113, 113, 0.15);
		color: var(--error);
	}
</style>
