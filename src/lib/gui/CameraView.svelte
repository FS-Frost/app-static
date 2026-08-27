<script lang="ts">
	import type { Scanner } from "$lib/scan/scanner.svelte";
	import { onMount } from "svelte";

	interface Props {
		scanner: Scanner;
	}

	let { scanner }: Props = $props();

	let video: HTMLVideoElement;
	let overlay: HTMLCanvasElement;

	// La proporción del marco sale del video, no de un valor fijo: en un teléfono el
	// stream puede venir vertical (1080x1920) u horizontal según el aparato y la
	// orientación, y con una proporción fija la hoja queda en una franja chica —el
	// detector la ve pequeña y pide acercarse sin motivo.
	let videoSize = $state<{ width: number; height: number }>({ width: 3, height: 4 });

	function anotarTamano(): void {
		if (video?.videoWidth > 0) {
			videoSize = { width: video.videoWidth, height: video.videoHeight };
		}
	}

	export function getVideo(): HTMLVideoElement {
		return video;
	}

	onMount(() => {
		return () => scanner.stop();
	});

	// El overlay se redibuja cuando llega un resultado nuevo, no en cada frame de
	// video: dibujar más seguido que el detector sólo gasta batería.
	$effect(() => {
		const quad = scanner.quad;
		const size = scanner.frameSize;
		if (overlay == null || size.width === 0) {
			return;
		}

		if (overlay.width !== size.width || overlay.height !== size.height) {
			overlay.width = size.width;
			overlay.height = size.height;
		}

		const context = overlay.getContext("2d");
		if (context == null) {
			return;
		}

		context.clearRect(0, 0, overlay.width, overlay.height);
		if (quad == null) {
			return;
		}

		context.beginPath();
		context.moveTo(quad.topLeft.x, quad.topLeft.y);
		context.lineTo(quad.topRight.x, quad.topRight.y);
		context.lineTo(quad.bottomRight.x, quad.bottomRight.y);
		context.lineTo(quad.bottomLeft.x, quad.bottomLeft.y);
		context.closePath();
		context.lineWidth = Math.max(2, overlay.width * 0.004);
		context.strokeStyle = scanner.status === "listo" ? "#34d399" : "#38bdf8";
		context.stroke();
		context.fillStyle = "rgba(56, 189, 248, 0.12)";
		context.fill();
	});
</script>

<div class="marco" style:aspect-ratio={`${videoSize.width} / ${videoSize.height}`}>
	<video
		bind:this={video}
		playsinline
		muted
		autoplay
		onloadedmetadata={anotarTamano}
		onresize={anotarTamano}
	></video>
	<canvas bind:this={overlay}></canvas>

	<div class="estado" class:listo={scanner.status === "listo"}>
		<span class="punto"></span>
		<span>{scanner.message}</span>
	</div>

	{#if scanner.status === "escaneando"}
		<div class="progreso" aria-label="avance de la lectura">
			<div class="barra" style:width={`${Math.round(scanner.progress * 100)}%`}></div>
		</div>
	{/if}
</div>

<style>
	.marco {
		position: relative;
		width: 100%;
		background: #000;
		border-radius: var(--radio);
		overflow: hidden;
		max-height: 70dvh;
	}

	video,
	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: contain;
	}

	.estado {
		position: absolute;
		left: 0.5rem;
		right: 0.5rem;
		bottom: 0.5rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		border-radius: 999px;
		background: rgba(15, 23, 42, 0.82);
		font-size: 0.875rem;
	}

	.estado .punto {
		width: 0.6rem;
		height: 0.6rem;
		border-radius: 50%;
		background: var(--alerta);
		flex: none;
	}

	.estado.listo .punto {
		background: var(--ok);
	}

	.progreso {
		position: absolute;
		left: 0;
		right: 0;
		top: 0;
		height: 4px;
		background: rgba(255, 255, 255, 0.15);
	}

	.barra {
		height: 100%;
		background: var(--acento);
		transition: width 120ms linear;
	}
</style>
