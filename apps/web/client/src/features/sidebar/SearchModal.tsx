import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { formatRelativeTime, type TranslateFn, useT } from "../../i18n";
import { errorMessage } from "../../lib/api";
import { splitAttachedFiles } from "../../lib/attached-files";
import { basename } from "../../lib/format";
import { useImeGuard } from "../../lib/ime";
import { skillInvocation } from "../../lib/markdown";
import { refreshSessions, sessionTitle } from "../../state/session";
import { useAppStore } from "../../state/store";
import type { SessionSearchHit, SessionSearchResult, SessionSummary } from "../../state/types";
import { EmptyState, Icon, IconButton, Kbd, LEGACY_ICONS, Modal } from "../../ui";
import { openSessionAtEntry } from "../conversation/actions";
import { closeSearch, searchSessionContent, subscribeSearchOpen } from "./actions";

const MAX_RESULTS = 50;
/** Typing pause before the content query goes to the host; each keystroke cancels the previous one. */
const SEARCH_DEBOUNCE_MS = 150;
const MATCH_START = "\u0002";
const MATCH_END = "\u0003";

/** One result row: a session, and the content hit that matched it when the index found one. */
interface SearchRow {
	readonly session: SessionSummary;
	readonly hit?: SessionSearchHit;
}

/** The host's answer for `query`; `result` is null when the request failed. */
interface ContentSearch {
	readonly query: string;
	readonly result: SessionSearchResult | null;
}

function newestFirst(sessions: readonly SessionSummary[]): SessionSummary[] {
	return [...sessions].sort(
		(left, right) => new Date(right.modified ?? "").getTime() - new Date(left.modified ?? "").getTime(),
	);
}

/** Title, first message or folder containing the query: answered at once, before the host replies. */
function metadataMatches(sessions: readonly SessionSummary[], query: string): SessionSummary[] {
	const normalized = query.trim().toLowerCase();
	return sessions.filter((session) =>
		[session.name, session.firstMessage, session.cwd].some((text) => text?.toLowerCase().includes(normalized)),
	);
}

/**
 * Content hits in the host's rank order, one row per session, then metadata
 * matches the index did not return (a folder path is not indexed). Sessions
 * hidden from search (their folder is gone) stay hidden; a hit in a session
 * the page has not listed yet (written by a CLI meanwhile) still shows.
 */
function searchRows(
	sessions: readonly SessionSummary[],
	query: string,
	content: SessionSearchResult | null,
): SearchRow[] {
	const visible = newestFirst(sessions.filter((session) => session.cwdAvailable !== false));
	if (!query.trim()) return visible.slice(0, MAX_RESULTS).map((session) => ({ session }));
	const known = new Map(sessions.map((session) => [session.id, session]));
	const rows: SearchRow[] = [];
	const seen = new Set<string>();
	for (const hit of content?.hits ?? []) {
		if (seen.has(hit.sessionId)) continue;
		const session = known.get(hit.sessionId);
		if (session?.cwdAvailable === false) continue;
		seen.add(hit.sessionId);
		rows.push({
			session: session ?? { id: hit.sessionId, cwd: hit.cwd, modified: new Date(hit.ts).toISOString() },
			hit,
		});
	}
	for (const session of metadataMatches(visible, query)) {
		if (!seen.has(session.id)) rows.push({ session });
	}
	return rows.slice(0, MAX_RESULTS);
}

/** A snippet with each match in a <mark>; whitespace runs collapse to one space. */
/*
 * Snippets are cut from the raw Markdown of a message; a result line reads as
 * prose, so emphasis, code ticks, heading and quote marks are dropped. The
 * match markers are control characters and survive untouched.
 */
function plainSnippet(snippet: string): string {
	return snippet
		.replace(/\*\*|__|`+/g, "")
		.replace(/(^|\s)(#{1,6}|>|[-*+])\s+/g, "$1")
		.replace(/\s+/g, " ");
}

function highlighted(snippet: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	const text = plainSnippet(snippet);
	let offset = 0;
	while (offset < text.length) {
		const start = text.indexOf(MATCH_START, offset);
		if (start < 0) {
			nodes.push(text.slice(offset));
			break;
		}
		if (start > offset) nodes.push(text.slice(offset, start));
		const end = text.indexOf(MATCH_END, start + 1);
		const stop = end < 0 ? text.length : end;
		nodes.push(<mark key={start}>{text.slice(start + 1, stop)}</mark>);
		offset = stop + 1;
	}
	return nodes;
}

/** Marks each case-insensitive occurrence of `query` in a title, so a title hit shows why it matched. */
function markQuery(text: string, query: string): ReactNode {
	const needle = query.trim().toLowerCase();
	if (!needle) return text;
	const nodes: ReactNode[] = [];
	const haystack = text.toLowerCase();
	let offset = 0;
	for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, offset)) {
		if (at > offset) nodes.push(text.slice(offset, at));
		nodes.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>);
		offset = at + needle.length;
	}
	if (!nodes.length) return text;
	if (offset < text.length) nodes.push(text.slice(offset));
	return nodes;
}

/** Footer note while the index cannot answer for the whole history. */
function coverageNote(content: SessionSearchResult | null, t: TranslateFn): string {
	if (!content || content.state === "ready") return "";
	if (content.state === "degraded") return t("searchIndexDegraded");
	return t("searchIndexing", { indexed: content.coverage.indexed, total: content.coverage.total });
}

function openResult(row: SearchRow | undefined): void {
	if (!row) return;
	closeSearch();
	void openSessionAtEntry(row.session.id, row.hit?.entryId ?? null);
}

/** `#searchModal`: global conversation search (legacy index.html 1159-1202, app.js 1187-1280, 3401-3425). */
/** First message as shown: a skill invocation reads `name · request`, not the skill's instructions. */
function skillPreview(raw: string | undefined): string {
	const text = splitAttachedFiles(raw ?? "").text;
	const skill = text ? skillInvocation(text) : null;
	if (!skill) return text;
	return skill.request ? `${skill.name} · ${skill.request}` : skill.name;
}

export function SearchModal() {
	const t = useT();
	const open = useAppStore((state) => state.ui.searchOpen);
	const sessions = useAppStore((state) => state.sessions);
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const ime = useImeGuard();
	const [query, setQuery] = useState("");
	const [index, setIndex] = useState(-1);
	const [openRequest, setOpenRequest] = useState(0);
	const [content, setContent] = useState<ContentSearch | null>(null);

	// Each openSearch() clears the query and the selection, then focuses the field
	// once the modal is visible.
	useEffect(
		() =>
			subscribeSearchOpen(() => {
				if (input.current) input.current.value = "";
				setQuery("");
				setIndex(-1);
				setOpenRequest((count) => count + 1);
				setContent(null);
				// Hits can point at sessions written since the list loaded; fetch their titles.
				void refreshSessions().catch(() => {});
			}),
		[],
	);
	useEffect(() => {
		if (openRequest) input.current?.focus();
	}, [openRequest]);
	useEffect(() => {
		if (index < 0) return;
		list.current?.querySelector(`.search-result[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
	}, [index]);

	useEffect(() => {
		const text = query.trim();
		if (!open || !text) return;
		const controller = new AbortController();
		const timer = setTimeout(() => {
			searchSessionContent(text, controller.signal).then(
				(result) => setContent({ query: text, result }),
				(error: unknown) => {
					if (controller.signal.aborted) return;
					// Metadata matches still show; the index is an addition, not a requirement.
					console.warn("Session search failed:", errorMessage(error));
					setContent({ query: text, result: null });
				},
			);
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [open, query]);

	const answered = content && content.query === query.trim() ? content.result : null;
	const results = open ? searchRows(sessions, query, answered) : [];
	const note = query.trim() ? coverageNote(answered, t) : "";
	const move = (delta: number) => {
		if (!results.length) return;
		// The first row starts highlighted, so the first ↓ moves to the second.
		setIndex((current) => (Math.max(current, 0) + delta + results.length) % results.length);
	};
	const onInput = (event: FormEvent<HTMLInputElement>) => {
		setIndex(-1);
		setQuery(event.currentTarget.value);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			move(1);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			move(-1);
		} else if (event.key === "Enter" && !ime.isComposing(event)) {
			event.preventDefault();
			openResult(results[index >= 0 ? index : 0]);
		} else if (event.key === "Escape") {
			event.preventDefault();
			// Only this layer: the shell's Escape chain would otherwise carry on to the next one.
			event.stopPropagation();
			closeSearch();
		}
	};

	const projects = new Map<string, SearchRow[]>();
	for (const row of results) {
		const key = row.session.cwd || "";
		const items = projects.get(key) ?? [];
		items.push(row);
		projects.set(key, items);
	}
	let position = 0;

	return (
		<Modal
			open={open}
			onClose={closeSearch}
			id="searchModal"
			overlayClassName="search-overlay"
			className="search-dialog"
			labelledBy="searchTitle"
		>
			<header className="search-header">
				<h2 id="searchTitle">{t("searchTitle")}</h2>
				<IconButton
					id="searchClose"
					title="关闭"
					aria-label="关闭"
					icon="close"
					iconSize="lg"
					onClick={closeSearch}
				/>
			</header>
			<div className="search-input-wrap">
				<Icon name="searchLg" size="lg" />
				<input
					ref={input}
					id="globalSearchInput"
					type="search"
					autoComplete="off"
					placeholder={t("searchPlaceholder")}
					{...ime.handlers}
					onInputCapture={onInput}
					onKeyDown={onKeyDown}
					role="combobox"
					aria-expanded={results.length > 0}
					aria-controls="globalSearchResults"
					aria-autocomplete="list"
					aria-label={t("searchPlaceholder")}
					aria-activedescendant={results.length ? `search-option-${index >= 0 ? index : 0}` : undefined}
				/>
			</div>
			<div
				className="search-results"
				id="globalSearchResults"
				ref={list}
				role="listbox"
				aria-label={t("searchTitle")}
			>
				{results.length ? (
					[...projects].map(([cwd, items]) => (
						// biome-ignore lint/a11y/useSemanticElements: an option group inside a listbox is role="group"; a fieldset is a form control group.
						<section className="search-project" key={cwd} role="group" aria-label={basename(cwd) || t("recent")}>
							<div className="search-project-header" aria-hidden="true">
								<Icon {...LEGACY_ICONS.folder} />
								<span>{basename(cwd) || t("recent")}</span>
							</div>
							{items.map((row) => {
								const itemIndex = position++;
								const { session, hit } = row;
								// A title hit repeats the title; the first message says more.
								const excerpt = hit && hit.entryType !== "session" ? hit.snippet : "";
								const title = sessionTitle(session);
								const preview = excerpt ? "" : skillPreview(session.firstMessage);
								// A title derived from the first message would only be printed twice.
								const showPreview = Boolean(excerpt) || (Boolean(preview) && preview !== title);
								return (
									<button
										key={session.id}
										className={
											itemIndex === (index >= 0 ? index : 0) ? "search-result selected" : "search-result"
										}
										type="button"
										id={`search-option-${itemIndex}`}
										role="option"
										aria-selected={itemIndex === (index >= 0 ? index : 0)}
										tabIndex={-1}
										data-index={String(itemIndex)}
										data-entry-id={hit?.entryId ?? undefined}
										onClick={() => openResult(row)}
									>
										<span className="search-result-main">
											<strong>{markQuery(title, query)}</strong>
											{showPreview ? (
												<small className={excerpt ? "search-result-snippet" : undefined}>
													{excerpt ? highlighted(excerpt) : preview}
												</small>
											) : null}
										</span>
										<time>{formatRelativeTime(session.modified)}</time>
									</button>
								);
							})}
						</section>
					))
				) : (
					<EmptyState>{t("noSearchResults")}</EmptyState>
				)}
			</div>
			<footer className="search-footer">
				<span>
					<Kbd>↑</Kbd>
					<Kbd>↓</Kbd> <span>{t("searchSelect")}</span>
				</span>
				<span>
					<Kbd>Enter</Kbd> <span>{t("searchOpen")}</span>
				</span>
				<span>
					<Kbd>Esc</Kbd> <span>{t("searchClose")}</span>
				</span>
				<span className="search-index-note" id="searchIndexNote" hidden={!note}>
					{note}
				</span>
			</footer>
		</Modal>
	);
}
