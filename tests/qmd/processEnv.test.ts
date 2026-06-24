import { describe, it, expect } from "vitest";
import {
	commandEnv,
	extraBinDirs,
	isExplicitPath,
	resolveCommand,
	type HostInfo,
} from "../../src/qmd/processEnv";

function macHost(overrides: Partial<HostInfo> = {}): HostInfo {
	return {
		platform: "darwin",
		env: { PATH: "/usr/bin:/bin" },
		home: "/Users/me",
		exists: () => false,
		...overrides,
	};
}

function winHost(overrides: Partial<HostInfo> = {}): HostInfo {
	return {
		platform: "win32",
		env: {
			Path: "C:\\Windows\\system32;C:\\Windows",
			LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
			APPDATA: "C:\\Users\\me\\AppData\\Roaming",
		},
		home: "C:\\Users\\me",
		exists: () => false,
		...overrides,
	};
}

describe("extraBinDirs", () => {
	it("includes the documented pnpm/homebrew dirs on macOS", () => {
		const dirs = extraBinDirs(macHost());
		expect(dirs).toContain("/Users/me/Library/pnpm");
		expect(dirs).toContain("/opt/homebrew/bin");
		expect(dirs).toContain("/usr/local/bin");
	});

	it("respects PNPM_HOME when set", () => {
		const dirs = extraBinDirs(macHost({ env: { PATH: "", PNPM_HOME: "/custom/pnpm" } }));
		expect(dirs[0]).toBe("/custom/pnpm");
	});

	it("uses Windows locations on win32", () => {
		const dirs = extraBinDirs(winHost());
		expect(dirs.join(";")).toMatch(/AppData\\Local\\pnpm/);
		expect(dirs.join(";")).toMatch(/AppData\\Roaming\\npm/);
		expect(dirs.join(";")).toMatch(/scoop\\shims/);
	});
});

describe("commandEnv", () => {
	it("prepends extra dirs with ':' on macOS", () => {
		const env = commandEnv(macHost());
		expect(env.PATH).toMatch(/^\/Users\/me\/Library\/pnpm:/);
		expect(env.PATH).toMatch(/:\/usr\/bin:\/bin$/);
	});

	it("uses ';' and the existing 'Path' key casing on Windows", () => {
		const env = commandEnv(winHost());
		expect(env.Path).toBeDefined();
		expect(env.Path).toMatch(/;C:\\Windows\\system32;C:\\Windows$/);
		expect(env.Path).not.toContain(":C\\"); // no colon-joined corruption
	});
});

describe("isExplicitPath", () => {
	it("treats slashes as explicit on all platforms", () => {
		expect(isExplicitPath("/usr/local/bin/qmd", "darwin")).toBe(true);
		expect(isExplicitPath("qmd", "darwin")).toBe(false);
	});

	it("treats backslashes and drive letters as explicit on Windows", () => {
		expect(isExplicitPath("C:\\tools\\qmd.exe", "win32")).toBe(true);
		expect(isExplicitPath("tools\\qmd", "win32")).toBe(true);
		expect(isExplicitPath("qmd", "win32")).toBe(false);
	});
});

describe("resolveCommand", () => {
	it("returns explicit paths unchanged", () => {
		expect(resolveCommand("/abs/qmd", macHost())).toBe("/abs/qmd");
	});

	it("finds the binary in an extra dir on macOS", () => {
		const host = macHost({ exists: (p) => p === "/Users/me/Library/pnpm/qmd" });
		expect(resolveCommand("qmd", host)).toBe("/Users/me/Library/pnpm/qmd");
	});

	it("probes Windows executable extensions", () => {
		const host = winHost({
			exists: (p) => p === "C:\\Users\\me\\AppData\\Local\\pnpm\\qmd.cmd",
		});
		expect(resolveCommand("qmd", host)).toBe("C:\\Users\\me\\AppData\\Local\\pnpm\\qmd.cmd");
	});

	it("searches the env PATH after the extra dirs", () => {
		const host = macHost({ exists: (p) => p === "/usr/bin/qmd" });
		expect(resolveCommand("qmd", host)).toBe("/usr/bin/qmd");
	});

	it("falls back to the bare name when nothing is found", () => {
		expect(resolveCommand("qmd", macHost())).toBe("qmd");
	});
});
