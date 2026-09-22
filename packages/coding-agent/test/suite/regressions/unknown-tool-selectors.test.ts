import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// User feedback: `stepcode -p --tools definitely_missing ...` ran normally with no
// warning — an unknown name in the allowlist selected nothing and was silently
// ignored. getUnknownToolSelectors reports those names so print mode can warn.
describe("unknown --tools / --exclude-tools selectors", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("reports allowlist names that match no registered tool", async () => {
		harness = await createHarness({ allowedToolNames: ["definitely_missing", "read"] });

		const result = harness.session.getUnknownToolSelectors();
		expect(result.tools).toEqual(["definitely_missing"]);
		expect(result.excludeTools).toEqual([]);
	});

	it("reports unknown --exclude-tools names too", async () => {
		harness = await createHarness({ excludedToolNames: ["also_missing", "write"] });

		const result = harness.session.getUnknownToolSelectors();
		expect(result.tools).toEqual([]);
		expect(result.excludeTools).toEqual(["also_missing"]);
	});

	it("reports nothing when every selector names a real tool", async () => {
		harness = await createHarness({ allowedToolNames: ["read", "bash"], excludedToolNames: ["write"] });

		const result = harness.session.getUnknownToolSelectors();
		expect(result.tools).toEqual([]);
		expect(result.excludeTools).toEqual([]);
	});

	it("reports nothing when no selectors were passed", async () => {
		harness = await createHarness();

		const result = harness.session.getUnknownToolSelectors();
		expect(result.tools).toEqual([]);
		expect(result.excludeTools).toEqual([]);
	});

	// A name excluded from the registry is still a real tool: validation compares
	// against the unfiltered universe, not the post-filter registry.
	it("does not report a real tool that the allowlist filtered out", async () => {
		harness = await createHarness({ allowedToolNames: ["read"], excludedToolNames: ["bash"] });

		const result = harness.session.getUnknownToolSelectors();
		expect(result.tools).toEqual([]);
		expect(result.excludeTools).toEqual([]);
	});

	// getAllTools() reports the post-filter set, which is empty exactly when every
	// selector was misspelled — knownTools must still list the real choices so the
	// warning can tell the user what was available.
	it("lists the unfiltered tool universe even when the allowlist matched nothing", async () => {
		harness = await createHarness({ allowedToolNames: ["definitely_missing"] });

		const result = harness.session.getUnknownToolSelectors();
		expect(harness.session.getAllTools()).toEqual([]);
		expect(result.knownTools).toContain("read");
		expect(result.knownTools).toContain("bash");
		expect(result.knownTools).toEqual([...result.knownTools].sort());
	});
});
