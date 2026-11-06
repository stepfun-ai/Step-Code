/**
 * Settings feature slot, mounted by App.tsx after `.app`: `SettingsView`
 * (`#settingsView`), the full-window settings page opened from the sidebar
 * footer's gear. Other features open and close it through `actions.ts`.
 */

import "./settings.css";
import "./extension-management.css";

export { ExtensionCreateMenu, readUploadSelection, type UploadOutcome } from "./ExtensionCreateMenu";
export { ExtensionRemoveButton } from "./ExtensionRemoveButton";
export { ExtensionRowMenu } from "./ExtensionRowMenu";
export type { ExtensionRemoval } from "./extension-removal";
export { startExtensionTrial } from "./extension-trial";
export { PluginDependencyStatus } from "./PluginDependencyStatus";
export { PluginInstallButton } from "./PluginInstallButton";
export { importPluginFile } from "./plugin-actions";
export { SettingsView } from "./SettingsView";
export { SkillInstallButton } from "./SkillInstallButton";
export { importSkillFile } from "./skill-actions";
