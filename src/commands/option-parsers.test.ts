import { describe, it, expect } from "vitest";
import {
  parsePositiveInt,
  parseOperatingMode,
  parseApprovalMode,
  parseNonNegativeInt,
  parseNumber,
  parseNonInteractiveApproval,
  parseConfigScope,
  parseAnthropicThinkingBudgetTokens,
  parseOpenAIReasoningEffort,
  parseSystemPromptProfile,
  parseToolPresentationProfile,
  parseToolDescriptionStyle,
  parseToolSearchIndexProfile,
  collectToolOverride,
  collectRepeatedString,
  InvalidArgumentError,
} from "./option-parsers.js";

describe("parsePositiveInt", () => {
  it("parses valid positive integers", () => {
    expect(parsePositiveInt("5")).toBe(5);
    expect(parsePositiveInt("100")).toBe(100);
  });

  it("throws for zero", () => {
    expect(() => parsePositiveInt("0")).toThrow("positive integer");
  });

  it("throws for negative", () => {
    expect(() => parsePositiveInt("-3")).toThrow("positive integer");
  });

  it("throws for non-numeric strings", () => {
    expect(() => parsePositiveInt("abc")).toThrow("positive integer");
  });

  it("rejects partially parsed numeric prefixes instead of truncating them", () => {
    for (const value of ["12px", "12abc", "3.14xyz", "1.5", "1e3", "0x10"]) {
      expect(() => parsePositiveInt(value)).toThrow("positive integer");
    }
  });

  it("rejects integers beyond the safe integer range", () => {
    for (const value of ["9007199254740992", "9007199254740993", "1e21"]) {
      expect(() => parsePositiveInt(value)).toThrow("positive integer");
    }
  });

  it("accepts the largest safe integer", () => {
    expect(parsePositiveInt("9007199254740991")).toBe(9007199254740991);
  });
});

describe("parseNonNegativeInt", () => {
  it("accepts zero", () => {
    expect(parseNonNegativeInt("0")).toBe(0);
  });

  it("throws for negative", () => {
    expect(() => parseNonNegativeInt("-1")).toThrow("non-negative");
  });

  it("rejects partially parsed values", () => {
    for (const value of ["0items", "3.14xyz", "1e3"]) {
      expect(() => parseNonNegativeInt(value)).toThrow("non-negative");
    }
  });

  it("rejects values beyond the safe integer range", () => {
    expect(() => parseNonNegativeInt("9007199254740992")).toThrow(
      "non-negative",
    );
  });

  it("accepts the largest safe integer", () => {
    expect(parseNonNegativeInt("9007199254740991")).toBe(9007199254740991);
  });
});

describe("parseNumber", () => {
  it("parses floats", () => {
    expect(parseNumber("3.14")).toBeCloseTo(3.14);
  });

  it("throws for non-numeric", () => {
    expect(() => parseNumber("xyz")).toThrow("Expected number");
  });

  it("rejects malformed numeric values", () => {
    for (const value of [
      "3.14ms",
      "3.14xyz",
      "1.2.3",
      "Infinity",
      "-Infinity",
      "NaN",
    ]) {
      expect(() => parseNumber(value)).toThrow("Expected number");
    }
  });

  it("still accepts scientific notation and sign prefixes", () => {
    expect(parseNumber("1e3")).toBeCloseTo(1000);
    expect(parseNumber("-2.5e-3")).toBeCloseTo(-0.0025);
    expect(parseNumber("+7")).toBe(7);
  });
});

describe("parseOperatingMode", () => {
  it("accepts normal and plan", () => {
    expect(parseOperatingMode("normal")).toBe("normal");
    expect(parseOperatingMode("plan")).toBe("plan");
  });

  it("throws for unknown mode", () => {
    expect(() => parseOperatingMode("debug")).toThrow(InvalidArgumentError);
  });
});

describe("parseApprovalMode", () => {
  it("accepts confirm, auto, strict", () => {
    expect(parseApprovalMode("confirm")).toBe("confirm");
    expect(parseApprovalMode("auto")).toBe("auto");
    expect(parseApprovalMode("strict")).toBe("strict");
  });

  it("throws for unknown mode", () => {
    expect(() => parseApprovalMode("manual")).toThrow("Unsupported");
  });
});

describe("parseNonInteractiveApproval", () => {
  it("accepts allow and deny", () => {
    expect(parseNonInteractiveApproval("allow")).toBe("allow");
    expect(parseNonInteractiveApproval("deny")).toBe("deny");
  });

  it("throws for unknown", () => {
    expect(() => parseNonInteractiveApproval("maybe")).toThrow("Unsupported");
  });
});

describe("parseConfigScope", () => {
  it("accepts user and workspace", () => {
    expect(parseConfigScope("user")).toBe("user");
    expect(parseConfigScope("workspace")).toBe("workspace");
  });

  it("throws for unknown", () => {
    expect(() => parseConfigScope("global")).toThrow("Unsupported");
  });
});

describe("parseAnthropicThinkingBudgetTokens", () => {
  it("accepts a value at the minimum boundary", () => {
    expect(parseAnthropicThinkingBudgetTokens("1024")).toBe(1024);
  });

  it("accepts a value above the minimum", () => {
    expect(parseAnthropicThinkingBudgetTokens("16000")).toBe(16000);
  });

  it("throws for a value below the minimum", () => {
    expect(() => parseAnthropicThinkingBudgetTokens("1023")).toThrow(
      InvalidArgumentError,
    );
    expect(() => parseAnthropicThinkingBudgetTokens("500")).toThrow(">= 1024");
  });

  it("throws for non-positive values via parsePositiveInt", () => {
    expect(() => parseAnthropicThinkingBudgetTokens("0")).toThrow(
      "positive integer",
    );
    expect(() => parseAnthropicThinkingBudgetTokens("-5")).toThrow(
      "positive integer",
    );
  });
});

describe("parseOpenAIReasoningEffort", () => {
  it("accepts every supported effort level", () => {
    expect(parseOpenAIReasoningEffort("minimal")).toBe("minimal");
    expect(parseOpenAIReasoningEffort("low")).toBe("low");
    expect(parseOpenAIReasoningEffort("medium")).toBe("medium");
    expect(parseOpenAIReasoningEffort("high")).toBe("high");
  });

  it("throws for an unknown effort level", () => {
    expect(() => parseOpenAIReasoningEffort("extreme")).toThrow(
      InvalidArgumentError,
    );
    expect(() => parseOpenAIReasoningEffort("")).toThrow("minimal, low");
  });
});

describe("parseSystemPromptProfile", () => {
  it("accepts default and minimal", () => {
    expect(parseSystemPromptProfile("default")).toBe("default");
    expect(parseSystemPromptProfile("minimal")).toBe("minimal");
  });

  it("throws for an unknown profile", () => {
    expect(() => parseSystemPromptProfile("verbose")).toThrow(
      InvalidArgumentError,
    );
  });
});

describe("parseToolPresentationProfile", () => {
  it("normalizes canonical aliases to their canonical form", () => {
    expect(parseToolPresentationProfile("grouped")).toBe("grouped");
    expect(parseToolPresentationProfile("compact")).toBe("grouped");
    expect(parseToolPresentationProfile("raw")).toBe("raw");
    expect(parseToolPresentationProfile("canonical")).toBe("raw");
    expect(parseToolPresentationProfile("obfuscated")).toBe("obfuscated");
  });

  it("throws for an unknown profile", () => {
    expect(() => parseToolPresentationProfile("fancy")).toThrow(
      InvalidArgumentError,
    );
    expect(() => parseToolPresentationProfile("")).toThrow("Received:");
  });
});

describe("parseToolDescriptionStyle", () => {
  it("accepts canonical and simple", () => {
    expect(parseToolDescriptionStyle("canonical")).toBe("canonical");
    expect(parseToolDescriptionStyle("simple")).toBe("simple");
  });

  it("throws for an unknown style", () => {
    expect(() => parseToolDescriptionStyle("verbose")).toThrow(
      InvalidArgumentError,
    );
  });
});

describe("parseToolSearchIndexProfile", () => {
  it("accepts presented and canonical", () => {
    expect(parseToolSearchIndexProfile("presented")).toBe("presented");
    expect(parseToolSearchIndexProfile("canonical")).toBe("canonical");
  });

  it("throws for an unknown profile", () => {
    expect(() => parseToolSearchIndexProfile("raw")).toThrow(
      InvalidArgumentError,
    );
  });
});

describe("collectToolOverride", () => {
  it("accumulates overrides", () => {
    const result = collectToolOverride("my_tool=allow", {});
    expect(result).toEqual({ my_tool: "allow" });
  });

  it("adds to previous overrides", () => {
    const result = collectToolOverride("b=deny", { a: "allow" });
    expect(result).toEqual({ a: "allow", b: "deny" });
  });

  it("trims whitespace around tool name and mode", () => {
    const result = collectToolOverride("  my_tool  =  confirm  ", {});
    expect(result).toEqual({ my_tool: "confirm" });
  });

  it("throws for missing separator", () => {
    expect(() => collectToolOverride("no_equals", {})).toThrow(
      "Invalid --tool-override",
    );
  });

  it("throws when separator is the first character", () => {
    expect(() => collectToolOverride("=allow", {})).toThrow(
      "Invalid --tool-override",
    );
  });

  it("throws when separator is the last character", () => {
    expect(() => collectToolOverride("tool=", {})).toThrow(
      "Invalid --tool-override",
    );
  });

  it("throws when the tool name is only whitespace", () => {
    expect(() => collectToolOverride("   =allow", {})).toThrow(
      "Invalid tool name in --tool-override",
    );
  });

  it("throws for invalid permission mode", () => {
    expect(() => collectToolOverride("tool=maybe", {})).toThrow(
      "Invalid tool permission mode",
    );
  });
});

describe("collectRepeatedString", () => {
  it("accumulates trimmed values", () => {
    const result = collectRepeatedString("hello", undefined);
    expect(result).toEqual(["hello"]);
    const result2 = collectRepeatedString("world", result);
    expect(result2).toEqual(["hello", "world"]);
  });

  it("throws for empty value", () => {
    expect(() => collectRepeatedString("  ", undefined)).toThrow(
      InvalidArgumentError,
    );
  });
});
