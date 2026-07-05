import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	...obsidianmd.configs.recommended,
	{
		ignores: ["main.js", "*.mjs", "vitest.config.ts"],
	},
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_" },
			],
			"@typescript-eslint/ban-ts-comment": "off",
			"no-prototype-builtins": "off",
			"@typescript-eslint/no-empty-function": "off",
			// Not enforced by Obsidian's submission validator, and wrong for us:
			// sentence-case mangles brand names (qmd, LM Studio, BM25); base-to-string
			// flags safe String(x ?? "") coercion of untyped tool-call args.
			"obsidianmd/ui/sentence-case": "off",
			"@typescript-eslint/no-base-to-string": "off",
		},
	}
);
