<script lang="ts">
	import type { Scanner } from "$lib/scan/scanner.svelte";

	interface Props {
		scanner: Scanner;
	}

	let { scanner }: Props = $props();

	let canvas: HTMLCanvasElement | null = $state(null);

	// Qué fracción del frame se está analizando: 100% es búsqueda completa, menos es
	// seguimiento enganchado a la hoja.
	const seguimiento = $derived<number>(
		scanner.searchRect == null || scanner.frameSize.width === 0
			? 1
			: (scanner.searchRect.width * scanner.searchRect.height) /
					(scanner.frameSize.width * scanner.frameSize.height)
	);

	// La hoja rectificada llega como ImageBitmap desde el worker; pintarla es la
	// forma rápida de ver si la grilla cayó donde debía.
	$effect(() => {
		const bitmap = scanner.debugImage;
		if (canvas == null || bitmap == null) {
			return;
		}

		if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
		}

		const context = canvas.getContext("2d");
		context?.drawImage(bitmap, 0, 0);
	});
</script>

<section class="debug">
	<h3>Depuración</h3>

	<p class="mensaje">{scanner.lastReason || scanner.message}</p>

	<dl>
		<div><dt>fps de análisis</dt><dd>{scanner.analysisFps}</dd></div>
		<div><dt>total</dt><dd>{scanner.timing.total.toFixed(1)} ms</dd></div>
		<div><dt>ubicar hoja</dt><dd>{scanner.timing.locate.toFixed(1)} ms</dd></div>
		<div><dt>rectificar</dt><dd>{scanner.timing.warp.toFixed(1)} ms</dd></div>
		<div><dt>leer grilla</dt><dd>{scanner.timing.read.toFixed(1)} ms</dd></div>
		<div><dt>frame</dt><dd>{scanner.frameSize.width}×{scanner.frameSize.height}</dd></div>
		<div><dt>seguimiento</dt><dd data-testid="seguimiento">{(seguimiento * 100).toFixed(0)}%</dd></div>
		<div><dt>zoom</dt><dd>{scanner.zoom === 0 ? "—" : `${scanner.zoom.toFixed(1)}x`}</dd></div>
	</dl>

	<canvas bind:this={canvas}></canvas>

	{#if scanner.fills.length > 0}
		<details>
			<summary>Relleno por burbuja</summary>
			<pre>{scanner.fills
					.map(
						(fila, indice) =>
							`${(indice + 1).toString().padStart(2, "0")} ${fila.map((valor) => valor.toFixed(2)).join(" ")}`
					)
					.join("\n")}</pre>
		</details>
	{/if}
</section>

<style>
	.debug {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.75rem;
		border: 1px solid var(--borde);
		border-radius: var(--radio);
		background: var(--fondo-panel);
	}

	.mensaje {
		margin: 0;
		font-size: 0.75rem;
		color: var(--texto-suave);
		overflow-wrap: anywhere;
	}

	dl {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
		gap: 0.5rem;
		margin: 0;
	}

	dt {
		color: var(--texto-suave);
		font-size: 0.75rem;
	}

	dd {
		margin: 0;
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}

	canvas {
		width: 100%;
		height: auto;
		background: #000;
		border-radius: 8px;
	}

	pre {
		margin: 0;
		max-height: 14rem;
		overflow: auto;
		font-size: 0.7rem;
		line-height: 1.3;
	}
</style>
