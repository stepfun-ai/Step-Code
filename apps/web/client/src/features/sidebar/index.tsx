/**
 * Sidebar feature slots, mounted by App.tsx at their legacy DOM positions
 * (see client/MIGRATION_MAP.md): the brand row, sidebar actions and
 * conversation list inside `aside.sidebar`, the width handle, the session
 * context menu, the tag picker and the global search modal.
 */

import "./sidebar.css";
import "./sessions.css";
import "./overlays.css";
import { BrandRow, ConversationList, SidebarActions } from "./SidebarNav";

export { RenameSessionDialog } from "./RenameSessionDialog";
export { SearchModal } from "./SearchModal";
// The conversation header shares this menu, so it is part of the sidebar's public surface.
export { SessionMenu } from "./SessionMenu";
export { SidebarResizer } from "./SidebarResizer";

/** `.brand-row`, `nav.sidebar-actions`, `section.conversation-list` (legacy index.html 539-640). */
export function SidebarNav() {
	return (
		<>
			<BrandRow />
			<SidebarActions />
			<ConversationList />
		</>
	);
}
