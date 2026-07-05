/**
 * Environment for spawning/exec'ing the qmd binary.
 *
 * Obsidian is a GUI app, so its process PATH is minimal (typically not the
 * login-shell PATH). That means a bare `qmd` — installed under e.g.
 * ~/Library/pnpm, Homebrew, or %LOCALAPPDATA%\pnpm — won't resolve. Prepend
 * the common user/CLI bin directories so `qmd` (and the node it launches) are
 * found without the user having to hardcode an absolute path.
 *
 * Everything is parameterized by a `HostInfo` (platform / env / home /
 * exists) so the platform-specific logic is unit-testable; callers use the
 * real-host defaults.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { posix, win32 } from "path";

export interface HostInfo {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	home: string;
	/** Injectable existsSync for tests. */
	exists: (path: string) => boolean;
}

function realHost(): HostInfo {
	return { platform: process.platform, env: process.env, home: homedir(), exists: (path: string) => existsSync(path) };
}

/** Platform-correct path helpers for the (possibly injected) host platform. */
function pathApi(platform: NodeJS.Platform): typeof posix {
	return platform === "win32" ? win32 : posix;
}

/**
 * Common CLI bin directories not usually on a GUI app's PATH.
 * pnpm's documented global-bin defaults: macOS ~/Library/pnpm,
 * Linux ~/.local/share/pnpm, Windows %LOCALAPPDATA%\pnpm.
 */
export function extraBinDirs(host: HostInfo = realHost()): string[] {
	const { platform, env, home } = host;
	const path = pathApi(platform);
	const join = (...parts: string[]) => path.join(...parts);

	if (platform === "win32") {
		return [
			env.PNPM_HOME ?? "",
			env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "pnpm") : "",
			env.APPDATA ? join(env.APPDATA, "npm") : "",
			home ? join(home, "scoop", "shims") : "",
			home ? join(home, ".bun", "bin") : "",
		].filter((p) => p.length > 0);
	}

	return [
		env.PNPM_HOME ?? "",
		home ? join(home, "Library", "pnpm") : "", // pnpm (macOS)
		home ? join(home, ".local", "share", "pnpm") : "", // pnpm (Linux)
		home ? join(home, ".local", "bin") : "",
		home ? join(home, ".bun", "bin") : "",
		"/opt/homebrew/bin", // Homebrew (Apple Silicon)
		"/opt/local/bin", // MacPorts
		"/opt/local/sbin",
		"/usr/local/bin", // Homebrew (Intel) / manual installs
		"/usr/bin",
		"/bin",
	].filter((p) => p.length > 0);
}

/** The PATH key as it exists in the env (Windows may use "Path"). */
function pathKey(env: NodeJS.ProcessEnv): string {
	return Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
}

/** Process env with the extra bin dirs prepended to PATH (platform-correct separator). */
export function commandEnv(host: HostInfo = realHost()): NodeJS.ProcessEnv {
	const sep = pathApi(host.platform).delimiter;
	const key = pathKey(host.env);
	const existing = host.env[key] ?? "";
	const path = [...extraBinDirs(host), existing].filter((p) => p.length > 0).join(sep);
	return { ...host.env, [key]: path };
}

/** True when the value is an explicit path rather than a bare command name. */
export function isExplicitPath(binaryPath: string, platform: NodeJS.Platform = process.platform): boolean {
	if (binaryPath.includes("/")) return true;
	if (platform === "win32" && (binaryPath.includes("\\") || /^[A-Za-z]:/.test(binaryPath))) return true;
	return false;
}

/** Executable suffixes to probe per platform. */
function executableExtensions(platform: NodeJS.Platform): string[] {
	return platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
}

/**
 * Resolve a bare command name (e.g. "qmd") to an absolute path by searching
 * the augmented PATH. Node's spawn/execFile don't reliably use options.env.PATH
 * to locate the executable, so we resolve it ourselves. Explicit paths are
 * returned unchanged.
 */
export function resolveCommand(binaryPath: string, host: HostInfo = realHost()): string {
	if (isExplicitPath(binaryPath, host.platform)) return binaryPath;

	const path = pathApi(host.platform);
	const join = (...parts: string[]) => path.join(...parts);
	const envPath = host.env[pathKey(host.env)] ?? "";
	const dirs = [...extraBinDirs(host), ...envPath.split(path.delimiter)];
	const exts = executableExtensions(host.platform);

	for (const dir of dirs) {
		if (!dir) continue;
		for (const ext of exts) {
			const candidate = join(dir, binaryPath + ext);
			try {
				if (host.exists(candidate)) return candidate;
			} catch {
				/* ignore */
			}
		}
	}
	return binaryPath; // fall back to letting spawn/execFile try
}
