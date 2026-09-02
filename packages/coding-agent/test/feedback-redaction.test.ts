import { describe, expect, test } from "vitest";
import {
	FEEDBACK_DIAGNOSTICS_MAX_BYTES,
	FEEDBACK_DIAGNOSTICS_MAX_LINE_CHARS,
	FEEDBACK_DIAGNOSTICS_MAX_LINES,
} from "../src/step/feedback/types.ts";
import { excerptFeedbackDiagnostics, redactFeedbackDiagnostics } from "../src/step/feedback/validate.ts";
import { createSecretRedactionCollector, redactSecretString } from "../src/step/secret-redaction.ts";

const REDACTED_SECRET = "<redacted:secret>";

describe("feedback credential redaction", () => {
	test("redacts labelled, header, known-token, environment, and CLI credentials", () => {
		const secrets = [
			"english-password-value",
			"中文密码值-123456",
			"header-credential-value",
			"ghp_abcdefghijklmnopqrstuvwxyz0123456789",
			"environment-secret-value",
			"command-secret-value",
		];
		const redacted = redactSecretString(
			[
				`password: ${secrets[0]}`,
				`密码是：${secrets[1]}`,
				`Authorization: Bearer ${secrets[2]}`,
				`token ${secrets[3]}`,
				`API_KEY=${secrets[4]}`,
				`--client-secret ${secrets[5]}`,
			].join("\n"),
		);

		for (const secret of secrets) {
			expect(redacted).not.toContain(secret);
		}
		expect(redacted).toContain(REDACTED_SECRET);
	});

	test("redacts unquoted labelled secrets that contain spaces", () => {
		const secret = "opaque secret value 12345678";
		const redacted = redactSecretString(`password: ${secret}\nretry echo ${secret}`);

		expect(redacted).toBe(`password: ${REDACTED_SECRET}\nretry echo ${REDACTED_SECRET}`);
		expect(redacted).not.toContain(secret);
	});

	test("redacts complete free-form header values without consuming adjacent JSON fields", () => {
		const secret = "actual-signature-secret";
		const signature = `Signature keyId="id",algorithm="hmac",signature="${secret}"`;
		const freeForm = redactSecretString(`Authorization: ${signature}\nafter`);
		expect(freeForm).toBe(`Authorization: ${REDACTED_SECRET}\nafter`);

		const structured = JSON.parse(
			redactSecretString(JSON.stringify({ authorization: signature, message: "visible adjacent field" })),
		) as { authorization: string; message: string };
		expect(structured).toEqual({ authorization: REDACTED_SECRET, message: "visible adjacent field" });
	});

	test("redacts complete and unterminated private keys", () => {
		const complete = redactSecretString(
			[
				"before",
				"-----BEGIN PRIVATE KEY-----",
				"complete-private-material",
				"-----END PRIVATE KEY-----",
				"after",
			].join("\n"),
		);
		expect(complete).toBe(["before", REDACTED_SECRET, "after"].join("\n"));

		const unterminated = redactSecretString(
			["before", "-----BEGIN RSA PRIVATE KEY-----", "unterminated-private-material"].join("\n"),
		);
		expect(unterminated).toBe(["before", REDACTED_SECRET].join("\n"));

		const pgp = redactSecretString(
			[
				"before",
				"-----BEGIN PGP PRIVATE KEY BLOCK-----",
				"pgp-private-material",
				"-----END PGP PRIVATE KEY BLOCK-----",
				"after",
			].join("\n"),
		);
		expect(pgp).toBe(["before", REDACTED_SECRET, "after"].join("\n"));
	});

	test("propagates private-key body lines to later echoes", () => {
		const secret = "opaque-private-body-12345678";
		const redacted = redactSecretString(
			["before", "-----BEGIN PRIVATE KEY-----", secret, "-----END PRIVATE KEY-----", `echo ${secret}`, "after"].join(
				"\n",
			),
		);

		expect(redacted).toBe(["before", REDACTED_SECRET, `echo ${REDACTED_SECRET}`, "after"].join("\n"));
		expect(redacted).not.toContain(secret);
	});

	test("propagates private-key material that precedes a nested begin marker", () => {
		const secret = "opaque-private-prefix-secret-12345678";
		const redacted = redactSecretString(
			[
				"-----BEGIN PRIVATE KEY-----",
				`${secret}-----BEGIN PRIVATE KEY-----other-material`,
				"-----END PRIVATE KEY-----",
				`echo ${secret}`,
			].join("\n"),
		);

		expect(redacted).not.toContain(secret);
		expect(redacted).toContain(`echo ${REDACTED_SECRET}`);
	});

	test("redacts balanced inline JSON without dropping surrounding prose", () => {
		const secret = "actual-secret-value";
		const redacted = redactSecretString(`request failed with payload {"password":"${secret}"} before retry`);

		expect(redacted).toBe(`request failed with payload {"password":"${REDACTED_SECRET}"} before retry`);
	});

	test("redacts nested JSON strings carried by SSE", () => {
		const secret = "nested-tool-secret-value";
		const redacted = redactSecretString(
			`event: response.output_item.added\ndata: ${JSON.stringify({
				delta: { arguments: JSON.stringify({ password: secret }) },
			})}\n`,
		);

		expect(redacted).not.toContain(secret);
		const dataLine = redacted.split("\n").find((line) => line.startsWith("data: "));
		expect(dataLine).toBeDefined();
		const payload = JSON.parse(dataLine!.slice("data: ".length)) as { delta: { arguments: string } };
		expect(JSON.parse(payload.delta.arguments)).toEqual({ password: REDACTED_SECRET });
	});

	test("redacts passwords from empty-username Redis and AMQP DSNs", () => {
		const redacted = redactSecretString(
			"redis://:actual-redis-password@example.test/0 amqp://:actual-amqp-password@example.test/vhost",
		);

		expect(redacted).toBe(`redis://:${REDACTED_SECRET}@example.test/0 amqp://:${REDACTED_SECRET}@example.test/vhost`);
	});

	test("uses the last authority at-sign when redacting raw URL passwords", () => {
		const redacted = redactSecretString("https://user:p@ss@example.com/path redis://:p@ss@host/0 after@example.test");

		expect(redacted).toBe(
			`https://user:${REDACTED_SECRET}@example.com/path redis://:${REDACTED_SECRET}@host/0 after@example.test`,
		);
	});

	test("preserves real JSON Schema definitions but redacts invalid direct property values", () => {
		const schema = {
			type: "object",
			properties: {
				password: { type: "string", description: "Password supplied by the user." },
				token: false,
			},
			required: ["password"],
		};
		const serializedSchema = JSON.stringify(schema);
		expect(redactSecretString(serializedSchema)).toBe(serializedSchema);
		const schemaWithoutExplicitObjectType = {
			properties: {
				password: { type: "string" },
				token: false,
			},
		};
		expect(redactSecretString(JSON.stringify(schemaWithoutExplicitObjectType))).toBe(
			JSON.stringify(schemaWithoutExplicitObjectType),
		);
		const schemaWithSensitiveExamples = {
			type: "object",
			properties: {
				password: {
					type: "string",
					description: "Password supplied by the user.",
					default: "actual-default-secret",
					const: "actual-const-secret",
					examples: ["actual-example-secret"],
				},
			},
		};
		expect(JSON.parse(redactSecretString(JSON.stringify(schemaWithSensitiveExamples)))).toEqual({
			type: "object",
			properties: {
				password: {
					type: "string",
					description: "Password supplied by the user.",
					default: REDACTED_SECRET,
					const: REDACTED_SECRET,
					examples: [REDACTED_SECRET],
				},
			},
		});

		const invalid = JSON.stringify({
			type: "object",
			properties: { password: "actual-schema-secret" },
			required: ["password"],
		});
		expect(JSON.parse(redactSecretString(invalid))).toEqual({
			type: "object",
			properties: { password: REDACTED_SECRET },
			required: ["password"],
		});
		const mixed = JSON.stringify({
			properties: { password: { type: "string" }, token: "actual-schema-secret" },
		});
		expect(JSON.parse(redactSecretString(mixed))).toEqual({
			properties: { password: { type: "string" }, token: REDACTED_SECRET },
		});
		const ordinaryObject = JSON.stringify({
			properties: { password: { value: "actual-secret-value" } },
		});
		expect(JSON.parse(redactSecretString(ordinaryObject))).toEqual({
			properties: { password: { value: REDACTED_SECRET } },
		});
	});

	test("limits Basic and Bearer matching to credential-shaped values", () => {
		const prose = "Use basic reasoning here; she is the bearer of the message.";
		expect(redactSecretString(prose)).toBe(prose);

		const redacted = redactSecretString("Basic YWxpY2U6Y29ycmVjdC1ob3JzZQ== and Bearer abc.def-1234567890");
		expect(redacted).toBe(`Basic ${REDACTED_SECRET} and Bearer ${REDACTED_SECRET}`);

		const alphabeticCredential = "Abcdefghijklmnopqrst";
		expect(redactSecretString(`Bearer ${alphabeticCredential}`)).toBe(`Bearer ${REDACTED_SECRET}`);
		expect(redactSecretString(`Basic ${alphabeticCredential}`)).toBe(`Basic ${alphabeticCredential}`);
	});

	test("propagates discovered secrets through string values without rewriting JSON keys", () => {
		const secret = "opaque-value-12345678";
		const redacted = JSON.parse(
			redactSecretString(
				JSON.stringify({
					password: secret,
					preview: `value=${secret}`,
					[secret]: "key remains visible",
					reasoning: "Use basic reasoning here",
				}),
			),
		) as Record<string, unknown>;

		expect(redacted.password).toBe(REDACTED_SECRET);
		expect(redacted.preview).toBe(`value=${REDACTED_SECRET}`);
		expect(redacted[secret]).toBe("key remains visible");
		expect(redacted.reasoning).toBe("Use basic reasoning here");
		expect(Object.keys(redacted)).toContain(secret);
	});

	test("propagates every nested value from sensitive object and array containers", () => {
		const objectSecret = "nested-credential-value-12345678";
		const arraySecret = "array-credential-value-12345678";
		const redacted = JSON.parse(
			redactSecretString(
				JSON.stringify({
					credentials: { nested: { value: objectSecret } },
					objectEcho: objectSecret,
					password: [{ value: arraySecret }],
					arrayEcho: arraySecret,
				}),
			),
		) as Record<string, unknown>;

		expect(JSON.stringify(redacted)).not.toContain(objectSecret);
		expect(JSON.stringify(redacted)).not.toContain(arraySecret);
		expect(redacted.objectEcho).toBe(REDACTED_SECRET);
		expect(redacted.arrayEcho).toBe(REDACTED_SECRET);
	});

	test("propagates long numeric credentials without globally guessing short numbers", () => {
		const redacted = JSON.parse(
			redactSecretString(
				JSON.stringify({
					passcode: 12345678,
					passcodeEcho: "12345678",
					shortPasscode: 123456,
					shortEcho: "123456",
				}),
			),
		) as Record<string, unknown>;

		expect(redacted.passcode).toBe(0);
		expect(redacted.passcodeEcho).toBe(REDACTED_SECRET);
		expect(redacted.shortPasscode).toBe(0);
		expect(redacted.shortEcho).toBe("123456");
	});

	test("requires a strong valid schema signal before exempting a sensitive property definition", () => {
		const invalidTypeSecret = "invalid-schema-type-secret";
		const titleSecret = "annotation-title-secret";
		const descriptionSecret = "annotation-description-secret";
		const redacted = JSON.parse(
			redactSecretString(
				JSON.stringify({
					properties: {
						password: { type: invalidTypeSecret },
						passphrase: { title: titleSecret, description: descriptionSecret },
					},
					typeEcho: invalidTypeSecret,
					titleEcho: titleSecret,
					descriptionEcho: descriptionSecret,
				}),
			),
		) as Record<string, unknown>;

		expect(JSON.stringify(redacted)).not.toContain(invalidTypeSecret);
		expect(JSON.stringify(redacted)).not.toContain(titleSecret);
		expect(JSON.stringify(redacted)).not.toContain(descriptionSecret);
		expect(redacted.typeEcho).toBe(REDACTED_SECRET);
		expect(redacted.titleEcho).toBe(REDACTED_SECRET);
		expect(redacted.descriptionEcho).toBe(REDACTED_SECRET);
	});

	test("propagates deterministic key credentials but not ordinary opaque keys", () => {
		const keySecret = "key-credential-value-12345678";
		const opaqueKey = "opaque-object-key-12345678";
		const redacted = JSON.parse(
			redactSecretString(
				JSON.stringify({
					[`API_KEY=${keySecret}`]: "mapped",
					keyEcho: keySecret,
					[opaqueKey]: "ordinary mapped value",
					opaqueEcho: opaqueKey,
				}),
			),
		) as Record<string, unknown>;

		expect(Object.keys(redacted).join("\n")).not.toContain(keySecret);
		expect(redacted.keyEcho).toBe(REDACTED_SECRET);
		expect(Object.keys(redacted)).toContain(opaqueKey);
		expect(redacted.opaqueEcho).toBe(opaqueKey);
	});

	test("propagates sensitive schema data without collecting descriptions or constraints", () => {
		const defaultSecret = "schema-default-credential-12345678";
		const constSecret = "schema-const-credential-12345678";
		const enumSecret = "schema-enum-credential-12345678";
		const exampleSecret = "schema-example-credential-12345678";
		const unknownSecret = "schema-extension-credential-12345678";
		const descriptionValue = "schema-description-value-12345678";
		const patternValue = "schema-pattern-value-12345678";
		const redacted = JSON.parse(
			redactSecretString(
				JSON.stringify({
					type: "object",
					properties: {
						password: {
							type: "string",
							description: descriptionValue,
							pattern: patternValue,
							default: defaultSecret,
							const: constSecret,
							enum: [enumSecret],
							examples: [exampleSecret],
							credentialData: unknownSecret,
						},
					},
					defaultEcho: defaultSecret,
					constEcho: constSecret,
					enumEcho: enumSecret,
					exampleEcho: exampleSecret,
					unknownEcho: unknownSecret,
					descriptionEcho: descriptionValue,
					patternEcho: patternValue,
				}),
			),
		) as Record<string, unknown>;

		for (const key of ["defaultEcho", "constEcho", "enumEcho", "exampleEcho", "unknownEcho"]) {
			expect(redacted[key]).toBe(REDACTED_SECRET);
		}
		expect(redacted.descriptionEcho).toBe(descriptionValue);
		expect(redacted.patternEcho).toBe(patternValue);
	});

	test("recurses through sensitive schema maps and propagates their credential data", () => {
		const defsSecret = "schema-defs-default-12345678";
		const definitionsSecret = "schema-definitions-const-12345678";
		const dependentSecret = "schema-dependent-enum-12345678";
		const patternSecret = "schema-pattern-example-12345678";
		const extensionSecret = "schema-extension-value-12345678";
		const redacted = JSON.parse(
			redactSecretString(
				JSON.stringify({
					type: "object",
					properties: {
						password: {
							type: "string",
							$defs: { value: { type: "string", default: defsSecret } },
							definitions: { value: { type: "string", const: definitionsSecret } },
							dependentSchemas: { account: { type: "object", enum: [dependentSecret] } },
							patternProperties: {
								"^credential-": {
									type: "string",
									examples: [patternSecret],
									credentialExtension: extensionSecret,
								},
							},
						},
					},
					defsEcho: defsSecret,
					definitionsEcho: definitionsSecret,
					dependentEcho: dependentSecret,
					patternEcho: patternSecret,
					extensionEcho: extensionSecret,
				}),
			),
		);

		expect(redacted).toEqual({
			type: "object",
			properties: {
				password: {
					type: "string",
					$defs: { value: { type: "string", default: REDACTED_SECRET } },
					definitions: { value: { type: "string", const: REDACTED_SECRET } },
					dependentSchemas: { account: { type: "object", enum: [REDACTED_SECRET] } },
					patternProperties: {
						"^credential-": {
							type: "string",
							examples: [REDACTED_SECRET],
							credentialExtension: REDACTED_SECRET,
						},
					},
				},
			},
			defsEcho: REDACTED_SECRET,
			definitionsEcho: REDACTED_SECRET,
			dependentEcho: REDACTED_SECRET,
			patternEcho: REDACTED_SECRET,
			extensionEcho: REDACTED_SECRET,
		});
	});

	test("applies a streamed prefix credential to a bounded tail across chunk boundaries", () => {
		const secret = "streamed-prefix-secret-12345678";
		const target = `${JSON.stringify({ echo: secret, [secret]: "ordinary key" })}\n`;
		const collector = createSecretRedactionCollector(target);

		collector.write('{"API_');
		collector.write(`KEY":"${secret.slice(0, 11)}`);
		collector.write(`${secret.slice(11)}"}\n`);
		const result = collector.finish();

		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		const redacted = JSON.parse(result.value) as Record<string, unknown>;
		expect(redacted.echo).toBe(REDACTED_SECRET);
		expect(redacted[secret]).toBe("ordinary key");
	});

	test("deduplicates many streamed candidates and applies them once at finish", () => {
		const secret = "repeated-stream-secret-12345678";
		const collector = createSecretRedactionCollector(`${"visible ".repeat(16_384)}echo=${secret}\n`);
		const sourceLine = `${JSON.stringify({ password: secret })}\n`;

		for (let index = 0; index < 1_000; index += 1) collector.write(sourceLine);
		const result = collector.finish();

		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.value).toContain(`echo=${REDACTED_SECRET}`);
		expect(result.value).not.toContain(secret);
	});

	test("fails safely when streamed candidates exceed the bounded budget", () => {
		const collector = createSecretRedactionCollector("bounded target\n");
		for (let index = 0; index < 300; index += 1) {
			collector.write(
				`${JSON.stringify({ password: `unique-stream-secret-${index.toString().padStart(4, "0")}` })}\n`,
			);
		}

		expect(collector.finish()).toEqual({ status: "unsafe", reason: "candidate-budget-exceeded" });
	});

	test.each([
		[
			"a multiline PGP private key",
			"mFIEZprivatebase64material\n=checksum\n-----END PGP PRIVATE KEY BLOCK-----\n",
			"-----BEGIN PGP PRIVATE KEY BLOCK-----\n",
		],
		[
			"a quoted sensitive value split across lines",
			'"actual-secret-value"\n{"echo":"actual-secret-value"}\n',
			'{\n"api_key":\n',
		],
		[
			"a multiline sensitive JSON container",
			'"primary":"actual-secret-value"\n}\n{"echo":"actual-secret-value"}\n',
			'{\n"credentials": {\n',
		],
		[
			"a sensitive key, separator, and value split across lines",
			'"split-pretty-secret-12345678"\n}\n{"echo":"split-pretty-secret-12345678"}\n',
			'{\n"api_key"\n:\n',
		],
		[
			"a sensitive quoted scalar split across lines",
			'continued-12345678"}\n{"echo":"prefix-secret-continued-12345678"}\n',
			'{"password":"prefix-secret-\n',
		],
		[
			"individually valid JSON scalars that cannot be session records",
			'"split-scalar-secret-12345678"\n{"echo":"split-scalar-secret-12345678"}\n',
			'"api_key"\n":"\n',
		],
		[
			"a JSON array that cannot be a session record",
			'{"echo":"array-record-secret-12345678"}\n',
			'["password","array-record-secret-12345678"]\n',
		],
	] as const)("fails safely for %s before a bounded tail", (_case, target, prefix) => {
		const collector = createSecretRedactionCollector(target);
		collector.write(prefix);
		collector.write(target);

		expect(collector.finish()).toEqual({ status: "unsafe", reason: "invalid-jsonl-record" });
	});

	test("redacts intrinsically known credentials in JSON keys without losing colliding values", () => {
		const firstToken = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
		const secondToken = "ghp_ZYXWVUTSRQPONMLKJIHG9876543210";
		expect(JSON.parse(redactSecretString(JSON.stringify({ [firstToken]: "mapped" })))).toEqual({
			[REDACTED_SECRET]: "mapped",
		});

		const redactedBaseKey = `${REDACTED_SECRET}-mapping`;
		const redacted = JSON.parse(
			redactSecretString(
				JSON.stringify({
					[`${firstToken}-mapping`]: "first mapped value",
					[`${secondToken}-mapping`]: "second mapped value",
					[redactedBaseKey]: "existing placeholder value",
					[`${redactedBaseKey}#2`]: "existing suffixed value",
				}),
			),
		) as Record<string, unknown>;

		expect(Object.keys(redacted)).toHaveLength(4);
		expect(Object.keys(redacted).join("\n")).not.toContain(firstToken);
		expect(Object.keys(redacted).join("\n")).not.toContain(secondToken);
		expect(Object.values(redacted)).toEqual(
			expect.arrayContaining([
				"first mapped value",
				"second mapped value",
				"existing placeholder value",
				"existing suffixed value",
			]),
		);
		expect(redacted[redactedBaseKey]).toBe("existing placeholder value");
		expect(redacted[`${redactedBaseKey}#2`]).toBe("existing suffixed value");
	});

	test("redacts deterministic URL, auth, environment, and PEM credentials in JSON keys", () => {
		const urlSecret = "urlcredential12345678";
		const authSecret = "abc.def-1234567890";
		const environmentSecret = "environmentcredential12345678";
		const firstPemSecret = "first-private-material";
		const secondPemSecret = "second-private-material";
		const firstPemKey = ["-----BEGIN PRIVATE KEY-----", firstPemSecret, "-----END PRIVATE KEY-----", "mapping"].join(
			"\n",
		);
		const secondPemKey = [
			"-----BEGIN PRIVATE KEY-----",
			secondPemSecret,
			"-----END PRIVATE KEY-----",
			"mapping",
		].join("\n");
		const pemBaseKey = `${REDACTED_SECRET}\nmapping`;
		const redacted = JSON.parse(
			redactSecretString(
				JSON.stringify({
					[`https://example.test/path?token=${urlSecret}&view=mapping`]: "url mapped value",
					[`Authorization: Bearer ${authSecret}`]: "auth mapped value",
					[`API_KEY=${environmentSecret};mapping`]: "environment mapped value",
					[firstPemKey]: "first PEM mapped value",
					[secondPemKey]: "second PEM mapped value",
					[pemBaseKey]: "existing PEM placeholder value",
				}),
			),
		) as Record<string, unknown>;

		const keys = Object.keys(redacted).join("\n");
		expect(Object.keys(redacted)).toHaveLength(6);
		for (const secret of [urlSecret, authSecret, environmentSecret, firstPemSecret, secondPemSecret]) {
			expect(keys).not.toContain(secret);
		}
		expect(keys).not.toContain("BEGIN PRIVATE KEY");
		expect(Object.values(redacted)).toEqual(
			expect.arrayContaining([
				"url mapped value",
				"auth mapped value",
				"environment mapped value",
				"first PEM mapped value",
				"second PEM mapped value",
				"existing PEM placeholder value",
			]),
		);
		expect(redacted[pemBaseKey]).toBe("existing PEM placeholder value");
	});

	test("bounds structured recursion and conservatively redacts malformed JSON", () => {
		const secret = "deeply-nested-secret-value";
		const deeplyNested = `${"[".repeat(20_000)}{"password":"${secret}"}${"]".repeat(20_000)}`;
		let redacted = "";
		expect(() => {
			redacted = redactSecretString(deeplyNested);
		}).not.toThrow();
		expect(redacted).not.toContain(secret);
		expect(redacted).toContain(REDACTED_SECRET);

		const malformed = `${"[".repeat(20_000)}{"password":"${secret}"`;
		expect(() => redactSecretString(malformed)).not.toThrow();
		expect(redactSecretString(malformed)).not.toContain(secret);
	});

	test("preserves exact placeholders and redacts plaintext appended to one", () => {
		expect(redactSecretString(`password: ${REDACTED_SECRET}`)).toBe(`password: ${REDACTED_SECRET}`);
		expect(redactSecretString(`password: ${REDACTED_SECRET}plaintext`)).toBe(`password: ${REDACTED_SECRET}`);
	});

	test("preserves ordinary URLs and unlabelled text", () => {
		const value = "See https://example.test/docs?q=ordinary and keep this conversation intact.";
		expect(redactSecretString(value)).toBe(value);
	});
});

describe("feedback diagnostics redaction", () => {
	test("redacts the complete diagnostics text before splitting and bounding", () => {
		for (const diagnostics of [
			redactFeedbackDiagnostics({
				source: "stderr_dev_log",
				lines: ["password:", "caller-injected-secret", "after"],
				truncated: false,
			}),
			{
				source: "stderr_dev_log" as const,
				...excerptFeedbackDiagnostics({
					lines: ["password:", "file-read-secret", "after"],
					source: "stderr_dev_log",
					startsMidStream: false,
				}),
			},
		]) {
			const text = diagnostics.lines.join("\n");
			expect(text).toContain(REDACTED_SECRET);
			expect(text).not.toContain("caller-injected-secret");
			expect(text).not.toContain("file-read-secret");
		}
	});

	test("removes terminal controls, complete OSC, and unterminated OSC", () => {
		const redacted = redactFeedbackDiagnostics({
			source: "stderr_dev_log",
			lines: [
				"safe\rspoof\btext\u007f",
				"left\u001b]0;window title\u0007right",
				"csi\u009b31mcolored\u009b0m",
				"dcs-left\u001bPprivate payload\u001b\\dcs-right",
				"c1-left\u009dprivate title\u009cc1-right",
				"tab\tvalue",
				"visible\u001b]0;unterminated title",
			],
			truncated: false,
		});
		const text = redacted.lines.join("\n");

		expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
		expect(text).not.toContain("window title");
		expect(text).not.toContain("unterminated title");
		expect(text).not.toContain("private payload");
		expect(text).not.toContain("private title");
		expect(text).toContain("leftright");
		expect(text).toContain("csicolored");
		expect(text).toContain("dcs-leftdcs-right");
		expect(text).toContain("c1-leftc1-right");
		expect(text).toContain("tab value");
	});

	test("sanitizes and redacts the complete tail before dropping a partial first line", () => {
		const osc = excerptFeedbackDiagnostics({
			lines: ["fragment\u001b]0;hidden title", "continued payload\u0007visible", "latest"],
			source: "stderr_dev_log",
			startsMidStream: true,
		});
		const labeled = excerptFeedbackDiagnostics({
			lines: ["fragment password:", "cross-boundary-secret", "latest"],
			source: "stderr_dev_log",
			startsMidStream: true,
		});

		expect(osc.lines).toEqual(["latest"]);
		expect(osc.lines.join("\n")).not.toContain("hidden title");
		expect(labeled.lines.join("\n")).not.toContain("cross-boundary-secret");
		expect(labeled.lines).toContain("latest");
	});

	test("redacts a complete single-line tail before retaining its newest characters", () => {
		const secret = "opaque-tail-secret-12345678";
		const excerpt = excerptFeedbackDiagnostics({
			lines: [`password: ${secret} ${"x".repeat(600)} repeated=${secret}`],
			source: "stderr_dev_log",
			startsMidStream: true,
		});

		expect(excerpt.lines).toHaveLength(1);
		expect(excerpt.lines[0]).toContain(REDACTED_SECRET);
		expect(excerpt.lines[0]).not.toContain(secret);
		expect(excerpt.truncated).toBe(true);
	});

	test("reapplies line, character, and byte bounds while retaining input-trace notes", () => {
		const diagnostics = redactFeedbackDiagnostics({
			source: "input_trace",
			lines: [
				'{"src":"note","msg":"raw-without-dispatch"}',
				...Array.from(
					{ length: FEEDBACK_DIAGNOSTICS_MAX_LINES + 20 },
					(_, index) => `line-${index}-${"界".repeat(FEEDBACK_DIAGNOSTICS_MAX_LINE_CHARS + 100)}`,
				),
			],
			truncated: false,
		});

		expect(diagnostics.lines.length).toBeLessThanOrEqual(FEEDBACK_DIAGNOSTICS_MAX_LINES);
		expect(diagnostics.lines.every((line) => [...line].length <= FEEDBACK_DIAGNOSTICS_MAX_LINE_CHARS)).toBe(true);
		expect(Buffer.byteLength(diagnostics.lines.join("\n"), "utf8")).toBeLessThanOrEqual(
			FEEDBACK_DIAGNOSTICS_MAX_BYTES,
		);
		expect(diagnostics.lines.some((line) => line.includes("raw-without-dispatch"))).toBe(true);
		expect(diagnostics.truncated).toBe(true);
	});
});
