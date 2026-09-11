import { Check, Errors } from "typebox/schema";
import type { WorkflowJsonSchema } from "./types.ts";

export interface WorkflowSchemaResult {
	valid: boolean;
	errors: string[];
	value: unknown;
}

/** Validate TypeBox or standard JSON Schema values, optionally dropping unknown object keys first. */
export function validateWorkflowSchema(schema: unknown, value: unknown, stripUnknown = false): WorkflowSchemaResult {
	if (isSafeParseSchema(schema)) {
		try {
			const parsed = schema.safeParse(value);
			return parsed.success
				? { valid: true, errors: [], value: parsed.data }
				: { valid: false, errors: [formatUnknownError(parsed.error)], value };
		} catch (error: unknown) {
			return { valid: false, errors: [formatUnknownError(error)], value };
		}
	}
	if (typeof schema !== "boolean" && (!schema || typeof schema !== "object" || Array.isArray(schema))) {
		return { valid: true, errors: [], value };
	}
	try {
		const normalized = stripUnknown ? cleanUnknownProperties(schema as WorkflowJsonSchema, value) : value;
		if (Check(schema, normalized)) return { valid: true, errors: [], value: normalized };
		const [, errors] = Errors(schema, normalized);
		return {
			valid: false,
			errors: errors.map((error) => `${error.instancePath || "$"} ${error.message}`),
			value: normalized,
		};
	} catch (error: unknown) {
		return { valid: false, errors: [formatUnknownError(error)], value };
	}
}

interface SafeParseSchema {
	safeParse(input: unknown): { success: boolean; data?: unknown; error?: unknown };
}

function isSafeParseSchema(value: unknown): value is SafeParseSchema {
	return !!value && typeof value === "object" && typeof (value as { safeParse?: unknown }).safeParse === "function";
}

function cleanUnknownProperties(schema: WorkflowJsonSchema, value: unknown): unknown {
	if (Array.isArray(value)) {
		return schema.items ? value.map((item) => cleanUnknownProperties(schema.items!, item)) : value;
	}
	if (!value || typeof value !== "object") return value;
	const properties = schema.properties ?? {};
	const output = Object.create(null) as Record<string, unknown>;
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		const childSchema = properties[key];
		if (childSchema) output[key] = cleanUnknownProperties(childSchema, item);
		else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
			output[key] = cleanUnknownProperties(schema.additionalProperties, item);
		} else if (schema.additionalProperties !== false) output[key] = item;
	}
	return output;
}

function formatUnknownError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return "Schema validation failed";
	}
}
