/**
 * Test setup: Obsidian runs in Electron where browser globals exist, so the
 * code uses `window.setTimeout` / `window.clearTimeout` (required by Obsidian's
 * lint rules for popout-window compatibility). The unit tests run under Node,
 * which has no `window` — alias it to `globalThis` so those timers resolve.
 */
if (typeof (globalThis as { window?: unknown }).window === "undefined") {
	(globalThis as { window?: unknown }).window = globalThis;
}
