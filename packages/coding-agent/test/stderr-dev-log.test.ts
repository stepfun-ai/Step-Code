import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	appendStderrDevLog,
	createStderrMirrorWrite,
	flushStderrDevLog,
	resolveStderrDevLogPath,
} from "../src/step/stderr-dev-log.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "step-stderr-dev-log-"));
	temporaryRoots.push(root);
	return root;
}

function captureWrite(returnValue = true): {
	write: NodeJS.WriteStream["write"];
	text(): string;
} {
	const chunks: Buffer[] = [];
	const write = ((
		chunk: string | Uint8Array,
		encoding?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		chunks.push(
			typeof chunk === "string"
				? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8")
				: Buffer.from(chunk),
		);
		if (typeof encoding === "function") encoding();
		else callback?.();
		return returnValue;
	}) as NodeJS.WriteStream["write"];
	return { write, text: () => Buffer.concat(chunks).toString("utf8") };
}

describe("stderr dev log capture", () => {
	test("forwards the original write first with its return value and arguments", async () => {
		const root = await makeRoot();
		const events: string[] = [];
		const callback = vi.fn();
		const baseWrite = vi.fn(
			(
				_chunk: string | Uint8Array,
				_encoding?: BufferEncoding | ((error?: Error | null) => void),
				writeCallback?: (error?: Error | null) => void,
			) => {
				events.push("base");
				writeCallback?.();
				return false;
			},
		) as unknown as NodeJS.WriteStream["write"];
		const mirror = createStderrMirrorWrite({
			baseWrite,
			getStorageRootDir: () => {
				events.push("mirror");
				return root;
			},
		});

		const result = mirror("Error: visible\n", "utf8", callback);
		await mirror.flush();

		expect(result).toBe(false);
		expect(events.slice(0, 2)).toEqual(["base", "mirror"]);
		expect(baseWrite).toHaveBeenCalledWith("Error: visible\n", "utf8", callback);
		expect(callback).toHaveBeenCalledOnce();
	});

	test("keeps base stderr unchanged when capture fails", () => {
		const captured = captureWrite(false);
		const mirror = createStderrMirrorWrite({
			baseWrite: captured.write,
			getStorageRootDir: () => {
				throw new Error("capture unavailable");
			},
		});
		const text = "Error: still reaches stderr\n";

		expect(mirror(text)).toBe(false);
		expect(captured.text()).toBe(text);
	});

	test("decodes UTF-8 buffers split inside a multibyte character", async () => {
		const root = await makeRoot();
		const captured = captureWrite();
		const mirror = createStderrMirrorWrite({ baseWrite: captured.write, getStorageRootDir: () => root });
		const source = Buffer.from("错误: 请求失败\n", "utf8");

		mirror(source.subarray(0, 1));
		mirror(source.subarray(1, 5));
		mirror(source.subarray(5));
		await mirror.flush();

		expect(captured.text()).toBe(source.toString("utf8"));
		expect(await readFile(resolveStderrDevLogPath(root), "utf8")).toBe(source.toString("utf8"));
	});

	test("redacts a known token split across writes", async () => {
		const root = await makeRoot();
		const captured = captureWrite();
		const mirror = createStderrMirrorWrite({ baseWrite: captured.write, getStorageRootDir: () => root });
		const secret = "ghp_ABCDEFGHIJKLMNOPQRST0123456789";

		mirror("Error: auth failed for ghp_ABCDEFGHIJ");
		mirror("KLMNOPQRST0123456789\n");
		await mirror.flush();

		expect(captured.text()).toContain(secret);
		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).toContain("Error: auth failed");
		expect(persisted).toContain("<redacted:secret>");
		expect(persisted).not.toContain(secret);
	});

	test("does not reassemble a secret across an intermediate flush", async () => {
		const root = await makeRoot();
		const captured = captureWrite();
		const mirror = createStderrMirrorWrite({ baseWrite: captured.write, getStorageRootDir: () => root });
		const secret = "ghp_ABCDEFGHIJKLMNOPQRST0123456789";

		mirror("Error: auth failed for ghp_ABCDEFGHIJ");
		await mirror.flush();
		mirror("KLMNOPQRST0123456789\nnext line\n");
		await mirror.flush();

		expect(captured.text()).toContain(secret);
		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).toContain("<redacted:secret>\nnext line\n");
		expect(persisted).not.toContain(secret);
		expect(persisted).not.toContain("KLMNOPQRST0123456789");
	});

	test("does not reassemble a token after a complete PEM residual suffix", async () => {
		const root = await makeRoot();
		const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });
		const secret = "ghp_ABCDEFGHIJKLMNOPQRST0123456789";

		mirror("-----BEGIN PRIVATE KEY-----\nkey-body\n-----END PRIVATE KEY----- ghp_ABCDEFGHIJ");
		await mirror.flush();
		mirror("KLMNOPQRST0123456789\nnext line\n");
		await mirror.flush();

		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).toContain("<redacted:secret>");
		expect(persisted).toContain("next line");
		expect(persisted).not.toContain(secret);
		expect(persisted).not.toContain("key-body");
	});

	test("does not reassemble a token inside an unterminated PEM across flush", async () => {
		const root = await makeRoot();
		const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });
		const secret = "ghp_ABCDEFGHIJKLMNOPQRST0123456789";

		mirror("-----BEGIN PRIVATE KEY-----\nkey-body ghp_ABCDEFGHIJ");
		await mirror.flush();
		mirror("KLMNOPQRST0123456789\n-----END PRIVATE KEY-----\nafter\n");
		await mirror.flush();

		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).toContain("<redacted:secret>");
		expect(persisted).toContain("after");
		expect(persisted).not.toContain(secret);
		expect(persisted).not.toContain("key-body");
	});

	test("detects a PEM that begins inside a flushed residual continuation", async () => {
		const root = await makeRoot();
		const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });

		mirror("Error: incomplete residual");
		await mirror.flush();
		mirror(" and -----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----\nafter\n");
		await mirror.flush();

		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).toContain("<redacted:secret>");
		expect(persisted).toContain("after");
		expect(persisted).not.toContain("PRIVATE KEY");
		expect(persisted).not.toContain("private-key-material");
	});

	test("redacts a labeled secret split across writes", async () => {
		const root = await makeRoot();
		const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });
		const secret = "actual-secret-value";

		mirror("Error: password=actual-");
		mirror("secret-value\n");
		await mirror.flush();

		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).toContain("password=<redacted:secret>");
		expect(persisted).not.toContain(secret);
	});

	test("redacts a labeled secret with spaces and its later echo", async () => {
		const root = await makeRoot();
		const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });
		const secret = "opaque secret value 12345678";

		mirror(`password: ${secret}\nretry echo ${secret}\n`);
		await mirror.flush();

		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).toBe(`password: <redacted:secret>\nretry echo <redacted:secret>\n`);
		expect(persisted).not.toContain(secret);
	});

	test.each(["one write", "separate writes"])("propagates a discovered secret to a later echo in %s", async (mode) => {
		const root = await makeRoot();
		const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });
		const secret = "opaque-secret-value-12345678";
		const firstLine = `password: ${secret}\n`;
		const echoLine = `retry echo ${secret}\n`;

		if (mode === "one write") mirror(`${firstLine}${echoLine}`);
		else {
			mirror(firstLine);
			mirror(echoLine);
		}
		await mirror.flush();

		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).toBe("password: <redacted:secret>\nretry echo <redacted:secret>\n");
		expect(persisted).not.toContain(secret);
	});

	test.each(["one write", "separate writes"])(
		"propagates a value introduced by a cross-line label in %s",
		async (mode) => {
			const root = await makeRoot();
			const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });
			const secret = "opaque-cross-line-secret-12345678";
			const lines = ["password:\n", `${secret}\n`, `retry echo ${secret}\n`];

			if (mode === "one write") mirror(lines.join(""));
			else for (const line of lines) mirror(line);
			await mirror.flush();

			const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
			expect(persisted).toBe("password:\n<redacted:secret>\nretry echo <redacted:secret>\n");
			expect(persisted).not.toContain(secret);
		},
	);

	test("rebuilds the bounded matcher when a later line discovers another secret", async () => {
		const root = await makeRoot();
		const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });
		const firstSecret = "first-stream-secret-12345678";
		const secondSecret = "second-stream-secret-87654321";

		mirror(`password: ${firstSecret}\n`);
		mirror(`password: ${secondSecret}\n`);
		mirror(`first echo ${firstSecret}\nsecond echo ${secondSecret}\n`);
		await mirror.flush();

		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).not.toContain(firstSecret);
		expect(persisted).not.toContain(secondSecret);
		expect(persisted.match(/<redacted:secret>/gu)).toHaveLength(4);
	});

	test("keeps password and authorization labels across physical lines", async () => {
		const root = await makeRoot();
		const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });
		const password = "cross-line-password-value";
		const authorization = "Bearer Abcdefghijklmnopqrst";

		mirror("Error: password:\n");
		await mirror.flush();
		mirror(`${password}\nAuthorization:\n`);
		mirror(`${authorization}\nafter\n`);
		await mirror.flush();

		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).toContain(`Error: password:\n<redacted:secret>\n`);
		expect(persisted).toContain(`Authorization:\n<redacted:secret>\nafter\n`);
		expect(persisted).not.toContain(password);
		expect(persisted).not.toContain(authorization);
	});

	test.each(["password:", "Authorization:"])(
		"keeps a %s label across a flush before its physical newline",
		async (label) => {
			const root = await makeRoot();
			const captured = captureWrite();
			const mirror = createStderrMirrorWrite({ baseWrite: captured.write, getStorageRootDir: () => root });
			const secret = "opaque-password-value";

			mirror(label);
			await mirror.flush();
			mirror(`\n${secret}\nretry echo ${secret}\nafter\n`);
			await mirror.flush();

			expect(captured.text()).toBe(`${label}\n${secret}\nretry echo ${secret}\nafter\n`);
			const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
			expect(persisted).toBe("<redacted:secret>\n<redacted:secret>\nretry echo <redacted:secret>\nafter\n");
			expect(persisted).not.toContain(secret);
		},
	);

	test("observes a cross-line sensitive value before a flush without its newline", async () => {
		const root = await makeRoot();
		const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });
		const secret = "cross-flush-sensitive-value-12345678";

		mirror(`password:\n${secret}`);
		await mirror.flush();
		mirror(`\nretry echo ${secret}\nafter\n`);
		await mirror.flush();

		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).toBe("password:\n<redacted:secret>\nretry echo <redacted:secret>\nafter\n");
		expect(persisted).not.toContain(secret);
	});

	test.each(["async", "sync"])(
		"observes a cross-line sensitive value completed after a %s flush",
		async (flushMode) => {
			const root = await makeRoot();
			const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });
			const secret = "opaque-secret-value-12345678";

			mirror("password:\nopaque-");
			if (flushMode === "async") await mirror.flush();
			else mirror.flushSync();
			mirror(`secret-value-12345678\nretry echo ${secret}\nafter\n`);
			await mirror.flush();

			const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
			expect(persisted).toBe("password:\n<redacted:secret>\nretry echo <redacted:secret>\nafter\n");
			expect(persisted).not.toContain(secret);
		},
	);

	test.each(["async", "sync"])(
		"fails closed when a flushed sensitive continuation exceeds the bound after a %s flush",
		async (flushMode) => {
			const root = await makeRoot();
			const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });
			const secret = "opaque-flushed-secret-12345678";

			mirror("password:");
			if (flushMode === "async") await mirror.flush();
			else mirror.flushSync();
			mirror(` ${secret}${"x".repeat(70 * 1024)}\necho ${secret}\nafter\n`);
			await mirror.flush();

			const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
			expect(persisted).not.toContain(secret);
			expect(persisted).not.toContain("after");
			expect(persisted.match(/<redacted:secret>/gu)?.length).toBeGreaterThanOrEqual(3);
		},
	);

	test.each(["async", "sync"])("preserves an incomplete UTF-8 character across a %s flush", async (flushMode) => {
		const root = await makeRoot();
		const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });
		const secret = "密钥秘密值-12345678";
		const prefix = Buffer.from("password: ");
		const encodedSecret = Buffer.from(secret);

		mirror(Buffer.concat([prefix, encodedSecret.subarray(0, 1)]));
		if (flushMode === "async") await mirror.flush();
		else mirror.flushSync();
		mirror(Buffer.concat([encodedSecret.subarray(1), Buffer.from(`\necho ${secret}\nafter\n`)]));
		await mirror.flush();

		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).toBe("<redacted:secret>\necho <redacted:secret>\nafter\n");
		expect(persisted).not.toContain(secret);
	});

	test("redacts string chunks independently of the stderr byte encoding", async () => {
		const root = await makeRoot();
		const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });
		const secret = "opaque-encoding-secret-12345678";

		mirror(`password: ${secret}\n`, "utf16le");
		await mirror.flush();

		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).toBe(`password: <redacted:secret>\n`);
		expect(persisted).not.toContain(secret);
		expect(persisted).not.toContain("\0");
	});

	test("holds and redacts a private key split across writes and lines", async () => {
		const root = await makeRoot();
		const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });

		mirror("Error: key follows\n-----BEGIN RSA PRIVATE KEY-----\nabc");
		mirror("def\n-----END RSA PRIVATE KEY-----\nafter\n");
		await mirror.flush();

		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).toContain("Error: key follows");
		expect(persisted).toContain("<redacted:secret>");
		expect(persisted).toContain("after");
		expect(persisted).not.toContain("PRIVATE KEY");
		expect(persisted).not.toContain("abcdef");
	});

	test("holds and redacts a PGP private key block across writes and lines", async () => {
		const root = await makeRoot();
		const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });

		mirror("Error: PGP key follows\n-----BEGIN PGP PRIVATE KEY BLOCK-----\npgp-");
		mirror("private-material\n-----END PGP PRIVATE KEY BLOCK-----\nafter\n");
		await mirror.flush();

		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).toContain("Error: PGP key follows");
		expect(persisted).toContain("<redacted:secret>");
		expect(persisted).toContain("after");
		expect(persisted).not.toContain("PGP PRIVATE KEY BLOCK");
		expect(persisted).not.toContain("pgp-private-material");
	});

	test.each(["none", "async", "sync"])(
		"propagates a private-key body line to a later echo with %s flush",
		async (flushMode) => {
			const root = await makeRoot();
			const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });
			const secret = "opaque-private-body-12345678";

			mirror("before\n-----BEGIN PRIVATE KEY-----\nopaque-private-");
			if (flushMode === "async") await mirror.flush();
			else if (flushMode === "sync") mirror.flushSync();
			mirror(`body-12345678\n-----END PRIVATE KEY-----\necho ${secret}\nafter\n`);
			await mirror.flush();

			const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
			expect(persisted).toContain("before\n<redacted:secret>");
			expect(persisted).toContain("echo <redacted:secret>\nafter\n");
			expect(persisted).not.toContain(secret);
		},
	);

	test.each(["async", "sync"])(
		"propagates a same-line private-key body after a pre-newline %s flush",
		async (flushMode) => {
			const root = await makeRoot();
			const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });
			const secret = "opaque-inline-private-body-12345678";

			mirror(`before -----BEGIN PRIVATE KEY-----${secret}-----END PRIVATE KEY-----`);
			if (flushMode === "async") await mirror.flush();
			else mirror.flushSync();
			mirror(`\necho ${secret}\nafter\n`);
			await mirror.flush();

			const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
			expect(persisted).toContain("<redacted:secret>\necho <redacted:secret>\nafter\n");
			expect(persisted).not.toContain(secret);
		},
	);

	test("fails closed when a private-key body contains a nested begin marker", async () => {
		const root = await makeRoot();
		const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });
		const secret = "opaque-private-prefix-secret-12345678";

		mirror(
			`-----BEGIN PRIVATE KEY-----\n${secret}-----BEGIN PRIVATE KEY-----other-material\n-----END PRIVATE KEY-----\necho ${secret}\nafter\n`,
		);
		await mirror.flush();

		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).not.toContain(secret);
		expect(persisted).not.toContain("after");
		expect(persisted).toContain("<redacted:secret>");
	});

	test("flushes an unterminated private key conservatively", async () => {
		const root = await makeRoot();
		const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });

		mirror("Error: prefix -----BEGIN PRIVATE KEY-----\nprivate-key-material\n");
		await mirror.flush();

		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).toContain("Error: prefix <redacted:secret>");
		expect(persisted).not.toContain("PRIVATE KEY");
		expect(persisted).not.toContain("private-key-material");
	});

	test("bounds overlong pending lines with a conservative placeholder", async () => {
		const root = await makeRoot();
		const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });
		const secret = "ghp_ABCDEFGHIJKLMNOPQRST0123456789";

		mirror(`${"x".repeat(70 * 1024)}${secret}\n`);
		await mirror.flush();

		expect(await readFile(resolveStderrDevLogPath(root), "utf8")).toBe("<redacted:secret>\n");
	});

	test("fails closed after an overlong labeled line", async () => {
		const root = await makeRoot();
		const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });
		const secret = "opaque-overlong-secret-12345678";

		mirror(`prefix password: ${secret}${"x".repeat(70 * 1024)}\n`);
		mirror(`echo ${secret}\nafter\n`);
		await mirror.flush();

		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).not.toContain(secret);
		expect(persisted).not.toContain("after");
		expect(persisted.match(/<redacted:secret>/gu)?.length).toBeGreaterThanOrEqual(3);
	});

	test("fails closed when an overlong flushed continuation introduces a labeled secret", async () => {
		const root = await makeRoot();
		const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });
		const secret = "opaque-overlong-secret-12345678";

		mirror("ordinary partial");
		await mirror.flush();
		mirror(` password: ${secret}${"x".repeat(70 * 1024)}\necho ${secret}\nafter\n`);
		await mirror.flush();

		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).not.toContain(secret);
		expect(persisted).not.toContain("after");
		expect(persisted.match(/<redacted:secret>/gu)?.length).toBeGreaterThanOrEqual(3);
	});

	test("fails closed when an overlong private-key begin line crosses writes", async () => {
		const root = await makeRoot();
		const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });

		mirror(`${"x".repeat(64 * 1024)}-----BEGIN PRI`);
		mirror(`VATE KEY-----${"y".repeat(64)}\n`);
		mirror("private-key-material\n-----END PRIVATE KEY-----\nafter\n");
		await mirror.flush();

		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).toContain("<redacted:secret>");
		expect(persisted).not.toContain("after");
		expect(persisted).not.toContain("PRIVATE KEY");
		expect(persisted).not.toContain("private-key-material");
	});

	test("keeps base stderr available when redacting pathological input", async () => {
		const root = await makeRoot();
		const captured = captureWrite();
		const mirror = createStderrMirrorWrite({ baseWrite: captured.write, getStorageRootDir: () => root });
		const secret = "ghp_ABCDEFGHIJKLMNOPQRST0123456789";
		const text = `${"[".repeat(20_000)}{"password":"${secret}"}${"]".repeat(20_000)}\n`;

		mirror(text);
		await mirror.flush();

		expect(captured.text()).toBe(text);
		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).toContain("<redacted:secret>");
		expect(persisted).not.toContain(secret);
	});

	test("synchronously drains pending and later exit-time writes without duplication", async () => {
		const root = await makeRoot();
		const captured = captureWrite();
		const mirror = createStderrMirrorWrite({ baseWrite: captured.write, getStorageRootDir: () => root });
		const firstSecret = "ghp_ABCDEFGHIJKLMNOPQRST0123456789";
		const laterSecret = "ghp_ZYXWVUTSRQPONMLKJIHG9876543210";

		mirror(`Error: first ${firstSecret}\n`);
		mirror.flushSync();
		mirror(`Error: later ${laterSecret}\n`);

		const immediate = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(immediate.match(/Error: first/gu)).toHaveLength(1);
		expect(immediate).toContain("Error: later");
		expect(immediate).not.toContain(firstSecret);
		expect(immediate).not.toContain(laterSecret);
		await mirror.flush();
		expect(await readFile(resolveStderrDevLogPath(root), "utf8")).toBe(immediate);
		expect(captured.text()).toBe(`Error: first ${firstSecret}\nError: later ${laterSecret}\n`);
	});

	test("synchronously replaces an unterminated residual before immediate exit", async () => {
		const root = await makeRoot();
		const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });

		mirror("Error: unterminated residual");
		mirror.flushSync();

		expect(await readFile(resolveStderrDevLogPath(root), "utf8")).toBe("<redacted:secret>");
	});

	test("synchronously finalizes and continues discarding an unterminated private key", async () => {
		const root = await makeRoot();
		const mirror = createStderrMirrorWrite({ baseWrite: captureWrite().write, getStorageRootDir: () => root });

		mirror("Error: key -----BEGIN PRIVATE KEY-----");
		mirror.flushSync();
		mirror("\nprivate-key-material\n");

		const persisted = await readFile(resolveStderrDevLogPath(root), "utf8");
		expect(persisted).toContain("<redacted:secret>");
		expect(persisted).not.toContain("PRIVATE KEY");
		expect(persisted).not.toContain("private-key-material");
	});

	test("reruns pruning on the next local calendar day", async () => {
		vi.useFakeTimers();
		const root = await makeRoot();
		vi.setSystemTime(new Date(2026, 8, 8, 12));
		await appendStderrDevLog("day one\n", root);
		const stalePath = resolveStderrDevLogPath(root, new Date(2026, 7, 1, 12));
		await writeFile(stalePath, "stale\n");
		expect(await readFile(stalePath, "utf8")).toBe("stale\n");

		vi.setSystemTime(new Date(2026, 8, 9, 12));
		await appendStderrDevLog("day two\n", root);

		expect(await readdir(join(root, "logs"))).not.toContain("dev-2026-08-01.log");
	});

	test("retains today and the previous six local-date logs", async () => {
		vi.useFakeTimers();
		const root = await makeRoot();
		const directory = join(root, "logs");
		await mkdir(directory, { recursive: true });
		for (let day = 1; day <= 8; day += 1) {
			await writeFile(resolveStderrDevLogPath(root, new Date(2026, 8, day, 12)), `day ${day}\n`);
		}
		vi.setSystemTime(new Date(2026, 8, 8, 12));

		await appendStderrDevLog("current\n", root);

		expect((await readdir(directory)).sort()).toEqual([
			"dev-2026-09-02.log",
			"dev-2026-09-03.log",
			"dev-2026-09-04.log",
			"dev-2026-09-05.log",
			"dev-2026-09-06.log",
			"dev-2026-09-07.log",
			"dev-2026-09-08.log",
		]);
	});

	test("creates private log directories and files where modes are supported", async () => {
		if (process.platform === "win32") return;
		const root = await makeRoot();

		await appendStderrDevLog("Error: visible\n", root);

		const directoryMode = (await stat(join(root, "logs"))).mode & 0o777;
		const fileMode = (await stat(resolveStderrDevLogPath(root))).mode & 0o777;
		expect(directoryMode).toBe(0o700);
		expect(fileMode).toBe(0o600);
	});

	test.skipIf(process.platform === "win32")("does not append through a symbolic-link log file", async () => {
		const root = await makeRoot();
		const outside = await mkdtemp(join(tmpdir(), "step-stderr-dev-log-outside-"));
		temporaryRoots.push(outside);
		const at = new Date("2026-08-31T00:00:00.000Z");
		const externalPath = join(outside, "external.log");
		await writeFile(externalPath, "outside\n");
		await mkdir(join(root, "logs"), { recursive: true });
		await symlink(externalPath, resolveStderrDevLogPath(root, at));

		await appendStderrDevLog("should not escape\n", root);
		await expect(readFile(externalPath, "utf8")).resolves.toBe("outside\n");
	});

	test("global flush waits for direct append operations", async () => {
		const root = await makeRoot();
		const append = appendStderrDevLog("Error: direct append\n", root);

		await flushStderrDevLog();
		await append;

		expect(await readFile(resolveStderrDevLogPath(root), "utf8")).toBe("Error: direct append\n");
	});
});
