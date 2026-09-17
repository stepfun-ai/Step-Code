import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeContext } from "../src/ui/runtime/context.ts";

// Exercise the WSL Windows-path branch of insertPastedImagePath end-to-end: the
// real cleanPastedPath/isImageFilePath/isWindowsPath run, while wslPathToPosix and
// fs.existsSync are controlled so we can assert the resolved POSIX path (not the
// raw `C:\...` text) is threaded into the `@"..."` reference.
const mocks = vi.hoisted(() => ({
	wslPathToPosix: vi.fn<(winPath: string) => Promise<string | null>>(),
	existsSync: vi.fn<(p: string) => boolean>(),
}));

vi.mock("@step-harness/coding-agent", async (importOriginal) => {
	const actual = await importOriginal();
	return Object.assign({}, actual as object, { wslPathToPosix: mocks.wslPathToPosix });
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal();
	return Object.assign({}, actual as object, { existsSync: mocks.existsSync });
});

const { insertPastedImagePath } = await import("../src/ui/runtime/input-dispatch.ts");

function makeCtx(): { ctx: RuntimeContext; inserted: string[] } {
	const inserted: string[] = [];
	const ctx = {
		editor: {
			insertTextAtCursor: (text: string) => {
				inserted.push(text);
			},
		},
		redraw: { requestRender: () => {} },
	} as unknown as RuntimeContext;
	return { ctx, inserted };
}

describe("insertPastedImagePath WSL Windows-path branch", () => {
	beforeEach(() => {
		mocks.wslPathToPosix.mockReset();
		mocks.existsSync.mockReset();
	});

	it("resolves a pasted Windows image path to an @-reference of the POSIX path", async () => {
		const posix = "/mnt/c/Users/Administrator/Desktop/pic.jpg";
		mocks.wslPathToPosix.mockResolvedValue(posix);
		mocks.existsSync.mockImplementation((p) => p === posix);

		const { ctx, inserted } = makeCtx();
		await insertPastedImagePath(ctx, "C:\\Users\\Administrator\\Desktop\\pic.jpg");

		expect(mocks.wslPathToPosix).toHaveBeenCalledWith("C:\\Users\\Administrator\\Desktop\\pic.jpg");
		expect(inserted).toEqual([`@"${posix}"`]);
	});

	it("inserts the raw text unchanged when the Windows path cannot be resolved", async () => {
		mocks.wslPathToPosix.mockResolvedValue(null);
		mocks.existsSync.mockReturnValue(false);

		const { ctx, inserted } = makeCtx();
		await insertPastedImagePath(ctx, "C:\\Users\\a\\pic.jpg");

		expect(inserted).toEqual(["C:\\Users\\a\\pic.jpg"]);
	});
});
