/**
 * A failed request has to say why.
 *
 * Most host routes answer `{ error }`, but a kernel rejection answers
 * `{ ok: false, message }` (feedback submission). Reading only `error` turned
 * those into a bare "HTTP 400" with no reason in the toast or the dialog.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../client/src/lib/api.ts";

test("a host error field wins", () => {
	assert.equal(new ApiError(400, { error: "name is required" }).message, "name is required");
});

test("a kernel message is used when the payload has no error field", () => {
	const error = new ApiError(400, {
		ok: false,
		message: "Saved to /tmp/feedback/00000000-0000-4000-8000-000000000001.json",
	});
	assert.equal(error.message, "Saved to /tmp/feedback/00000000-0000-4000-8000-000000000001.json");
	assert.equal(error.status, 400);
});

test("a payload with neither field keeps the HTTP status", () => {
	assert.equal(new ApiError(502, {}).message, "HTTP 502");
});

test("a blank field does not hide the other one", () => {
	assert.equal(new ApiError(400, { error: "   ", message: "kernel reason" }).message, "kernel reason");
	assert.equal(new ApiError(400, { error: "", message: "  " }).message, "HTTP 400");
});
