// The subset of Vite's `import.meta.glob` that the test helpers use. The
// project does not load `vite/client` types.
interface ImportMeta {
	glob<T>(
		pattern: string,
		options: { query: string; import: string; eager: true },
	): Record<string, T>;
}
