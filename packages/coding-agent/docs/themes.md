> step can create themes. Ask it to build one for your setup.

# Themes

Themes are JSON files that define colors for the TUI.

## Table of Contents

- [Locations](#locations)
- [Selecting a Theme](#selecting-a-theme)
- [Creating a Custom Theme](#creating-a-custom-theme)
- [Theme Format](#theme-format)
- [Color Tokens](#color-tokens)
- [Color Values](#color-values)
- [Tips](#tips)

## Locations

Step loads themes from:

- Built-in: `dark`, `light`, `sage`, `step-blue`, `step-violet`, `step-violet-light`
- Global: `~/.stepcode/agent/themes/*.json`
- Project: `.stepcode/themes/*.json` (only after the project is trusted)
- Packages: `themes/` directories or `pi.themes` entries in `package.json`
- Settings: `themes` array with files or directories
- CLI: `--theme <path>` (repeatable)

Disable discovery with `--no-themes`.

## Selecting a Theme

Select a theme via `/settings` or in `settings.json`:

```json
{
  "theme": "my-theme"
}
```

Step defaults to `step-blue`, a single bright-blue palette with no light/dark variants.
The first-run picker lists `step-blue (default)` first, followed by the other installed themes.

| Theme | Appearance |
|-------|------------|
| `step-blue` | Default bright blue (`#68c0ff`), tuned for dark terminals |
| `step-violet` | Original Step violet for dark terminals |
| `step-violet-light` | Original Step violet for light terminals |
| `dark` / `light` | General-purpose dark / light palettes |
| `sage` | Sage green for dark terminals |

The former violet `step` and `step-light` palettes now use the `step-violet` names.
The old `step` and `step-light` names are no longer built-in themes or aliases.
If a saved setting uses either old name or `step-light/step`, select `step-blue` via `/theme`.
Use `step-violet-light/step-violet` for violet with automatic appearance switching.
No personal configuration files are rewritten. Blue uses the existing truecolor / nearest-256-color pipeline.

Built-in themes leave inline code, tool status blocks, and custom-message backgrounds transparent.
The full-width user prompt background remains visible so user messages are easy to find.
Selection, search-match, scrollbar, and word-level diff highlights remain functional feedback.
The welcome logo retains its violet-to-gold gradient and its matching border color independently of the text theme.

### Initial Theme

Start an interactive run with a theme without changing the saved setting:

```bash
step --use-theme light
```

To follow terminal appearance, use `lightTheme/darkTheme` syntax:

```bash
step --use-theme light/dark
```

The CLI value is the initial theme for that run. Choosing another theme later in `/settings` applies it immediately
and saves it normally.

## Creating a Custom Theme

1. Create a theme file:

```bash
mkdir -p ~/.stepcode/agent/themes
vim ~/.stepcode/agent/themes/my-theme.json
```

2. Define the theme with all required colors (see [Color Tokens](#color-tokens)):

```json
{
  "$schema": "https://github.com/stepfun-ai/step-harness/raw/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "primary": "#00aaff",
    "secondary": 242
  },
  "colors": {
    "accent": "primary",
    "border": "primary",
    "borderAccent": "#00ffff",
    "borderMuted": "secondary",
    "success": "#00ff00",
    "error": "#ff0000",
    "warning": "#ffff00",
    "muted": "secondary",
    "dim": 240,
    "text": "",
    "thinkingText": "secondary",
    "selectedBg": "#2d2d30",
    "scrollbarThumb": "#555566",
    "searchMatchBg": "#2d2d30",
    "searchMatchText": "",
    "userMessageBg": "#2d2d30",
    "userMessageText": "",
    "customMessageBg": "#2d2d30",
    "customMessageText": "",
    "customMessageLabel": "primary",
    "toolPendingBg": "#1e1e2e",
    "toolSuccessBg": "#1e2e1e",
    "toolErrorBg": "#2e1e1e",
    "toolTitle": "primary",
    "toolOutput": "",
    "mdHeading": "#ffaa00",
    "mdLink": "primary",
    "mdLinkUrl": "secondary",
    "mdCode": "#00ffff",
    "mdCodeBlock": "",
    "mdCodeBlockBorder": "secondary",
    "mdQuote": "secondary",
    "mdQuoteBorder": "secondary",
    "mdHr": "secondary",
    "mdListBullet": "#00ffff",
    "toolDiffAdded": "#00ff00",
    "toolDiffRemoved": "#ff0000",
    "toolDiffContext": "secondary",
    "syntaxComment": "secondary",
    "syntaxKeyword": "primary",
    "syntaxFunction": "#00aaff",
    "syntaxVariable": "#ffaa00",
    "syntaxString": "#00ff00",
    "syntaxNumber": "#ff00ff",
    "syntaxType": "#00aaff",
    "syntaxOperator": "primary",
    "syntaxPunctuation": "secondary",
    "thinkingOff": "secondary",
    "thinkingMinimal": "primary",
    "thinkingLow": "#00aaff",
    "thinkingMedium": "#00ffff",
    "thinkingHigh": "#ff00ff",
    "thinkingXhigh": "#ff0000",
    "thinkingMax": "#ff0088",
    "bashMode": "#ffaa00"
  }
}
```

3. Select the theme via `/settings`.

**Hot reload:** When you edit the currently active custom theme file, step reloads it automatically for immediate visual feedback.

## Theme Format

```json
{
  "$schema": "https://github.com/stepfun-ai/step-harness/raw/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "blue": "#0066cc",
    "gray": 242
  },
  "colors": {
    "accent": "blue",
    "muted": "gray",
    "text": "",
    ...
  }
}
```

- `name` is required, must be unique, and must not contain `/`.
- `vars` is optional. Define reusable colors here, then reference them in `colors`.
- `colors` must define all 51 required tokens. `thinkingMax`, `scrollbarThumb`, and the two search highlight tokens are optional and use the fallbacks listed below.

The `$schema` field enables editor auto-completion and validation.

## Color Tokens

Every theme must define all 51 required color tokens. The optional tokens preserve compatibility with existing themes: `thinkingMax` falls back to `thinkingXhigh`, `scrollbarThumb` and `searchMatchBg` fall back to `selectedBg`, and `searchMatchText` falls back to `text`. Other search matches use `searchMatchText` on `searchMatchBg` with an underline; the current match reverses that foreground/background pair and uses bold text.

### Core UI (11 colors)

| Token | Purpose |
|-------|---------|
| `accent` | Primary accent (logo, selected items, cursor) |
| `border` | Normal borders |
| `borderAccent` | Highlighted borders |
| `borderMuted` | Subtle borders (editor) |
| `success` | Success states |
| `error` | Error states |
| `warning` | Warning states |
| `muted` | Secondary text |
| `dim` | Tertiary text |
| `text` | Default text (usually `""`) |
| `thinkingText` | Thinking block text |

### Backgrounds & Content (11 required, 3 optional)

| Token | Purpose |
|-------|---------|
| `selectedBg` | Selected line background |
| `scrollbarThumb` | Fullscreen scrollbar thumb background; optional, falls back to `selectedBg` |
| `searchMatchBg` | Transcript search match background and current-match text; optional, falls back to `selectedBg` |
| `searchMatchText` | Transcript search match text and current-match background; optional, falls back to `text` |
| `userMessageBg` | User message background |
| `userMessageText` | User message text |
| `customMessageBg` | Extension message background |
| `codeInlineBg` | Optional inline-code background; falls back to `customMessageBg` |
| `customMessageText` | Extension message text |
| `customMessageLabel` | Extension message label |
| `toolPendingBg` | Tool box (pending) |
| `toolSuccessBg` | Tool box (success) |
| `toolErrorBg` | Tool box (error) |
| `toolTitle` | Tool title |
| `toolOutput` | Tool output text |

### Markdown (10 colors)

| Token | Purpose |
|-------|---------|
| `mdHeading` | Headings |
| `mdLink` | Link text |
| `mdLinkUrl` | Link URL |
| `mdCode` | Inline code |
| `mdCodeBlock` | Code block content |
| `mdCodeBlockBorder` | Code block fences |
| `mdQuote` | Blockquote text |
| `mdQuoteBorder` | Blockquote border |
| `mdHr` | Horizontal rule |
| `mdListBullet` | List bullets |

### Tool Diffs (3 colors)

| Token | Purpose |
|-------|---------|
| `toolDiffAdded` | Added lines |
| `toolDiffRemoved` | Removed lines |
| `toolDiffContext` | Context lines |

### Syntax Highlighting (9 colors)

| Token | Purpose |
|-------|---------|
| `syntaxComment` | Comments |
| `syntaxKeyword` | Keywords |
| `syntaxFunction` | Function names |
| `syntaxVariable` | Variables |
| `syntaxString` | Strings |
| `syntaxNumber` | Numbers |
| `syntaxType` | Types |
| `syntaxOperator` | Operators |
| `syntaxPunctuation` | Punctuation |

### Thinking Level Borders (6 required, 1 optional)

Editor border colors indicating thinking level (visual hierarchy from subtle to prominent):

| Token | Purpose |
|-------|---------|
| `thinkingOff` | Thinking off |
| `thinkingMinimal` | Minimal thinking |
| `thinkingLow` | Low thinking |
| `thinkingMedium` | Medium thinking |
| `thinkingHigh` | High thinking |
| `thinkingXhigh` | Extra high thinking |
| `thinkingMax` | Maximum thinking; optional, falls back to `thinkingXhigh` |

### Bash Mode (1 color)

| Token | Purpose |
|-------|---------|
| `bashMode` | Editor border in bash mode (`!` prefix) |

### HTML Export (optional)

The `export` section controls colors for `/export` HTML output. If omitted, colors are derived from `userMessageBg`.

```json
{
  "export": {
    "pageBg": "#18181e",
    "cardBg": "#1e1e24",
    "infoBg": "#3c3728"
  }
}
```

## Color Values

Four formats are supported:

| Format | Example | Description |
|--------|---------|-------------|
| Hex | `"#ff0000"` | 6-digit hex RGB |
| 256-color | `39` | xterm 256-color palette index (0-255) |
| Variable | `"primary"` | Reference to a `vars` entry |
| Default | `""` | Terminal's default color |

For inline code, an empty background renders foreground-only text without chip padding or background resets,
so it inherits the enclosing user prompt background. Explicit custom inline-code backgrounds remain supported.
HTML export resolves empty background tokens to CSS `transparent`, not to the default foreground color.

### 256-Color Palette

- `0-15`: Basic ANSI colors (terminal-dependent)
- `16-231`: 6×6×6 RGB cube (`16 + 36×R + 6×G + B` where R,G,B are 0-5)
- `232-255`: Grayscale ramp

### Terminal Compatibility

Step uses 24-bit RGB colors. Most modern terminals support this (iTerm2, Kitty, WezTerm, Windows Terminal, VS Code). For older terminals with only 256-color support, step falls back to the nearest approximation.

Check truecolor support:

```bash
echo $COLORTERM  # Should output "truecolor" or "24bit"
```

## Tips

**Dark terminals:** Use bright, saturated colors with higher contrast.

**Light terminals:** Use darker, muted colors with lower contrast.

**Color harmony:** Start with a base palette (Nord, Gruvbox, Tokyo Night), define it in `vars`, and reference consistently.

**Testing:** Check your theme with different message types, tool states, markdown content, and long wrapped text.

**VS Code:** Set `terminal.integrated.minimumContrastRatio` to `1` for accurate colors.

## Examples

See the built-in themes:
- [dark.json](../src/theme/dark.json)
- [light.json](../src/theme/light.json)
- [sage.json](../src/theme/sage.json)
- [step-blue.json](../src/theme/step-blue.json)
- [step-violet.json](../src/theme/step-violet.json)
- [step-violet-light.json](../src/theme/step-violet-light.json)
