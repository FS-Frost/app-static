<script lang="ts">
	import { FORMATS, type FormatId } from "$lib/scan/format";
	import { ANCHORS, CAPTURES, type Anchor, type Capture } from "$lib/scan/strategy";

	interface Props {
		formatId: FormatId;
		anchor: Anchor;
		capture: Capture;
		assist: boolean;
		debug: boolean;
		onstart: () => void;
		ontest: (file: File) => void;
	}

	let {
		formatId = $bindable(),
		anchor = $bindable(),
		capture = $bindable(),
		assist = $bindable(),
		debug = $bindable(),
		onstart,
		ontest,
	}: Props = $props();

	let selector: HTMLInputElement;

	function elegirArchivo(event: Event): void {
		const archivo = (event.currentTarget as HTMLInputElement).files?.[0];
		if (archivo != null) {
			ontest(archivo);
		}
	}
</script>

<section class="picker">
	<header>
		<h1>Escáner de respuestas</h1>
		<p>El formato define cuántas filas y alternativas se buscan en la hoja.</p>
	</header>

	<div class="grupo">
		<h2>Formato</h2>
		<div class="opciones">
			{#each FORMATS as formato (formato.id)}
				<button
					type="button"
					class="opcion"
					class:activa={formatId === formato.id}
					aria-pressed={formatId === formato.id}
					onclick={() => (formatId = formato.id)}
				>
					<strong>{formato.questions} preguntas</strong>
					<span>{formato.blocks} columnas · {formato.rows} filas · {formato.letters.join(" ")}</span>
				</button>
			{/each}
		</div>
	</div>

	<div class="grupo">
		<h2>Cómo ubicar la hoja</h2>
		<div class="opciones">
			{#each ANCHORS as opcion (opcion.id)}
				<button
					type="button"
					class="opcion"
					class:activa={anchor === opcion.id}
					aria-pressed={anchor === opcion.id}
					onclick={() => (anchor = opcion.id)}
				>
					<strong>{opcion.label}</strong>
					<span>{opcion.detail}</span>
				</button>
			{/each}
		</div>
	</div>

	<div class="grupo">
		<h2>Cómo capturar</h2>
		<div class="opciones">
			{#each CAPTURES as opcion (opcion.id)}
				<button
					type="button"
					class="opcion"
					class:activa={capture === opcion.id}
					aria-pressed={capture === opcion.id}
					onclick={() => (capture = opcion.id)}
				>
					<strong>{opcion.label}</strong>
					<span>{opcion.detail}</span>
				</button>
			{/each}
		</div>
	</div>

	<div class="botones">
		<button type="button" class="primario" onclick={onstart}>Abrir cámara</button>
		<button type="button" class="secundario" onclick={() => selector.click()}>Usar una imagen</button>
		<input
			bind:this={selector}
			type="file"
			accept="image/*"
			class="oculto"
			data-testid="selector-imagen"
			onchange={elegirArchivo}
		/>
	</div>

	<label class="toggle">
		<input type="checkbox" bind:checked={assist} />
		<span>
			Asistencia de encuadre: sigue la hoja, acerca la cámara, enfoca el papel, indica hacia dónde moverse y,
			en modo foto, dispara solo cuando está quieta
		</span>
	</label>

	<label class="toggle">
		<input type="checkbox" bind:checked={debug} />
		<span>Depurar: muestra la hoja rectificada, la grilla y los tiempos</span>
	</label>

	<p class="nota">
		Todo el procesamiento ocurre en el teléfono: no se sube ninguna imagen. Las combinaciones de ancla y captura
		están para probarlas y quedarse con la que resulte más cómoda.
	</p>
</section>

<style>
	.picker {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		padding: 1.25rem 1rem 2rem;
		max-width: 40rem;
		margin: 0 auto;
	}

	header p {
		color: var(--texto-suave);
		margin: 0.5rem 0 0;
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

	.opciones {
		display: grid;
		gap: 0.5rem;
	}

	.opcion {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		align-items: flex-start;
		text-align: left;
		padding: 0.75rem 0.9rem;
		border-radius: var(--radio);
		border: 2px solid var(--borde);
		background: var(--fondo-panel);
	}

	.opcion.activa {
		border-color: var(--acento);
		background: var(--fondo-panel-alto);
	}

	.opcion span {
		color: var(--texto-suave);
		font-size: 0.8125rem;
		line-height: 1.35;
	}

	.botones {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.primario,
	.secundario {
		flex: 1 1 10rem;
		padding: 0.9rem 1rem;
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

	.toggle {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8125rem;
		color: var(--texto-suave);
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
