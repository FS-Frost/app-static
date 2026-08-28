<script lang="ts">
	interface Props {
		message: string;
		/** Texto del botón de acción. Sin él, el aviso sólo se puede cerrar. */
		actionLabel?: string;
		onaction?: () => void;
		ondismiss: () => void;
	}

	let { message, actionLabel, onaction, ondismiss }: Props = $props();
</script>

<div class="toast" role="status" data-testid="toast">
	<span>{message}</span>

	{#if actionLabel != null && onaction != null}
		<button type="button" class="accion" onclick={onaction}>{actionLabel}</button>
	{/if}

	<button type="button" class="cerrar" aria-label="Cerrar aviso" onclick={ondismiss}>×</button>
</div>

<style>
	.toast {
		position: fixed;
		left: 0.75rem;
		right: 0.75rem;
		bottom: calc(0.75rem + env(safe-area-inset-bottom));
		z-index: 20;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.7rem 0.9rem;
		border-radius: var(--radio);
		border: 1px solid var(--borde);
		background: var(--fondo-panel-alto);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
		font-size: 0.875rem;
	}

	.toast span {
		flex: 1;
	}

	.accion {
		border: none;
		border-radius: 999px;
		padding: 0.35rem 0.8rem;
		background: var(--acento);
		color: #06121f;
		font-weight: 700;
	}

	.cerrar {
		border: none;
		background: none;
		color: var(--texto-suave);
		font-size: 1.25rem;
		line-height: 1;
		padding: 0 0.25rem;
	}
</style>
