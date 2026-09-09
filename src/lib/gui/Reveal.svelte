<script lang="ts">
	interface Props {
		/** Cuántas respuestas se leyeron, para que el aviso diga algo concreto. */
		detected: number;
		total: number;
		msSinceCameraStart: number;
		msToDetect: number;
		/** Se llama al tocar la cortina: quien va apurado no espera el segundo. */
		ondismiss: () => void;
	}

	let { detected, total, msSinceCameraStart, msToDetect, ondismiss }: Props = $props();
</script>

<!--
	Cortina entre la cámara y los resultados.

	Cumple dos funciones: da la señal de "listo, la leí" —que en una tanda de hojas es
	lo que uno espera ver— y tapa el reacomodo del layout, que pasa de una cámara a
	pantalla completa a una tabla con scroll. Sin ella el salto se ve como un
	parpadeo.

	Se descarta con un toque: si no, durante casi un segundo se come los toques de
	quien ya quiere apretar "Escanear otra".
-->
<div class="cortina" role="status" data-testid="revelado">
	<!-- Botón de verdad y no un `onclick` en el div: así se puede cerrar con teclado y
	     el lector de pantalla lo anuncia como lo que es. -->
	<button type="button" class="descartar" aria-label="Cerrar aviso" onclick={ondismiss}></button>

	<div class="tarjeta">
		<svg class="tilde" viewBox="0 0 52 52" aria-hidden="true">
			<circle cx="26" cy="26" r="24" />
			<path d="M15 27 L23 35 L38 19" />
		</svg>

		<strong>Hoja leída</strong>
		<span class="detalle">{detected} de {total} preguntas con respuesta</span>
		<span class="tiempos">
			{(msSinceCameraStart / 1000).toFixed(1)} s desde abrir la cámara · {msToDetect} ms de detección
		</span>
	</div>
</div>

<style>
	.cortina {
		position: fixed;
		inset: 0;
		z-index: 30;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
		background: color-mix(in srgb, var(--fondo) 88%, transparent);
		backdrop-filter: blur(6px);
		animation: aparecer 140ms ease-out;
	}

	.descartar {
		position: absolute;
		inset: 0;
		border: none;
		background: transparent;
	}

	.tarjeta {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.4rem;
		padding: 1.75rem 1.5rem;
		border-radius: 20px;
		border: 1px solid var(--borde);
		background: var(--fondo-panel);
		box-shadow: 0 18px 48px rgba(22, 32, 58, 0.18);
		text-align: center;
	}

	.tarjeta strong {
		font-size: 1.125rem;
	}

	.detalle {
		color: var(--texto);
	}

	.tiempos {
		color: var(--texto-suave);
		font-size: 0.8125rem;
		font-variant-numeric: tabular-nums;
	}

	.tilde {
		width: 4rem;
		height: 4rem;
		margin-bottom: 0.35rem;
		fill: none;
		stroke: var(--ok);
		stroke-width: 4;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.tilde circle {
		opacity: 0.28;
	}

	.tilde path {
		stroke-dasharray: 48;
		stroke-dashoffset: 48;
		animation: trazar 380ms 60ms ease-out forwards;
	}

	@keyframes aparecer {
		from {
			opacity: 0;
		}
	}

	@keyframes trazar {
		to {
			stroke-dashoffset: 0;
		}
	}

	/* Sin animación para quien la desactivó: el aviso aparece igual, quieto. */
	@media (prefers-reduced-motion: reduce) {
		.cortina {
			animation: none;
			backdrop-filter: none;
		}

		.tilde path {
			animation: none;
			stroke-dashoffset: 0;
		}
	}
</style>
