<script lang="ts">
	import Segmented from "$lib/gui/Segmented.svelte";
	import Switch from "$lib/gui/Switch.svelte";
	import { FORMATS, type FormatId } from "$lib/scan/format";
	import { ANCHORS, CAPTURES, type Anchor, type Capture } from "$lib/scan/strategy";

	interface Props {
		formatId: FormatId;
		anchor: Anchor;
		capture: Capture;
		assist: boolean;
		fullscreen: boolean;
		vibration: boolean;
		debug: boolean;
		onstart: () => void;
		ontest: (file: File) => void;
	}

	let {
		formatId = $bindable(),
		anchor = $bindable(),
		capture = $bindable(),
		assist = $bindable(),
		fullscreen = $bindable(),
		vibration = $bindable(),
		debug = $bindable(),
		onstart,
		ontest,
	}: Props = $props();

	let selector: HTMLInputElement;

	const formatos = $derived(
		FORMATS.map((formato) => ({
			id: formato.id,
			label: `${formato.questions} preguntas`,
			detail: `${formato.blocks} columnas · ${formato.rows} filas · ${formato.letters.join(" ")}`,
		}))
	);

	function elegirArchivo(event: Event): void {
		const archivo = (event.currentTarget as HTMLInputElement).files?.[0];
		if (archivo != null) {
			ontest(archivo);
		}
	}
</script>

<!--
	Pantalla de partida. Lo que se usa en cada hoja —formato y abrir la cámara— cabe
	sin desplazar; todo lo demás vive plegado. Antes eran cuatro grupos de tarjetas y
	tres interruptores en una sola columna: para llegar al botón había que recorrer
	toda la pantalla, y en la mano eso es un scroll por hoja.
-->
<section class="picker">
	<header>
		<h1>Escáner de respuestas</h1>
		<p>Elige el formato y apunta a la hoja. El resto viene configurado.</p>
	</header>

	<div class="grupo">
		<h2 id="rotulo-formato">Formato de la hoja</h2>
		<Segmented legend="Formato de la hoja" options={formatos} bind:value={formatId} showDetail={true} />
	</div>

	<details class="ajustes">
		<summary>
			<span>Ajustes</span>
			<span class="pista">detección, captura y accesorios</span>
		</summary>

		<div class="contenido">
			<div class="grupo">
				<h2>Cómo ubicar la hoja</h2>
				<Segmented legend="Cómo ubicar la hoja" options={ANCHORS} bind:value={anchor} showDetail={true} />
			</div>

			<div class="grupo">
				<h2>Cómo capturar</h2>
				<Segmented legend="Cómo capturar" options={CAPTURES} bind:value={capture} showDetail={true} />
			</div>

			<div class="grupo">
				<h2>Accesorios</h2>
				<Switch
					label="Cámara a pantalla completa"
					detail="La imagen se ajusta al ancho, sin deformarse."
					bind:checked={fullscreen}
				/>
				<Switch label="Vibrar" detail="Al enganchar la hoja y al terminar la lectura." bind:checked={vibration} />
				<Switch
					label="Asistencia de encuadre"
					detail="Sigue la hoja, acerca la cámara, enfoca el papel y dispara solo cuando está quieta."
					bind:checked={assist}
				/>
				<Switch
					label="Depurar"
					detail="Muestra la hoja rectificada, la grilla y los tiempos por etapa."
					bind:checked={debug}
				/>
			</div>
		</div>
	</details>

	<p class="nota">Todo el procesamiento ocurre en el teléfono: no se sube ninguna imagen.</p>

	<div class="acciones">
		<button type="button" class="primario" onclick={onstart}>Abrir cámara</button>
		<button type="button" class="secundario" onclick={() => selector.click()}>Usar imagen</button>
		<input
			bind:this={selector}
			type="file"
			accept="image/*"
			class="oculto"
			data-testid="selector-imagen"
			onchange={elegirArchivo}
		/>
	</div>
</section>

<style>
	.picker {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1.25rem 1rem calc(1.25rem + env(safe-area-inset-bottom));
		max-width: 40rem;
		margin: 0 auto;
	}

	h1 {
		/* En un teléfono angosto, 2em parte el título en dos líneas y empuja todo. */
		font-size: clamp(1.45rem, 6.5vw, 1.9rem);
	}

	header p {
		color: var(--texto-suave);
		margin: 0.4rem 0 0;
		line-height: 1.45;
	}

	.grupo {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	h2 {
		font-size: 0.8125rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--texto-suave);
	}

	.ajustes {
		border: 1px solid var(--borde);
		border-radius: var(--radio);
		background: var(--fondo-panel);
	}

	summary {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-height: var(--toque);
		padding: 0.75rem 0.9rem;
		justify-content: center;
		cursor: pointer;
		font-weight: 600;
		border-radius: var(--radio);
	}

	.pista {
		font-weight: 400;
		font-size: 0.8125rem;
		color: var(--texto-suave);
	}

	.contenido {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 0 0.9rem 1rem;
		border-top: 1px solid var(--borde);
		padding-top: 1rem;
	}

	/* Las acciones quedan pegadas abajo: es donde llega el pulgar, y así no dependen
	   de cuánto haya crecido la pantalla de ajustes.

	   Con fondo sólido y a sangre completa: flotando sobre el contenido, los botones
	   tapaban una de las opciones y parecían parte de la lista. */
	.acciones {
		position: sticky;
		bottom: 0;
		z-index: 1;
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0 -1rem;
		padding: 0.75rem 1rem calc(0.75rem + env(safe-area-inset-bottom));
		background: var(--fondo);
		border-top: 1px solid var(--borde);
	}

	.primario,
	.secundario {
		flex: 1 1 10rem;
		min-height: var(--toque);
		padding: 0.9rem 1rem;
		border-radius: var(--radio);
		border: 1px solid var(--borde);
		background: var(--fondo-panel);
		font-weight: 600;
		box-shadow: 0 6px 18px rgba(22, 32, 58, 0.08);
	}

	.primario {
		border-color: transparent;
		background: var(--acento);
		color: var(--sobre-acento);
		font-weight: 700;
	}

	.oculto {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}

	.nota {
		color: var(--texto-suave);
		font-size: 0.8125rem;
		line-height: 1.45;
		margin: 0;
	}
</style>
