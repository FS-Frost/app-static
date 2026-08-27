<script lang="ts">
	import type { SheetFormat } from "$lib/scan/format";

	interface Props {
		format: SheetFormat;
		answers: string[];
		votes: number[];
		minVotes: number;
	}

	let { format, answers, votes, minVotes }: Props = $props();

	type Celda = {
		numero: number;
		respuesta: string;
		votos: number;
	};

	const bloques = $derived<Celda[][]>(
		Array.from({ length: format.blocks }, (_, bloque) =>
			Array.from({ length: format.rows }, (_, fila) => {
				const numero = bloque * format.rows + fila + 1;
				return {
					numero,
					respuesta: answers[numero - 1] ?? "",
					votos: votes[numero - 1] ?? 0,
				};
			})
		)
	);
</script>

<div class="hoja">
	{#each bloques as bloque, indice (indice)}
		<ul>
			{#each bloque as celda (celda.numero)}
				<li
					class:vacia={celda.respuesta.length === 0}
					class:doble={celda.respuesta.length > 1}
					class:inestable={celda.votos < minVotes}
				>
					<span class="numero">{celda.numero.toString().padStart(2, "0")}</span>
					<span class="respuesta">{celda.respuesta || "—"}</span>
				</li>
			{/each}
		</ul>
	{/each}
</div>

<style>
	.hoja {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(6.5rem, 1fr));
		gap: 0.75rem;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 2px;
	}

	li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.25rem 0.5rem;
		border-radius: 6px;
		background: var(--fondo-panel);
		font-variant-numeric: tabular-nums;
	}

	.numero {
		color: var(--texto-suave);
		font-size: 0.75rem;
	}

	.respuesta {
		font-weight: 700;
		color: var(--ok);
	}

	li.vacia .respuesta {
		color: var(--texto-suave);
		font-weight: 400;
	}

	li.doble .respuesta {
		color: var(--alerta);
	}

	li.inestable {
		outline: 1px dashed var(--borde);
	}
</style>
