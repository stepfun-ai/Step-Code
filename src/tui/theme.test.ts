import { describe, expect, it } from "vitest";
import { getBuiltinTuiThemes } from "./theme.js";

type ThemeColors = ReturnType<typeof getBuiltinTuiThemes>[number]["colors"];

// Mirrors resolveTranscriptBadgeStyle in app.tsx: which badge background and
// which tone colour each transcript tone renders with.
const TRANSCRIPT_TONE_STYLES = [
  { tone: "accent", badge: "userBadge", color: "accent" },
  { tone: "brand", badge: "assistantBadge", color: "brand" },
  { tone: "success", badge: "toolBadge", color: "success" },
  { tone: "warning", badge: "systemBadge", color: "warning" },
  { tone: "danger", badge: "systemBadge", color: "danger" },
] as const satisfies readonly {
  tone: string;
  badge: keyof ThemeColors;
  color: keyof ThemeColors;
}[];

const PANEL_SURFACES = ["panel", "panelAlt", "inputBackground"] as const;

// Plain RGB distance; only used to prove two tones are not near-duplicates.
const DISTINCT_TONE_DISTANCE = 24;

function channelDistance(left: string, right: string): number {
  const first = hexToRgb(left).map((channel) => channel * 255);
  const second = hexToRgb(right).map((channel) => channel * 255);
  return Math.sqrt(
    first.reduce(
      (total, channel, index) => total + (channel - second[index]) ** 2,
      0,
    ),
  );
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.trim().replace(/^#/, "");
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((character) => `${character}${character}`)
          .join("")
      : normalized.slice(0, 6);

  return [
    Number.parseInt(expanded.slice(0, 2), 16) / 255,
    Number.parseInt(expanded.slice(2, 4), 16) / 255,
    Number.parseInt(expanded.slice(4, 6), 16) / 255,
  ];
}

function linearize(channel: number): number {
  return channel <= 0.03928
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const [red, green, blue] = hexToRgb(hex).map(linearize);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(left: string, right: string): number {
  const [lighter, darker] = [
    relativeLuminance(left),
    relativeLuminance(right),
  ].sort((first, second) => second - first);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("builtin TUI themes", () => {
  const themes = getBuiltinTuiThemes();

  it("keeps foreground and muted text readable on core surfaces", () => {
    for (const theme of themes) {
      expect(
        contrastRatio(theme.colors.foreground, theme.colors.canvas),
        `${theme.name} foreground vs canvas`,
      ).toBeGreaterThanOrEqual(7);
      expect(
        contrastRatio(theme.colors.foreground, theme.colors.panel),
        `${theme.name} foreground vs panel`,
      ).toBeGreaterThanOrEqual(7);
      expect(
        contrastRatio(theme.colors.foreground, theme.colors.inputBackground),
        `${theme.name} foreground vs inputBackground`,
      ).toBeGreaterThanOrEqual(7);
      expect(
        contrastRatio(theme.colors.muted, theme.colors.canvas),
        `${theme.name} muted vs canvas`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(theme.colors.muted, theme.colors.panel),
        `${theme.name} muted vs panel`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(theme.colors.foreground, theme.colors.selection),
        `${theme.name} foreground vs selection`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps transcript rails and badges visible against panel surfaces", () => {
    for (const theme of themes) {
      for (const surface of PANEL_SURFACES) {
        expect(
          contrastRatio(theme.colors.line, theme.colors[surface]),
          `${theme.name} transcript rail vs ${surface}`,
        ).toBeGreaterThanOrEqual(3);
      }
      expect(
        contrastRatio(theme.colors.foreground, theme.colors.assistantBadge),
        `${theme.name} badge foreground vs assistantBadge`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(theme.colors.foreground, theme.colors.userBadge),
        `${theme.name} badge foreground vs userBadge`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(theme.colors.foreground, theme.colors.toolBadge),
        `${theme.name} badge foreground vs toolBadge`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(theme.colors.foreground, theme.colors.systemBadge),
        `${theme.name} badge foreground vs systemBadge`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps every transcript tone colour readable on its badge and rail", () => {
    for (const theme of themes) {
      for (const { tone, badge, color } of TRANSCRIPT_TONE_STYLES) {
        // Badge text sits on the tone's badge background.
        expect(
          contrastRatio(theme.colors[color], theme.colors[badge]),
          `${theme.name} ${tone} badge text on ${badge}`,
        ).toBeGreaterThanOrEqual(4.5);

        // The same colour draws the transcript rail against panel surfaces.
        for (const surface of PANEL_SURFACES) {
          expect(
            contrastRatio(theme.colors[color], theme.colors[surface]),
            `${theme.name} ${tone} rail on ${surface}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("keeps transcript tone colours semantically distinct", () => {
    for (const theme of themes) {
      const { danger, warning, success } = theme.colors;

      // Errors must stay red, so the danger tone has to be red-dominant
      // instead of collapsing toward the neutral palette.
      const [dangerRed, dangerGreen, dangerBlue] = hexToRgb(danger);
      expect(dangerRed, `${theme.name} danger is red-dominant`).toBeGreaterThan(
        dangerGreen,
      );
      expect(dangerRed, `${theme.name} danger is red-dominant`).toBeGreaterThan(
        dangerBlue,
      );

      // Warnings must be distinguishable from the rest of the palette: the
      // three tones cannot collapse onto one value just to pass contrast.
      expect(
        channelDistance(warning, danger),
        `${theme.name} warning is distinguishable from danger`,
      ).toBeGreaterThan(DISTINCT_TONE_DISTANCE);
      expect(
        channelDistance(success, danger),
        `${theme.name} success is distinguishable from danger`,
      ).toBeGreaterThan(DISTINCT_TONE_DISTANCE);
      expect(
        channelDistance(success, warning),
        `${theme.name} success is distinguishable from warning`,
      ).toBeGreaterThan(DISTINCT_TONE_DISTANCE);
    }
  });
});
