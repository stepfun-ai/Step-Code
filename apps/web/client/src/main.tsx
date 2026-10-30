// CSS order matters: tokens and base rules, then the ui/ CSS Modules (via the
// barrel), then feature CSS (imported by the features through App). Feature
// rules use the legacy class names and must be able to override the primitives.
// The bundled variable fonts come first: they only declare @font-face rules
// (font-display: swap, per-script unicode-range), so they never block paint.
import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist-mono/wght.css";
// KaTeX's fonts and layout for math in rendered Markdown (ui/MarkdownView).
import "katex/dist/katex.min.css";
import "./styles/global.css";
import "./ui";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { openTree } from "./features/files/actions";
import { applyLocale, applyTheme, restoreDesktopTheme } from "./features/shell/actions";
import { applyHostAttributes, isDesktopHost } from "./platform/host";
import { bootstrap } from "./state/session";
import { getState } from "./state/store";

applyHostAttributes();
// Before the first render, as the legacy script did, so the page never paints
// in the wrong theme or language.
applyTheme(getState().theme, false);
applyLocale(getState().locale, false);

function renderApp(): void {
	const container = document.getElementById("root");
	if (!container) throw new Error("#root is missing from index.html");
	createRoot(container).render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
	void bootstrap({ openTree });
}

// Desktop changes origin on each server start; restore its profile choice before mounting any controls.
if (isDesktopHost()) void restoreDesktopTheme().then(renderApp);
else renderApp();
