import assert from "node:assert/strict";
import { test } from "node:test";
import { ALLOWED_PERMISSIONS, isAllowedPermission, originOf } from "../src/permissions.ts";

const origin = "http://127.0.0.1:3077";

test("the window grants only the fixed permission list to its own server origin", () => {
	assert.deepEqual([...ALLOWED_PERMISSIONS].sort(), ["clipboard-sanitized-write", "fullscreen", "media"]);

	for (const permission of ALLOWED_PERMISSIONS) {
		assert.equal(isAllowedPermission(permission, `${origin}/`, origin), true, permission);
		assert.equal(isAllowedPermission(permission, `${origin}/?x=1#y`, origin), true, permission);
		assert.equal(isAllowedPermission(permission, "https://example.test/", origin), false, permission);
		assert.equal(isAllowedPermission(permission, origin, undefined), false, permission);
	}
	assert.equal(isAllowedPermission("geolocation", `${origin}/`, origin), false);
});

test("reading the clipboard is not a granted permission", () => {
	// Terminal paste goes through the browser's native paste event, whose
	// clipboard data needs no permission; nothing in the client reads it.
	assert.equal(ALLOWED_PERMISSIONS.has("clipboard-read"), false);
	assert.equal(isAllowedPermission("clipboard-read", `${origin}/`, origin), false);
});

test("origin parsing ignores unusable URLs", () => {
	assert.equal(originOf(`${origin}/#token=secret`), origin);
	assert.equal(originOf("about:blank"), "null");
	assert.equal(originOf("not a url"), undefined);
	assert.equal(originOf(""), undefined);
});
