/**
 * IndexTracker — what Lantern knows about the vault collection's freshness.
 *
 * qmd reports pending embeddings only globally (`qmd status` / MCP `status`:
 * "Pending: N need embedding" across every collection), so the vault's own
 * state is tracked here from what Lantern sees: vault file events, files
 * modified while Obsidian was closed (mtime newer than the last index run),
 * the update → embed phases of Lantern's own runs, an embed skipped by qmd's
 * process lock, and qmd's embed lock held by another process.
 *
 * Pure state + formatting (no Obsidian imports) so it is unit-testable.
 */

export type IndexPhase = "idle" | "indexing" | "embedding";

export interface IndexStatus {
	/** Vault registered as a qmd collection (null = not probed yet). */
	registered: boolean | null;
	/** Notes changed since the last completed index run. */
	dirty: number;
	phase: IndexPhase;
	/** When the current phase started (ms epoch). */
	phaseSince: number | null;
	/** When the debounced auto-update fires (ms epoch), if armed. */
	scheduledAt: number | null;
	/** Last run indexed text but qmd's embed lock made it skip embedding. */
	embedPending: boolean;
	/** qmd's embed lock is held by a process Lantern didn't start. */
	externalEmbed: boolean;
	/** Last run's error message. */
	error: string | null;
	/** Start time of the last completed run (ms epoch; 0 = unknown). */
	lastIndexedAt: number;
}

export type IndexStatusLevel = "ok" | "pending" | "running" | "warn" | "error";

export interface IndexStatusView {
	level: IndexStatusLevel;
	/** Status-bar text ("" when there's nothing to show). */
	short: string;
	/** One-line detail for tooltips and the settings overview. */
	detail: string;
	/** Clicking would start an update (not while one is running). */
	actionable: boolean;
}

export class IndexTracker {
	private dirty = new Set<string>();
	/** Paths captured at run start; cleared from `dirty` when the run succeeds. */
	private runSnapshot: Set<string> | null = null;
	private runStartedAt = 0;
	private listeners = new Set<() => void>();
	private state: Omit<IndexStatus, "dirty">;

	constructor(lastIndexedAt = 0) {
		this.state = {
			registered: null,
			phase: "idle",
			phaseSince: null,
			scheduledAt: null,
			embedPending: false,
			externalEmbed: false,
			error: null,
			lastIndexedAt,
		};
	}

	get status(): IndexStatus {
		return { ...this.state, dirty: this.dirty.size };
	}

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit(): void {
		for (const fn of [...this.listeners]) fn();
	}

	private patch(next: Partial<Omit<IndexStatus, "dirty">>): void {
		let changed = false;
		for (const key of Object.keys(next) as Array<keyof typeof next>) {
			if (this.state[key] !== next[key]) {
				changed = true;
				break;
			}
		}
		if (!changed) return;
		this.state = { ...this.state, ...next };
		this.emit();
	}

	/** A markdown note was created/modified/deleted/renamed. */
	markChanged(path: string): void {
		const before = this.dirty.size;
		this.dirty.add(path);
		if (this.dirty.size !== before) this.emit();
	}

	setRegistered(registered: boolean): void {
		this.patch({ registered });
	}

	/** Auto-update armed for `at` (or disarmed with null). */
	setScheduled(at: number | null): void {
		this.patch({ scheduledAt: at });
	}

	setExternalEmbed(held: boolean): void {
		this.patch({ externalEmbed: held });
	}

	/** An index run started: changes from here on stay dirty after it finishes. */
	beginRun(now: number): void {
		this.runSnapshot = new Set(this.dirty);
		this.runStartedAt = now;
		this.patch({ phase: "indexing", phaseSince: now, scheduledAt: null, error: null });
	}

	setPhase(phase: Exclude<IndexPhase, "idle">, now: number): void {
		this.patch({ phase, phaseSince: now });
	}

	finishRun(result: { embedBusy?: boolean }): void {
		for (const path of this.runSnapshot ?? []) this.dirty.delete(path);
		this.runSnapshot = null;
		this.state = {
			...this.state,
			registered: true,
			phase: "idle",
			phaseSince: null,
			embedPending: result.embedBusy === true,
			error: null,
			lastIndexedAt: this.runStartedAt || this.state.lastIndexedAt,
		};
		this.emit();
	}

	failRun(message: string): void {
		this.runSnapshot = null;
		this.patch({ phase: "idle", phaseSince: null, error: message });
	}
}

/** "42s", "3m 05s", "1h 02m". */
export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function formatAgo(ms: number): string {
	const m = Math.floor(Math.max(0, ms) / 60000);
	if (m < 1) return "just now";
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

function notes(n: number): string {
	return `${n} note${n === 1 ? "" : "s"}`;
}

/** Map tracker state to status-bar / settings text. Priority: running > error > pending > ok. */
export function describeIndexStatus(s: IndexStatus, now: number): IndexStatusView {
	const external = s.externalEmbed ? " Another qmd embed is running (GPU busy)." : "";

	if (s.phase !== "idle") {
		const elapsed = s.phaseSince ? ` · ${formatDuration(now - s.phaseSince)}` : "";
		const step = s.phase === "indexing" ? "qmd update" : "qmd embed";
		return {
			level: "running",
			short: `${step}${elapsed}`,
			detail:
				s.phase === "indexing"
					? `Re-scanning the vault (qmd update)${elapsed}.`
					: `Embedding changed notes (qmd embed)${elapsed}.`,
			actionable: false,
		};
	}

	if (s.registered === false) {
		return { level: "ok", short: "", detail: "Vault not registered with qmd.", actionable: false };
	}

	if (s.error) {
		return {
			level: "error",
			short: "index update failed",
			detail: `Last index update failed: ${s.error}. Click to retry.`,
			actionable: true,
		};
	}

	if (s.dirty > 0) {
		const due = s.scheduledAt !== null ? ` · update in ${formatDuration(s.scheduledAt - now)}` : "";
		return {
			level: "pending",
			short: `${notes(s.dirty)} changed${due}`,
			detail:
				`${notes(s.dirty)} changed since Lantern's last qmd update — not yet searchable in their current form.` +
				(s.scheduledAt !== null ? ` Auto-update runs in ${formatDuration(s.scheduledAt - now)}.` : " Click to update.") +
				external,
			actionable: true,
		};
	}

	if (s.embedPending) {
		return {
			level: "warn",
			short: "embedding pending",
			detail:
				"Text index is current; embedding was skipped because another qmd embed held qmd's lock. " +
				"Semantic search misses the changed notes until it runs. Click to retry." +
				external,
			actionable: true,
		};
	}

	if (s.externalEmbed) {
		return {
			level: "running",
			short: "qmd embed running",
			detail: "Vault index current. Another process is running qmd embed (GPU busy).",
			actionable: false,
		};
	}

	const when = s.lastIndexedAt > 0 ? ` · updated ${formatAgo(now - s.lastIndexedAt)}` : "";
	return { level: "ok", short: "", detail: `Index current${when}`, actionable: false };
}
