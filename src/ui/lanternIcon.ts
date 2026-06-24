/**
 * Custom "lantern" icon (Lucide ships only a desk lamp). Registered via
 * Obsidian's addIcon — paths live in a 0–100 viewBox and use currentColor so
 * the icon themes light/dark like any built-in. Used for the view tab and the
 * setup card. A ring-handle storm lantern (user-chosen design). The group is
 * scaled 1.09× about the center (9% larger) to fill more of the icon slot.
 */

import { addIcon } from "obsidian";

export const LANTERN_ICON = "lantern";

const LANTERN_SVG = `<g transform="translate(50 50) scale(1.09) translate(-50 -50)" fill="none" stroke="currentColor" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round">
<circle cx="50" cy="12.5" r="7.1"/>
<path d="M50 19.2 V23.3"/>
<path d="M27.1 33.3 Q50 19.2 72.9 33.3"/>
<path d="M39.2 26.3 H60.8"/>
<path d="M32 33.3 H68 C80 48 80 64 68 79.2 H32 C20 64 20 48 32 33.3 Z"/>
<path d="M50 45 C62.1 56.7 56.7 68.3 50 70.8 C43.3 68.3 37.9 56.7 50 45 Z" fill="currentColor" stroke="none"/>
<path d="M32 79.2 L28 91.7 L72 91.7 L68 79.2"/>
</g>`;

let registered = false;

/** Register the lantern icon once (idempotent). Call in plugin onload. */
export function registerLanternIcon(): void {
	if (registered) return;
	addIcon(LANTERN_ICON, LANTERN_SVG);
	registered = true;
}
