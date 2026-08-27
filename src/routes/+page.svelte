<script lang="ts">
	import AnswerSheet from "$lib/gui/AnswerSheet.svelte";
	import CameraView from "$lib/gui/CameraView.svelte";
	import DebugPanel from "$lib/gui/DebugPanel.svelte";
	import FormatPicker from "$lib/gui/FormatPicker.svelte";
	import { answersToCsv, answersToText } from "$lib/scan/classify";
	import { isFormatId, type FormatId } from "$lib/scan/format";
	import { MIN_VOTES, Scanner } from "$lib/scan/scanner.svelte";

	type Vista = "formato" | "camara" | "imagen";

	const scanner = new Scanner();

	let vista = $state<Vista>("formato");
	let formatId = $state<FormatId>("45");
	let camara = $state<CameraView | null>(null);
	let iniciado = $state<boolean>(false);
	let copiado = $state<boolean>(false);
	let imagen = $state<File | null>(null);

	// El formato elegido sobrevive a un cierre de la app: en un colegio se corrigen
	// muchas hojas del mismo formato seguidas.
	$effect(() => {
		const guardado = localStorage.getItem("formato");
		if (guardado != null && isFormatId(guardado)) {
			formatId = guardado;
		}
	});

	$effect(() => {
		localStorage.setItem("formato", formatId);
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
				{scanner.format.questions} preguntas{vista === "imagen" ? " · imagen" : ""}
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
			minVotes={MIN_VOTES}
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
