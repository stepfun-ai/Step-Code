import { describe, expect, it } from "vitest";
import { cleanPastedPath, isImageFilePath, isWindowsPath, wslPathToPosix } from "../src/utils/clipboard-image.ts";

// Terminals shell-escape spaces/parens when a file path is pasted or dragged
// (e.g. "a\ file\ \(1\).png"). cleanPastedPath undoes that so the path resolves.
describe("cleanPastedPath", () => {
	it("unescapes spaces and parens on macOS/Linux", () => {
		expect(cleanPastedPath("1280X1280\\ \\(1\\)_副本.PNG", "darwin")).toBe("1280X1280 (1)_副本.PNG");
		expect(cleanPastedPath("/Users/x/a\\ b.png", "linux")).toBe("/Users/x/a b.png");
	});

	it("strips surrounding single or double quotes", () => {
		expect(cleanPastedPath('"/Users/x/c d.png"', "darwin")).toBe("/Users/x/c d.png");
		expect(cleanPastedPath("'/Users/x/c d.png'", "darwin")).toBe("/Users/x/c d.png");
	});

	it("preserves a doubled backslash as one literal backslash", () => {
		expect(cleanPastedPath("a\\\\b.png", "linux")).toBe("a\\b.png");
	});

	// A leading-backslash POSIX filename is shell-escaped to `\\file.png` on paste;
	// the tightened UNC check must not treat it as a Windows path, so it unescapes.
	it("unescapes a leading-backslash POSIX filename on linux (not misread as UNC)", () => {
		expect(cleanPastedPath("\\\\file.png", "linux")).toBe("\\file.png");
	});

	it("leaves backslashes intact on Windows (they are path separators)", () => {
		expect(cleanPastedPath("C:\\Users\\a\\pic.png", "win32")).toBe("C:\\Users\\a\\pic.png");
	});

	// Regression: on WSL `process.platform` is "linux", so cleanPastedPath used to
	// unescape a pasted Windows path's backslashes (C:\Users\...\美女.jpg ->
	// C:Users...美女.jpg), breaking resolution. A Windows-shaped path must stay intact.
	it("leaves a Windows path intact on WSL/linux (does not strip backslashes)", () => {
		expect(cleanPastedPath("C:\\Users\\Administrator\\Desktop\\美女.jpg", "linux")).toBe(
			"C:\\Users\\Administrator\\Desktop\\美女.jpg",
		);
		expect(cleanPastedPath("c:/Users/a/pic.png", "linux")).toBe("c:/Users/a/pic.png");
	});

	it("strips surrounding quotes from a Windows path but keeps its backslashes", () => {
		expect(cleanPastedPath('"C:\\Users\\a b\\pic.png"', "linux")).toBe("C:\\Users\\a b\\pic.png");
	});

	it("leaves an ordinary path unchanged", () => {
		expect(cleanPastedPath("/tmp/plain.png", "darwin")).toBe("/tmp/plain.png");
	});

	it("makes an escaped image path recognizable by isImageFilePath", () => {
		expect(isImageFilePath(cleanPastedPath("shot\\ \\(2\\).jpeg", "darwin"))).toBe(true);
	});
});

describe("isWindowsPath", () => {
	it("recognizes drive-letter paths (backslash or forward slash)", () => {
		expect(isWindowsPath("C:\\Users\\a\\pic.png")).toBe(true);
		expect(isWindowsPath("c:/Users/a/pic.png")).toBe(true);
		expect(isWindowsPath("Z:\\x")).toBe(true);
	});

	it("recognizes UNC paths with a host and share", () => {
		expect(isWindowsPath("\\\\server\\share\\pic.png")).toBe(true);
	});

	it("rejects POSIX paths, bare names, relative/leading-backslash paths, and empty", () => {
		expect(isWindowsPath("/mnt/c/Users/a/pic.png")).toBe(false);
		expect(isWindowsPath("pic.png")).toBe(false);
		expect(isWindowsPath("a\\b.png")).toBe(false);
		// A single leading-backslash filename is NOT UNC (no host\share segments).
		expect(isWindowsPath("\\\\file.png")).toBe(false);
		expect(isWindowsPath("")).toBe(false);
	});
});

// wslPathToPosix shells out to `wslpath`; every test injects `run` so no real
// wslpath is invoked, and forces WSL via env so the check is host-independent.
describe("wslPathToPosix", () => {
	const wslEnv = { WSL_DISTRO_NAME: "Ubuntu" };

	it("converts a Windows path via `wslpath -u` on WSL", async () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const run = async (command: string, args: string[]): Promise<string | null> => {
			calls.push({ command, args });
			return "/mnt/c/Users/Administrator/Desktop/美女.jpg";
		};
		const result = await wslPathToPosix("C:\\Users\\Administrator\\Desktop\\美女.jpg", { env: wslEnv, run });
		expect(result).toBe("/mnt/c/Users/Administrator/Desktop/美女.jpg");
		expect(calls).toEqual([{ command: "wslpath", args: ["-u", "C:\\Users\\Administrator\\Desktop\\美女.jpg"] }]);
	});

	it("returns null for a non-Windows path without shelling out", async () => {
		let called = false;
		const run = async (): Promise<string | null> => {
			called = true;
			return "unexpected";
		};
		const result = await wslPathToPosix("/home/user/pic.png", { env: wslEnv, run });
		expect(result).toBeNull();
		expect(called).toBe(false);
	});

	it("returns null when the conversion fails or yields nothing", async () => {
		expect(await wslPathToPosix("C:\\Users\\a\\pic.png", { env: wslEnv, run: async () => null })).toBeNull();
		expect(await wslPathToPosix("C:\\Users\\a\\pic.png", { env: wslEnv, run: async () => "" })).toBeNull();
	});
});
