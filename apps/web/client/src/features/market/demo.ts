/**
 * Demo cards for the scheduled-task and plugin-market views (remote commit
 * 4aea0f8). Placeholder data until the cron panel management API (batch 1)
 * and the plugin installer are wired to the host.
 */

export interface DemoCard {
	readonly title: string;
	readonly desc: string;
	readonly meta: string;
	readonly on: boolean;
	/** Announced but not installable yet: the card shows a "coming soon" label instead of an Install action. */
	readonly planned?: boolean;
}

export const CRON_DEMO: readonly DemoCard[] = [
	{
		title: "依赖过时巡检",
		desc: "每天 09:00 · step-harness-web\n下次：明早 09:00",
		meta: "cron · 0 9 * * *",
		on: true,
	},
	{
		title: "站会摘要生成",
		desc: "工作日 09:30 · step-harness\n下次：明早 09:30",
		meta: "cron · 30 9 * * 1-5",
		on: true,
	},
	{
		title: "BMK 回归",
		desc: "每周一 10:00 · step-harness\n暂停中，恢复后按计划运行",
		meta: "cron · 0 10 * * 1",
		on: false,
	},
];

export const MARKET_DEMO: readonly DemoCard[] = [
	{
		title: "StepPage",
		desc: "把静态网站一键发布上线，会话内说「发布这个页面」即可，自动生成访问链接。",
		meta: "官方 · 预装",
		on: true,
	},
	{
		title: "search-web",
		desc: "联网搜索工具：让会话可以检索网页并引用来源，回答时效性问题。",
		meta: "官方 · 工具",
		on: true,
	},
	{
		title: "MCP Servers",
		desc: "Model Context Protocol 接入：把数据库、浏览器、内部系统挂成模型可调用的工具。",
		meta: "生态 · 接入",
		on: false,
	},
	{
		title: "QuickJS Workflows",
		desc: "用 TypeScript 脚本编排多智能体并行执行，沙箱隔离、可重放。",
		meta: "官方 · 内核能力",
		on: true,
	},
	{
		title: "Skills",
		desc: "技能包：把团队约定与操作手册变成模型可加载的技能目录。",
		meta: "官方 · 内核能力",
		on: true,
	},
	{
		title: "Browser Bridge",
		desc: "受审批的浏览器操作：打开页面、点击、读取内容（Computer Use 一期）。",
		meta: "桌面端",
		on: false,
		planned: true,
	},
];
