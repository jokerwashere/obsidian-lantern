import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, toServiceConfig, toLlmConfig, type LanternSettings } from "../src/settings";

function settings(overrides: Partial<LanternSettings> = {}): LanternSettings {
	return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("toServiceConfig", () => {
	it("maps core qmd fields from settings", () => {
		const c = toServiceConfig(
			settings({
				qmdBinaryPath: "/bin/qmd",
				qmdPort: 9000,
				vaultCollection: "vault",
				autoStartDaemon: false,
				rerank: false,
				minScore: 0.5,
			})
		);
		expect(c).toMatchObject({
			binaryPath: "/bin/qmd",
			port: 9000,
			vaultCollection: "vault",
			autoStartDaemon: false,
			rerank: false,
			minScore: 0.5,
		});
	});

	it("treats an empty searchIntent as undefined but keeps a set one", () => {
		expect(toServiceConfig(settings({ searchIntent: "" })).searchIntent).toBeUndefined();
		expect(toServiceConfig(settings({ searchIntent: "code" })).searchIntent).toBe("code");
	});

	it("omits searchCollections when no external collections are configured", () => {
		expect(toServiceConfig(settings({ searchExternalCollections: [] })).searchCollections).toBeUndefined();
	});

	it("spans the vault plus external collections when configured", () => {
		const c = toServiceConfig(
			settings({ vaultCollection: "vault", searchExternalCollections: ["PMBOK", "docs"] })
		);
		expect(c.searchCollections).toEqual(["vault", "PMBOK", "docs"]);
	});
});

describe("toLlmConfig", () => {
	it("maps llm fields from settings", () => {
		const c = toLlmConfig(settings({ llmBaseUrl: "http://x/v1", llmTemperature: 0.7, reasoningEffort: "high" }));
		expect(c).toMatchObject({ baseUrl: "http://x/v1", temperature: 0.7, reasoningEffort: "high" });
	});

	it("treats empty apiKey/model as undefined but keeps set ones", () => {
		const empty = toLlmConfig(settings({ llmApiKey: "", llmModel: "" }));
		expect(empty.apiKey).toBeUndefined();
		expect(empty.model).toBeUndefined();
		const set = toLlmConfig(settings({ llmApiKey: "sk", llmModel: "qwen" }));
		expect(set.apiKey).toBe("sk");
		expect(set.model).toBe("qwen");
	});
});
