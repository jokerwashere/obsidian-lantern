/**
 * LIVE test of the qmd integration against a real, running qmd daemon.
 * Skipped unless LANTERN_LIVE_QMD=1. Read-only: queries and reads only.
 *
 *   LANTERN_LIVE_QMD=1 LANTERN_QMD_COLLECTION=<name> npx vitest run tests/live/qmdLive.test.ts
 *
 * Covers what qmd 2.8 changed under Lantern: `qmd://` percent-encoded result
 * URIs, stateless MCP `get` (protocol 2026-07-28), the Origin guard, and the
 * `--version` floor.
 */
import { describe, it, expect } from "vitest";
import { requestUrl } from "obsidian";
import { QmdClient } from "../../src/qmd/QmdClient";
import { QmdService } from "../../src/qmd/QmdService";

const LIVE = process.env.LANTERN_LIVE_QMD === "1";
const PORT = Number(process.env.LANTERN_QMD_PORT ?? 8181);
const BINARY = process.env.LANTERN_QMD_BIN ?? "qmd";
const COLLECTION = process.env.LANTERN_QMD_COLLECTION ?? "";
const QUERY = process.env.LANTERN_QMD_QUERY ?? "the";

describe.skipIf(!LIVE)("qmd live", () => {
	const client = new QmdClient({ port: PORT, binaryPath: BINARY });
	const service = new QmdService({
		binaryPath: BINARY,
		port: PORT,
		vaultCollection: COLLECTION,
		autoStartDaemon: false,
		rerank: false,
		minScore: 0,
	});

	it("reports a supported qmd version", async () => {
		const info = await service.getVersion();
		console.log("qmd version:", info.version);
		expect(info.supported).toBe(true);
	});

	it("searches a collection and reads a hit back through MCP get", async () => {
		expect(COLLECTION, "set LANTERN_QMD_COLLECTION").not.toBe("");
		expect(await client.isRunning()).toBe(true);
		const results = await client.query(QUERY, { collections: [COLLECTION], limit: 3, rerank: false, mode: "text" });
		expect(results.length).toBeGreaterThan(0);
		const hit = results[0];
		expect(hit.collection).toBe(COLLECTION);
		expect(hit.path).not.toMatch(/%[0-9A-F]{2}/i); // decoded

		const doc = await service.getDocument(hit.collection, hit.path);
		expect(doc.ok).toBe(true);
		if (doc.ok) {
			expect(doc.collection).toBe(COLLECTION);
			expect(doc.path).toBe(hit.path);
			expect(doc.text.length).toBeGreaterThan(0);
		}

		const missing = await service.getDocument(COLLECTION, "lantern-live-no-such-file.md");
		expect(missing.ok).toBe(false);
	});

	it("is refused by the Origin guard only when an Origin header is sent", async () => {
		const res = await requestUrl({
			url: `http://localhost:${PORT}/health`,
			method: "GET",
			headers: { Origin: "app://obsidian.md" },
			throw: false,
		});
		expect(res.status).toBe(403);
	});
});
