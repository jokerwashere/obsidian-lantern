import { describe, it, expect, vi } from "vitest";
import { QmdService, type QmdServiceConfig } from "../../src/qmd/QmdService";
import type { QmdClient } from "../../src/qmd/QmdClient";
import type { QmdCli, QmdExecResult } from "../../src/qmd/QmdCli";

const ok: QmdExecResult = { code: 0, stdout: "", stderr: "" };

/** Grounded `qmd update` output shape (qmd 2.5.3, non-TTY = no colors). */
const UPDATE_UNCHANGED = `Updating 2 collection(s)...

[1/2] my-vault (**/*.md)
Collection: /abs/vault (**/*.md)

Indexed: 0 new, 0 updated, 731 unchanged, 0 removed

[2/2] unity-docs (**/*.md)
Collection: /docs (**/*.md)

Indexed: 0 new, 2 updated, 44877 unchanged, 0 removed

✓ All collections updated.
`;

const UPDATE_CHANGED = UPDATE_UNCHANGED.replace(
	"Indexed: 0 new, 0 updated, 731 unchanged, 0 removed",
	"Indexed: 1 new, 2 updated, 728 unchanged, 1 removed"
);

function makeMocks() {
	const client = {
		isRunning: vi.fn().mockResolvedValue(true),
		ensureRunning: vi.fn().mockResolvedValue(undefined),
		query: vi.fn().mockResolvedValue([]),
		updateConfig: vi.fn(),
	} as unknown as QmdClient;

	const cli = {
		hasCollection: vi.fn().mockResolvedValue(true),
		addCollection: vi.fn().mockResolvedValue(ok),
		embed: vi.fn().mockResolvedValue(ok),
		update: vi.fn().mockResolvedValue({ ...ok, stdout: UPDATE_CHANGED }),
		stopServer: vi.fn().mockResolvedValue(ok),
		version: vi.fn().mockResolvedValue({ ...ok, stdout: "qmd 2.5.3" }),
		setContext: vi.fn().mockResolvedValue(ok),
		removeContext: vi.fn().mockResolvedValue(ok),
		updateConfig: vi.fn(),
	} as unknown as QmdCli;

	return { client, cli };
}

function makeService(overrides: Partial<QmdServiceConfig> = {}, deps = makeMocks()) {
	const config: QmdServiceConfig = {
		binaryPath: "qmd",
		port: 8181,
		vaultCollection: "my-vault",
		autoStartDaemon: true,
		rerank: true,
		minScore: 0,
		...overrides,
	};
	const service = new QmdService(config, deps);
	service.setVaultPath("/abs/vault");
	return { service, ...deps };
}

describe("QmdService.ensureDaemon", () => {
	it("auto-starts the daemon when enabled", async () => {
		const { service, client } = makeService({ autoStartDaemon: true });
		await service.ensureDaemon();
		expect(client.ensureRunning).toHaveBeenCalled();
	});

	it("throws when auto-start is off and the daemon is down", async () => {
		const deps = makeMocks();
		vi.mocked(deps.client.isRunning).mockResolvedValue(false);
		const { service } = makeService({ autoStartDaemon: false }, deps);
		await expect(service.ensureDaemon()).rejects.toThrow(/not running/i);
		expect(deps.client.ensureRunning).not.toHaveBeenCalled();
	});
});

describe("QmdService.ensureVaultIndexed", () => {
	it("registers and embeds the vault when the collection is missing", async () => {
		const deps = makeMocks();
		vi.mocked(deps.cli.hasCollection).mockResolvedValue(false);
		const { service } = makeService({}, deps);

		const result = await service.ensureVaultIndexed();

		expect(deps.cli.addCollection).toHaveBeenCalledWith("/abs/vault", "my-vault");
		expect(deps.cli.embed).toHaveBeenCalledWith("my-vault");
		expect(result.registered).toBe(true);
	});

	it("re-embeds (recovery) when the collection already exists, without re-adding", async () => {
		const deps = makeMocks();
		vi.mocked(deps.cli.hasCollection).mockResolvedValue(true);
		const { service } = makeService({}, deps);

		const result = await service.ensureVaultIndexed();

		// Recovers a collection whose prior embed failed — embed runs (cheap
		// no-op when nothing is pending) but the collection is not re-added.
		expect(deps.cli.addCollection).not.toHaveBeenCalled();
		expect(deps.cli.embed).toHaveBeenCalledWith("my-vault");
		expect(result.registered).toBe(false);
		expect(result.embedded).toBe(true);
	});

	it("throws when collection add fails", async () => {
		const deps = makeMocks();
		vi.mocked(deps.cli.hasCollection).mockResolvedValue(false);
		vi.mocked(deps.cli.addCollection).mockResolvedValue({ code: 1, stdout: "", stderr: "boom" });
		const { service } = makeService({}, deps);

		await expect(service.ensureVaultIndexed()).rejects.toThrow(/collection add failed: boom/);
	});

	it("throws when the vault path is not set", async () => {
		const deps = makeMocks();
		vi.mocked(deps.cli.hasCollection).mockResolvedValue(false);
		const service = new QmdService(
			{
				binaryPath: "qmd",
				port: 8181,
				vaultCollection: "v",
				autoStartDaemon: true,
				rerank: true,
				minScore: 0,
			},
			deps
		);
		await expect(service.ensureVaultIndexed()).rejects.toThrow(/vault path not set/i);
	});
});

describe("QmdService.reindexVault", () => {
	it("updates and embeds when the vault collection changed", async () => {
		const deps = makeMocks();
		const { service } = makeService({}, deps);

		const result = await service.reindexVault();

		expect(deps.cli.update).toHaveBeenCalled();
		expect(deps.cli.embed).toHaveBeenCalledWith("my-vault");
		expect(result.embedded).toBe(true);
		expect(result.counts).toEqual({ added: 1, updated: 2, unchanged: 728, removed: 1 });
	});

	it("skips the embed pass when the vault collection is unchanged", async () => {
		const deps = makeMocks();
		vi.mocked(deps.cli.update).mockResolvedValue({ ...ok, stdout: UPDATE_UNCHANGED });
		const { service } = makeService({}, deps);

		const result = await service.reindexVault();

		expect(deps.cli.embed).not.toHaveBeenCalled();
		expect(result.embedded).toBe(false);
		expect(result.counts).toEqual({ added: 0, updated: 0, unchanged: 731, removed: 0 });
	});

	it("embeds anyway when the update output cannot be parsed (format drift)", async () => {
		const deps = makeMocks();
		vi.mocked(deps.cli.update).mockResolvedValue({ ...ok, stdout: "something unexpected" });
		const { service } = makeService({}, deps);

		const result = await service.reindexVault();

		expect(deps.cli.embed).toHaveBeenCalledWith("my-vault");
		expect(result.counts).toBeNull();
	});

	it("registers the collection first when it is missing", async () => {
		const deps = makeMocks();
		vi.mocked(deps.cli.hasCollection).mockResolvedValue(false);
		const { service } = makeService({}, deps);

		const result = await service.reindexVault();

		expect(deps.cli.addCollection).toHaveBeenCalled();
		expect(deps.cli.update).not.toHaveBeenCalled();
		expect(result.registered).toBe(true);
	});

	it("never restarts the daemon (qmd reads its index fresh per query)", async () => {
		const deps = makeMocks();
		vi.mocked(deps.client.isRunning).mockResolvedValue(true);
		const { service } = makeService({ autoStartDaemon: true }, deps);

		await service.reindexVault();

		expect(deps.cli.stopServer).not.toHaveBeenCalled();
	});

	it("shares one run between concurrent reindex requests", async () => {
		const deps = makeMocks();
		let release!: (v: QmdExecResult) => void;
		vi.mocked(deps.cli.update).mockReturnValue(
			new Promise<QmdExecResult>((resolve) => {
				release = resolve;
			})
		);
		const { service } = makeService({}, deps);

		const first = service.reindexVault();
		const second = service.reindexVault();
		release({ ...ok, stdout: UPDATE_UNCHANGED });

		const [a, b] = await Promise.all([first, second]);
		expect(deps.cli.update).toHaveBeenCalledTimes(1);
		expect(a).toBe(b);
	});
});

describe("QmdService.search", () => {
	it("scopes search to the vault collection by default and passes config", async () => {
		const deps = makeMocks();
		const { service } = makeService({ rerank: false, minScore: 0.25 }, deps);

		await service.search("webhooks", { mode: "hybrid", limit: 7, intent: "git" });

		expect(deps.client.query).toHaveBeenCalledWith("webhooks", {
			collections: ["my-vault"],
			rerank: false,
			minScore: 0.25,
			mode: "hybrid",
			limit: 7,
			intent: "git",
			hyde: undefined,
		});
	});

	it("uses configured searchCollections when provided", async () => {
		const deps = makeMocks();
		const { service } = makeService(
			{ searchCollections: ["my-vault", "apple-docs"] },
			deps
		);

		await service.search("swiftui");

		const call = vi.mocked(deps.client.query).mock.calls[0][1];
		expect(call?.collections).toEqual(["my-vault", "apple-docs"]);
	});

	it("applies the configured default intent when the caller passes none", async () => {
		const deps = makeMocks();
		const { service } = makeService({ searchIntent: "personal notes" }, deps);

		await service.search("rust");
		expect(vi.mocked(deps.client.query).mock.calls[0][1]?.intent).toBe("personal notes");

		await service.search("rust", { intent: "the game" });
		expect(vi.mocked(deps.client.query).mock.calls[1][1]?.intent).toBe("the game");
	});

	it("forwards a hyde passage", async () => {
		const deps = makeMocks();
		const { service } = makeService({}, deps);

		await service.search("rate limiting", { hyde: "The limiter uses a token bucket." });
		expect(vi.mocked(deps.client.query).mock.calls[0][1]?.hyde).toBe(
			"The limiter uses a token bucket."
		);
	});

	it("forwards any_of alternatives to the client", async () => {
		const deps = makeMocks();
		const { service } = makeService({}, deps);

		await service.search("IT people", { anyOf: ["engineer", "developer"] });
		expect(vi.mocked(deps.client.query).mock.calls[0][1]?.anyOf).toEqual(["engineer", "developer"]);
	});

	it("forwards distinct lex keywords for the BM25 sub-query", async () => {
		const deps = makeMocks();
		const { service } = makeService({}, deps);

		await service.search("how leadership decides", { lex: "OKR cockpit" });
		expect(vi.mocked(deps.client.query).mock.calls[0][1]?.lex).toBe("OKR cockpit");
	});

	it("lets a per-call minScore override the configured floor", async () => {
		const deps = makeMocks();
		const { service } = makeService({ minScore: 0.65 }, deps);

		await service.search("plan", { minScore: 0.4 });
		expect(vi.mocked(deps.client.query).mock.calls[0][1]?.minScore).toBe(0.4);

		await service.search("plan");
		expect(vi.mocked(deps.client.query).mock.calls[1][1]?.minScore).toBe(0.65);
	});
});

describe("QmdService.setVaultContext", () => {
	it("adds context on the vault collection root when text is non-empty (trimmed)", async () => {
		const deps = makeMocks();
		const { service } = makeService({ vaultCollection: "my-vault" }, deps);

		await service.setVaultContext("  Personal notes and journal  ");
		expect(deps.cli.setContext).toHaveBeenCalledWith("my-vault", "Personal notes and journal");
		expect(deps.cli.removeContext).not.toHaveBeenCalled();
	});

	it("removes context (best-effort) when text is blank", async () => {
		const deps = makeMocks();
		const { service } = makeService({ vaultCollection: "my-vault" }, deps);

		await service.setVaultContext("   ");
		expect(deps.cli.removeContext).toHaveBeenCalledWith("my-vault");
		expect(deps.cli.setContext).not.toHaveBeenCalled();
	});

	it("throws when context add fails", async () => {
		const deps = makeMocks();
		vi.mocked(deps.cli.setContext).mockResolvedValue({ code: 1, stdout: "", stderr: "bad path" });
		const { service } = makeService({}, deps);

		await expect(service.setVaultContext("x")).rejects.toThrow(/context add failed: bad path/);
	});

	it("swallows a remove failure (nothing to clear)", async () => {
		const deps = makeMocks();
		vi.mocked(deps.cli.removeContext).mockRejectedValue(new Error("no such context"));
		const { service } = makeService({}, deps);

		await expect(service.setVaultContext("")).resolves.toBeUndefined();
	});
});
