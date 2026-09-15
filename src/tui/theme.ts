export const TUI_THEME_COLOR_FIELD_NAMES = [
  "foreground",
  "muted",
  "accent",
  "brand",
  "success",
  "warning",
  "danger",
  "canvas",
  "panel",
  "panelAlt",
  "inputBackground",
  "selection",
  "line",
  "assistantBadge",
  "userBadge",
  "toolBadge",
  "systemBadge",
] as const;

export interface StepCliTuiThemeColors {
  foreground: string;
  muted: string;
  accent: string;
  brand: string;
  success: string;
  warning: string;
  danger: string;
  canvas: string;
  panel: string;
  panelAlt: string;
  inputBackground: string;
  selection: string;
  line: string;
  assistantBadge: string;
  userBadge: string;
  toolBadge: string;
  systemBadge: string;
}

export interface StepCliTuiThemeDefinition {
  name: string;
  colors: StepCliTuiThemeColors;
}

export type StepCliTuiThemeName = string;

const BUILTIN_TUI_THEME_COLORS = {
  default: {
    foreground: "#eef6ff",
    muted: "#8eaac8",
    accent: "#62d8ff",
    brand: "#4da3ff",
    success: "#58d6a6",
    warning: "#f0c36b",
    danger: "#ff6f91",
    canvas: "#07101c",
    panel: "#0c1625",
    panelAlt: "#112033",
    inputBackground: "#1b2431",
    selection: "#173556",
    line: "#688fb1",
    assistantBadge: "#102846",
    userBadge: "#0b223d",
    toolBadge: "#0d2b36",
    systemBadge: "#17273a",
  },
  sage: {
    foreground: "#eef4df",
    muted: "#a7b7a2",
    accent: "#bde038",
    brand: "#a3ab78",
    success: "#bde038",
    warning: "#d4c979",
    danger: "#e28369",
    canvas: "#081417",
    panel: "#10454f",
    panelAlt: "#16515c",
    inputBackground: "#18363b",
    selection: "#245258",
    line: "#8ca7aa",
    assistantBadge: "#1a3940",
    userBadge: "#17343a",
    toolBadge: "#233d35",
    systemBadge: "#26373d",
  },
  pop: {
    foreground: "#f7f0e1",
    muted: "#8c955d",
    accent: "#47f5d7",
    brand: "#a669f7",
    success: "#f5f147",
    warning: "#f57847",
    danger: "#ff6f91",
    canvas: "#140f1e",
    panel: "#20162d",
    panelAlt: "#2b1d3d",
    inputBackground: "#251c35",
    selection: "#382353",
    line: "#8874b0",
    assistantBadge: "#2a1846",
    userBadge: "#113a37",
    toolBadge: "#3c3712",
    systemBadge: "#2f2438",
  },
  helix: {
    foreground: "#eef6ff",
    muted: "#7ca8d8",
    accent: "#02b891",
    brand: "#408dff",
    success: "#02b891",
    warning: "#3399ff",
    danger: "#ff6f91",
    canvas: "#051126",
    panel: "#08204a",
    panelAlt: "#0c2a62",
    inputBackground: "#0f2446",
    selection: "#163972",
    line: "#5a8fda",
    assistantBadge: "#0a2752",
    userBadge: "#0a3448",
    toolBadge: "#093b3b",
    systemBadge: "#15263c",
  },
  steel: {
    foreground: "#ffffff",
    muted: "#bbbcbc",
    accent: "#0092e2",
    brand: "#1c7fff",
    success: "#4eb4c7",
    warning: "#d9d9d9",
    danger: "#ff7c7c",
    canvas: "#000000",
    panel: "#07111d",
    panelAlt: "#0c1a2d",
    inputBackground: "#102033",
    selection: "#18304d",
    line: "#607d9d",
    assistantBadge: "#0a1c32",
    userBadge: "#0e2739",
    toolBadge: "#122631",
    systemBadge: "#1b1b1b",
  },
} as const satisfies Record<string, StepCliTuiThemeColors>;

export type StepCliBuiltinTuiThemeName = keyof typeof BUILTIN_TUI_THEME_COLORS;

export const DEFAULT_TUI_THEME_NAME: StepCliBuiltinTuiThemeName = "default";
export const STEP_CLI_BUILTIN_TUI_THEME_NAMES = Object.freeze(
  Object.keys(BUILTIN_TUI_THEME_COLORS),
) as readonly StepCliBuiltinTuiThemeName[];

export function getBuiltinTuiThemes(): readonly StepCliTuiThemeDefinition[] {
  return STEP_CLI_BUILTIN_TUI_THEME_NAMES.map((name) => ({
    name,
    colors: BUILTIN_TUI_THEME_COLORS[name],
  }));
}

export function getBuiltinTuiTheme(
  themeName: StepCliBuiltinTuiThemeName = DEFAULT_TUI_THEME_NAME,
): StepCliTuiThemeDefinition {
  return {
    name: themeName,
    colors: BUILTIN_TUI_THEME_COLORS[themeName],
  };
}

export function mergeTuiThemes(
  themes: readonly StepCliTuiThemeDefinition[],
): StepCliTuiThemeDefinition[] {
  const merged = new Map<string, StepCliTuiThemeDefinition>();
  for (const theme of themes) {
    merged.set(theme.name, theme);
  }
  return Array.from(merged.values());
}

export function getTuiThemeNames(
  themes: readonly StepCliTuiThemeDefinition[],
): string[] {
  return themes.map((theme) => theme.name);
}

export function findTuiTheme(
  themes: readonly StepCliTuiThemeDefinition[],
  themeName: string | undefined,
): StepCliTuiThemeDefinition | undefined {
  if (!themeName) {
    return undefined;
  }

  return themes.find((theme) => theme.name === themeName);
}

export function hasTuiTheme(
  themes: readonly StepCliTuiThemeDefinition[],
  themeName: string,
): boolean {
  return findTuiTheme(themes, themeName) !== undefined;
}

export function resolveTuiTheme(
  themes: readonly StepCliTuiThemeDefinition[],
  themeName?: string,
): StepCliTuiThemeDefinition {
  return (
    findTuiTheme(themes, themeName) ??
    findTuiTheme(themes, DEFAULT_TUI_THEME_NAME) ??
    getBuiltinTuiTheme()
  );
}

export function isValidTuiThemeName(value: string): boolean {
  return /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i.test(value.trim());
}

export function isValidTuiThemeColor(value: string): boolean {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(
    value.trim(),
  );
}
