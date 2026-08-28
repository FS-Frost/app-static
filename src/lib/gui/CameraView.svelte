<script lang="ts">
	import type { Quad } from "$lib/scan/geometry";
	import type { Scanner } from "$lib/scan/scanner.svelte";

	interface Props {
		scanner: Scanner;
		/**
		 * Ocupa toda la pantalla. La imagen se ajusta al ancho y no se deforma: con una
		 * pantalla más alargada que el sensor quedan franjas arriba y abajo, que es
		 * preferible a recortar la hoja o a estirarla.
		 */
		fill?: boolean;
	}

	let { scanner, fill = false }: Props = $props();

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

	function trazarQuad(context: CanvasRenderingContext2D, quad: Quad): void {
		context.beginPath();
		context.moveTo(quad.topLeft.x, quad.topLeft.y);
		context.lineTo(quad.topRight.x, quad.topRight.y);
		context.lineTo(quad.bottomRight.x, quad.bottomRight.y);
		context.lineTo(quad.bottomLeft.x, quad.bottomLeft.y);
		context.closePath();
	}

	// El overlay se redibuja cuando llega un resultado nuevo, no en cada frame de
	// video: dibujar más seguido que el detector sólo gasta batería.
	$effect(() => {
		const quad = scanner.quad;
		const marks = scanner.marks;
		const qrQuad = scanner.qrQuad;
		const target = scanner.target;
		const searchRect = scanner.searchRect;
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

	});
</script>

<div
	class="marco"
	class:completa={fill}
	style:aspect-ratio={fill ? undefined : `${videoSize.width} / ${videoSize.height}`}
>
	<video
		bind:this={video}
		playsinline
		muted
		autoplay
		onloadedmetadata={anotarTamano}
		onresize={anotarTamano}
	></video>
	<canvas bind:this={overlay}></canvas>

	<!-- `data-primera` deja a la vista el tiempo hasta la primera lectura sin tener que
	     abrir el panel de depuración: es la métrica que importa al encuadrar. -->
	<div
		class="estado"
		class:arriba={fill}
		class:listo={scanner.status === "listo"}
		data-primera={scanner.msToFirstRead}
		data-estado={scanner.status}
	>
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

	.marco.completa {
		width: 100dvw;
		height: 100dvh;
		max-height: none;
		border-radius: 0;
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
	}

	/* A pantalla completa los botones viven abajo: el estado se va arriba para no
	   quedar debajo de ellos. */
	.estado.arriba {
		top: calc(0.5rem + env(safe-area-inset-top));
		bottom: auto;
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
