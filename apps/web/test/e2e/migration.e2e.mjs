/** Offline acceptance: real source Host + built React + installed Chrome, never a personal profile.
 * Run after build:client: node --test test/e2e/migration.e2e.mjs (from apps/web).
 * Desktop's read-only picker bridge is simulated; this is not an Electron IPC acceptance.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { parse as parseToml } from "smol-toml";

const webRoot = fileURLToPath(new URL("../..", import.meta.url));
const root = fileURLToPath(new URL("../../../..", import.meta.url));
const chrome = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find((path) => path && existsSync(path));
const options = { skip: chrome ? false : "No installed Chrome; set CHROME_PATH (no downloads)", timeout: 90_000 };
const kinds = ["sessions", "mcp", "rules"];
const ruleText = "# Synthetic source rules\nAlways explain fixture changes.\n";
const skillText = (name) => `---\nname: ${name}\ndescription: Synthetic offline skill\n---\nRead references/help.md.\n`;
const modal = (page) => page.locator("#migrationModal");
const reviewButton = (page) => modal(page).locator('#migrationReviewPlan, #migrationStartPlan');

async function put(path, text) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text);
}
async function until(probe, label, timeout = 10_000) {
	const deadline = Date.now() + timeout;
	do {
		const value = await probe();
		if (value) return value;
		await delay(25);
	} while (Date.now() < deadline);
	throw new Error(`Timed out: ${label}`);
}
async function freePort() {
	const socket = createServer();
	await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
	const { port } = socket.address();
	await new Promise((resolve) => socket.close(resolve));
	return port;
}
// Child output may contain the single-use token. Keep it in memory and never include it in errors.
function launchToken(child) {
	return new Promise((resolve, reject) => {
		let output = "";
		const cleanup = () => {
			clearTimeout(timer);
			child.stdout.off("data", data); child.stderr.off("data", data);
			child.off("exit", exit); child.off("error", error);
			output = "";
		};
		const data = (chunk) => {
			output = (output + chunk.toString()).slice(-32_768);
			const token = /#token=([A-Za-z0-9_-]+)/u.exec(output)?.[1];
			if (token) { cleanup(); resolve(token); }
		};
		const exit = (code) => {
      const diagnostic = output.split("\n").filter(line => /^(Error|SyntaxError|TypeError|ReferenceError):/.test(line.trim()))
        .map(line => line.replace(/#token=[A-Za-z0-9_-]+/g, "#token=[redacted]")).join("\n");
      cleanup(); reject(new Error(`Migration Host exited before ready (${code}); ${diagnostic || "output withheld"}`));
    };
		const error = () => { cleanup(); reject(new Error("Migration Host spawn failed; output withheld")); };
		const timer = setTimeout(() => { cleanup(); reject(new Error("Migration Host readiness exceeded 30s; output withheld")); }, 30_000);
		child.stdout.on("data", data); child.stderr.on("data", data);
		child.once("exit", exit); child.once("error", error);
	});
}
async function stop(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM");
	const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
	try { await exited; } finally { clearTimeout(timer); }
}
async function fixture(t, { existingRule = false, legacy = false } = {}) {
	assert.ok(existsSync(join(webRoot, "dist/public/index.html")), "Run pnpm --filter @step-harness/web build:client first");
	const temp = await realpath(await mkdtemp(join(tmpdir(), "migration-browser-")));
	const home = join(temp, "home");
	const config = join(home, ".acceptance");
	const agent = join(config, "agent");
	const project = join(home, "source-project");
	const target = join(home, "picked-target");
	let child;
	let context;
	t.after(async () => {
		try { await context?.close(); } finally {
			try { await stop(child); } finally {
				try { assert.equal(existsSync(join(temp, "network-attempt")), false, "Host must not attempt external networking"); }
				finally { await rm(temp, { recursive: true, force: true }); }
			}
		}
	});
	await Promise.all([mkdir(project, { recursive: true }), mkdir(target, { recursive: true })]);
	await put(join(agent, "trust.json"), JSON.stringify({ [project]: true, [target]: true }));
	await put(join(config, "config.toml"), 'skills=["!disabled-source"]\n[mcp_servers.existing]\ncommand="fixture-never-start-existing"\nenabled=false\n');
	await put(join(home, ".codex/skills/import-skill/SKILL.md"), skillText("import-skill"));
	await put(join(home, ".codex/skills/import-skill/references/help.md"), "Nested fixture reference\n");
	await put(join(home, ".agents/skills/reference-skill/SKILL.md"), skillText("reference-skill"));
	await put(join(home, ".codex/skills/disabled-source/SKILL.md"), skillText("disabled-source"));
	await put(join(home, ".codex/skills/skip-skill/SKILL.md"), skillText("skip-skill"));
	await put(join(home, ".codex/sessions/rollout-fixture.jsonl"), [
		{ type: "session_meta", payload: { id: "synthetic-codex", cwd: project } },
		{ type: "response_item", payload: { type: "message", role: "user",
			content: [{ type: "input_text", text: "Synthetic Codex history" }] } },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	await put(join(home, ".claude/CLAUDE.md"), ruleText);
	await put(join(home, ".claude.json"), JSON.stringify({ mcpServers: {
		fresh: { command: "fixture-never-start-new", args: ["--offline"] },
		existing: { command: "fixture-never-start-existing" },
	} }));
	const sessionSource = join(home, ".claude/projects/fixture/history.jsonl");
	await put(sessionSource, [
		{ type: "user", uuid: "u", sessionId: "synthetic-history", cwd: project,
			timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "Synthetic historical question" } },
		{ type: "assistant", uuid: "a", parentUuid: "u", sessionId: "synthetic-history",
			timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "Synthetic historical answer" }] } },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	if (existingRule) await put(join(agent, "AGENTS.md"), "# Existing fixture rules\nKeep the original.\n");
	const legacyId = randomUUID();
	let legacyPath;
	if (legacy) {
		legacyPath = join(agent, "session-imports", `${legacyId}.json`);
		await put(legacyPath, JSON.stringify({ id: legacyId, status: "completed", total: 1,
			createdAt: "2026-01-01T00:00:00Z", results: [{ candidateId: "legacy-fixture", status: "skipped",
				source: "codex", title: "Legacy synthetic history", cwd: project }] }));
	}
	// No inherited credentials, proxy settings, account locations, or startup injection variables.
	const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG"]
		.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
	Object.assign(env, { HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp, TEMP: temp,
		STEP_CODING_AGENT_DIR: agent, STEPCODE_CONFIG_DIR: ".acceptance", STEPCODE_STEPGO_IMPORT: "0",
		TSX_TSCONFIG_PATH: join(root, "tsconfig.json"), STEPCODE_WEB_CWD: project,
		STEPCODE_WEB_PUBLIC_DIR: join(webRoot, "dist/public"), STEPCODE_WEB_OPEN: "0" });
	// Fail closed if source startup ever tries an external connection (including model/MCP endpoints).
	const guard = join(temp, "offline.mjs");
	await put(guard, `import {Socket} from "node:net";
import {writeFileSync} from "node:fs";
const connect=Socket.prototype.connect;
Socket.prototype.connect=function(...args){
 const options=Array.isArray(args[0])?args[0][0]:args[0];
 const host=typeof options==="object"?options.host:(typeof args[1]==="string"?args[1]:undefined);
 if(host && !["127.0.0.1","::1","localhost"].includes(host)) {
  writeFileSync(${JSON.stringify(join(temp, "network-attempt"))},"blocked");
  throw new Error("External network forbidden in migration acceptance");
 }
 return connect.apply(this,args);
};\n`);
	env.STEPCODE_WEB_PORT = String(await freePort());
	child = spawn(process.execPath, ["--import", guard, "--import", "tsx", join(webRoot, "src/server.ts")],
		{ cwd: webRoot, env, stdio: ["ignore", "pipe", "pipe"] });
	const token = await launchToken(child);
	// Drain later output without persisting it; it can contain credential-related diagnostics.
	child.stdout.resume(); child.stderr.resume();
	context = await chromium.launchPersistentContext(join(temp, "chrome-profile"), {
		executablePath: chrome, headless: true, chromiumSandbox: true, env,
		viewport: { width: 1440, height: 1000 }, serviceWorkers: "block",
		args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"],
	});
	const base = `http://127.0.0.1:${env.STEPCODE_WEB_PORT}`;
	const forbidden = [];
	await context.route("**/*", async (route) => {
		if (new URL(route.request().url()).origin === base) return route.continue();
		forbidden.push("external-browser-request");
		await route.abort();
	});
	await context.addInitScript(({ target, platform }) => {
		window.pickerPurposes = [];
		Object.defineProperty(window, "stepcodeDesktop", { value: Object.freeze({ platform, version: "acceptance",
			pickDirectory: async (options) => { window.pickerPurposes.push(options?.purpose); return target; },
			openExternal: async () => { throw new Error("External opening forbidden"); },
			revealPath: async () => { throw new Error("Reveal forbidden"); }, defaultBrowser: async () => null,
		}), writable: false, configurable: false });
	}, { target, platform: process.platform });
	const page = await context.newPage();
	page.setDefaultTimeout(10_000);
	const requests = [];
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (request.method() !== "GET") requests.push({ path, method: request.method() });
	});
	// Avoid Playwright's navigation error printing the secret URL on failure.
	try { await page.goto(`${base}/#token=${token}`); } catch { throw new Error("Launch-link navigation failed (URL withheld)"); }
	await page.waitForFunction(() => document.querySelector("#migrationModal")?.hidden === false);
	assert.equal(await page.locator("#loginGate").isVisible(), false, "Local offline startup must not show LoginGate");
	t.after(() => {
		assert.deepEqual(forbidden, [], "No browser external request");
		assert.equal(requests.some(({ path }) => /\/(prompt|login|discover|connect)(?:\/|$)/u.test(path)), false,
			"Acceptance must not send a prompt, log in, discover models or connect MCP");
	});
	return { page, context, temp, home, agent, config, project, target, requests, sessionSource, legacyId, legacyPath };
}
async function api(page, path) {
	return page.evaluate(async (path) => {
		const response = await fetch(path);
		if (!response.ok) throw new Error(`Read-only API failed: ${path} (${response.status})`);
		return response.json();
	}, path);
}
async function responseFor(page, path, action) {
	const response = page.waitForResponse((response) =>
		(new URL(response.url()).pathname === path ||
			(path === "/api/v1/migrations" && new URL(response.url()).pathname === `${path}/start`)) &&
		response.request().method() === "POST");
	const [, result] = await Promise.all([action(), response]);
	assert.ok(result.ok(), `${new URL(result.url()).pathname} returned HTTP ${result.status()}`);
	return result.json();
}
/** Re-running a scan is explicit; entering a step scans that kind once on its own. */
async function scan(page) {
	// Capture the response before clicking, and only while no other scan is in flight,
	// so the returned candidate ids are the ones the UI just rendered.
	await until(async () => await modal(page).locator("#migrationScanButton").isEnabled(), "previous scan settled");
	const pending = page.waitForResponse((response) =>
		new URL(response.url()).pathname === "/api/v1/migrations/scan" && response.request().method() === "POST");
	await modal(page).locator("#migrationScanButton").click();
	const response = await pending;
	assert.ok(response.ok(), `scan returned HTTP ${response.status()}`);
	await modal(page).locator(".migration-list").waitFor();
	return response.json();
}
/** Each category scans its own kind on entry; an explicit rescan keeps the result deterministic. */
async function category(page, kind) {
	await modal(page).locator(".migration-step-rail button").nth(kinds.indexOf(kind)).click();
	await modal(page).locator(".migration-list").waitFor();
	await until(async () => await modal(page).locator("#migrationScanButton").isEnabled(), "entry scan settled");
	return scan(page);
}
async function candidate(page, item, select = true) {
	const row = modal(page).locator(`[data-candidate-id="${item.id}"]`);
	const group = modal(page).locator('.migration-group').filter({ has: page.locator(`[data-candidate-id="${item.id}"]`) });
	if (await group.count() && !await row.isVisible()) await group.locator('.migration-group-toggle').click();
	// Opening the history/declaration and selecting it are separate actions, so drive both.
	const preview = await responseFor(page, "/api/v1/migrations/preview", () => row.locator(".migration-row-title").click());
	if (select && !(await row.locator("input").isChecked())) await row.locator("input").check();
	await until(async () => !(await modal(page).locator(".migration-preview").innerText()).includes("正在更新预览"), "preview UI settled");
	return preview;
}
async function changePreview(page, action) {
	const preview = await responseFor(page, "/api/v1/migrations/preview", action);
	await until(async () => !(await modal(page).locator(".migration-preview").innerText()).includes("正在更新预览"), "changed preview settled");
	return preview;
}
async function startJob(page) {
	const plan = await responseFor(page, "/api/v1/migrations/plans", () => reviewButton(page).click());
	await modal(page).locator(".migration-final-plan").waitFor();
	const started = await responseFor(page, "/api/v1/migrations", () => reviewButton(page).click());
	const job = await until(async () => {
		const job = await api(page, `/api/v1/migrations/${started.id}`);
		return ["completed", "interrupted", "cancelled"].includes(job.status) ? job : null;
	}, "durable migration completion");
	await until(async () => await modal(page).locator("[data-result-count=pending] dd").textContent() === "0", "job UI terminal");
	for (const status of ["imported", "skipped", "failed"]) {
		assert.equal(Number(await modal(page).locator(`[data-result-count=${status}] dd`).textContent()),
			job.items.filter((item) => item.status === status).length, `UI ${status} must match durable job`);
	}
	return { plan, job };
}
async function settings(page, name = "migration") {
	await page.locator("#settingsButton").click();
	await page.locator(`[data-settings-page=${name}]`).click();
	await page.locator(`.settings-content[data-page=${name}]`).waitFor();
}
function item(scan, kind, name) {
	const result = scan.candidates.find((c) => c.kind === kind && c.name === name);
	assert.ok(result, `Expected fixture candidate: ${kind}/${name}`);
	return result;
}
/** The wizard opens straight into the first category; there is no separate invitation screen. */
async function newFlow(page) {
	await page.locator("#migrationPage .migration-category-list button").first().click();
	await modal(page).locator(".migration-list").waitFor();
}
test("grouped session selection has all/partial states and batch targets re-preview without writes", options, async (t) => {
	const f = await fixture(t);
	const { page } = f;
	const scanResult = await scan(page);
	const session = scanResult.candidates.find((c) => c.kind === "sessions" && c.source === "claude-code");
	assert.ok(session, "Claude synthetic history must be discovered");
	const group = modal(page).locator('.migration-group').filter({ has: page.locator(`[data-candidate-id="${session.id}"]`) });
	const groupCheck = group.locator('.migration-group-head > input');
	assert.equal(await group.locator('.migration-group-toggle').getAttribute('aria-expanded'), 'false',
		"Workspace groups start collapsed so a bulk pick stays deliberate");
	await groupCheck.check();
	await until(async () => await groupCheck.isEnabled() && await groupCheck.isChecked(), "group reviews settle");
	assert.match(await modal(page).locator('.migration-select-all .migration-meta').textContent(), /2\/2/u,
		"The list reports its own selected/total counts");
	await group.locator('.migration-group-toggle').click();
	await group.locator(`[data-candidate-id="${session.id}"] > input`).uncheck();
	assert.equal(await groupCheck.evaluate(input => input.indeterminate), true);
	await groupCheck.check();
	await until(async () => await groupCheck.isEnabled() && await groupCheck.isChecked(), "group selected again");
	assert.equal(await page.evaluate(() => document.getElementById('migrationReviewPlan').disabled), false);
	// Sessions inherit their original workspace; no destination pick is offered.
	const response = await responseFor(page, '/api/v1/migrations/plans', () => reviewButton(page).click());
	assert.equal(response.items.length, 2);
	assert.ok(response.items.every(preview => preview.candidate.kind === 'sessions' && preview.target.scope.cwd === f.project));
	assert.equal(existsSync(join(f.agent, 'sessions')), false, "Plan and target changes do not publish history");
	await modal(page).locator('.migration-dialog-foot button').first().click();
	await category(page, 'rules');
	assert.equal(await modal(page).locator('.migration-select-all input').count(), 0, "Rules do not get bulk consent");
	assert.equal(await modal(page).locator('.migration-rule-consent').count(), 0, "Group selection never selects a rule");
	const mcpScan = await category(page, 'mcp');
	await candidate(page, item(mcpScan, "mcp", "fresh"), false);
	const scope = modal(page).locator('.migration-preview select').first();
	assert.equal(await scope.inputValue(), 'global', "Ordinary MCP defaults to the global configuration");
	const destinations = await scope.locator('option:not([disabled])').evaluateAll((els) => els.map((el) => el.value));
	assert.ok(destinations.includes('global'), "A global destination stays available");
	assert.ok(destinations.includes(f.project), "A trusted project destination is offered too");
});

test("offline first use, skip persistence, Settings entry, focus and all themes", options, async (t) => {
	const f = await fixture(t);
	const { page } = f;
	assert.equal(await page.locator("html").getAttribute("data-host"), "desktop");
	assert.equal(await modal(page).isVisible(), true);
	assert.equal(await modal(page).locator(".migration-invitation").count(), 0, "The wizard starts on the first category");
	assert.equal(await page.locator(".app").getAttribute("inert"), "");
	await page.keyboard.press("Tab");
	assert.equal(await page.evaluate(() => !!document.activeElement.closest("#migrationModal")), true);
	// A picked source folder joins the read-only scan without workspace registration.
	const workspacesBefore = await api(page, "/api/v1/workspaces");
	await category(page, "rules");
	await modal(page).locator(".migration-source-locations summary").click();
	await modal(page).locator("#migrationAddSourceFolder").click();
	await until(async () => (await modal(page).locator(".migration-source-locations").innerText()).includes(f.target),
		"picked source joins the scan list");
	assert.deepEqual(await page.evaluate(() => window.pickerPurposes), ["resource"]);
	assert.match(await modal(page).locator(".migration-source-locations").innerText(), /未登记|Unregistered/u,
		"An unregistered picked source stays marked as such");
	assert.deepEqual(await api(page, "/api/v1/workspaces"), workspacesBefore, "A source pick never registers a workspace");
	await modal(page).locator(".migration-dialog-foot button").last().click();
	await modal(page).waitFor({ state: "hidden" });
	assert.equal((await api(page, "/api/v1/desktop-onboarding")).status, "skipped");
	assert.equal(JSON.parse(await readFile(join(f.agent, "desktop-onboarding.json"), "utf8")).status, "skipped");
	await page.reload();
	await page.locator("#settingsButton").waitFor();
	assert.equal(await modal(page).isVisible(), false);
	assert.equal(await page.locator("#loginGate").isVisible(), false);
	const colors = {};
	for (const theme of ["light", "dark", "violet", "system"]) {
		await page.emulateMedia({ colorScheme: "dark" });
		await page.evaluate((theme) => localStorage.setItem("stepcode.theme", theme), theme);
		await page.reload();
		await settings(page);
		await newFlow(page);
		await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme,
			theme === "system" ? "dark" : theme);
		colors[theme] = await modal(page).locator(".migration-dialog").evaluate((el) => {
			const style = getComputedStyle(el);
			const rgb = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
			return { surface: rgb(style.backgroundColor), ink: rgb(style.color) };
		});
		assert.notDeepEqual(colors[theme].surface, colors[theme].ink, "Ink must not disappear into dialog surface");
		const brightness = (rgb) => rgb.reduce((sum, component) => sum + component);
		assert.ok(Math.abs(brightness(colors[theme].surface) - brightness(colors[theme].ink)) > 300,
			`${theme} must maintain readable surface/ink separation`);
		await modal(page).screenshot({ path: join(f.temp, `migration-${theme}.png`) });
		await modal(page).locator(".migration-dialog-head button").click();
		assert.equal(await page.locator("#settingsView").getAttribute("inert"), null, "Closing restores Settings focusability");
		await page.locator("[data-settings-page=appearance]").click();
		await page.locator(`[data-theme-choice=${theme}]`).click();
		assert.equal(await page.evaluate(() => localStorage.getItem("stepcode.theme")), theme, "Existing Apply action persists theme");
		await page.locator("#settingsBack").click();
	}
	assert.notDeepEqual(colors.light, colors.dark);
	assert.deepEqual(colors.system, colors.dark, "System dark uses the same computed dialog palette");
});

test("scan and preview preserve sources/targets; an already configured MCP is not a redundant import", options, async (t) => {
	const f = await fixture(t);
	const { page } = f;
	const before = await readFile(join(f.config, "config.toml"), "utf8");
	const result = await scan(page);
	assert.ok(result.sources.some((source) => source.source === "claude-code"));
	assert.ok(result.sources.some((source) => source.source === "codex"));
	assert.ok(result.sessionSummary, "Session scans report their own totals");
	const filters = modal(page).locator(".migration-list-toolbar [aria-label] button");
	const sessionSources = [...new Set(result.candidates.filter((c) => c.kind === "sessions").map((c) => c.source))];
	await filters.nth(sessionSources.indexOf("codex") + 1).click();
	assert.equal(await modal(page).locator(`[data-candidate-id="${item(result, "sessions", result.candidates.find((c) => c.kind === "sessions" && c.source === "claude-code").name).id}"]`).count(), 0,
		"Source filter excludes other sources without mutating scan results");
	await filters.first().click();
	const mcpScan = await category(page, "mcp");
	assert.equal(item(mcpScan, "mcp", "existing").needsMigration, false, "An already configured server is not offered again");
	assert.equal(item(mcpScan, "mcp", "existing").readiness, "disabled");
	await candidate(page, item(mcpScan, "mcp", "existing"), false);
	await candidate(page, item(mcpScan, "mcp", "fresh"), false);
	const scope = modal(page).locator(".migration-preview .migration-target-details select, .migration-preview select").first();
	const destinations = await scope.locator("option:not([disabled])").evaluateAll((els) => els.map((el) => el.value));
	assert.ok(destinations.includes("global"), "MCP keeps a global destination");
	assert.ok(destinations.includes(f.project), "MCP also offers a trusted project destination");
	const ruleScan = await category(page, "rules");
	await candidate(page, item(ruleScan, "rules", "CLAUDE.md"), false);
	for (const path of [join(f.agent, "skills"), join(f.agent, "AGENTS.md"), join(f.target, "AGENTS.md"), join(f.agent, "sessions")]) {
		assert.equal(existsSync(path), false, "Scan/preview must not create resource targets");
	}
	assert.equal(await readFile(join(f.config, "config.toml"), "utf8"), before);
	assert.equal(await readFile(join(f.home, ".claude/CLAUDE.md"), "utf8"), ruleText);
	assert.equal(f.requests.filter(({ path }) => path === "/api/v1/migrations").length, 0);
});

test("explicit rule CREATE consent invalidates on edits; disabled MCP and session publication", options, async (t) => {
	const f = await fixture(t, { legacy: true });
	const { page } = f;
	await scan(page);
	const ruleScan = await category(page, "rules");
	const rule = await candidate(page, item(ruleScan, "rules", "CLAUDE.md"));
	assert.equal(rule.action, "create");
	assert.equal(existsSync(rule.target.path), false);
	// A reviewed rule needs no separate consent: the plan is submittable directly.
	await reviewButton(page).click();
	await modal(page).locator('.migration-final-plan').waitFor();
	await until(async () => await modal(page).locator('#migrationStartPlan').isEnabled(), "a previewed rule plan is submittable");
	await modal(page).locator('.migration-dialog-foot button').first().click();
	await modal(page).locator('.migration-list').waitFor();
	// A genuine Desktop resource pick must not register a workspace or switch the draft.
	const workspacesBefore = await api(page, "/api/v1/workspaces");
	const changed = await changePreview(page, () => modal(page).locator(".migration-preview > button").nth(0).click());
	assert.equal(changed.target.scope.cwd, f.target);
	assert.deepEqual(await page.evaluate(() => window.pickerPurposes), ["resource"]);
	assert.deepEqual(await api(page, "/api/v1/workspaces"), workspacesBefore);
	await changePreview(page, () => modal(page).locator(".migration-preview select").nth(1).selectOption("skip"));
	await changePreview(page, () => modal(page).locator(".migration-preview select").nth(1).selectOption("create"));
	const mcpScan = await category(page, "mcp");
	const mcp = await candidate(page, item(mcpScan, "mcp", "fresh"));
	assert.equal(mcp.target.scope.kind, "global");
	const sessionScan = await category(page, "sessions");
	const sourceSession = sessionScan.candidates.find((c) => c.kind === "sessions" && c.source === "claude-code");
	assert.ok(sourceSession, "Claude synthetic history must be discovered");
	const session = await candidate(page, sourceSession);
	assert.equal(session.target.scope.cwd, f.project, "An existing original workspace is reused without registration");
	const { plan, job } = await startJob(page);
	assert.equal(plan.items.length, 3);
	assert.equal(job.status, "completed");
	assert.equal(job.items.filter((item) => item.status === "imported").length, 3, "No false successful result");
	assert.equal(job.items.filter((item) => item.status === "skipped").length, 0);
	assert.equal(job.items.filter((item) => item.status === "failed").length, 0);
	assert.equal(await readFile(join(f.target, "AGENTS.md"), "utf8"), ruleText);
	assert.equal(existsSync(join(f.agent, "AGENTS.md")), false, "Resource picker did not write global rules");
	const servers = await api(page, "/api/v1/settings/mcp");
	assert.equal(JSON.stringify(servers).includes("fixture-never-start-new"), false, "Stored executable fields must not be returned to the browser");
	assert.ok(servers.servers.find((server) => server.name === "fresh")?.protectedFields.includes("command"));
	const configText = await readFile(join(f.config, "config.toml"), "utf8");
	const imported = parseToml(configText).mcp_servers;
	assert.equal(imported.fresh.command, "fixture-never-start-new");
	assert.equal(imported.fresh.enabled, false, "Imported MCP must never connect");
	assert.equal(imported.existing.enabled, false, "Existing MCP must remain disabled");
	assert.equal(job.items.find((item) => item.kind === "mcp").activation, "disabled");
	const published = job.items.find((item) => item.kind === "sessions");
	const persisted = await readFile(published.actualTarget.path, "utf8");
	assert.match(persisted, /Synthetic historical question/u);
	assert.match(persisted, /Synthetic historical answer/u);
	assert.equal(await readFile(join(f.home, ".claude/CLAUDE.md"), "utf8"), ruleText);
	await modal(page).locator(".migration-dialog-foot button").last().click();
	await modal(page).waitFor({ state: "hidden" });
	assert.equal((await api(page, "/api/v1/desktop-onboarding")).status, "completed");
	await page.reload();
	await page.locator("#settingsButton").waitFor();
	assert.equal(await modal(page).isVisible(), false, "Finished onboarding remains finished after refresh");
	await settings(page);
	await page.locator("#migrationPage > .migration-history > .migration-history-row button").first().waitFor();
	const legacyBefore = await readFile(f.legacyPath, "utf8");
	assert.notEqual(job.id, f.legacyId, "The unified job list never adopts the legacy record's identity");
	await page.locator("#migrationPage > .migration-history > .migration-history-row button").first().click();
	await modal(page).locator(".migration-job").waitFor();
	const open = modal(page).locator(".migration-job-item").filter({ has: page.locator("h4", { hasText: published.name }) }).locator("button");
	await open.click();
	await modal(page).waitFor({ state: "hidden" });
	await until(async () => (await page.locator("#stream").textContent()).includes("Synthetic historical answer"), "result opens actual history");
	assert.equal(await page.locator("#settingsView").isVisible(), false);
	const afterOpen = await readFile(published.actualTarget.path, "utf8");
	assert.ok(afterOpen.startsWith(persisted), "Opening cannot rewrite imported history");
	const appended = afterOpen.slice(persisted.length).split("\n").filter(Boolean).map(line => JSON.parse(line));
	assert.ok(appended.every(entry => entry.type === "thinking_level_change" || (entry.type === "custom" && ["step.activity", "step.activity_capabilities"].includes(entry.customType))),
		`Opening may record resource discovery metadata, never a new chat message or tool execution: ${appended.map(entry => entry.type + ':' + (entry.customType ?? '')).join(', ')}`);
	assert.equal(await readFile(f.legacyPath, "utf8"), legacyBefore, "Viewing does not rewrite legacy journal");
});

test("rule replace creates real backup; recovery preview is read-only and explicit restore restores original bytes", options, async (t) => {
	const f = await fixture(t, { existingRule: true });
	const { page } = f;
	const rulePath = join(f.agent, "AGENTS.md");
	const original = await readFile(rulePath, "utf8");
	await scan(page);
	const ruleScan = await category(page, "rules");
	await candidate(page, item(ruleScan, "rules", "CLAUDE.md"));
	const replacement = await changePreview(page, () => modal(page).locator(".migration-preview select").nth(1).selectOption("replace"));
	assert.equal(replacement.ruleImpact.backupRequired, true);
	assert.equal(await readFile(rulePath, "utf8"), original, "Replace preview must not mutate rules");
	const { job } = await startJob(page);
	assert.equal(job.items[0].status, "imported");
	assert.ok(job.items[0].backupId, "Replacement result identifies backup");
	assert.equal(await readFile(rulePath, "utf8"), ruleText);
	const recovery = await responseFor(page, "/api/v1/migrations/recoveries/preview", () =>
		modal(page).locator(".migration-job-item button").click());
	await modal(page).locator(".migration-recovery").waitFor();
	assert.equal(recovery.restoredText, original, "Backup contains original file bytes");
	assert.equal(await readFile(rulePath, "utf8"), ruleText, "Recovery preview is read-only");
	const panel = modal(page).locator(".migration-recovery");
	assert.equal(await panel.locator("button").isDisabled(), true, "Recovery requires explicit consent");
	assert.equal(await page.evaluate(() => !!document.activeElement.closest(".migration-recovery")), true);
	await panel.locator("input").check();
	await responseFor(page, "/api/v1/migrations/recoveries/apply", () => panel.locator("button").click());
	await panel.waitFor({ state: "hidden" });
	assert.equal(await readFile(rulePath, "utf8"), original);
	assert.equal(await readFile(join(f.home, ".claude/CLAUDE.md"), "utf8"), ruleText);
	assert.equal((await api(page, `/api/v1/migrations/${job.id}`)).items[0].status, "imported",
		"Restore must not falsify the original import outcome");
});
