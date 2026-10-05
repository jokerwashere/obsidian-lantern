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
			// Type-aware, so NOT in tseslint's `recommended` — but Obsidian's
			// submission audit runs it, and a dead `as T` was the only thing it
			// caught that `npm run lint` could not. Enabled on its own rather than
			// switching the whole config to recommended-type-checked, which would
			// surface an unrelated pile of findings.
			"@typescript-eslint/no-unnecessary-type-assertion": "warn",
			// Not enforced by Obsidian's submission validator, and wrong for us:
			// sentence-case mangles brand names (qmd, LM Studio, BM25); base-to-string
			// flags safe String(x ?? "") coercion of untyped tool-call args.
			"obsidianmd/ui/sentence-case": "off",
			"@typescript-eslint/no-base-to-string": "off",
		},
	},
	{
		// DECIDED, NOT DEFERRED: Lantern keeps the imperative settings tab. The
		// declarative settings API (Obsidian 1.13.0) was evaluated and rejected —
		// see CLAUDE.md "Settings tab" and docs/ROADMAP.md. Short version:
		// a non-empty getSettingDefinitions() makes Obsidian skip display()
		// ENTIRELY, so it is all-or-nothing per tab, and half of this tab (probe
		// buttons, the Menu model picker, the multi-select collection picker) has
		// no declarative control.
		//
		// Silenced here so `npm run lint` stays at zero and keeps meaning
		// something. This does NOT hide an escalation: Obsidian's submission audit
		// runs its own ruleset, so if the warning ever becomes a hard requirement,
		// the store says so regardless of what we set locally.
		files: ["src/ui/SettingsTab.ts"],
		rules: {
			"obsidianmd/settings-tab/prefer-setting-definitions": "off",
			// display() is deprecated since 1.13.0 but remains the documented
			// fallback for Obsidian older than 1.13.0 — which is exactly what
			// minAppVersion 1.7.2 commits us to supporting.
			"@typescript-eslint/no-deprecated": "off",
		},
	}
);
