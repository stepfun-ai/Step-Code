import assert from "node:assert/strict";
import test from "node:test";
import { browserMarkForName, detectBrowser } from "../client/src/lib/browser-identity.ts";

const UA = {
	chrome:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
	safari:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
	firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
	opera:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/115.0.0.0",
	electron:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) StepCode/0.84.4 Chrome/138.0.0.0 Electron/44.7.0 Safari/537.36",
};

test("the page's own browser is named from its user agent", () => {
	assert.deepEqual(detectBrowser(UA.chrome), { name: "Google Chrome", mark: "chrome" });
	assert.deepEqual(detectBrowser(UA.edge), { name: "Microsoft Edge", mark: "edge" });
	assert.deepEqual(detectBrowser(UA.safari), { name: "Safari", mark: "safari" });
	assert.deepEqual(detectBrowser(UA.firefox), { name: "Firefox", mark: "firefox" });
	assert.deepEqual(detectBrowser(UA.opera), { name: "Opera" });
	// Desktop's own window is not where "open in browser" lands.
	assert.equal(detectBrowser(UA.electron), undefined);
	assert.equal(detectBrowser("curl/8.0"), undefined);
});

test("Client Hints brands win over a Chromium fork's Chrome-like user agent", () => {
	assert.deepEqual(detectBrowser(UA.chrome, ["Not)A;Brand", "Brave", "Chromium"]), { name: "Brave" });
	assert.deepEqual(detectBrowser(UA.chrome, ["Chromium", "Microsoft Edge"]), { name: "Microsoft Edge", mark: "edge" });
	assert.deepEqual(detectBrowser(UA.chrome, ["Chromium", "Google Chrome"]), { name: "Google Chrome", mark: "chrome" });
});

test("OS default-browser names map to bundled marks", () => {
	assert.equal(browserMarkForName("Google Chrome"), "chrome");
	assert.equal(browserMarkForName("Safari"), "safari");
	assert.equal(browserMarkForName("Microsoft Edge"), "edge");
	assert.equal(browserMarkForName("Firefox Developer Edition"), "firefox");
	assert.equal(browserMarkForName("Chromium"), undefined);
	assert.equal(browserMarkForName("Arc"), undefined);
});
