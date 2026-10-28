/**
 * Reusable presentation primitives. Rules for this folder:
 * - no imports from state/, lib/api, or features/ (lib/format and lib/markdown are fine);
 * - every component forwards id, className, aria-* and data-* so feature code
 *   can keep the legacy ids and classes the tests and feature CSS rely on;
 * - overlays stay mounted and toggle the native `hidden` attribute.
 *
 * apps/web/AGENTS.md ("Shared UI components") lists what each export is for;
 * add a row there with every new export.
 *
 * main.tsx imports this barrel before App so that the CSS Modules here load
 * before feature CSS, letting the legacy feature rules override them.
 */

export { Button, type ButtonProps, type ButtonVariant } from "./Button/Button";
export { DiffStat, type DiffStatProps } from "./DiffStat/DiffStat";
export { EmptyState } from "./EmptyState/EmptyState";
export { useCopiedFlag } from "./hooks/useCopiedFlag";
export { type DismissEvent, type DismissOptions, useDismiss } from "./hooks/useDismiss";
export { useMergedRef } from "./hooks/useMergedRef";
export { Icon, type IconName, type IconProps, type IconSize, LEGACY_ICONS } from "./Icon/Icon";
export { IconButton, type IconButtonProps } from "./IconButton/IconButton";
export { ICON_NAMES, IconSprite } from "./IconSprite/IconSprite";
export { Kbd, type KbdProps } from "./Kbd/Kbd";
export { type MarkdownLabels, MarkdownView, type MarkdownViewProps } from "./MarkdownView/MarkdownView";
export { Menu, MenuDivider, type MenuDividerProps, MenuItem, type MenuItemProps, type MenuProps } from "./Menu/Menu";
export { Modal, type ModalProps } from "./Modal/Modal";
export { Popover, type PopoverPlacement, type PopoverProps } from "./Popover/Popover";
export { ResizeHandle, type ResizeHandleProps } from "./ResizeHandle/ResizeHandle";
export { SearchInput, type SearchInputProps } from "./SearchInput/SearchInput";
export {
	SegmentedControl,
	SegmentedControl as Tabs,
	type SegmentedControlProps,
	type SegmentedItem,
} from "./SegmentedControl/SegmentedControl";
export { ShimmerText } from "./ShimmerText/ShimmerText";
export { Spinner } from "./Spinner/Spinner";
export { Switch, type SwitchProps } from "./Switch/Switch";
export { Toast, type ToastProps, type ToastTone } from "./Toast/Toast";
export { Tooltip, type TooltipProps, type TooltipTriggerProps } from "./Tooltip/Tooltip";
