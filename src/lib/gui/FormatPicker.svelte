<script lang="ts">
	import { FORMATS, type FormatId } from "$lib/scan/format";

	interface Props {
		formatId: FormatId;
		debug: boolean;
		onstart: () => void;
		ontest: (file: File) => void;
	}

	let { formatId = $bindable(), debug = $bindable(), onstart, ontest }: Props = $props();

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
		<p>Elige el formato de la prueba antes de escanear. El formato define cuántas filas y alternativas se buscan en la hoja.</p>
	</header>

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
		<input type="checkbox" bind:checked={debug} />
		<span>Depurar: muestra la hoja rectificada, la grilla y los tiempos</span>
	</label>

	<p class="nota">
		La hoja debe entrar completa en el cuadro, con sus cuatro marcas negras de las esquinas visibles. Todo el
		procesamiento ocurre en el teléfono: no se sube ninguna imagen.
	</p>
</section>

<style>
	.picker {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		padding: 1.5rem 1.25rem;
		max-width: 40rem;
		margin: 0 auto;
	}

	header p {
		color: var(--texto-suave);
		margin: 0.5rem 0 0;
		line-height: 1.45;
	}

	.opciones {
		display: grid;
		gap: 0.75rem;
	}

	.opcion {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		align-items: flex-start;
		text-align: left;
		padding: 1rem;
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
		font-size: 0.875rem;
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
