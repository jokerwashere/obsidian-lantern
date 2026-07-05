/**
 * QmdCli — wraps the `qmd` command-line for index/collection management.
 *
 * Querying goes through the warm HTTP daemon (see QmdClient); indexing has no
 * HTTP endpoint, so collection/update/embed operations shell out to the CLI.
 * These commands mutate qmd's global index (~/.cache/qmd/index.sqlite).
 */

import { execFile } from "child_process";
import { commandEnv, resolveCommand } from "./processEnv";

export interface QmdCliConfig {
	/** Path to the qmd binary. */
	binaryPath: string;
}

export interface QmdExecResult {
	/** Process exit code (0 = success). */
	code: number;
	stdout: string;
	stderr: string;
}

/** qmd's default glob for markdown collections. */
export const DEFAULT_MASK = "**/*.md";

const LIST_TIMEOUT_MS = 15_000;
/** Indexing/embedding a large vault can take minutes — no timeout. */
const INDEX_TIMEOUT_MS = 0;
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Parse collection names from `qmd collection list` output.
 * Lines look like: `my-collection (qmd://my-collection/)`.
 * (qmd disables ANSI colors when stdout is not a TTY, so execFile output is plain.)
 */
export function parseCollectionNames(listOutput: string): string[] {
	const names: string[] = [];
	const re = /^(\S+)\s+\(qmd:\/\//gm;
	let match: RegExpExecArray | null;
	while ((match = re.exec(listOutput)) !== null) {
		names.push(match[1]);
	}
	return names;
}

export interface UpdateCounts {
	added: number;
	updated: number;
	unchanged: number;
	removed: number;
}

/** Files changed (added/updated/removed) according to these counts. */
export function hasChanges(counts: UpdateCounts | undefined): boolean {
	if (!counts) return false;
	return counts.added > 0 || counts.updated > 0 || counts.removed > 0;
}

/**
 * Parse per-collection results from `qmd update` output. qmd prints, per
 * collection, a `[i/N] <name> (<glob>)` header followed (possibly after other
 * lines) by `Indexed: X new, Y updated, Z unchanged, W removed`. Output from a
 * collection's custom update command is indented by four spaces, so it cannot
 * shadow either marker line.
 */
export function parseUpdateOutput(stdout: string): Record<string, UpdateCounts> {
	const result: Record<string, UpdateCounts> = {};
	let current: string | null = null;
	for (const line of stdout.split("\n")) {
		const header = line.match(/^\[\d+\/\d+\]\s+(\S+)\s+\(/);
		if (header) {
			current = header[1];
			continue;
		}
		const counts = line.match(/^Indexed: (\d+) new, (\d+) updated, (\d+) unchanged, (\d+) removed/);
		if (counts && current) {
			result[current] = {
				added: parseInt(counts[1], 10),
				updated: parseInt(counts[2], 10),
				unchanged: parseInt(counts[3], 10),
				removed: parseInt(counts[4], 10),
			};
			current = null;
		}
	}
	return result;
}

export class QmdCli {
	private config: QmdCliConfig;

	constructor(config: QmdCliConfig) {
		this.config = config;
	}

	updateConfig(config: Partial<QmdCliConfig>): void {
		this.config = { ...this.config, ...config };
	}

	/** Run a qmd subcommand, resolving with its exit code and output. */
	run(args: string[], timeoutMs: number = INDEX_TIMEOUT_MS): Promise<QmdExecResult> {
		return new Promise((resolve, reject) => {
			execFile(
				resolveCommand(this.config.binaryPath),
				args,
				{ timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: commandEnv() },
				(error, stdout, stderr) => {
					const out = stdout?.toString() ?? "";
					const err = stderr?.toString() ?? "";

					// execFile sets `code` to "ENOENT" (string) for a missing binary,
					// or the numeric exit code for a non-zero exit.
					const rawCode = (error as { code?: string | number } | null)?.code;

					if (rawCode === "ENOENT") {
						reject(
							new Error(
								`qmd binary not found at "${this.config.binaryPath}". ` +
								"Set the qmd path in Lantern settings."
							)
						);
						return;
					}

					const code = typeof rawCode === "number" ? rawCode : error ? 1 : 0;
					resolve({ code, stdout: out, stderr: err });
				}
			);
		});
	}

	/** Names of all configured collections. Throws when the CLI itself fails. */
	async listCollectionNames(): Promise<string[]> {
		const res = await this.run(["collection", "list"], LIST_TIMEOUT_MS);
		if (res.code !== 0) {
			throw new Error(`qmd collection list failed: ${(res.stderr || res.stdout).trim()}`);
		}
		return parseCollectionNames(res.stdout);
	}

	async hasCollection(name: string): Promise<boolean> {
		return (await this.listCollectionNames()).includes(name);
	}

	/** Register a folder as a collection (text-indexes it immediately). */
	async addCollection(
		path: string,
		name: string,
		mask: string = DEFAULT_MASK
	): Promise<QmdExecResult> {
		return this.run(["collection", "add", path, "--name", name, "--mask", mask]);
	}

	async removeCollection(name: string): Promise<QmdExecResult> {
		return this.run(["collection", "remove", name]);
	}

	/** Re-index all collections (text). Hash-based, so unchanged files are cheap. */
	async update(): Promise<QmdExecResult> {
		return this.run(["update"]);
	}

	/** Generate/refresh embeddings, optionally limited to one collection. */
	async embed(collection?: string, force = false): Promise<QmdExecResult> {
		const args = ["embed"];
		if (force) args.push("-f");
		if (collection) args.push("-c", collection);
		return this.run(args);
	}

	/**
	 * Attach a human-written context summary to a collection root, improving
	 * ranking (`qmd context add qmd://<name>/ "<text>"`). Re-adding the root
	 * overwrites (qmd keys contexts by path prefix). Args go through execFile's
	 * argv (no shell), so the text is passed literally — no quoting needed.
	 */
	async setContext(collection: string, text: string): Promise<QmdExecResult> {
		return this.run(["context", "add", `qmd://${collection}/`, text], LIST_TIMEOUT_MS);
	}

	/** Remove a collection-root context (`qmd context rm qmd://<name>/`). */
	async removeContext(collection: string): Promise<QmdExecResult> {
		return this.run(["context", "rm", `qmd://${collection}/`], LIST_TIMEOUT_MS);
	}

	/** Stop the qmd HTTP daemon (via its PID file). */
	async stopServer(): Promise<QmdExecResult> {
		return this.run(["mcp", "stop"], LIST_TIMEOUT_MS);
	}

	/** Cheap binary check (`qmd --version`). Rejects with ENOENT guidance when missing. */
	async version(): Promise<QmdExecResult> {
		return this.run(["--version"], LIST_TIMEOUT_MS);
	}
}
