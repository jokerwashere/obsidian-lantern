import { describe, it, expect, vi } from "vitest";
import { IndexTracker, describeIndexStatus, formatDuration, formatAgo } from "../../src/qmd/indexStatus";

const T0 = 1_800_000_000_000;

describe("IndexTracker", () => {
	it("counts distinct changed notes and notifies subscribers", () => {
		const t = new IndexTracker();
		const fn = vi.fn();
		t.subscribe(fn);
		t.markChanged("a.md");
		t.markChanged("a.md");
		t.markChanged("b.md");
		expect(t.status.dirty).toBe(2);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("clears only the notes captured at run start; edits during the run stay dirty", () => {
		const t = new IndexTracker();
		t.markChanged("a.md");
		t.beginRun(T0);
		expect(t.status.phase).toBe("indexing");
		t.markChanged("b.md"); // edited mid-run
		t.setPhase("embedding", T0 + 5000);
		t.finishRun({});
		expect(t.status).toMatchObject({ dirty: 1, phase: "idle", lastIndexedAt: T0, embedPending: false });
	});

	it("records a lock-skipped embed and a failed run", () => {
		const t = new IndexTracker();
		t.beginRun(T0);
		t.finishRun({ embedBusy: true });
		expect(t.status.embedPending).toBe(true);
		t.markChanged("a.md");
		t.beginRun(T0 + 1);
		t.failRun("qmd update failed: boom");
		expect(t.status).toMatchObject({ phase: "idle", error: "qmd update failed: boom", dirty: 1 });
	});

	it("beginRun disarms a scheduled auto-update", () => {
		const t = new IndexTracker();
		t.setScheduled(T0 + 30_000);
		t.beginRun(T0);
		expect(t.status.scheduledAt).toBeNull();
	});
});

describe("describeIndexStatus", () => {
	const base = new IndexTracker(T0 - 5 * 60_000).status;

	it("hides the status bar when the index is current", () => {
		const v = describeIndexStatus({ ...base, registered: true }, T0);
		expect(v).toMatchObject({ level: "ok", short: "", actionable: false });
		expect(v.detail).toBe("Index current · updated 5m ago");
	});

	it("shows changed notes with the auto-update countdown", () => {
		const v = describeIndexStatus({ ...base, dirty: 3, scheduledAt: T0 + 24_000 }, T0);
		expect(v).toMatchObject({ level: "pending", short: "3 notes changed · update in 24s", actionable: true });
	});

	it("shows changed notes as click-to-update when auto-update is off", () => {
		const v = describeIndexStatus({ ...base, dirty: 1 }, T0);
		expect(v.short).toBe("1 note changed");
		expect(v.detail).toMatch(/Click to update/);
	});

	it("shows the running phase with elapsed time, not clickable", () => {
		const v = describeIndexStatus({ ...base, dirty: 2, phase: "embedding", phaseSince: T0 - 72_000 }, T0);
		expect(v).toMatchObject({ level: "running", short: "qmd embed · 1m 12s", actionable: false });
	});

	it("ranks error over pending, and pending over a skipped embed", () => {
		expect(describeIndexStatus({ ...base, dirty: 2, error: "boom" }, T0).level).toBe("error");
		expect(describeIndexStatus({ ...base, dirty: 2, embedPending: true }, T0).level).toBe("pending");
		expect(describeIndexStatus({ ...base, embedPending: true }, T0)).toMatchObject({
			level: "warn",
			short: "embedding pending",
		});
	});

	it("reports another process's qmd embed when the vault is current", () => {
		expect(describeIndexStatus({ ...base, externalEmbed: true }, T0)).toMatchObject({
			level: "running",
			short: "qmd embed running",
		});
	});

	it("stays hidden for an unregistered vault (the setup card covers it)", () => {
		expect(describeIndexStatus({ ...base, registered: false, dirty: 4 }, T0).short).toBe("");
	});
});

describe("formatDuration / formatAgo", () => {
	it("formats compactly", () => {
		expect(formatDuration(42_000)).toBe("42s");
		expect(formatDuration(185_000)).toBe("3m 05s");
		expect(formatDuration(3_720_000)).toBe("1h 02m");
		expect(formatAgo(10_000)).toBe("just now");
		expect(formatAgo(3 * 3_600_000)).toBe("3h ago");
		expect(formatAgo(3 * 86_400_000)).toBe("3d ago");
	});
});
