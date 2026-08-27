<script lang="ts">
	import type { Quad } from "$lib/scan/geometry";
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

	export function getVideo(): HTMLVideoElement {
		return video;
	}

	function anotarTamano(): void {
		if (video?.videoWidth > 0) {
			videoSize = { width: video.videoWidth, height: video.videoHeight };
		}
	}

	onMount(() => {
		return () => scanner.stop();
	});

	function trazarQuad(context: CanvasRenderingContext2D, quad: Quad): void {
		context.beginPath();
		context.moveTo(quad.topLeft.x, quad.topLeft.y);
		context.lineTo(quad.topRight.x, quad.topRight.y);
		context.lineTo(quad.bottomRight.x, quad.bottomRight.y);
		context.lineTo(quad.bottomLeft.x, quad.bottomLeft.y);
		context.closePath();
	}

	function trazarFlecha(context: CanvasRenderingContext2D, desde: { x: number; y: number }, nudge: { x: number; y: number }, largo: number): void {
		const norma = Math.hypot(nudge.x, nudge.y);
		if (norma === 0) {
			return;
		}

		const dx = (nudge.x / norma) * largo;
		const dy = (nudge.y / norma) * largo;
		const hasta = { x: desde.x + dx, y: desde.y + dy };
		const angulo = Math.atan2(dy, dx);
		const ala = largo * 0.25;

		context.beginPath();
		context.moveTo(desde.x, desde.y);
		context.lineTo(hasta.x, hasta.y);
		context.moveTo(hasta.x, hasta.y);
		context.lineTo(hasta.x - ala * Math.cos(angulo - 0.5), hasta.y - ala * Math.sin(angulo - 0.5));
		context.moveTo(hasta.x, hasta.y);
		context.lineTo(hasta.x - ala * Math.cos(angulo + 0.5), hasta.y - ala * Math.sin(angulo + 0.5));
		context.stroke();
	}

	// El overlay se redibuja cuando llega un resultado nuevo, no en cada frame de
	// video: dibujar más seguido que el detector sólo gasta batería.
	$effect(() => {
		const quad = scanner.quad;
		const marks = scanner.marks;
		const qrQuad = scanner.qrQuad;
		const target = scanner.target;
		const searchRect = scanner.searchRect;
		const nudge = scanner.guidance.nudge;
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
		const trazo = Math.max(2, overlay.width * 0.004);

		// Rectángulo objetivo: dónde conviene que caiga el bloque de respuestas. Se
		// dibuja hasta que el encuadre sirve, y ahí desaparece para no estorbar.
		if (target != null && !scanner.guidance.framed && scanner.status !== "listo") {
			context.strokeStyle = "rgba(255, 255, 255, 0.5)";
			context.lineWidth = trazo;
			context.setLineDash([trazo * 4, trazo * 3]);
			context.strokeRect(target.x, target.y, target.width, target.height);
			context.setLineDash([]);
		}

		// Zona de seguimiento: si es más chica que el frame, la app está buscando sólo
		// donde vio la hoja la última vez.
		if (searchRect != null && scanner.assist) {
			context.strokeStyle = "rgba(148, 163, 184, 0.35)";
			context.lineWidth = trazo * 0.6;
			context.strokeRect(searchRect.x, searchRect.y, searchRect.width, searchRect.height);
		}

		// Las marcas que la app ve, aunque todavía no formen una hoja: es la única
		// pista útil mientras se encuadra ("ve tres, falta una").
		context.fillStyle = "rgba(251, 191, 36, 0.9)";
		for (const mark of marks) {
			context.beginPath();
			context.arc(mark.x, mark.y, trazo * 2, 0, Math.PI * 2);
			context.fill();
		}

		if (qrQuad != null) {
			context.strokeStyle = "rgba(167, 139, 250, 0.9)";
			context.lineWidth = trazo;
			trazarQuad(context, qrQuad);
			context.stroke();
		}

		if (quad != null) {
			trazarQuad(context, quad);
			context.lineWidth = trazo;
			context.strokeStyle = scanner.status === "listo" ? "#34d399" : "#38bdf8";
			context.stroke();
			context.fillStyle = "rgba(56, 189, 248, 0.12)";
			context.fill();
		}

		// Flecha: hacia dónde mover el teléfono. Sale del centro porque es donde está
		// mirando quien encuadra.
		if (nudge != null && scanner.assist) {
			context.strokeStyle = "rgba(56, 189, 248, 0.95)";
			context.lineWidth = trazo * 1.5;
			trazarFlecha(
				context,
				{ x: overlay.width / 2, y: overlay.height / 2 },
				nudge,
				Math.min(overlay.width, overlay.height) * 0.18
			);
		}
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
		<!-- La guía sólo mientras se encuadra: una vez leída la hoja, lo que importa es
		     el estado ("lectura estable"). -->
		<span>
			{scanner.assist && scanner.status === "escaneando" && scanner.guidance.message !== ""
				? scanner.guidance.message
				: scanner.message}
		</span>
		<span class="marcas">{scanner.marks.length} marcas</span>
	</div>

	{#if scanner.status === "escaneando" && scanner.capture === "continua"}
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

	.estado .marcas {
		margin-left: auto;
		color: var(--texto-suave);
		font-size: 0.75rem;
		white-space: nowrap;
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
