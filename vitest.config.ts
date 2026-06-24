import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { readFileSync } from "fs";

/**
 * Load bundled prompt `*.md` files as raw-string default exports — mirrors
 * esbuild's `{ ".md": "text" }` loader so `import x from "./foo.md"` works the
 * same in tests as in the build.
 */
const rawMarkdown = {
	name: "raw-markdown",
	load(id: string) {
		if (id.endsWith(".md")) {
			return `export default ${JSON.stringify(readFileSync(id, "utf-8"))};`;
		}
	},
};

export default defineConfig({
	plugins: [rawMarkdown],
	test: {
		globals: true,
		environment: "node",
		include: ["tests/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			include: ["src/**/*.ts"],
			// UI + plugin entry are verified inside Obsidian; traceFormat is pure and covered.
			exclude: ["src/main.ts", "src/ui/**/*.ts", "!src/ui/traceFormat.ts"],
		},
		testTimeout: 30000,
	},
	resolve: {
		alias: {
			obsidian: resolve(__dirname, "./tests/mocks/obsidian.ts"),
		},
	},
});
