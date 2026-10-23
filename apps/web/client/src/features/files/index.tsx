/**
 * Files feature slots, mounted by App.tsx at their legacy DOM positions:
 * `#fileTree` in the sidebar and
 * `aside#previewPanel`. Cross-feature entry points live in ./actions.ts.
 */

import "./files.css";
// Registers the side-answer tab actions with `state/session.ts` at module load.
import "./side-answers.ts";

export { FileTreePanel } from "./FileTreePanel";
/** Code shown outside the preview: a tool call's excerpt and diff use the same tokens and families. */
export { fileLanguage, highlightFence, highlightLines } from "./highlight";
export { PreviewPanel } from "./PreviewPanel";
export { askSideQuestion, beginSideAnswer, failSideAnswer } from "./side-answers";
