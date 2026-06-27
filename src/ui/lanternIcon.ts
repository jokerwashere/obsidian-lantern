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

/**
 * The "Answer now" running figure (the emergency-exit pictogram, from
 * assets/emergency-exit.svg) — Lucide ships no running person. A FILLED
 * silhouette, so it is NOT registered via addIcon/setIcon: Obsidian's
 * `.svg-icon` styling is stroke-based and forces `fill: none`, hiding a filled
 * shape. Building the element directly (fill=currentColor, no `svg-icon` class)
 * sidesteps that. The source 444×478 artwork is mapped into the 0–100 box by a
 * single `scale(0.2)` + centering translate (the artwork's two ~mutually
 * inverse inner scales collapse to ~1).
 */
const RUNNER_PATHS = [
	"M510.355,247.212C537.001,247.212 559.16,269.37 559.16,296.017C559.16,322.665 537.001,343.809 510.355,343.809C483.707,343.809 462.563,322.52 462.563,296.017C462.563,269.515 482.839,247.212 510.355,247.212Z",
	"M340.333,584.794C329.761,597.25 322.665,601.594 308.472,600.724L201.159,598.988C187.835,598.117 177.263,584.794 178.132,573.354C179.001,557.424 189.718,548.588 204.779,548.588L303.114,547.719L326.14,516.582L367.849,550.326L340.333,584.794Z",
	"M597.248,504.129L509.486,484.721C503.259,482.983 498.914,478.494 496.164,473.135L475.742,427.951C474.004,429.689 428.821,504.129 428.821,504.129L480.233,543.085C496.164,556.408 497.9,568.718 491.819,585.663L438.669,708.038C434.178,719.623 421.001,727.589 407.677,723.098C394.353,718.608 385.519,703.547 391.747,690.368L437.8,579.579L368.72,527.298C350.038,515.712 343.086,493.552 356.265,471.395L418.249,370.308L373.064,354.378L291.529,395.218C280.957,401.445 267.634,396.087 262.275,386.384C257.786,377.55 261.406,365.095 270.24,359.736L355.396,315.421C359.886,312.814 364.23,310.931 368.72,310.931C373.209,310.931 377.554,311.8 381.175,312.669L453.007,335.696C455.615,336.565 457.497,337.434 459.235,339.172L498.19,368.429C503.548,371.904 505.286,378.132 507.025,382.621L526.576,443.736L605.505,464.156C616.077,466.763 621.435,476.613 621.435,486.314C620.275,495.293 607.965,506.879 597.248,504.129Z",
];

/** Build the "Answer now" running-figure icon as a real SVG element inside `host`. */
export function createAnswerNowIcon(host: HTMLElement): SVGElement {
	const svg = host.createSvg("svg", {
		cls: "lantern-answer-now-svg",
		attr: { viewBox: "0 0 100 100", "aria-hidden": "true" },
	});
	const g = svg.createSvg("g", {
		attr: { fill: "currentColor", stroke: "none", transform: "translate(-30.0164 -47.2424) scale(0.2)" },
	});
	for (const d of RUNNER_PATHS) g.createSvg("path", { attr: { d } });
	return svg;
}
