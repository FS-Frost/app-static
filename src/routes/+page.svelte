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

	type Vista = "formato" | "camara" | "imagen";

	const scanner = new Scanner();

	let vista = $state<Vista>("formato");
	let formatId = $state<FormatId>("45");
	let camara = $state<CameraView | null>(null);
	let iniciado = $state<boolean>(false);
	let copiado = $state<boolean>(false);
	let imagen = $state<File | null>(null);

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
	});

	$effect(() => {
		localStorage.setItem("formato", formatId);
		localStorage.setItem("ancla", scanner.anchor);
		localStorage.setItem("captura", scanner.capture);
		localStorage.setItem("asistencia", scanner.assist ? "1" : "0");
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

{#if vista === "formato"}
	<FormatPicker
		bind:formatId
		bind:anchor={scanner.anchor}
		bind:capture={scanner.capture}
		bind:assist={scanner.assist}
		bind:debug={scanner.debug}
		onstart={() => (vista = "camara")}
		ontest={(archivo) => {
			imagen = archivo;
			vista = "imagen";
		}}
	/>
{:else}
	<section class="escaneo">
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
			<CameraView bind:this={camara} {scanner} />
		{/if}

		<div class="acciones">
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

		{#if scanner.status === "error"}
			<p class="error">{scanner.message}</p>
		{/if}

		<AnswerSheet
			format={scanner.format}
			answers={scanner.answers}
			votes={scanner.votes}
			minVotes={scanner.minVotes}
		/>

		{#if scanner.debug}
			<DebugPanel {scanner} />
		{/if}
	</section>
{/if}

<style>
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
