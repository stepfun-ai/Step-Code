/** Bilingual MCP Settings strings; composed into the shared dictionaries by the client entry point. */
export const mcpSettingsMessages = {
	zh: {
		settingsMcpStoredHidden: "已保存的配置内容已隐藏",
		settingsMcpPatchDesc:
			"已保存的敏感值不会发送到页面。每个字段默认保留；只有明确选择替换或删除才会修改。切换传输方式会删除不兼容的传输字段，不会删除工具限制。",
		settingsMcpPatchValues:
			'替换值使用 JSON 格式，例如字符串 "node"、数组 ["server.js"]、对象 {"KEY":"value"}、布尔值 false。删除需选择“删除字段”。',
		settingsMcpPatchField: "配置字段：{field}",
		settingsMcpPatchAction: "{field} 的修改方式",
		settingsMcpPatchKeep: "保留现有值",
		settingsMcpPatchSet: "替换为新值",
		settingsMcpPatchRemove: "删除字段",
		settingsMcpPatchJson: "MCP 配置修改 JSON",
		settingsMcpJsonLabel: "JSON",
		settingsMcpPatchInvalid: "修改格式无效。请检查 JSON 值、字段操作和配置版本。",
		settingsMcpPatchFailed: "未能保存配置。请返回列表刷新后重试；配置可能已被其他操作修改。",
		settingsMcpPatchReload: "请返回 MCP 列表刷新，再编辑配置。",
		settingsMcpSafeFailure: "MCP 连接失败，请检查本机配置。",
		settingsMcpLoadFailed: "无法加载 MCP 配置，请刷新后重试。",
	},
	en: {
		settingsMcpStoredHidden: "Stored configuration hidden",
		settingsMcpPatchDesc:
			"Stored sensitive values are never sent to this page. Fields are kept unless you explicitly replace or remove them. Changing transport removes incompatible transport fields, never tool restrictions.",
		settingsMcpPatchValues:
			'Replacement values use JSON: a string "node", an array ["server.js"], an object {"KEY":"value"}, or a boolean false. Choose Remove field to delete a value.',
		settingsMcpPatchField: "Configuration field: {field}",
		settingsMcpPatchAction: "Change operation for {field}",
		settingsMcpPatchKeep: "Keep existing value",
		settingsMcpPatchSet: "Replace with new value",
		settingsMcpPatchRemove: "Remove field",
		settingsMcpPatchJson: "MCP settings patch JSON",
		settingsMcpJsonLabel: "JSON",
		settingsMcpPatchInvalid: "Invalid patch. Check JSON values, field operations and configuration revision.",
		settingsMcpPatchFailed:
			"Could not save. Return to the list, refresh and retry; the configuration may have changed elsewhere.",
		settingsMcpPatchReload: "Return to the MCP list and refresh before editing.",
		settingsMcpSafeFailure: "MCP connection failed. Check the local configuration.",
		settingsMcpLoadFailed: "Could not load MCP settings. Refresh and retry.",
	},
} as const;
