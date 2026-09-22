import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeContext } from "../src/ui/runtime/context.ts";
import { PastedImageRegistry } from "../src/ui/runtime/pasted-images.ts";

// Exercise the WSL Windows-path branch of insertPastedImagePath end-to-end: the
// real cleanPastedPath/isImageFilePath/isWindowsPath run, while wslPathToPosix and
// fs.existsSync are controlled so we can assert the resolved POSIX path (not the
// raw `C:\...` text) is registered and inserted as an `[Image #N]` placeholder.
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

function makeCtx(): { ctx: RuntimeContext; inserted: string[]; pastedImages: PastedImageRegistry } {
	const inserted: string[] = [];
	const pastedImages = new PastedImageRegistry();
	const ctx = {
		editor: {
			insertTextAtCursor: (text: string) => {
				inserted.push(text);
			},
		},
		redraw: { requestRender: () => {} },
		pastedImages,
	} as unknown as RuntimeContext;
	return { ctx, inserted, pastedImages };
}

describe("insertPastedImagePath WSL Windows-path branch", () => {
	beforeEach(() => {
		mocks.wslPathToPosix.mockReset();
		mocks.existsSync.mockReset();
	});

	it("registers a pasted Windows image path and inserts an [Image #N] placeholder for the POSIX path", async () => {
		const posix = "/mnt/c/Users/Administrator/Desktop/pic.jpg";
		mocks.wslPathToPosix.mockResolvedValue(posix);
		mocks.existsSync.mockImplementation((p) => p === posix);

		const { ctx, inserted, pastedImages } = makeCtx();
		await insertPastedImagePath(ctx, "C:\\Users\\Administrator\\Desktop\\pic.jpg");

		expect(mocks.wslPathToPosix).toHaveBeenCalledWith("C:\\Users\\Administrator\\Desktop\\pic.jpg");
		expect(inserted).toEqual(["[Image #1] "]);
		// The placeholder resolves back to the registered POSIX path.
		expect(pastedImages.scan("[Image #1] ").map((e) => e.path)).toEqual([posix]);
	});

	it("registers a spaced POSIX path the same way (no path is echoed into the editor)", async () => {
		const posix = "/mnt/c/Users/John Doe/pic.jpg";
		mocks.wslPathToPosix.mockResolvedValue(posix);
		mocks.existsSync.mockImplementation((p) => p === posix);

		const { ctx, inserted, pastedImages } = makeCtx();
		await insertPastedImagePath(ctx, "C:\\Users\\John Doe\\pic.jpg");

		expect(inserted).toEqual(["[Image #1] "]);
		expect(pastedImages.scan("[Image #1] ").map((e) => e.path)).toEqual([posix]);
	});

	it("inserts the raw text unchanged (and registers nothing) when the Windows path cannot be resolved", async () => {
		mocks.wslPathToPosix.mockResolvedValue(null);
		mocks.existsSync.mockReturnValue(false);

		const { ctx, inserted, pastedImages } = makeCtx();
		await insertPastedImagePath(ctx, "C:\\Users\\a\\pic.jpg");

		expect(inserted).toEqual(["C:\\Users\\a\\pic.jpg"]);
		expect(pastedImages.scan("[Image #1] ").map((e) => e.path)).toEqual([]);
	});
});
