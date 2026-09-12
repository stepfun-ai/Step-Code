/**
 * approval.ts — the confirm-provider seam for extension/permission approvals (S4-1 STEP 5).
 *
 * Deliberately thin. S4-1 extracts ONLY the confirm-provider closure that the extension UI
 * context hands to `session.bindExtensions` (and, through it, to the permission hook at
 * packages/coding-agent/src/step/permissions.ts). The ExtensionSelector dialog that actually
 * renders the Yes/No prompt (showExtensionConfirm → showExtensionSelector) and the other ~90%
 * of createExtensionUIContext stay on the host as view/dialog concerns for S4-2 — we do NOT
 * force-split createExtensionUIContext here. The closure still resolves to the host's
 * showExtensionConfirm through the live ctx, so the editor/theme/footer refs it ultimately
 * uses are never lifted out of their capturing scope.
 */

import type { ExtensionUIContext } from "@step-harness/coding-agent";
import type { RuntimeContext } from "./context.ts";

export function createApprovalProvider(ctx: RuntimeContext): Pick<ExtensionUIContext, "confirm"> {
	return {
		confirm: (title, message, opts) => ctx.showExtensionConfirm(title, message, opts),
	};
}
