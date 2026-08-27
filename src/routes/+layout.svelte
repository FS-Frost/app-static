<script lang="ts">
	interface Props {
		children: import("svelte").Snippet;
	}

	let { children }: Props = $props();
</script>

<main>
	{@render children()}
</main>

<style>
	main {
		min-height: 100dvh;
		padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
	}
</style>
