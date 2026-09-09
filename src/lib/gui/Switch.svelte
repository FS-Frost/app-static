<script lang="ts">
	interface Props {
		label: string;
		/** Explicación corta. Va debajo, en gris, para no alargar la etiqueta. */
		detail?: string;
		checked: boolean;
	}

	let { label, detail, checked = $bindable() }: Props = $props();
</script>

<!--
	Interruptor con la fila completa como área de toque: en un teléfono, apuntarle a
	una casilla de 16 px es una lotería. El input sigue siendo un checkbox nativo, así
	que teclado y lector de pantalla funcionan sin ayuda.
-->
<label class="toggle">
	<span class="texto">
		<strong>{label}</strong>
		{#if detail != null}
			<span class="detalle">{detail}</span>
		{/if}
	</span>

	<input type="checkbox" bind:checked />
	<span class="palanca" aria-hidden="true"></span>
</label>

<style>
	.toggle {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: var(--toque);
		padding: 0.5rem 0.75rem;
		border-radius: var(--radio);
		border: 1px solid var(--borde);
		background: var(--fondo-panel);
		cursor: pointer;
	}

	.texto {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}

	.texto strong {
		font-weight: 600;
		font-size: 0.9375rem;
	}

	.detalle {
		color: var(--texto-suave);
		font-size: 0.8125rem;
		line-height: 1.35;
	}

	/* El checkbox real queda invisible pero enfocable: la palanca es sólo pintura. */
	input {
		position: absolute;
		opacity: 0;
		width: 1px;
		height: 1px;
	}

	.palanca {
		flex: none;
		position: relative;
		width: 3rem;
		height: 1.75rem;
		border-radius: 999px;
		background: var(--borde);
		transition: background 120ms ease;
	}

	.palanca::after {
		content: "";
		position: absolute;
		top: 0.2rem;
		left: 0.2rem;
		width: 1.35rem;
		height: 1.35rem;
		border-radius: 50%;
		background: var(--fondo-panel);
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
		transition: transform 120ms ease;
	}

	input:checked + .palanca {
		background: var(--acento);
	}

	input:checked + .palanca::after {
		transform: translateX(1.25rem);
	}

	input:focus-visible + .palanca {
		outline: 3px solid var(--acento);
		outline-offset: 2px;
	}

	@media (prefers-reduced-motion: reduce) {
		.palanca,
		.palanca::after {
			transition: none;
		}
	}
</style>
