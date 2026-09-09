<script lang="ts" generics="T extends string">
	interface Opcion {
		id: T;
		label: string;
		/** Línea corta bajo la etiqueta. Opcional: en móvil, menos texto es más. */
		detail?: string;
	}

	interface Props {
		legend: string;
		options: Opcion[];
		value: T;
		/** Muestra el detalle de cada opción. Con muchas opciones conviene apagarlo. */
		showDetail?: boolean;
	}

	let { legend, options, value = $bindable(), showDetail = false }: Props = $props();
</script>

<!--
	Grupo de opciones excluyentes. Botones de verdad con `aria-checked` en vez de
	radios escondidos: el área de toque queda del tamaño del botón completo y el
	lector de pantalla igual anuncia el grupo y qué está elegido.
-->
<div class="grupo" role="radiogroup" aria-label={legend}>
	{#each options as opcion (opcion.id)}
		<button
			type="button"
			role="radio"
			class="opcion"
			class:activa={value === opcion.id}
			class:conDetalle={showDetail}
			aria-checked={value === opcion.id}
			onclick={() => (value = opcion.id)}
		>
			<strong>{opcion.label}</strong>
			{#if showDetail && opcion.detail != null}
				<span>{opcion.detail}</span>
			{/if}
		</button>
	{/each}
</div>

<style>
	.grupo {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.opcion {
		flex: 1 1 8rem;
		min-height: var(--toque);
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 0.15rem;
		padding: 0.6rem 0.9rem;
		border-radius: var(--radio);
		border: 2px solid var(--borde);
		background: var(--fondo-panel);
		text-align: left;
	}

	.opcion.conDetalle {
		flex-basis: 100%;
	}

	.opcion.activa {
		border-color: var(--acento);
		background: var(--acento-suave);
	}

	.opcion strong {
		font-weight: 600;
	}

	.opcion span {
		color: var(--texto-suave);
		font-size: 0.8125rem;
		line-height: 1.35;
		font-weight: 400;
	}
</style>
