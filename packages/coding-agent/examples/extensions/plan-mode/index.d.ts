/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, built-in write tools are disabled.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function planModeExtension(pi: ExtensionAPI): void;
//# sourceMappingURL=index.d.ts.map
