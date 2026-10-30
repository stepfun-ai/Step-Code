/**
 * Remark plugins and plugin lists for the Streamdown Markdown renderer.
 *
 * Kept free of React and CSS so the Markdown grammar can be exercised from node tests.
 */

import { cjk } from "@streamdown/cjk";
import { createMathPlugin } from "@streamdown/math";
import type { Link, Parents, PhrasingContent, Root, RootContent, Text } from "mdast";
import { defaultRemarkPlugins, type PluginConfig, type StreamdownProps } from "streamdown";

/** One remark plugin entry, with or without options. */
export type MarkdownPluggable = NonNullable<StreamdownProps["remarkPlugins"]>[number];

/** Stands for `files[N]` in a message: `\u0002N\u0002` (see lib/attached-files `markAttachedFiles`). */
const FILE_MARKER = /\u0002(\d+)\u0002/g;
const FILE_MARKER_SPLIT = /\u0002(\d+)\u0002/;

/** Element name the file-marker plugin produces; the renderer maps it to a chip. */
export const FILE_CHIP_TAG = "step-file";

/**
 * `~text~` stays literal: remark-gfm and the CJK strikethrough extension both
 * accept a single tilde by default, and the CJK one overrides remark-gfm's result,
 * so both get `singleTilde: false`. Plugins that take no options ignore it.
 */
function withoutSingleTilde(plugin: MarkdownPluggable): MarkdownPluggable {
	if (typeof plugin === "function") return [plugin, { singleTilde: false }];
	if (!Array.isArray(plugin)) return plugin;
	const [attacher, options, ...rest] = plugin;
	return [
		attacher,
		{ ...(typeof options === "object" && options !== null ? options : {}), singleTilde: false },
		...rest,
	];
}

const EMPHASIS_BY_MARKER: Readonly<Record<string, "strong" | "emphasis" | "delete">> = {
	"**": "strong",
	__: "strong",
	"*": "emphasis",
	_: "emphasis",
	"~~": "delete",
};

/** A bare URL the GFM autolink literal turned into a link: its only text is the address as written. */
function isLiteralAutolink(link: Link): link is Link & { children: [Text] } {
	const [label] = link.children;
	if (link.children.length !== 1 || label?.type !== "text") return false;
	return link.url === label.value || link.url === `http://${label.value}` || link.url === `mailto:${label.value}`;
}

/**
 * GFM never ends an autolink literal on `*`, `_` or `~`, but micromark keeps them
 * when CJK punctuation follows without a space (`**https://x**。`), so the link
 * swallowed the closing marker and the opening one showed literally. Split the
 * markers off and, when the text before the link ends with the same run, restore
 * the emphasis they delimit.
 */
export function remarkAutolinkTrailingMarkers() {
	return (tree: Root): void => splitTrailingMarkers(tree);
}

function splitTrailingMarkers(parent: Parents): void {
	for (let index = 0; index < parent.children.length; index += 1) {
		const child = parent.children[index];
		if (child.type !== "link" || !isLiteralAutolink(child)) {
			if ("children" in child) splitTrailingMarkers(child);
			continue;
		}
		const label = child.children[0];
		const tail = /[*_~]+$/.exec(label.value)?.[0];
		if (!tail || !child.url.endsWith(tail) || label.value.length === tail.length) continue;
		child.url = child.url.slice(0, -tail.length);
		label.value = label.value.slice(0, -tail.length);
		const before = parent.children[index - 1];
		const wrapper = EMPHASIS_BY_MARKER[tail];
		if (wrapper && before?.type === "text" && before.value.endsWith(tail)) {
			before.value = before.value.slice(0, -tail.length);
			const wrapped: PhrasingContent = { type: wrapper, children: [child] };
			replaceChild(parent, index, wrapped);
		} else {
			insertAfter(parent, index, { type: "text", value: tail });
			index += 1;
		}
	}
}

// `Parents["children"]` is a union of child arrays; phrasing content is valid wherever a link was.
function replaceChild(parent: Parents, index: number, node: PhrasingContent): void {
	(parent.children as RootContent[]).splice(index, 1, node);
}

function insertAfter(parent: Parents, index: number, node: PhrasingContent): void {
	(parent.children as RootContent[]).splice(index + 1, 0, node);
}

/**
 * Turns the attached-file markers into `<step-file data-index>` elements. A
 * marker inside code cannot hold a chip, so it reads as the file's name there.
 */
export function remarkFileMarkers(names: readonly string[]) {
	return () =>
		(tree: Root): void =>
			replaceFileMarkers(tree, names);
}

function replaceFileMarkers(parent: Parents, names: readonly string[]): void {
	for (let index = 0; index < parent.children.length; index += 1) {
		const child = parent.children[index];
		if (child.type === "inlineCode" || child.type === "code") {
			child.value = child.value.replace(FILE_MARKER, (_match, file: string) => names[Number(file)] ?? "");
			continue;
		}
		if (child.type !== "text") {
			if ("children" in child) replaceFileMarkers(child, names);
			continue;
		}
		if (!FILE_MARKER_SPLIT.test(child.value)) continue;
		const parts = child.value.split(FILE_MARKER_SPLIT);
		// Odd parts are captured file indexes; even parts are the text around them.
		const nodes: Text[] = parts.flatMap((part, position): Text[] => {
			if (position % 2 === 0) return part ? [{ type: "text", value: part }] : [];
			// mdast-util-to-hast turns a node with `data.hName` into that element.
			return [{ type: "text", value: "", data: { hName: FILE_CHIP_TAG, hProperties: { dataIndex: part } } }];
		});
		(parent.children as RootContent[]).splice(index, 1, ...nodes);
		index += nodes.length - 1;
	}
}

/** GFM plus fence metadata, without single-tilde strikethrough. */
export const MARKDOWN_REMARK_PLUGINS: readonly MarkdownPluggable[] = Object.entries(defaultRemarkPlugins).map(
	([name, plugin]) => (name === "gfm" ? withoutSingleTilde(plugin) : plugin),
);

const cjkAfter = [...cjk.remarkPluginsAfter.map(withoutSingleTilde), remarkAutolinkTrailingMarkers];

/**
 * CJK-friendly emphasis and autolink boundaries, then the trailing-marker repair,
 * which must see the links after the CJK split. Code highlighting and Mermaid
 * are not Streamdown plugins here: they load on demand in the renderer.
 */
export const MARKDOWN_PLUGINS: PluginConfig = {
	cjk: {
		...cjk,
		remarkPluginsAfter: cjkAfter,
		remarkPlugins: [...cjk.remarkPluginsBefore, ...cjkAfter],
	},
	math: createMathPlugin({ errorColor: "var(--danger)" }),
};
