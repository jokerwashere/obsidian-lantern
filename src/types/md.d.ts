/**
 * Bundled markdown imported as a raw string. esbuild inlines `*.md` via its
 * text loader (see esbuild.config.mjs); vitest mirrors this with a load plugin
 * (vitest.config.ts). Used for the agent's prompt templates (src/agent/prompts).
 */
declare module "*.md" {
	const content: string;
	export default content;
}
