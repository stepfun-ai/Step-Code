import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openBrowser } from "../src/utils/open-browser.ts";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
afterEach(() => spawn.mockReset());

describe("best-effort browser launch", () => {
	it("passes the URL without a shell and does not wait for the browser", () => {
		const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
		spawn.mockReturnValue(child);
		const url = "https://example.test/cli-login-remote?flow_id=123&x=y";
		expect(openBrowser(url)).toBeUndefined();
		expect(spawn.mock.calls[0]?.[1]).toContain(url);
		expect(spawn.mock.calls[0]?.[2]).not.toHaveProperty("shell");
		expect(child.unref).toHaveBeenCalledOnce();
		expect(() => child.emit("error", new Error("ENOENT"))).not.toThrow();
		expect(() => child.emit("exit", 3, null)).not.toThrow();
	});
	it("does not interrupt login on a synchronous launcher failure", () => {
		spawn.mockImplementation(() => {
			throw new Error("no desktop");
		});
		expect(() => openBrowser("https://example.test")).not.toThrow();
	});
});
