/**
 * The Markdown renderer every Markdown surface shares: Streamdown (remark/micromark)
 * with Step-Code's own elements. Kept free of CSS imports so node tests can render it.
 *
 * Safety: raw HTML is never parsed (Streamdown turns HTML into text when the
 * `rehype-raw` plugin is absent), only http, https and mailto destinations become
 * links, local paths become `.md-file-reference` buttons when allowed, and images
 * never load: they read as links. No other element carries a URL.
 */

import {
	Component,
	type CSSProperties,
	createContext,
	Fragment,
	createElement as h,
	type JSX,
	memo,
	type ReactElement,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import {
	type CodeHighlighterPlugin,
	type Components,
	type ExtraProps,
	type HighlightResult,
	type HighlightToken,
	Streamdown,
} from "streamdown";
import { localFileReference } from "../../lib/file-references";
import { useCopiedFlag } from "../hooks/useCopiedFlag";
import {
	FILE_CHIP_TAG,
	MARKDOWN_PLUGINS,
	MARKDOWN_REMARK_PLUGINS,
	type MarkdownPluggable,
	remarkFileMarkers,
} from "./markdown-plugins";

export interface MarkdownLabels {
	/** Header label of a fenced block without a language. */
	readonly code: string;
	/** Text of the copy button in each code block header. */
	readonly copy: string;
	/** Accessible name of a horizontally scrollable Markdown table. */
	readonly table: string;
	/** Accessible name of a rendered Mermaid diagram. */
	readonly diagram: string;
}

export interface MarkdownContentProps {
	readonly source: string;
	readonly labels: MarkdownLabels;
	/**
	 * The text is still arriving. Only then does Streamdown complete unfinished
	 * syntax and split blocks; settled text renders statically, and code is
	 * highlighted and diagrams drawn only once it has settled.
	 */
	readonly streaming?: boolean;
	/** Render local file references as `.md-file-reference` buttons instead of plain text. */
	readonly localFiles?: boolean;
	/**
	 * Names of the files whose `\u0002N\u0002` markers the source carries
	 * (lib/attached-files); a marker becomes `renderFile(N)`.
	 */
	readonly fileNames?: readonly string[];
	readonly renderFile?: (index: number) => ReactNode;
	/**
	 * A code block's copy button was pressed; receives the block's code. Unless it
	 * resolves `false`, the button shows `copiedLabel` for a moment.
	 */
	readonly onCopyCode?: (code: string) => Promise<boolean> | undefined;
	readonly copiedLabel?: string;
}

interface MarkdownSettings {
	readonly labels: MarkdownLabels;
	readonly streaming: boolean;
	readonly localFiles: boolean;
	readonly renderFile?: (index: number) => ReactNode;
	readonly onCopyCode?: (code: string) => Promise<boolean> | undefined;
	readonly copiedLabel?: string;
}

const MarkdownSettingsContext = createContext<MarkdownSettings>({
	labels: { code: "", copy: "", table: "", diagram: "" },
	streaming: false,
	localFiles: false,
});

function useSettings(): MarkdownSettings {
	return useContext(MarkdownSettingsContext);
}

function isWebDestination(destination: string): boolean {
	try {
		return ["http:", "https:", "mailto:"].includes(new URL(destination).protocol);
	} catch {
		// Relative, incomplete or malformed destinations are not navigable links.
		return false;
	}
}

/** Local references are buttons, never browser navigation to a file URL. */
function Destination({ destination, children }: { readonly destination: string; readonly children?: ReactNode }) {
	const { localFiles } = useSettings();
	if (localFileReference(destination)) {
		return localFiles
			? h("button", { type: "button", className: "md-file-reference", "data-file-path": destination }, children)
			: h(Fragment, null, children);
	}
	if (isWebDestination(destination)) {
		return h("a", { href: destination, target: "_blank", rel: "noopener noreferrer" }, children);
	}
	return h(Fragment, null, children);
}

function MarkdownLink({ href, children }: JSX.IntrinsicElements["a"] & ExtraProps) {
	return h(Destination, { destination: typeof href === "string" ? href : "" }, children);
}

/** An image is never fetched: a reply cannot make the page load a remote resource. */
function MarkdownImage({ src, alt }: JSX.IntrinsicElements["img"] & ExtraProps) {
	const destination = typeof src === "string" ? src : "";
	return h(Destination, { destination }, alt || destination);
}

/** Pass the element through with its Markdown-derived attributes, without Streamdown's utility classes. */
function plain<K extends keyof JSX.IntrinsicElements>(tag: K) {
	return function MarkdownElement({ node: _node, ...props }: JSX.IntrinsicElements[K] & ExtraProps) {
		return h(tag as string, props);
	};
}

/** Headings sit one level below the surface's own title: `#` is an h2. */
function heading(tag: "h2" | "h3" | "h4") {
	return function MarkdownHeading({ children }: JSX.IntrinsicElements["h1"] & ExtraProps) {
		return h(tag, null, children);
	};
}

function alignment(style: CSSProperties | undefined): string {
	const align = style?.textAlign;
	return `md-align-${align === "center" || align === "right" ? align : "left"}`;
}

function MarkdownHeaderCell({ style, children }: JSX.IntrinsicElements["th"] & ExtraProps) {
	return h("th", { scope: "col", className: alignment(style) }, children);
}

function MarkdownCell({ style, children }: JSX.IntrinsicElements["td"] & ExtraProps) {
	return h("td", { className: alignment(style) }, children);
}

function MarkdownTable({ children }: JSX.IntrinsicElements["table"] & ExtraProps) {
	const { labels } = useSettings();
	return h(
		"div",
		{ className: "md-table-scroll md-table-wrap", role: "region", tabIndex: 0, "aria-label": labels.table },
		h("table", { className: "md-table" }, children),
	);
}

function MarkdownCheckbox({ checked }: JSX.IntrinsicElements["input"] & ExtraProps) {
	return h("input", { type: "checkbox", checked: Boolean(checked), disabled: true });
}

function InlineCode({ children }: JSX.IntrinsicElements["code"] & ExtraProps) {
	return h("code", null, children);
}

function textOf(children: ReactNode): string {
	if (typeof children === "string") return children;
	if (Array.isArray(children)) return children.map(textOf).join("");
	return "";
}

/** Streamdown marks fenced code with `data-block`; everything else is inline. */
function MarkdownCode(props: JSX.IntrinsicElements["code"] & ExtraProps) {
	if (!("data-block" in props)) return h("code", null, props.children);
	const language = /(?:^|\s)language-(\S+)/.exec(props.className ?? "")?.[1] ?? "";
	return h(CodeBlock, { language, source: textOf(props.children).replace(/\n$/, "") });
}

const CODE_THEMES: [string, string] = ["github-light", "github-dark"];
let codePlugin: Promise<CodeHighlighterPlugin> | undefined;

/** Shiki loads on the first highlighted block, outside the initial bundle. */
function loadCodePlugin(): Promise<CodeHighlighterPlugin> {
	codePlugin ??= import("@streamdown/code").then((module) => module.code);
	return codePlugin;
}

interface Highlighted {
	readonly source: string;
	readonly language: string;
	readonly result: HighlightResult;
}

function useHighlight(source: string, language: string, enabled: boolean): HighlightResult | undefined {
	const [highlighted, setHighlighted] = useState<Highlighted>();
	useEffect(() => {
		if (!enabled || !language) return;
		let current = true;
		const accept = (result: HighlightResult) => {
			if (current) setHighlighted({ source, language, result });
		};
		void loadCodePlugin()
			.then((plugin) => {
				if (!current || !plugin.supportsLanguage(language)) return;
				const ready = plugin.highlight({ code: source, language, themes: CODE_THEMES }, accept);
				if (ready) accept(ready);
			})
			.catch(() => {
				// Highlighting is decoration: the block already shows its code as plain text.
			});
		return () => {
			current = false;
		};
	}, [source, language, enabled]);
	return highlighted?.source === source && highlighted.language === language ? highlighted.result : undefined;
}

/** Shiki styles are CSS declarations; React wants camelCase names, custom properties stay as they are. */
function tokenStyle(token: HighlightToken): CSSProperties | undefined {
	if (!token.htmlStyle) return token.color ? { color: token.color } : undefined;
	const style: Record<string, string> = {};
	for (const [name, value] of Object.entries(token.htmlStyle)) {
		style[
			name.startsWith("--") ? name : name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
		] = value;
	}
	return style;
}

function highlightedLines(result: HighlightResult): ReactNode {
	const last = result.tokens.length - 1;
	return result.tokens.map((line, row) =>
		h(
			Fragment,
			// Lines and tokens have no identity but their position.
			{ key: row },
			line.map((token, column) => h("span", { key: column, style: tokenStyle(token) }, token.content)),
			row < last ? "\n" : null,
		),
	);
}

/** `.code-block` markup: the composer's paste conversion and the copy-button styles read it. */
function CodeBlockView({ language, source }: { readonly language: string; readonly source: string }) {
	const { labels, streaming, onCopyCode, copiedLabel } = useSettings();
	const highlighted = useHighlight(source, language, !streaming);
	const [copied, flash] = useCopiedFlag();
	const copy = () => {
		if (!onCopyCode) return;
		void Promise.resolve(onCopyCode(source)).then((ok) => {
			if (ok !== false) flash();
		});
	};
	return h(
		"div",
		{ className: "code-block", "data-language": language || undefined },
		h(
			"div",
			{ className: "code-block-header" },
			h("span", null, language || labels.code),
			h(
				"button",
				{ className: "copy-code", type: "button", "data-copied": copied ? "" : undefined, onClick: copy },
				copied && copiedLabel ? copiedLabel : labels.copy,
			),
		),
		h("pre", null, h("code", null, highlighted ? highlightedLines(highlighted) : source)),
	);
}

let mermaidRenders = 0;

/** `<html data-theme>` names the resolved theme (features/shell `applyTheme`); `ui/` reads it, not the store. */
function documentDark(): boolean {
	return document.documentElement.dataset.theme === "dark";
}

function subscribeTheme(notify: () => void): () => void {
	const observer = new MutationObserver(notify);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
	return () => observer.disconnect();
}

/** Whether the page is dark; re-renders the caller when the theme changes. Server rendering reads light. */
function useDarkTheme(): boolean {
	return useSyncExternalStore(subscribeTheme, documentDark, () => false);
}

interface MermaidSvg {
	readonly source: string;
	readonly dark: boolean;
	readonly markup: string;
}

/**
 * Mermaid loads on the first diagram; until it draws (or if it fails) the source
 * shows as code. Its colours are baked into the SVG, so a theme change draws it again.
 */
function MermaidDiagram({ source }: { readonly source: string }) {
	const { labels } = useSettings();
	const dark = useDarkTheme();
	const [svg, setSvg] = useState<MermaidSvg>();
	useEffect(() => {
		let current = true;
		void import("@streamdown/mermaid")
			.then(async ({ mermaid }) => {
				mermaidRenders += 1;
				const { svg: markup } = await mermaid
					.getMermaid({ theme: dark ? "dark" : "default" })
					.render(`md-mermaid-${mermaidRenders}`, source);
				if (current) setSvg({ source, dark, markup });
			})
			.catch(() => {
				// An invalid diagram keeps showing its source.
			});
		return () => {
			current = false;
		};
	}, [source, dark]);
	// While a redraw for the other theme is pending, the previous drawing stays rather than flashing the source.
	if (svg?.source !== source) return h(CodeBlockView, { language: "mermaid", source });
	return h("div", {
		className: "md-mermaid",
		role: "img",
		"aria-label": labels.diagram,
		"data-theme": svg.dark ? "dark" : "light",
		// Mermaid renders with securityLevel "strict" (the @streamdown/mermaid default), which sanitizes its SVG.
		// biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid's own sanitized SVG output.
		dangerouslySetInnerHTML: { __html: svg.markup },
	});
}

function CodeBlock({ language, source }: { readonly language: string; readonly source: string }) {
	const { streaming } = useSettings();
	if (language === "mermaid" && !streaming) return h(MermaidDiagram, { source });
	return h(CodeBlockView, { language, source });
}

function FileChip(props: Record<string, unknown> & ExtraProps) {
	const { renderFile } = useSettings();
	const index = Number(props["data-index"]);
	return Number.isInteger(index) && renderFile ? h(Fragment, null, renderFile(index)) : null;
}

const COMPONENTS: Components = {
	a: MarkdownLink,
	img: MarkdownImage,
	code: MarkdownCode,
	inlineCode: InlineCode,
	table: MarkdownTable,
	thead: plain("thead"),
	tbody: plain("tbody"),
	tr: plain("tr"),
	th: MarkdownHeaderCell,
	td: MarkdownCell,
	h1: heading("h2"),
	h2: heading("h3"),
	h3: heading("h4"),
	h4: heading("h4"),
	h5: heading("h4"),
	h6: heading("h4"),
	p: plain("p"),
	ul: plain("ul"),
	ol: plain("ol"),
	li: plain("li"),
	input: MarkdownCheckbox,
	blockquote: plain("blockquote"),
	hr: plain("hr"),
	strong: plain("strong"),
	em: plain("em"),
	del: plain("del"),
	sup: plain("sup"),
	sub: plain("sub"),
	section: plain("section"),
	[FILE_CHIP_TAG]: FileChip,
};

/** No raw HTML, sanitizer or URL hardening pass: the elements above own every URL. Math adds its own pass. */
const REHYPE_PLUGINS: MarkdownPluggable[] = [];
/** One list for every surface without attached files, so Streamdown reuses its parser. */
const DEFAULT_REMARK_PLUGINS: MarkdownPluggable[] = [...MARKDOWN_REMARK_PLUGINS];
const LINK_SAFETY = { enabled: false } as const;

interface BoundaryProps {
	readonly fallback: string;
	readonly children?: ReactNode;
}

interface BoundaryState {
	readonly failed: boolean;
	/** The source the children last rendered, so a failure stays tied to that text. */
	readonly source: string;
}

/**
 * A renderer failure shows the source as plain text instead of unmounting the
 * conversation; different text gets a fresh attempt.
 */
class MarkdownBoundary extends Component<BoundaryProps, BoundaryState> {
	state: BoundaryState = { failed: false, source: "" };

	static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
		if (!state.failed) return state.source === props.fallback ? null : { source: props.fallback };
		return state.source === props.fallback ? null : { failed: false, source: props.fallback };
	}

	static getDerivedStateFromError(): Partial<BoundaryState> {
		return { failed: true };
	}

	render(): ReactNode {
		return this.state.failed ? h("div", { className: "md-fallback" }, this.props.fallback) : this.props.children;
	}
}

export const MarkdownContent = memo(function MarkdownContent({
	source,
	labels,
	streaming = false,
	localFiles = false,
	fileNames,
	renderFile,
	onCopyCode,
	copiedLabel,
}: MarkdownContentProps): ReactElement {
	const settings = useMemo(
		() => ({ labels, streaming, localFiles, renderFile, onCopyCode, copiedLabel }),
		[labels, streaming, localFiles, renderFile, onCopyCode, copiedLabel],
	);
	const remarkPlugins = useMemo(
		() => (fileNames?.length ? [...MARKDOWN_REMARK_PLUGINS, remarkFileMarkers(fileNames)] : DEFAULT_REMARK_PLUGINS),
		[fileNames],
	);
	return h(
		MarkdownSettingsContext.Provider,
		{ value: settings },
		h(
			MarkdownBoundary,
			{ fallback: source },
			h(
				Streamdown,
				{
					className: "md-root",
					mode: streaming ? "streaming" : "static",
					parseIncompleteMarkdown: streaming,
					animated: false,
					isAnimating: false,
					controls: false,
					lineNumbers: false,
					linkSafety: LINK_SAFETY,
					plugins: MARKDOWN_PLUGINS,
					remarkPlugins,
					rehypePlugins: REHYPE_PLUGINS,
					components: COMPONENTS,
				},
				source,
			),
		),
	);
});
