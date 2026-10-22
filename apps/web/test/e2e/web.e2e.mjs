/**
 * Browser end-to-end tests for the workspace, file-tree and file-preview UI.
 *
 * Drives a real headless Chrome over the DevTools protocol against a real
 * server process, so it covers what the unit tests cannot: the launch-link
 * sign-in, lazy tree loading, the preview panel, and the workspace dialog.
 *
 * No real model credentials are needed: message tests use a local mock provider. Chrome is
 * located through CHROME_PATH or the usual install locations; without one the
 * suite is skipped rather than failed.
 */

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { createServer as createHttpServer } from "node:http"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { clarificationCompletion } from "./clarification-provider.mjs"

const webRoot = fileURLToPath(new URL("../..", import.meta.url))

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
]
const chromePath = CHROME_CANDIDATES.find(
  (candidate) => candidate && existsSync(candidate),
)
const skip = chromePath
  ? false
  : "no Chrome found; set CHROME_PATH to run the browser e2e suite"

/**
 * The system folder chooser cannot be clicked by a test, so a stand-in with
 * the real helper's name goes first on the server's PATH. It answers from
 * PICKER_RESULT_FILE ("cancel", "fail", or a path) and records its argv, so
 * the real spawn, argument passing and output parsing are still exercised.
 * Windows would need a fake powershell.exe; the native case is skipped there.
 */
const nativePickerSkip =
  skip ||
  (process.platform === "win32"
    ? "native picker stand-in needs a POSIX shell"
    : false)
const PICKER_HELPER = process.platform === "darwin" ? "osascript" : "zenity"
const PICKER_STANDIN = `#!/bin/sh
printf '%s\n' "$@" > "$PICKER_ARGS_FILE"
answer=$(cat "$PICKER_RESULT_FILE")
case "$answer" in
	cancel) echo "execution error: User canceled. (-128)" >&2; exit 1 ;;
	fail) echo "picker exploded" >&2; exit 2 ;;
	*) printf '%s\n' "$answer" ;;
esac
`

/** 1x1 transparent PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
)

async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** Collect a child's output and resolve once `pattern` appears in it. */
function waitForOutput(child, pattern, label) {
  let output = ""
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} did not become ready:\n${output}`)),
      30_000,
    )
    const onData = (chunk) => {
      output += chunk
      const match = pattern.exec(output)
      if (!match) return
      clearTimeout(timer)
      resolve(match)
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    child.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`${label} exited early (${code}):\n${output}`))
    })
  })
}

/** Minimal DevTools-protocol client: one browser socket, one attached page. */
class Browser {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.sessionId = undefined
    this.listeners = new Map()
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data)
      if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? [])
          listener(message.params)
        this.listeners.delete(message.method)
        return
      }
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
    })
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true })
      socket.addEventListener(
        "error",
        () => reject(new Error("could not connect to Chrome")),
        { once: true },
      )
    })
    const browser = new Browser(socket)
    const { targetId } = await browser.send(
      "Target.createTarget",
      { url: "about:blank" },
      false,
    )
    const attached = await browser.send(
      "Target.attachToTarget",
      { targetId, flatten: true },
      false,
    )
    browser.sessionId = attached.sessionId
    await browser.send("Page.enable")
    await browser.send("Runtime.enable")
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    return browser
  }

  send(method, params = {}, inPage = true) {
    const id = this.nextId++
    const message = {
      id,
      method,
      params,
      ...(inPage ? { sessionId: this.sessionId } : {}),
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify(message))
    })
  }

  /** Run an async function body in the page and return its JSON result. */
  async run(body) {
    const result = await this.send("Runtime.evaluate", {
      expression: `(async () => { ${PAGE_HELPERS}\n${body} })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      )
    }
    return result.result.value
  }

  /** Resolve on the next protocol event with this name. */
  once(method) {
    return new Promise((resolve) => {
      this.listeners.set(method, [
        ...(this.listeners.get(method) ?? []),
        resolve,
      ])
    })
  }

  /** Navigate and wait for the new document, not the one being replaced. */
  async goto(url) {
    const loaded = this.once("Page.loadEventFired")
    await this.send("Page.navigate", { url })
    await loaded
  }

  /** A real key chord, so the page's keydown handler sees genuine modifiers. */
  async chord(code, key, modifiers) {
    const event = {
      code,
      key,
      modifiers,
      windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
    }
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event })
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...event })
  }
}

/** Helpers evaluated in the page before every snippet. */
const PAGE_HELPERS = `
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const until = async (probe, label, timeout = 8000) => {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = await probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error("timed out waiting for " + label);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
};
const treeRows = () => $$("#fileTreeBody .file-row").map((row) => row.dataset.path);
const treeRow = (path) => $$("#fileTreeBody .file-row").find((row) => row.dataset.path === path);
const projects = () => $$("#projectGroups .project-group").map((group) => group.dataset.cwd);
const codeText = () => $$("#previewBody .code-line").map((line) => line.textContent).join("\\n");
const tabs = () => $$("#previewTabs .preview-tab").map((tab) => tab.textContent.trim());
`

const ALT_META = 1 | 4
const SHIFT_META = 8 | 4

test("session migration imports reviewed snapshots while sources continue writing", { skip }, async () => {
  const codexRoot = join(base, "migration-codex")
  const claudeRoot = join(base, "migration-claude")
  await mkdir(join(codexRoot, "sessions"), { recursive: true })
  await mkdir(join(codexRoot, "archived_sessions"), { recursive: true })
  await mkdir(claudeRoot, { recursive: true })
  const timestamp = "2026-10-22T00:00:00.000Z"
  const sourcePath = join(codexRoot, "sessions", "rollout-migration.jsonl")
  const input = [
    { type: "session_meta", timestamp, payload: { id: "migration-codex", cwd: workspace, cli_version: "0.163.0-alpha.11", history_mode: "paginated" } },
    { type: "response_item", timestamp, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Migration acceptance quokkabridge" }] } },
    { type: "response_item", timestamp, payload: { type: "function_call", call_id: "migration-tool", name: "exec_command", arguments: '{"cmd":"never execute this historical call"}' } },
  ].map(JSON.stringify).join("\n") + "\n"
  await writeFile(sourcePath, input)
  // An unreadable archive must not even produce a scan/parse failure by default.
  await writeFile(join(codexRoot, "archived_sessions", "rollout-archive.jsonl"), "{")
  await writeFile(join(claudeRoot, "migration-claude.jsonl"), [
    { type: "user", uuid: "cc-user", parentUuid: null, sessionId: "migration-claude", cwd: workspace, timestamp, message: { content: "Claude migration acceptance" } },
    { type: "assistant", uuid: "cc-assistant", parentUuid: "cc-user", sessionId: "migration-claude", timestamp, message: { content: [{ type: "text", text: "Historical CC reply" }] } },
  ].map(JSON.stringify).join("\n") + "\n")
  const scanned = await browser.run(`
    if ($("#settingsView").hidden) $("#settingsButton").click();
    await until(() => !$("#settingsView").hidden, "settings");
    $("[data-settings-page='migration']").click();
    await until(() => $("#importScan"), "migration page");
    $("#importCodexRoot").value = ${JSON.stringify(codexRoot)};
    $("#importCodexRoot").dispatchEvent(new Event("input"));
    $("#importClaudeRoot").value = ${JSON.stringify(claudeRoot)};
    $("#importClaudeRoot").dispatchEvent(new Event("input"));
    await new Promise(resolve => setTimeout(resolve, 50));
    const archived = $("#importIncludeArchived").checked;
    $("#importScan").click();
    await until(() => $$(".session-import-row").length === 2, "two active source sessions");
    return { archived, errors: !!$(".session-import-errors"), sources: $$(".session-import-row").map(row => row.dataset.importSource).sort() };
  `)
  assert.deepEqual(scanned, { archived: false, errors: false, sources: ["claude-code", "codex"] })
  await browser.run(`
    $("#importSelectAll").click();
    await until(() => !$("#importReviewSelected").disabled, "review enabled");
    $("#importReviewSelected").click();
    await until(() => !$("#importConfirm").disabled, "preview completion");
    return true;
  `)
  await browser.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: false,
  })
  try {
    const layout = await browser.run(`
      await new Promise(resolve => requestAnimationFrame(resolve));
      const content = $(".settings-content");
      const buttons = [$("#importReviewSelected"), $("#importConfirm")].map(node => node.getBoundingClientRect());
      return {
        contentWidth: content.getBoundingClientRect().width,
        overflowing: content.scrollWidth > content.clientWidth,
        buttonsFit: buttons.every(rect => rect.left >= 0 && rect.right <= innerWidth),
      };
    `)
    assert.ok(layout.contentWidth >= 280, JSON.stringify(layout))
    assert.equal(layout.overflowing, false)
    assert.equal(layout.buttonsFit, true)
  } finally {
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
    })
  }
  const updatedInput = input + [
    { type: "event_msg", timestamp, payload: { type: "token_count", info: {} } },
    { type: "response_item", timestamp, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Unreviewed source append" }] } },
  ].map(JSON.stringify).join("\n") + "\n"
  await writeFile(sourcePath, updatedInput)
  await browser.run(`
    $("#importConfirm").click();
    await until(() => $$(".session-import-result").length === 2, "completed imports");
    const jobs = await (await fetch("/api/v1/session-imports")).json();
    const job = jobs.jobs.find(job => job.results.length === 2);
    if (!job || job.results.some(result => result.status !== "imported")) throw new Error(JSON.stringify(jobs));
    window.migrationJob = job;
    return true;
  `)
  const imported = await browser.run(`
    const job = window.migrationJob;
    const sessions = (await (await fetch("/api/v1/sessions")).json()).sessions;
    const codex = sessions.find(session => job.results.some(result => result.sessionId === session.id) && session.name.startsWith("[codex]"));
    if (!codex) throw new Error("Codex import missing from native sessions");
    const snapshot = await (await fetch("/api/v1/sessions/" + codex.id)).json();
    if (!snapshot.entries.some(entry => entry.imported)) throw new Error("Missing source provenance");
    if (JSON.stringify(snapshot.entries).includes("Unreviewed source append")) throw new Error("Imported unreviewed content");
    const result = job.results.find(result => result.sessionId === codex.id);
    const buttons = $$(".session-import-result button");
    buttons[job.results.indexOf(result)].click();
    await until(() => $("#settingsView").hidden, "opened native import");
    await until(() => document.body.textContent.includes("Migration acceptance quokkabridge"), "imported history");
    return { id: codex.id, hasUnknown: !!$("[data-tool-state='unknown']") };
  `)
  assert.equal(imported.hasUnknown, true)
  assert.equal(await readFile(sourcePath, "utf8"), updatedInput)
  await browser.send("Page.reload")
  await browser.run(`await until(() => document.body.textContent.includes("Migration acceptance quokkabridge"), "reopened after refresh");`)
  const search = await browser.run(`
    const result = await (await fetch("/api/v1/search?q=quokkabridge")).json();
    return result.hits.some(hit => hit.sessionId === ${JSON.stringify(imported.id)});
  `)
  assert.equal(search, true)
})

let base
let workspace
let extra
let server
let chrome
let browser
let origin
let pickerResult
let authPath
let provider
/** Base URL of the stand-in provider, so a test can point a model provider at it. */
let providerUrl
let pickerArgs

before(async () => {
  if (skip) return
  base = await realpath(await mkdtemp(join(tmpdir(), "stepcode-web-e2e-")))
  workspace = join(base, "project")
  extra = join(base, "second-project")
  await mkdir(join(workspace, "src", "deep"), { recursive: true })
  await mkdir(join(workspace, "docs"), { recursive: true })
  await mkdir(join(extra, "lib"), { recursive: true })
  await writeFile(
    join(workspace, "README.md"),
    "# Title\n\nSome **bold** text.\n",
  )
  await writeFile(
    join(workspace, "package.json"),
    '{\n  "name": "fixture",\n  "private": true\n}\n',
  )
  await writeFile(
    join(workspace, "src", "main.ts"),
    '// entry\nexport const answer = 42;\nconst name = "step";\n',
  )
  await writeFile(
    join(workspace, "src", "deep", "needle-file.ts"),
    "export {};\n",
  )
  await writeFile(join(workspace, "docs", "guide.md"), "guide\n")
  await writeFile(join(workspace, "logo.png"), PNG)
  await writeFile(join(workspace, "blob.bin"), Buffer.from([1, 0, 2, 0]))
  await writeFile(
    join(extra, "lib", "util.py"),
    "# util\ndef f():\n    return 1\n",
  )
  await writeFile(join(base, "outside.txt"), "outside\n")

  // A stored plan credential, so the login report and the settings section can
  // be asserted without touching the real credential file. The token is not
  // valid outside this fixture; message tests send it only to the local mock.
  const agentDir = join(base, "agent")
  authPath = join(base, "stepcode", "auth.json")
  await mkdir(agentDir, { recursive: true })
  await mkdir(dirname(authPath), { recursive: true })
  await writeFile(
    authPath,
    JSON.stringify({
      step: {
        type: "oauth",
        access: "e2e-not-a-real-token",
        refresh: "static",
        expires: Number.MAX_SAFE_INTEGER,
        profile: "step_plan",
        obtainedAt: "2026-01-01T00:00:00.000Z",
      },
    }),
  )

  const bin = join(base, "bin")
  await mkdir(bin)
  await writeFile(join(bin, PICKER_HELPER), PICKER_STANDIN)
  await chmod(join(bin, PICKER_HELPER), 0o755)
  // A stand-in for the provider, so the suite never reaches the real one: the
  // credential check and the model catalog are requests the host makes on its
  // own, and a test that let them out would depend on the network and on a real
  // token.
  const providerPort = await freePort()
  provider = createHttpServer((request, response) => {
    if (request.headers.authorization !== "Bearer e2e-not-a-real-token") {
      response.writeHead(401, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "bad token" }))
      return
    }
    if (request.url?.endsWith("/chat/completions")) {
      void clarificationCompletion(request, response);
      return;
    }
    const payload = request.url?.endsWith("/models")
      ? {
          data: [
            {
              id: "e2e-model-large",
              model_type: "大语言模型",
              max_input_tokens: 128000,
              enable_reason: true,
            },
            {
              id: "e2e-model-small",
              model_type: "大语言模型",
              max_input_tokens: 32000,
              enable_reason: false,
            },
          ],
        }
      : {}
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify(payload))
  })
  await new Promise((resolve) =>
    provider.listen(providerPort, "127.0.0.1", resolve),
  )
  providerUrl = `http://127.0.0.1:${providerPort}/v1`

  pickerResult = join(base, "picker-result")
  pickerArgs = join(base, "picker-args")
  await writeFile(pickerResult, "cancel")

  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: webRoot,
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: join(webRoot, "..", "..", "tsconfig.json"),
      STEPCODE_WEB_PORT: String(port),
      STEPCODE_WEB_CWD: workspace,
      STEP_CODING_AGENT_DIR: agentDir,
      // Plugins and marketplaces live under the storage root, which defaults to
      // $HOME/.stepcode. Point it inside the fixture so the suite neither reads
      // nor writes the developer's own plugins.
      STEPCODE_STORAGE_ROOT_DIR: join(base, "stepcode"),
      // The credential path is its own setting, not derived from the agent
      // directory, so a fixture credential has to point the host at it.
      STEPCODE_AUTH_PATH: authPath,
      // Both the credential check and model discovery read these, and the
      // stored profile would otherwise override them with the real region.
      STEP_PROVIDER_API_URL: providerUrl,
      STEP_PROVIDER_AUTH_URL: providerUrl,
      STEP_LOGIN_PROFILE_API_URL: providerUrl,
      STEP_LOGIN_PROFILE_AUTH_URL: providerUrl,
      STEPCODE_WEB_AUTH_SECRET: join(base, "web-auth-secret"),
      STEPCODE_WEB_DIRECTORY_PICKER: nativePickerSkip ? "browse" : "native",
      // Headless run: never open a browser, even when the developer's shell
      // exports the flag for `pnpm web`.
      STEPCODE_WEB_OPEN: "0",
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      PICKER_RESULT_FILE: pickerResult,
      PICKER_ARGS_FILE: pickerArgs,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout.setEncoding("utf8")
  server.stderr.setEncoding("utf8")
  const [, token] = await waitForOutput(
    server,
    /#token=([A-Za-z0-9_-]+)/u,
    "web server",
  )

  chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${join(base, "chrome-profile")}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      ...(process.env.CI ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  )
  chrome.stdout.setEncoding("utf8")
  chrome.stderr.setEncoding("utf8")
  const [, endpoint] = await waitForOutput(
    chrome,
    /DevTools listening on (ws:\/\/\S+)/u,
    "Chrome",
  )
  browser = await Browser.connect(endpoint)

  // Before signing in, the API must refuse the page.
  // A different path, so the launch link below is a real navigation rather
  // than a same-document hash change.
  await browser.goto(`${origin}/healthz`)
  assert.equal(
    await browser.run(`return (await fetch("/api/v1/workspaces")).status;`),
    401,
  )
  await browser.goto(`${origin}/#token=${token}`)
  await browser.run(
    `await until(() => !location.hash, "launch token exchange");`,
  )
})

after(async () => {
  if (skip) return
  browser?.socket.close()
  await new Promise((resolve) => provider?.close(resolve))
  for (const child of [chrome, server]) {
    if (!child || child.exitCode !== null) continue
    child.kill("SIGTERM")
    await new Promise((resolve) => child.once("exit", resolve))
  }
  if (base) await rm(base, { recursive: true, force: true, maxRetries: 3 })
})

test(
  "the launch link signs the browser in and is removed from the address bar",
  { skip },
  async () => {
    const state = await browser.run(`
		return {
			href: location.href,
			status: (await fetch("/api/v1/workspaces")).status,
			banner: $("#authBanner").hidden,
			// Wait for the real name: before bootstrap the control carries a
			// neutral placeholder, and reading it early would assert on that.
			workspace: await until(
				() => (($("#workspaceButtonName").textContent === "project") ? "project" : ""),
				"workspace name",
			),
		};
	`)
    assert.equal(state.href, `${origin}/`)
    assert.equal(state.status, 200)
    assert.equal(state.banner, true)
    assert.equal(state.workspace, "project")
  },
)

test(
  "the sidebar footer opens the settings view, which applies language and theme",
  { skip },
  async () => {
    const report = await browser.run(`
		const boot = await (await fetch("/api/v1/bootstrap")).json();
		const direct = await (await fetch("/api/v1/login")).json();
		return { boot, direct };
	`)
    // The stored profile is named, and the credential itself is nowhere in it.
    assert.equal(report.boot.login.source, "auth.json")
    assert.equal(report.boot.login.provider, "step")
    assert.equal(report.boot.login.profile, "step_plan")
    assert.equal(report.boot.login.configured, true)
    assert.equal(report.boot.login.loginCommand, "step login")
    assert.equal(report.boot.login.planUrl, "https://platform.stepfun.com/step-plan")
    assert.equal(report.boot.login.path, authPath)
    assert.deepEqual(report.direct, report.boot.login)
    assert.equal(
      JSON.stringify(report).includes("e2e-not-a-real-token"),
      false,
      "no secret in the report",
    )

    // The footer holds the account, the remote-control placeholder and the gear.
    const footer = await browser.run(`
		$("#settingsButton").click();
		await until(() => !$("#settingsView").hidden, "settings view");
		return {
			gear: !!$("#settingsButton use[href='#i-cog']"),
			phone: !!$("#remoteControlButton use[href='#i-phone']"),
			remoteDisabled: $("#remoteControlButton").getAttribute("aria-disabled"),
			popover: !!$("#userPopover"),
			page: $("#settingsView [data-page]").dataset.page,
			account: !!$("#settingsAccountLabel"),
			legacy: !!$("#loginNote") || !!$("#loginCommand") || !!$(".user-popover-account"),
		};
	`)
    assert.equal(footer.gear, true)
    assert.equal(footer.phone, true)
    assert.equal(footer.remoteDisabled, "true")
    assert.equal(footer.popover, false, "the popover is gone")
    assert.equal(footer.page, "general")
    assert.equal(footer.account, false, "account settings no longer live on General")
    assert.equal(footer.legacy, false)

    const account = await browser.run(`
		$("[data-settings-page='account']").click();
		await until(() => $("#settingsAccountLabel"), "account page");
		await until(() => $$(".settings-account-channel").length === 4, "four sign-in methods");
		const result = {
			page: $("#settingsView [data-page]").dataset.page,
			label: $("#settingsAccountLabel").textContent,
			mark: !!$(".settings-account-logo use[href='#i-stepPlatform']"),
			channels: $$(".settings-account-channel").map((row) => row.dataset.loginProfile),
			logout: !!$("#logoutButton"),
			upgrade: $("#stepPlanLink").getAttribute("href"),
			firstPage: $(".settings-nav-item").dataset.settingsPage,
			logoutInIdentity: !!$(".settings-account-identity #logoutButton use[href='#i-accountLogout']"),
			loginIcon: !!$("#settingsAccountLogin use[href='#i-accountExternal']"),
			twoColumns: (() => {
				const rows = $$(".settings-account-channel").map((row) => row.getBoundingClientRect());
				return rows[0].y === rows[1].y && rows[2].y > rows[0].y && rows[2].y === rows[3].y;
			})(),
		};
		$("[data-settings-page='general']").click();
		await until(() => $("[data-language-choice='en-US']"), "general page");
		return result;
	`);
    assert.deepEqual(account, {
      page: "account", label: "Step Plan · 中国大陆", mark: true,
      channels: ["step_plan", "step_plan_oversea", "platform_cn", "platform_oversea"],
      logout: true,
      upgrade: "https://platform.stepfun.com/step-plan",
      firstPage: "account", logoutInIdentity: true, loginIcon: true, twoColumns: true,
    });

    // The account button opens the account menu above it, not the settings view.
    const menu = await browser.run(`
		$("#settingsBack").click();
		await until(() => $("#settingsView").hidden, "settings view to close");
		$("#userAccountButton").click();
		await until(() => $("#accountMenu"), "account menu");
		const opened = {
			expanded: $("#userAccountButton").getAttribute("aria-expanded"),
			settingsHidden: $("#settingsView").hidden,
			items: [...$("#accountMenu").querySelectorAll("[role=menuitem]")].map((item) => item.id),
			upgrade: $("#accountUpgradeButton").dataset.href,
			above: $("#accountMenu").getBoundingClientRect().bottom <= $("#userAccountButton").getBoundingClientRect().top,
		};
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await until(() => !$("#accountMenu"), "account menu to close");
		const expandedAfter = $("#userAccountButton").getAttribute("aria-expanded");
		// Log out asks in the app's own dialog; Escape cancels it and keeps the session.
		const nativeConfirm = window.confirm;
		let nativeAsked = false;
		window.confirm = () => { nativeAsked = true; return false; };
		$("#userAccountButton").click();
		await until(() => $("#accountLogoutButton"), "account menu again");
		$("#accountLogoutButton").click();
		await until(() => !$("#logoutDialog").hidden, "log-out dialog");
		const dialog = {
			menuClosed: !$("#accountMenu"),
			focused: document.activeElement?.id,
			buttons: [...$("#logoutDialog").querySelectorAll("footer button")].map((button) => button.textContent),
			nativeAsked,
		};
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await until(() => $("#logoutDialog").hidden, "log-out dialog to close");
		window.confirm = nativeConfirm;
		// Enter on a dialog button is that button's own; Enter on Cancel cancels.
		$("#settingsButton").click();
		await until(() => !$("#settingsView").hidden, "settings view for account");
		$("[data-settings-page='account']").click();
		await until(() => $("#logoutButton"), "settings log-out button");
		$("#logoutButton").click();
		await until(() => !$("#logoutDialog").hidden, "log-out dialog from settings");
		$("#logoutCancel").focus();
		$("#logoutCancel").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		$("#logoutCancel").click();
		await until(() => $("#logoutDialog").hidden, "log-out dialog to cancel");
		$("#settingsBack").click();
		await until(() => $("#settingsView").hidden, "settings view to close again");
		const stillIn = $("#loggedOutOverlay").hidden && (await fetch("/api/v1/login")).ok;
		// Back to the settings view for the steps below.
		$("#settingsButton").click();
		await until(() => !$("#settingsView").hidden, "settings view to reopen");
		return { ...opened, expandedAfter, dialog, stillIn };
	`)
    assert.deepEqual(menu, {
      expanded: "true",
      settingsHidden: true,
      items: ["accountUpgradeButton", "accountLogoutButton"],
      upgrade: "https://platform.stepfun.com/step-plan",
      above: true,
      expandedAfter: "false",
      dialog: { menuClosed: true, focused: "logoutConfirm", buttons: ["取消esc", "退出登录↵"], nativeAsked: false },
      stillIn: true,
    })

    // Language applies from the general page and is remembered.
    const language = await browser.run(`
		$("[data-language-choice='en-US']").click();
		await until(() => document.documentElement.lang === "en-US", "English");
		return { stored: localStorage.getItem("stepcode.locale"), nav: $("#settingsBack").textContent.trim() };
	`)
    assert.equal(language.stored, "en-US")
    assert.equal(language.nav, "Back to workspace")

    // Theme applies from the appearance page.
    const appearance = await browser.run(`
		$("[data-settings-page='appearance']").click();
		await until(() => $("#settingsView [data-page]").dataset.page === "appearance", "appearance page");
		$("[data-theme-choice='dark']").click();
		await until(() => document.documentElement.dataset.theme === "dark", "dark theme");
		return {
			stored: localStorage.getItem("stepcode.theme"),
			checked: $("[data-theme-choice='dark']").getAttribute("aria-pressed"),
		};
	`)
    assert.equal(appearance.stored, "dark")
    assert.equal(appearance.checked, "true")

    // Escape leaves the settings view; the workspace is interactive again.
    const closed = await browser.run(`
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await until(() => $("#settingsView").hidden, "settings view to close");
		const hidden = $("#settingsView").hidden;
		$("#settingsButton").click();
		await until(() => !$("#settingsView").hidden, "settings view to reopen");
		return { hidden, page: $("#settingsView [data-page]").dataset.page };
	`)
    assert.equal(closed.hidden, true)
    assert.equal(closed.page, "general", "reopening starts on the first page")

    // Leave the suite in the state it found, since the browser is shared.
    const restored = await browser.run(`
		$("[data-settings-page='appearance']").click();
		await until(() => $("#settingsView [data-page]").dataset.page === "appearance", "appearance page");
		$("[data-theme-choice='system']").click();
		$("[data-settings-page='general']").click();
		await until(() => $("#settingsView [data-page]").dataset.page === "general", "general page");
		$("[data-language-choice='zh-CN']").click();
		await until(() => document.documentElement.lang === "zh-CN", "Chinese");
		$("#settingsBack").click();
		await until(() => $("#settingsView").hidden, "settings view to close");
		return localStorage.getItem("stepcode.theme");
	`)
    assert.equal(restored, "system")
  },
)

test(
  "the settings pages manage MCP servers, plugins and skills through the host",
  { skip },
  async () => {
    const created = await browser.run(`
		const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const bad = await post("/api/v1/settings/mcp", { name: "bad__name", config: { command: "node" } });
		const added = await post("/api/v1/settings/mcp", { name: "e2e-files", config: { command: "node", args: ["server.js"] } });
		const list = await (await fetch("/api/v1/settings/mcp")).json();
		return {
			bad: bad.status,
			added: added.status,
			server: list.servers.find((server) => server.name === "e2e-files"),
		};
	`)
    assert.equal(created.bad, 400, "'__' is reserved for plugin servers")
    assert.equal(created.added, 201)
    assert.equal(created.server.source, "user")
    assert.equal(created.server.transport, "stdio")
    assert.equal(created.server.enabled, true)

    // The MCP page lists it, the switch writes config.toml, and delete removes it.
    const managed = await browser.run(`
		$("#settingsButton").click();
		await until(() => !$("#settingsView").hidden, "settings view");
		$("[data-settings-page='mcp']").click();
		await until(() => $("[data-mcp-server='e2e-files']"), "the server row");
		$("[data-mcp-server='e2e-files'] [role='switch']").click();
		await until(async () => (await (await fetch("/api/v1/settings/mcp")).json()).servers.find((s) => s.name === "e2e-files")?.enabled === false, "the server switched off");
		const config = await (await fetch("/api/v1/settings/mcp")).json();
		window.confirm = () => true;
		$("[data-mcp-server='e2e-files'] button[aria-label='删除']").click();
		await until(() => !$("[data-mcp-server='e2e-files']"), "the server row to go");
		const after = await (await fetch("/api/v1/settings/mcp")).json();
		return {
			off: config.servers.find((s) => s.name === "e2e-files").enabled,
			gone: !after.servers.some((server) => server.name === "e2e-files"),
		};
	`)
    assert.equal(managed.off, false)
    assert.equal(managed.gone, true)

    // Creating a skill writes SKILL.md, the switch writes the skills pattern, delete removes the folder.
    const skills = await browser.run(`
		const post = (body) => fetch("/api/v1/settings/skills", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const created = await post({ name: "e2e-notes", description: "Write release notes", instructions: "Steps." });
		$("[data-settings-page='skills']").click();
		await until(() => $("[data-skill='e2e-notes']"), "the skill row");
		const listed = await (await fetch("/api/v1/settings/skills")).json();
		const skill = listed.skills.find((entry) => entry.name === "e2e-notes");
		$("[data-skill='e2e-notes'] [role='switch']").click();
		await until(async () => (await (await fetch("/api/v1/settings/skills")).json()).skills.find((s) => s.name === "e2e-notes")?.enabled === false, "the skill switched off");
		window.confirm = () => true;
		$("[data-skill='e2e-notes'] button[aria-label='删除']").click();
		await until(() => !$("[data-skill='e2e-notes']"), "the skill row to go");
		return { created: created.status, deletable: skill.deletable, location: skill.location };
	`)
    assert.equal(skills.created, 201)
    assert.equal(skills.deletable, true)
    // `~` when the host can shorten it, an absolute path otherwise.
    assert.ok(
      skills.location.startsWith("~/") || skills.location.includes("/skills/e2e-notes/SKILL.md"),
      `unexpected skill location: ${skills.location}`,
    )

    // The plugin page lists the built-in marketplace and says so when nothing is installed.
    const plugins = await browser.run(`
		$("[data-settings-page='plugins']").click();
		await until(() => $("[data-settings-page='plugins']").getAttribute("aria-current") === "page", "plugins page");
		// The sources tab lists the marketplaces the host resolved.
		const tab = $$("#settingsView .settings-tabs button").find((button) => button.textContent.includes("市场来源"));
		tab.click();
		await until(() => $("[data-marketplace='builtin']"), "the built-in marketplace row");
		const catalog = await (await fetch("/api/v1/settings/plugins")).json();
		return {
			marketplaces: catalog.marketplaces.map((entry) => entry.name),
			installed: catalog.installed.length,
			builtinKind: $("[data-marketplace='builtin']").textContent.includes("内置"),
		};
	`)
    assert.ok(plugins.marketplaces.includes("builtin"), "the built-in marketplace is listed")
    assert.equal(plugins.installed, 0)
    assert.equal(plugins.builtinKind, true)
  },
)

test(
  "the models page manages custom providers and can fetch a provider's models",
  { skip },
  async () => {
    // Create through the host, then confirm the page lists it: the same shape the
    // MCP case above uses, so the test drives real state rather than the form's
    // controlled inputs, which a non-bubbling event does not reach.
    const created = await browser.run(`
		const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const reserved = await post("/api/v1/settings/models", { id: "step", baseUrl: "https://x.example/v1", api: "openai-completions" });
		const bad = await post("/api/v1/settings/models", { id: "e2e-gw", baseUrl: "not a url", api: "openai-completions" });
		const added = await post("/api/v1/settings/models", {
			id: "e2e-gw",
			name: "E2E Gateway",
			baseUrl: ${JSON.stringify(providerUrl)},
			api: "openai-completions",
			apiKey: "e2e-not-a-real-token",
			models: [{ id: "e2e-model-large", contextWindow: 128000 }],
		});
		const list = await (await fetch("/api/v1/settings/models")).json();
		const provider = list.providers.find((entry) => entry.id === "e2e-gw");
		return { reserved: reserved.status, bad: bad.status, added: added.status, provider, count: list.providers.length };
	`)
    assert.equal(created.reserved, 400, "'step' is the account provider and cannot be redefined")
    assert.equal(created.bad, 400, "the address must be an http(s) URL")
    assert.equal(created.added, 201)
    assert.equal(created.provider.credential, "stored", "the typed key is stored in auth.json")
    assert.deepEqual(created.provider.models, [{ id: "e2e-model-large", contextWindow: 128000 }])

    // The page lists the row with its badge and key state.
    const listed = await browser.run(`
		$("[data-settings-page='models']").click();
		await until(() => $("[data-model-provider='e2e-gw']"), "the provider row");
		const row = $("[data-model-provider='e2e-gw']");
		return {
			name: row.textContent.includes("E2E Gateway"),
			custom: row.textContent.includes("自定义"),
			keyed: row.textContent.includes("已配置密钥"),
			addRow: !!$("#settingsModelNew"),
		};
	`)
    assert.equal(listed.name, true)
    assert.equal(listed.custom, true)
    assert.equal(listed.keyed, true)
    assert.equal(listed.addRow, true, "the add row sits at the bottom of the list")

    // Discovery asks the provider's endpoint, and the endpoint's refusal is reported.
    const discovered = await browser.run(`
		const post = (body) => fetch("/api/v1/settings/models/discover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const ok = await (await post({ baseUrl: ${JSON.stringify(providerUrl)}, api: "openai-completions", apiKey: "e2e-not-a-real-token" })).json();
		const wrongKey = await post({ baseUrl: ${JSON.stringify(providerUrl)}, api: "openai-completions", apiKey: "nope" });
		const unsupported = await post({ baseUrl: ${JSON.stringify(providerUrl)}, api: "google-generative-ai" });
		return { ids: ok.models.map((model) => model.id), wrongKey: wrongKey.status, unsupported: unsupported.status };
	`)
    assert.deepEqual(discovered.ids, ["e2e-model-large", "e2e-model-small"])
    assert.equal(discovered.wrongKey, 502, "the endpoint said 401; the key is the thing to fix")
    assert.equal(discovered.unsupported, 400)

    // Delete removes the row and the stored key.
    const removed = await browser.run(`
		window.confirm = () => true;
		$("[data-model-provider='e2e-gw'] button[aria-label='删除']").click();
		await until(() => !$("[data-model-provider='e2e-gw']"), "the provider row to go");
		const after = await (await fetch("/api/v1/settings/models")).json();
		return { gone: !after.providers.some((entry) => entry.id === "e2e-gw") };
	`)
    assert.equal(removed.gone, true)
  },
)

test(
  "the file tree loads one level at a time and folders expand and collapse",
  { skip },
  async () => {
    await browser.chord("KeyP", "p", ALT_META)
    const top = await browser.run(`
		await until(() => $("#fileTree").classList.contains("open") && treeRows().length, "tree to open");
		return { name: $("#fileTreeName").textContent, rows: treeRows(), expanded: treeRow("src").getAttribute("aria-expanded") };
	`)
    assert.equal(top.name, "project")
    // Directories first, then files; nothing below the first level yet.
    assert.deepEqual(top.rows, [
      "docs",
      "src",
      "blob.bin",
      "logo.png",
      "package.json",
      "README.md",
    ])
    assert.equal(top.expanded, "false")

    const expanded = await browser.run(`
		treeRow("src").click();
		await until(() => treeRow("src/main.ts"), "src children");
		return { rows: treeRows(), expanded: treeRow("src").getAttribute("aria-expanded"), level: treeRow("src/main.ts").getAttribute("aria-level") };
	`)
    assert.deepEqual(expanded.rows, [
      "docs",
      "src",
      "src/deep",
      "src/main.ts",
      "blob.bin",
      "logo.png",
      "package.json",
      "README.md",
    ])
    assert.equal(expanded.expanded, "true")
    assert.equal(expanded.level, "2")

    const nested = await browser.run(`
		treeRow("src/deep").click();
		await until(() => treeRow("src/deep/needle-file.ts"), "nested children");
		treeRow("src").click();
		await until(() => !treeRow("src/main.ts"), "src to collapse");
		const collapsed = treeRows();
		// Re-opening restores the nested folder that was open inside it.
		treeRow("src").click();
		await until(() => treeRow("src/deep/needle-file.ts"), "nested state to return");
		return { collapsed, reopened: treeRows() };
	`)
    assert.deepEqual(nested.collapsed, [
      "docs",
      "src",
      "blob.bin",
      "logo.png",
      "package.json",
      "README.md",
    ])
    assert.ok(nested.reopened.includes("src/deep/needle-file.ts"))

    const keyboard = await browser.run(`
		treeRow("docs").focus();
		treeRow("docs").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		await until(() => treeRow("docs/guide.md"), "keyboard expand");
		const focusKept = document.activeElement.dataset.path;
		treeRow("docs").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
		await until(() => !treeRow("docs/guide.md"), "keyboard collapse");
		return { focusKept };
	`)
    assert.equal(keyboard.focusKept, "docs")
  },
)

test(
  "refresh picks up files created after the tree was loaded",
  { skip },
  async () => {
    await writeFile(
      join(workspace, "src", "added-later.ts"),
      "export const later = true;\n",
    )
    const rows = await browser.run(`
		$("#fileTreeRefresh").click();
		await until(() => treeRow("src/added-later.ts"), "new file after refresh");
		return treeRows();
	`)
    assert.ok(
      rows.includes("src/deep/needle-file.ts"),
      "expanded folders stay expanded across a refresh",
    )
  },
)

test(
  "clicking a file opens a highlighted, line-numbered source preview",
  { skip },
  async () => {
    const opened = await browser.run(`
		treeRow("src/main.ts").click();
		await until(() => $$("#previewBody .code-line").length, "code lines");
		const view = $("#previewBody .code-view");
		return {
			panel: !$("#previewPanel").hidden,
			shifted: $(".app").classList.contains("right-panel-open"),
			railPressed: $("[data-right-panel='files']").getAttribute("aria-pressed"),
			tabs: tabs(),
			path: $("#previewPath").textContent,
			code: codeText(),
			lineNumber: getComputedStyle($$(".code-line")[2], "::before").content,
			comment: $(".tok-comment")?.textContent,
			keywords: $$(".tok-keyword").map((node) => node.textContent),
			number: $(".tok-number")?.textContent,
			string: $(".tok-string")?.textContent,
			activeRow: $("#fileTreeBody .file-row.active")?.dataset.path,
			wrapped: view.classList.contains("wrap"),
		};
	`)
    assert.equal(opened.panel, true)
    assert.equal(opened.shifted, true)
    assert.equal(opened.railPressed, "true")
    assert.deepEqual(opened.tabs, ["main.ts"])
    assert.ok(opened.path.startsWith(`${workspace}/src/main.ts`), opened.path)
    assert.equal(
      opened.code,
      '// entry\nexport const answer = 42;\nconst name = "step";',
    )
    assert.match(opened.lineNumber, /counter\(line\)/)
    assert.equal(opened.comment, "// entry")
    assert.deepEqual(opened.keywords, ["export", "const", "const"])
    assert.equal(opened.number, "42")
    assert.equal(opened.string, '"step"')
    assert.equal(opened.activeRow, "src/main.ts")
    assert.equal(opened.wrapped, true)

    const toggled = await browser.run(`
		$("#previewWrap").click();
		const off = $("#previewBody .code-view").classList.contains("wrap");
		$("#previewWrap").click();
		return { off, on: $("#previewBody .code-view").classList.contains("wrap"), pressed: $("#previewWrap").getAttribute("aria-pressed") };
	`)
    assert.deepEqual(toggled, { off: false, on: true, pressed: "true" })
  },
)

test(
  "files open in tabs, and reload re-reads the file from disk",
  { skip },
  async () => {
    const two = await browser.run(`
		treeRow("package.json").click();
		await until(() => tabs().length === 2 && codeText().includes("fixture"), "second tab");
		return { tabs: tabs(), active: $(".preview-tab.active").textContent.trim(), key: $(".tok-key")?.textContent };
	`)
    assert.deepEqual(two.tabs, ["main.ts", "package.json"])
    assert.equal(two.active, "package.json")
    assert.equal(two.key, '"name"')

    // Opening an already-open file focuses its tab instead of duplicating it.
    const refocused = await browser.run(`
		treeRow("src/main.ts").click();
		await until(() => $(".preview-tab.active").textContent.trim() === "main.ts", "first tab to refocus");
		return tabs();
	`)
    assert.deepEqual(refocused, ["main.ts", "package.json"])

    await writeFile(
      join(workspace, "src", "main.ts"),
      "export const answer = 43;\n",
    )
    const reloaded = await browser.run(`
		$("#previewReload").click();
		await until(() => codeText().includes("43"), "reloaded content");
		return codeText();
	`)
    assert.equal(reloaded, "export const answer = 43;")

    const closed = await browser.run(`
		$(".preview-tab.active .preview-tab-close").click();
		await until(() => tabs().length === 1, "tab to close");
		return { tabs: tabs(), code: codeText(), panel: !$("#previewPanel").hidden };
	`)
    assert.deepEqual(closed.tabs, ["package.json"])
    assert.ok(closed.code.includes("fixture"))
    assert.equal(closed.panel, true)
  },
)

test(
  "markdown can be rendered, images are shown, and binaries are not dumped",
  { skip },
  async () => {
    const markdown = await browser.run(`
		treeRow("README.md").click();
		await until(() => !$("#previewMode").hidden && codeText().includes("# Title"), "markdown source");
		$("#previewMode").click();
		await until(() => $("#previewBody .preview-markdown"), "rendered markdown");
		return {
			heading: $("#previewBody .preview-markdown h2")?.textContent,
			bold: $("#previewBody .preview-markdown strong")?.textContent,
			wrapHidden: $("#previewWrap").hidden,
		};
	`)
    assert.deepEqual(markdown, {
      heading: "Title",
      bold: "bold",
      wrapHidden: true,
    })

    const image = await browser.run(`
		treeRow("logo.png").click();
		const img = await until(() => $("#previewBody img.preview-image"), "image element");
		await until(() => img.complete && img.naturalWidth > 0, "image to decode");
		return { width: img.naturalWidth, copyHidden: $("#previewCopy").hidden, modeHidden: $("#previewMode").hidden };
	`)
    assert.deepEqual(image, { width: 1, copyHidden: true, modeHidden: true })

    const binary = await browser.run(`
		treeRow("blob.bin").click();
		await until(() => $(".preview-tab.active").textContent.trim() === "blob.bin" && $("#previewBody .preview-message"), "binary placeholder");
		return { lines: $$("#previewBody .code-line").length, message: $("#previewBody .preview-message").textContent };
	`)
    assert.equal(binary.lines, 0)
    assert.ok(binary.message.length > 0)
  },
)

test(
  "the preview panel hides and returns without losing its tabs",
  { skip },
  async () => {
    await browser.chord("KeyB", "b", SHIFT_META)
    const hidden = await browser.run(`
		await until(() => $("#previewPanel").hidden, "panel to hide");
		const rail = $("[data-right-panel='files']");
		return { shifted: $(".app").classList.contains("right-panel-open"), reopen: Boolean(rail) && !rail.disabled, pressed: rail?.getAttribute("aria-pressed") };
	`)
    assert.deepEqual(hidden, { shifted: false, reopen: true, pressed: "false" })
    const shown = await browser.run(`
		$("[data-right-panel='files']").click();
		await until(() => !$("#previewPanel").hidden, "panel to return");
		return { tabs: tabs().length, shifted: $(".app").classList.contains("right-panel-open") };
	`)
    assert.deepEqual(shown, { tabs: 4, shifted: true })
  },
)

test(
  "search finds files in folders that were never expanded",
  { skip },
  async () => {
    const found = await browser.run(`
		// Start from a tree where the match's folder is collapsed.
		treeRow("src").click();
		await until(() => !treeRow("src/main.ts"), "src to collapse");
		const input = $("#fileTreeSearch");
		input.value = "NEEDLE";
		input.dispatchEvent(new Event("input"));
		await until(() => treeRow("src/deep/needle-file.ts"), "search result");
		const results = treeRows();
		const detail = treeRow("src/deep/needle-file.ts").querySelector(".file-detail").textContent;
		treeRow("src/deep/needle-file.ts").click();
		await until(() => $(".preview-tab.active").textContent.trim() === "needle-file.ts", "result to open");
		input.value = "zzz-no-such-file";
		input.dispatchEvent(new Event("input"));
		await until(() => !treeRows().length && $("#fileTreeBody .empty-list"), "empty result");
		// A folder result leaves search and reveals the folder in the tree.
		input.value = "deep";
		input.dispatchEvent(new Event("input"));
		await until(() => treeRow("src/deep"), "folder result");
		treeRow("src/deep").click();
		await until(() => !input.value && treeRow("src/deep/needle-file.ts") && treeRow("docs"), "folder to be revealed");
		return { results, detail, revealed: treeRow("src/deep").getAttribute("aria-expanded") };
	`)
    assert.deepEqual(found.results, ["src/deep/needle-file.ts"])
    assert.equal(found.detail, "src/deep")
    assert.equal(found.revealed, "true")
  },
)

test(
  "add workspace opens the system folder picker and registers the chosen folder",
  { skip: nativePickerSkip },
  async () => {
    const before = await browser.run(`
		$("#fileTreeBack").click();
		return { projects: projects(), tooltip: $("#addWorkspace + [role='tooltip']").textContent };
	`)
    assert.deepEqual(before.projects, [])
    assert.match(before.tooltip, /O$/)

    // Cancelling the dialog changes nothing and opens no in-page dialog.
    await writeFile(pickerResult, "cancel")
    await rm(pickerArgs, { force: true })
    await browser.chord("KeyO", "o", ALT_META)
    const cancelled = await browser.run(`
		await until(() => $("#addWorkspace").getAttribute("aria-busy") === "true", "picker request to start");
		await until(() => !$("#addWorkspace").hasAttribute("aria-busy"), "picker request to finish");
		return { projects: projects(), browser: !$("#workspaceBrowserModal").hidden };
	`)
    assert.deepEqual(cancelled, { projects: [], browser: false })
    const args = await readFile(pickerArgs, "utf8")
    // The dialog is titled in the page's language and starts in the current workspace.
    assert.ok(args.includes("选择工作区文件夹"), args)
    assert.ok(args.includes(workspace), args)

    await writeFile(pickerResult, `${extra}/`)
    const picked = await browser.run(`
		$("#addWorkspace").click();
		await until(() => projects().length === 1, "picked workspace in the sidebar");
		return {
			projects: projects(),
			name: $("#projectGroups .project-name").textContent,
			draft: $("#workspaceButtonName").textContent,
			browser: !$("#workspaceBrowserModal").hidden,
		};
	`)
    assert.deepEqual(picked, {
      projects: [extra],
      name: "second-project",
      draft: "second-project",
      browser: false,
    })
    assert.deepEqual(
      JSON.parse(
        await readFile(join(base, "agent", "web-workspaces.json"), "utf8"),
      ),
      {
        workspaces: [extra],
        removedWorkspaces: [],
      },
    )

    const removed = await browser.run(`
		$("#projectGroups .workspace-menu-button").click();
		await until(() => $("#workspaceMenu"), "workspace menu");
		$("#workspaceMenu .remove-workspace").click();
		await until(() => !$("#removeWorkspaceModal").hidden, "removal dialog");
		$("#removeWorkspaceConfirm").click();
		await until(() => !projects().length, "workspace to be removed");
		return projects();
	`)
    assert.deepEqual(removed, [])
  },
)

test(
  "a workspace can be added from the sidebar, survives a reload, and can be removed",
  { skip },
  async () => {
    await browser.run(
      `if ($("#fileTree").classList.contains("open")) $("#fileTreeBack").click();`,
    )
    // A broken system picker must not leave the button dead: it falls back to
    // the in-page browser. With the native picker disabled the button opens the
    // browser directly.
    await writeFile(pickerResult, "fail")
    const fallback = await browser.run(`
		$("#addWorkspace").click();
		await until(() => !$("#workspaceBrowserModal").hidden && $("#workspacePathInput").value, "in-page browser");
		return { toast: $("#errorToast").hidden ? "" : $("#errorToast").textContent };
	`)
    if (!nativePickerSkip) assert.match(fallback.toast, /picker exploded/)

    const added = await browser.run(`
		$("#workspaceParentButton").click();
		const row = await until(
			() => $$(".workspace-directory-item").find((item) => item.textContent.trim() === "second-project"),
			"sibling folder in the browser",
		);
		row.click();
		await until(() => $("#workspacePathInput").value.endsWith("second-project"), "folder to open");
		$("#workspaceBrowserConfirm").click();
		await until(() => projects().length === 1, "workspace in the sidebar");
		return {
			projects: projects(),
			name: $("#projectGroups .project-name").textContent,
			draft: $("#workspaceButtonName").textContent,
			empty: $("#projectGroups .project-sessions .empty-list")?.textContent.length > 0,
		};
	`)
    assert.deepEqual(added.projects, [extra])
    assert.equal(added.name, "second-project")
    assert.equal(added.draft, "second-project")
    assert.equal(added.empty, true)
    assert.deepEqual(
      JSON.parse(
        await readFile(join(base, "agent", "web-workspaces.json"), "utf8"),
      ),
      {
        workspaces: [extra],
        removedWorkspaces: [],
      },
    )

    await browser.goto(`${origin}/`)
    const reloaded = await browser.run(`
		await until(() => projects().length === 1, "workspace after reload");
		// Its tree is browsable even though it has no conversation yet.
		$("#projectGroups .tree-button").click();
		await until(() => treeRow("lib"), "second workspace tree");
		treeRow("lib").click();
		await until(() => treeRow("lib/util.py"), "second workspace children");
		treeRow("lib/util.py").click();
		await until(() => codeText().includes("def f"), "python preview");
		return { projects: projects(), comment: $(".tok-comment")?.textContent, keyword: $(".tok-keyword")?.textContent };
	`)
    assert.deepEqual(reloaded, {
      projects: [extra],
      comment: "# util",
      keyword: "def",
    })

    const removed = await browser.run(`
		$("#fileTreeBack").click();
		$("#projectGroups .workspace-menu-button").click();
		await until(() => $("#workspaceMenu"), "workspace menu");
		$("#workspaceMenu .remove-workspace").click();
		await until(() => !$("#removeWorkspaceModal").hidden, "removal dialog");
		$("#removeWorkspaceConfirm").click();
		await until(() => !projects().length, "workspace to be removed");
		return (await (await fetch("/api/v1/workspaces")).json()).workspaces.filter(workspace => !workspace.hidden);
	`)
    assert.deepEqual(removed, [])
    assert.ok(
      existsSync(join(extra, "lib", "util.py")),
      "removing a workspace must not delete files",
    )
  },
)

test(
  "file endpoints refuse unknown folders and paths outside the workspace",
  { skip },
  async () => {
    const statuses = await browser.run(`
		const status = async (endpoint, params) =>
			(await fetch("/api/v1/workspace/" + endpoint + "?" + new URLSearchParams(params))).status;
		const cwd = ${JSON.stringify(workspace)};
		return {
			known: await status("files", { cwd, path: "" }),
			// No longer registered, and no session ever ran there.
			unregistered: await status("files", { cwd: ${JSON.stringify(extra)}, path: "" }),
			parent: await status("files", { cwd: ${JSON.stringify(base)}, path: "" }),
			traversal: await status("file", { cwd, path: "../outside.txt" }),
			absolute: await status("file", { cwd, path: ${JSON.stringify(join(base, "outside.txt"))} }),
			rawText: await status("raw", { cwd, path: "README.md" }),
			rawImage: await status("raw", { cwd, path: "logo.png" }),
		};
	`)
    assert.deepEqual(statuses, {
      known: 200,
      unregistered: 403,
      parent: 403,
      traversal: 400,
      absolute: 400,
      rawText: 415,
      rawImage: 200,
    })
  },
)

test("clarification pages restore after reload, preserve drafts and auto-submit the last answer", { skip }, async () => {
  const id = await browser.run(`
    const session = await (await fetch("/api/v1/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: ${JSON.stringify(workspace)} }) })).json();
    await fetch("/api/v1/sessions/" + session.id + "/policy", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset: "approve-for-me" }) });
    await fetch("/api/v1/sessions/" + session.id + "/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "clarification fixture" }) });
    await until(async () => {
      const snapshot = await (await fetch("/api/v1/sessions/" + session.id)).json();
      if (snapshot.status === "completed" || snapshot.status === "failed") throw new Error(JSON.stringify(snapshot));
      return snapshot.pendingClarifications?.length;
    }, "pending clarification");
    return session.id;
  `);
  await browser.goto(`${origin}/`);
  await browser.run(`
    const row = await until(() => $("[data-session-id='${id}']"), "session row"); row.click();
    await until(() => !$(".clarification-panel").hidden, "restored questions");
  `);
  const answered = await browser.run(`
    const page = () => $(".clarification-page").textContent.trim();
    const first = page();
    $("[aria-label='下一题']").click();
    await until(() => page() === "2 of 3", "page 2");
    $(".clarification-custom button").click();
    const editor = await until(() => $(".clarification-custom textarea"), "custom editor");
    editor.value = "自定义范围"; editor.dispatchEvent(new Event("input"));
    $("[aria-label='上一题']").click();
    await until(() => page() === "1 of 3", "page 1");
    $(".clarification-option").click();
    await until(() => page() === "2 of 3", "advance");
    const draft = $(".clarification-custom button").textContent;
    $(".clarification-custom button").click();
    await until(() => $(".clarification-custom textarea"), "custom editor again");
    const text = $(".clarification-custom textarea");
    text.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }));
    const imePage = page();
    text.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => page() === "3 of 3", "last page");
    let replies = 0;
    const original = window.fetch;
    window.fetch = (...args) => { if (String(args[0]).includes("/clarifications/response")) replies++; return original(...args); };
    const choice = $(".clarification-option"); choice.click(); choice.click();
    await until(() => $(".clarification-panel").hidden, "automatic submission");
    window.fetch = original;
    await until(async () => (await (await fetch("/api/v1/sessions/${id}")).json()).status === "completed", "agent resume and write");
    return { first, draft, imePage, replies };
  `);
  assert.deepEqual(answered, { first: "1 of 3", draft: "自定义范围", imePage: "2 of 3", replies: 1 });
  if (!existsSync(join(workspace, "clarification-result.txt"))) {
    assert.fail(JSON.stringify(await browser.run(`return await (await fetch("/api/v1/sessions/${id}")).json();`)));
  }
  const content = await readFile(join(workspace, "clarification-result.txt"), "utf8");
  assert.match(content, /answer: main/);
  assert.match(content, /answer: 自定义范围\nsource: freeform/);
  assert.match(content, /answer: key/);
});

test("clarification close cancels the pending tool and a single freeform answer auto-sends", { skip }, async () => {
  await browser.run(`
    const active = $(".session-row.active").dataset.sessionId;
    await fetch("/api/v1/sessions/" + active + "/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "clarification fixture again" }) });
    await until(() => !$(".clarification-panel").hidden, "new questions");
    $("[aria-label='关闭问题']").click();
    await until(() => $(".clarification-panel").hidden, "cancelled card");
    await until(async () => (await (await fetch("/api/v1/sessions/" + active)).json()).status === "completed", "cancelled turn settles");
    await fetch("/api/v1/sessions/" + active + "/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "freeform-only" }) });
    await until(() => !$(".clarification-panel").hidden && $(".clarification-custom textarea"), "freeform-only question");
    const editor = $(".clarification-custom textarea"); editor.value = "single answer"; editor.dispatchEvent(new Event("input"));
    await until(() => !$(".clarification-confirm").disabled, "custom input update");
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => $(".clarification-panel").hidden, "single automatic send");
    await until(async () => (await (await fetch("/api/v1/sessions/" + active)).json()).status === "completed", "single turn settles");
  `);
});

test("paging ahead never submits unanswered questions, and failed auto-send can retry", { skip }, async () => {
  const result = await browser.run(`
    const active = $(".session-row.active").dataset.sessionId;
    await fetch("/api/v1/sessions/" + active + "/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "clarification fixture retry" }) });
    await until(() => !$(".clarification-panel").hidden, "questions");
    const page = () => $(".clarification-page").textContent.trim();
    $("[aria-label='下一题']").click(); await until(() => page() === "2 of 3", "second");
    $("[aria-label='下一题']").click(); await until(() => page() === "3 of 3", "third");
    $(".clarification-option").click(); await until(() => page() === "1 of 3", "first unanswered");
    const pending = (await (await fetch("/api/v1/sessions/" + active)).json()).pendingClarifications.length;
    $(".clarification-skip").click(); await until(() => page() === "2 of 3", "skip advances");
    const original = window.fetch; let attempts = 0;
    window.fetch = (...args) => {
      if (String(args[0]).includes("/clarifications/response") && ++attempts === 1) return Promise.resolve(new Response(JSON.stringify({ error: "fixture retry" }), { status: 500, headers: { "content-type": "application/json" } }));
      return original(...args);
    };
    $(".clarification-option").click();
    await until(() => !$(".clarification-confirm").disabled && $("#errorToast").textContent.includes("fixture retry"), "retryable failure");
    const kept = !$(".clarification-panel").hidden;
    $(".clarification-confirm").click(); await until(() => $(".clarification-panel").hidden, "retry succeeds");
    window.fetch = original;
    await until(async () => (await (await fetch("/api/v1/sessions/" + active)).json()).status === "completed", "turn settles");
    return { pending, kept, attempts };
  `);
  assert.deepEqual(result, { pending: 1, kept: true, attempts: 2 });
  assert.match(await readFile(join(workspace, "clarification-result.txt"), "utf8"), /source: skipped/);
});

test("approval cards show complete commands, restore on reload, and offer only deny/session allow", { skip }, async () => {
  const id = await browser.run(`
    const session = await (await fetch("/api/v1/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: ${JSON.stringify(workspace)} }) })).json();
    await fetch("/api/v1/sessions/" + session.id + "/policy", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset: "ask" }) });
    await fetch("/api/v1/sessions/" + session.id + "/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "approval-fixture" }) });
    await until(async () => (await (await fetch("/api/v1/sessions/" + session.id)).json()).pendingApprovals?.length, "pending command");
    return session.id;
  `);
  await browser.goto(`${origin}/`);
  const shown = await browser.run(`
    const row = await until(() => $("[data-session-id='${id}']"), "approval session"); row.click();
    const card = await until(() => $(".approval-content"), "restored approval");
    await until(() => !$(".approval-expand-row").hidden, "long command expand");
    const background = getComputedStyle($(".approval")).backgroundColor;
    const labels = $$(".approval-actions button").map(button => button.textContent.trim());
    const noLogs = !$(".approval").textContent.includes("Call:") && !$(".approval").textContent.includes("undefined") && !$(".approval").textContent.includes("Batch calls");
    const clippedHeight = card.clientHeight;
    $(".approval-expand").click(); await until(() => card.classList.contains("expanded"), "expanded command");
    const expandedHeight = card.clientHeight;
    const full = card.textContent.includes("# exact-end-of-command");
    $(".approval-expand").click(); await until(() => !card.classList.contains("expanded"), "collapse command");
    let replies = 0; const original = window.fetch;
    window.fetch = (...args) => { if (String(args[0]).includes("/approvals/decision")) replies++; return original(...args); };
    const allow = $(".approval [data-verdict='approve_for_session']"); allow.click(); allow.click();
    await until(async () => (await (await fetch("/api/v1/sessions/${id}")).json()).status === "completed", "allowed command settles");
    window.fetch = original;
    return { background, labels, noLogs, expanded: expandedHeight > clippedHeight, full, replies };
  `);
  assert.deepEqual(shown, { background: "rgb(255, 255, 255)", labels: ["拒绝", "本会话允许"], noLogs: true, expanded: true, full: true, replies: 1 });
  assert.match(await readFile(join(workspace, "approval-result.txt"), "utf8"), /approval command preview/);
  await browser.run(`
    await fetch("/api/v1/sessions/${id}/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "approval-fixture-remembered" }) });
    await until(async () => (await (await fetch("/api/v1/sessions/${id}")).json()).status === "completed" && $(".approval") === null, "later command reuses session grant");
  `);
  assert.match(await readFile(join(workspace, "approval-remembered.txt"), "utf8"), /approval command preview/);
});

test("denying an approval never executes the command", { skip }, async () => {
  const id = await browser.run(`
    const session = await (await fetch("/api/v1/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: ${JSON.stringify(workspace)} }) })).json();
    await fetch("/api/v1/sessions/" + session.id + "/policy", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset: "ask" }) });
    await fetch("/api/v1/sessions/" + session.id + "/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "approval-fixture-denied" }) });
    await until(async () => (await (await fetch("/api/v1/sessions/" + session.id)).json()).pendingApprovals?.length, "pending denied command");
    return session.id;
  `);
  await browser.goto(`${origin}/`);
  await browser.run(`
    const row = await until(() => $("[data-session-id='${id}']"), "denied session"); row.click();
    await until(() => $(".approval [data-verdict='deny']"), "deny button");
    $(".approval [data-verdict='deny']").click();
    await until(async () => (await (await fetch("/api/v1/sessions/${id}")).json()).status === "completed", "denied turn settles");
  `);
  assert.equal(existsSync(join(workspace, "approval-denied.txt")), false);
});

test("Full Access needs the risk dialog: the host asks, cancel keeps the tier, a grant applies it", { skip }, async () => {
  const api = await browser.run(`
    const json = { "content-type": "application/json" };
    const session = await (await fetch("/api/v1/sessions", { method: "POST", headers: json, body: JSON.stringify({ cwd: ${JSON.stringify(workspace)} }) })).json();
    const base = "/api/v1/sessions/" + session.id;
    const before = (await (await fetch(base + "/policy", { method: "PATCH", headers: json, body: JSON.stringify({ preset: "ask" }) })).json());
    const asked = await (await fetch(base + "/policy", { method: "PATCH", headers: json, body: JSON.stringify({ preset: "full-access" }) })).json();
    const [question] = asked.pendingSelections ?? [];
    const busy = (await fetch(base + "/policy", { method: "PATCH", headers: json, body: JSON.stringify({ preset: "approve-for-me" }) })).status;
    const unoffered = (await fetch(base + "/selections/response", { method: "POST", headers: json, body: JSON.stringify({ id: question.id, value: "Yes" }) })).status;
    const cancelled = await (await fetch(base + "/selections/response", { method: "POST", headers: json, body: JSON.stringify({ id: question.id }) })).json();
    await fetch(base + "/policy", { method: "PATCH", headers: json, body: JSON.stringify({ preset: "full-access" }) });
    const again = (await (await fetch(base)).json()).pendingSelections[0];
    const granted = await (await fetch(base + "/selections/response", { method: "POST", headers: json, body: JSON.stringify({ id: again.id, value: again.options[0] }) })).json();
    return {
      presets: before.policies.map((preset) => preset.id),
      askedTier: asked.permissionPreset,
      askedStatus: asked.status,
      options: question.options.length,
      busy,
      unoffered,
      cancelled: [cancelled.permissionPreset, cancelled.pendingSelections.length],
      granted: [granted.permissionPreset, granted.pendingSelections.length, granted.status],
    };
  `);
  assert.deepEqual(api, {
    presets: ["ask", "approve-for-me", "full-access"],
    askedTier: "ask",
    askedStatus: "waiting",
    options: 3,
    busy: 400,
    unoffered: 404,
    cancelled: ["ask", 0],
    granted: ["full-access", 0, "idle"],
  });
  // The draft has no kernel yet: it asks the same question itself.
  await browser.goto(`${origin}/`);
  const draft = await browser.run(`
    (await until(() => $("#newSession"), "new chat")).click();
    await until(() => !$("#workspaceControl").hidden, "draft composer");
    // Above the card, not inside it. The queue dock sits between them but stays hidden while the queue is empty.
    let nextShown = $("#workspaceControl").nextElementSibling;
    while (nextShown?.hidden) nextShown = nextShown.nextElementSibling;
    const pillAboveCard = $(".queue-dock").hidden
      && nextShown === $(".composer-card")
      && $("#workspaceControl").getBoundingClientRect().bottom <= $(".composer-card").getBoundingClientRect().top;
    $("#workspaceButton").click();
    const popover = await until(() => $("#workspacePopover"), "workspace popover");
    // Below the pill when the list fits there, otherwise above; never off screen.
    const box = popover.getBoundingClientRect();
    const onScreen = box.top >= 0 && box.bottom <= innerHeight;
    document.body.click();
    await until(() => !$("#workspacePopover"), "popover closed");
    const option = (label) => $$("#policyPopover [role=option]").find((row) => row.textContent.includes(label));
    $("#policyTrigger").click();
    await until(() => $$("#policyPopover [role=option]").length === 3, "three presets");
    const labels = $$("#policyPopover .control-option-title").map((row) => row.textContent.trim());
    option("完全访问").click();
    await until(() => !$("#selectionDialog").hidden, "risk dialog");
    const title = $("#selectionDialogTitle").textContent;
    const rows = $$("#selectionDialog [role=option]").length;
    $("#selectionDialogCancel").click();
    await until(() => $("#selectionDialog").hidden, "dialog closed");
    const afterCancel = $("#policyLabel").textContent;
    $("#policyTrigger").click();
    (await until(() => option("完全访问"), "full access row")).click();
    await until(() => !$("#selectionDialog").hidden, "risk dialog again");
    $("#selectionDialogConfirm").click();
    await until(() => $("#selectionDialog").hidden, "dialog confirmed");
    return { pillAboveCard, onScreen, labels, title, rows, afterCancel, afterGrant: $("#policyLabel").textContent };
  `);
  assert.deepEqual(draft, {
    pillAboveCard: true,
    onScreen: true,
    labels: ["逐条确认", "自动审批", "完全访问"],
    title: "开启完全访问权限？",
    rows: 2,
    afterCancel: "逐条确认",
    afterGrant: "完全访问",
  });
});

test(
  "the workspace more menu starts hidden and toggles without folding the project",
  { skip },
  async () => {
    const toggled = await browser.run(`
		const project = await until(() => $("#projectGroups .project-group"), "workspace project");
		const button = project.querySelector(".workspace-menu-button");
		const initial = {
			rendered: !!$("#workspaceMenu"),
			inlineRemove: !!project.querySelector(".remove-workspace"),
			controls: button.getAttribute("aria-controls"),
			hasPopup: button.getAttribute("aria-haspopup"),
			expanded: button.getAttribute("aria-expanded"),
			label: button.getAttribute("aria-label"),
			toolbar: [...project.querySelectorAll(".project-actions button")].map((action) =>
				["workspace-menu-button", "tree-button", "new-project-session"].find((name) => action.classList.contains(name))),
			folded: project.classList.contains("folded"),
		};
		button.click();
		const menu = await until(() => $("#workspaceMenu"), "workspace menu to open");
		const opened = {
			role: menu.getAttribute("role"),
			removeRole: menu.querySelector(".remove-workspace").getAttribute("role"),
			expanded: button.getAttribute("aria-expanded"),
			folded: project.classList.contains("folded"),
		};
		button.click();
		await until(() => !$("#workspaceMenu"), "repeated click to close workspace menu");
		return { initial, opened, closed: { rendered: !!$("#workspaceMenu"), expanded: button.getAttribute("aria-expanded"), folded: project.classList.contains("folded") } };
	`)
    // The menu is rendered only while open.
    assert.equal(toggled.initial.rendered, false)
    assert.equal(toggled.initial.inlineRemove, false)
    assert.equal(toggled.initial.controls, "workspaceMenu")
    assert.equal(toggled.initial.hasPopup, "menu")
    assert.equal(toggled.initial.expanded, "false")
    assert.ok(toggled.initial.label?.trim(), "the more button has an accessible name")
    assert.deepEqual(toggled.initial.toolbar, ["workspace-menu-button", "tree-button", "new-project-session"])
    assert.equal(toggled.initial.folded, false)
    assert.deepEqual(toggled.opened, { role: "menu", removeRole: "menuitem", expanded: "true", folded: false })
    assert.deepEqual(toggled.closed, { rendered: false, expanded: "false", folded: false })
  },
)

test("icon hints open on hover, centered above their trigger, and the open menu's trigger shows none", { skip }, async () => {
  // A real pointer move, so CSS :hover applies; returns where the trigger's hint sits.
  const hover = async (selector) => {
    const box = await browser.run(`
		const rect = (await until(() => $(${JSON.stringify(selector)}), "hint trigger")).getBoundingClientRect();
		return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
	`)
    await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y })
    return browser.run(`
		const trigger = $(${JSON.stringify(selector)});
		const hint = trigger.nextElementSibling;
		const shown = await until(() => hint && getComputedStyle(hint).display !== "none" && hint, "hint to show");
		const a = trigger.getBoundingClientRect();
		const b = shown.getBoundingClientRect();
		return {
			role: shown.getAttribute("role"),
			text: shown.textContent,
			describedBy: trigger.getAttribute("aria-describedby") === shown.id,
			centerOffset: Math.round((b.left + b.width / 2) - (a.left + a.width / 2)),
			above: b.bottom <= a.top,
		};
	`)
  }
  const tree = await hover("#projectGroups .project-group .tree-button")
  assert.equal(tree.role, "tooltip")
  assert.ok(tree.text.trim(), "the tree button's hint has text")
  // Same words as the aria-label: not announced twice.
  assert.equal(tree.describedBy, false)
  assert.ok(Math.abs(tree.centerOffset) <= 1, `hint off center by ${tree.centerOffset}px`)
  assert.equal(tree.above, true)

  // Rich content: the footer's settings hint is an element, linked to its button.
  const settings = await hover("#settingsButton")
  assert.equal(settings.role, "tooltip")
  assert.equal(settings.describedBy, true)
  assert.equal(settings.above, true)

  // Settings icon buttons never had a visible hint before the Tooltip component.
  await browser.run(`
		$("#settingsButton").click();
		await until(() => !$("#settingsView").hidden, "settings view");
		$("[data-settings-page='mcp']").click();
	`)
  const refresh = await hover("#settingsView .settings-icon-action.bordered")
  assert.equal(refresh.role, "tooltip")
  assert.ok(Math.abs(refresh.centerOffset) <= 1, `hint off center by ${refresh.centerOffset}px`)
  assert.equal(refresh.above, true)
  await browser.run(`
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await until(() => $("#settingsView").hidden, "settings view to close");
	`)

  const open = await browser.run(`
		const button = $("#projectGroups .project-group .workspace-menu-button");
		const before = button.nextElementSibling?.getAttribute("role");
		button.click();
		await until(() => $("#workspaceMenu"), "workspace menu to open");
		const during = button.nextElementSibling?.getAttribute("role") ?? null;
		button.click();
		await until(() => !$("#workspaceMenu"), "workspace menu to close");
		return { before, during };
	`)
  assert.deepEqual(open, { before: "tooltip", during: null })
  await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 })
})

test(
  "sidebar menus follow their trigger; the workspace menu closes on outside click and Escape returns focus to its trigger",
  { skip },
  async () => {
    const outside = await browser.run(`
		const project = $("#projectGroups .project-group");
		const button = project.querySelector(".workspace-menu-button");
		button.click();
		await until(() => $("#workspaceMenu"), "workspace menu to open");
		document.body.click();
		await until(() => !$("#workspaceMenu"), "outside click to close workspace menu");
		return { hidden: !$("#workspaceMenu"), expanded: button.getAttribute("aria-expanded"), folded: project.classList.contains("folded") };
	`)
    assert.deepEqual(outside, { hidden: true, expanded: "false", folded: false })

    // Anchored to its trigger, the menu follows it, so scrolling no longer closes it.
    const anchored = await browser.run(`
		const button = $("#projectGroups .workspace-menu-button");
		button.click();
		const menu = await until(() => $("#workspaceMenu"), "workspace menu before scrolling");
		$(".conversation-list").dispatchEvent(new Event("scroll"));
		await new Promise((resolve) => requestAnimationFrame(resolve));
		const a = button.getBoundingClientRect();
		const b = menu.getBoundingClientRect();
		const result = { open: menu.isConnected, rightOffset: Math.round(b.right - a.right), gap: Math.round(b.top - a.bottom) };
		button.click();
		await until(() => !$("#workspaceMenu"), "workspace menu to close");
		return result;
	`)
    assert.deepEqual(anchored, { open: true, rightOffset: 0, gap: 4 })

    // The session row's more and tag buttons open their menus under themselves the same way.
    const rowMenus = await browser.run(`
		const row = await until(() => $(".session-row"), "a session row");
		const place = async (selector, menuId) => {
			const button = row.querySelector(selector);
			button.click();
			const menu = await until(() => $("#" + menuId), menuId + " to open");
			await new Promise((resolve) => requestAnimationFrame(resolve));
			const a = button.getBoundingClientRect();
			const b = menu.getBoundingClientRect();
			const placed = {
				// The grouped view renders the same session in a hidden row; only the visible row's menu exists.
				count: $$("#" + menuId).length,
				expanded: button.getAttribute("aria-expanded"),
				shown: a.width > 0,
				rightOffset: Math.round(b.right - a.right),
				gap: Math.round(b.top - a.bottom),
			};
			button.click();
			await until(() => !$("#" + menuId), menuId + " to close on a second click");
			return placed;
		};
		return { session: await place(".session-menu-button", "sessionMenu"), tag: await place(".session-tag-button", "tagPicker") };
	`)
    const placed = { count: 1, expanded: "true", shown: true, rightOffset: 0, gap: 4 }
    assert.deepEqual(rowMenus, { session: placed, tag: placed })

    await browser.run(`
		$("#projectGroups .workspace-menu-button").click();
		await until(() => $("#workspaceMenu"), "workspace menu to reopen");
		$("#workspaceMenu .remove-workspace").focus();
	`)
    await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
    await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
    const escaped = await browser.run(`
		const project = $("#projectGroups .project-group");
		const button = project.querySelector(".workspace-menu-button");
		await until(() => !$("#workspaceMenu") && document.activeElement === button, "Escape to close menu and return trigger focus");
		return {
			hidden: !$("#workspaceMenu"),
			expanded: button.getAttribute("aria-expanded"),
			focused: document.activeElement === button,
			folded: project.classList.contains("folded"),
			modalHidden: $("#removeWorkspaceModal").hidden,
		};
	`)
    assert.deepEqual(escaped, { hidden: true, expanded: "false", focused: true, folded: false, modalHidden: true })
  },
)

test(
  "the workspace more menu opens the accessible removal dialog without removing files or chats",
  { skip },
  async () => {
    const dialog = await browser.run(`
		const project = $("#projectGroups .project-group");
		const button = project.querySelector(".workspace-menu-button");
		const before = { projects: projects(), sessions: $$(".session-row").map((row) => row.dataset.sessionId) };
		button.focus(); button.click();
		await until(() => $("#workspaceMenu"), "workspace menu to open");
		$("#workspaceMenu .remove-workspace").click();
		await until(() => !$("#removeWorkspaceModal").hidden && document.activeElement === $("#removeWorkspaceCancel"), "removal dialog and cancel focus");
		const section = $("#removeWorkspaceModal [role='dialog']");
		const opened = {
			menuHidden: !$("#workspaceMenu"),
			expanded: button.getAttribute("aria-expanded"),
			modal: section.getAttribute("aria-modal"),
			labelledBy: section.getAttribute("aria-labelledby"),
			describedBy: section.getAttribute("aria-describedby"),
			title: $("#removeWorkspaceTitle").textContent,
			description: $("#removeWorkspaceDescription").textContent,
			focus: document.activeElement.id,
			folded: project.classList.contains("folded"),
		};
		// Opening and cancelling exercise semantics without confirming removal.
		$("#removeWorkspaceCancel").click();
		await until(() => $("#removeWorkspaceModal").hidden && document.activeElement === button, "cancel to restore trigger focus");
		return {
			before, opened,
			after: { projects: projects(), sessions: $$(".session-row").map((row) => row.dataset.sessionId) },
			cancelled: $("#removeWorkspaceModal").hidden,
			focused: document.activeElement === button,
		};
	`)
    assert.equal(dialog.opened.menuHidden, true)
    assert.equal(dialog.opened.expanded, "false")
    assert.equal(dialog.opened.modal, "true")
    assert.equal(dialog.opened.labelledBy, "removeWorkspaceTitle")
    assert.equal(dialog.opened.describedBy, "removeWorkspaceDescription")
    assert.equal(dialog.opened.title, "移除 project?")
    assert.match(dialog.opened.description, /文件和现有聊天不会被删除/)
    assert.equal(dialog.opened.focus, "removeWorkspaceCancel")
    assert.equal(dialog.opened.folded, false)
    assert.equal(dialog.cancelled, true)
    assert.equal(dialog.focused, true)
    assert.deepEqual(dialog.after, dialog.before)
    assert.ok(existsSync(join(workspace, "README.md")), "opening the removal dialog must not delete workspace files")
  },
)

test(
  "the workspace more menu stays visible in a narrow sidebar without folding the project",
  { skip },
  async () => {
    try {
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width: 720,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      })
      const narrow = await browser.run(`
			await new Promise((resolve) => requestAnimationFrame(resolve));
			const project = await until(() => $("#projectGroups .project-group"), "project in narrow sidebar");
			project.querySelector(".workspace-menu-button").click();
			const menu = await until(() => $("#workspaceMenu"), "workspace menu in narrow sidebar");
			await new Promise((resolve) => requestAnimationFrame(resolve));
			const box = menu.getBoundingClientRect();
			const remove = menu.querySelector(".remove-workspace");
			const item = remove.getBoundingClientRect();
			return {
				left: box.left,
				right: box.right,
				bottom: box.bottom,
				viewportWidth: innerWidth,
				viewportHeight: innerHeight,
				removeVisible: !remove.hidden && getComputedStyle(remove).visibility !== "hidden"
					&& item.width > 0 && item.height > 0
					&& item.left >= 0 && item.right <= innerWidth && item.top >= 0 && item.bottom <= innerHeight
					&& remove.contains(document.elementFromPoint(item.left + item.width / 2, item.top + item.height / 2)),
				folded: project.classList.contains("folded"),
			};
		`)
      assert.ok(narrow.left >= 8, `menu left ${narrow.left} must retain the viewport margin`)
      assert.ok(narrow.right <= narrow.viewportWidth, "the menu must fit within the viewport's right edge")
      assert.ok(narrow.bottom <= narrow.viewportHeight, "the menu must fit within the viewport's bottom edge")
      assert.equal(narrow.removeVisible, true, "the removal item must be visible and not covered")
      assert.equal(narrow.folded, false)
    } finally {
      try {
        await browser.run(`
			if ($("#workspaceMenu")) document.body.click();
			await until(() => !$("#workspaceMenu"), "narrow sidebar menu to close");
		`)
      } finally {
        await browser.send("Emulation.setDeviceMetricsOverride", {
          width: 1440,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        })
        await browser.run(`await new Promise((resolve) => requestAnimationFrame(resolve));`)
      }
    }
  },
)

test("workspaces with chats can be removed through the dialog, retained after reload and restored", { skip }, async () => {
  const before = await browser.run(`
    // Pick a conversation instead of assuming the page opened one: the removal must keep it.
    (await until(() => $("#projectGroups .session-row, #recentTasks .session-row"), "a conversation")).click();
    const session = await until(() => $(".session-row.active")?.dataset.sessionId, "open conversation");
    const project = $("#projectGroups .project-group");
    const button = project.querySelector(".workspace-menu-button");
    button.focus(); button.click();
    await until(() => $("#workspaceMenu"), "workspace menu");
    $("#workspaceMenu .remove-workspace").click();
    await until(() => !$("#removeWorkspaceModal").hidden, "removal dialog");
    const title = $("#removeWorkspaceTitle").textContent;
    const description = $("#removeWorkspaceDescription").textContent;
    const focused = document.activeElement.id;
    $("#removeWorkspaceCancel").click();
    await until(() => $("#removeWorkspaceModal").hidden && document.activeElement === button, "cancel and restore trigger focus");
    const restoredFocus = document.activeElement === button;
    button.click();
    await until(() => $("#workspaceMenu"), "workspace menu again");
    $("#workspaceMenu .remove-workspace").click();
    await until(() => !$("#removeWorkspaceModal").hidden, "reopen");
    return { session, title, description, focused, restoredFocus };
  `);
  assert.equal(before.title, "移除 project?");
  assert.match(before.description, /文件和现有聊天不会被删除/);
  assert.equal(before.focused, "removeWorkspaceCancel");
  assert.equal(before.restoredFocus, true);
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  const removed = await browser.run(`
    await until(() => $("#removeWorkspaceModal").hidden, "Escape closes dialog");
    const button = $("#projectGroups .workspace-menu-button");
    button.click();
    await until(() => $("#workspaceMenu"), "workspace menu for close");
    $("#workspaceMenu .remove-workspace").click();
    await until(() => !$("#removeWorkspaceModal").hidden, "reopen for close");
    $("#removeWorkspaceModal header button").click();
    await until(() => $("#removeWorkspaceModal").hidden, "close button");
    button.click();
    await until(() => $("#workspaceMenu"), "workspace menu for confirm");
    $("#workspaceMenu .remove-workspace").click();
    await until(() => !$("#removeWorkspaceModal").hidden, "reopen for confirm");
    const original = window.fetch; let calls = 0;
    window.fetch = (...args) => {
      if (String(args[0]).startsWith("/api/v1/workspaces?") && args[1]?.method === "DELETE") {
        calls++;
        if (calls === 1) return Promise.resolve(new Response(JSON.stringify({error:"removal fixture retry"}), {status:500, headers:{"content-type":"application/json"}}));
      }
      return original(...args);
    };
    $("#removeWorkspaceConfirm").click();
    await until(() => !$("#removeWorkspaceConfirm").disabled && $("#errorToast").textContent.includes("removal fixture retry"), "retryable failure");
    const kept = !$("#removeWorkspaceModal").hidden;
    $("#removeWorkspaceConfirm").click(); $("#removeWorkspaceConfirm").click();
    await until(() => $("#removeWorkspaceModal").hidden && !projects().length, "confirmed removal");
    window.fetch = original;
    return { calls, kept, session: $("#recentTasks .session-row.active")?.dataset.sessionId };
  `);
  assert.deepEqual(removed, { calls: 2, kept: true, session: before.session });
  await browser.goto(`${origin}/`);
  const reloaded = await browser.run(`
    await until(() => $("#recentTasks .session-row"), "retained chats after reload");
    return { projects: projects(), session: (await (await fetch("/api/v1/sessions/${before.session}")).json()).id };
  `);
  assert.deepEqual(reloaded, { projects: [], session: before.session });
  assert.ok(existsSync(join(workspace, "README.md")));
  await browser.run(`
    await fetch("/api/v1/workspaces", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({path:${JSON.stringify(workspace)}}) });
  `);
  await browser.goto(`${origin}/`);
  const restored = await browser.run(`
    await until(() => $("#projectGroups .session-row"), "project restored with chats");
    return projects();
  `);
  assert.deepEqual(restored, [workspace]);
});

test("conversation search finds message content written outside the page and opens the matching message", { skip }, async () => {
  // A session another process (the CLI) wrote: the host's index picks it up without a notification.
  const sessionId = "e2e-search-session"
  const now = new Date().toISOString()
  const lines = [
    { type: "session", version: 3, id: sessionId, timestamp: now, cwd: workspace },
    { type: "message", id: "e2e-user", parentId: null, timestamp: now, message: { role: "user", content: "where is the config loader", timestamp: Date.now() } },
    {
      type: "message",
      id: "e2e-answer",
      parentId: "e2e-user",
      timestamp: now,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The quokkaloader module reads config.toml once at startup." }],
        api: "openai-completions",
        provider: "e2e",
        model: "e2e",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    },
  ]
  const dir = join(base, "agent", "sessions", "--e2e-search--")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${sessionId}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n")
  // A subagent's transcript in the same folder: indexed, but neither searched nor listed.
  const child = [
    { type: "session", version: 3, id: "subagent-e2e", timestamp: now, cwd: workspace, origin: "subagent" },
    { ...lines[1], id: "e2e-child", message: { role: "user", content: "You are a subagent. Read the quokkaloader module.", timestamp: Date.now() } },
  ]
  await writeFile(join(dir, "subagent-e2e.jsonl"), child.map((line) => JSON.stringify(line)).join("\n") + "\n")

  const found = await browser.run(`
    $("#searchPlaceholder").click();
    await until(() => !$("#searchModal").hidden, "search modal");
    const input = $("#globalSearchInput");
    input.value = "quokkaloader";
    input.dispatchEvent(new Event("input"));
    const result = await until(() => $$(".search-result").find((row) => row.querySelector("mark")), "content hit");
    const marked = result.querySelector("mark").textContent;
    const entry = result.dataset.entryId;
    const all = $$(".search-result").length;
    result.click();
    await until(() => $("#searchModal").hidden, "modal to close");
    const message = await until(() => $('#streamInner [data-entry-id="e2e-answer"]'), "matching message");
    const stream = $("#stream").getBoundingClientRect();
    const box = message.getBoundingClientRect();
    return { marked, entry, all, visible: box.bottom > stream.top && box.top < stream.bottom };
  `)
  assert.deepEqual(found, { marked: "quokkaloader", entry: "e2e-answer", all: 1, visible: true })

  const rejected = await browser.run(`
    return (await fetch("/api/v1/search?q=abc&cwd=relative")).status;
  `)
  assert.equal(rejected, 400)

  const listed = await browser.run(`
    const { sessions } = await (await fetch("/api/v1/sessions")).json();
    return sessions.map((session) => session.id).filter((id) => id.startsWith("e2e-search") || id.startsWith("subagent-"));
  `)
  assert.deepEqual(listed, [sessionId])
})

test("the conversation locator rail jumps to a query and follows the viewport", { skip }, async () => {
  const sessionId = "e2e-nav-session"
  const now = new Date().toISOString()
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  const filler = "A conversation tall enough for the stream to scroll, so the locator rail has somewhere to jump. ".repeat(6)
  const user = (n) => ({
    type: "message", id: `e2e-nav-user-${n}`, parentId: n === 1 ? null : `e2e-nav-answer-${n - 1}`, timestamp: now,
    message: { role: "user", content: `question ${n}: ${filler}`, timestamp: Date.now() },
  })
  const answer = (n) => ({
    type: "message", id: `e2e-nav-answer-${n}`, parentId: `e2e-nav-user-${n}`, timestamp: now,
    message: {
      role: "assistant", content: [{ type: "text", text: `answer ${n}: ${filler}` }],
      api: "openai-completions", provider: "e2e", model: "e2e", usage, stopReason: "stop", timestamp: Date.now(),
    },
  })
  const lines = [{ type: "session", version: 3, id: sessionId, timestamp: now, cwd: workspace }]
  for (let n = 1; n <= 5; n++) {
    lines.push(user(n))
    lines.push(answer(n))
  }
  const dir = join(base, "agent", "sessions", "--e2e-nav--")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${sessionId}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n")

  await browser.goto(`${origin}/`)
  const located = await browser.run(`
    const row = await until(() => $('.session-row[data-session-id="${sessionId}"]'), "session row");
    row.click();
    await until(() => $("#stream .message.user"), "messages to draw");
    // With the sidebar shown at 1440px, the docked Summary (open by default on wide windows)
    // narrows the middle column below the rail's minimum, so the ticks would cover the messages.
    // Closing it brings the rail back; earlier tests may already have changed either panel.
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!$(".stream-nav") && $(".app").classList.contains("summary-docked")) $("[data-right-panel='summary']").click();
    const rail = await until(() => $(".stream-nav"), "locator rail");
    const stream = $("#stream");
    // Opening a session pins the bottom; back to the top the first tick is the active one.
    stream.scrollTop = 0;
    await until(() => {
      // A late projection after the session opens can pin the bottom again.
      if (stream.scrollTop > 0) stream.scrollTop = 0;
      return $('.stream-nav-tick[data-active="true"]')?.dataset.index === "0";
    }, "first tick active at the top");
    // Clicking the second tick centres that query and the active tick follows.
    $('.stream-nav-tick[data-index="1"]').click();
    await until(() => {
      const message = $('#streamInner [data-entry-id="e2e-nav-user-2"]');
      const box = message.getBoundingClientRect();
      const view = stream.getBoundingClientRect();
      return box.bottom > view.top && box.top < view.bottom
        && $('.stream-nav-tick[data-active="true"]')?.dataset.index === "1";
    }, "second query centred and its tick active");
    return {
      ticks: $$(".stream-nav-tick").length,
      label: rail.getAttribute("aria-label"),
      jump: $(".stream-nav-tick").getAttribute("aria-label"),
    };
  `)
  assert.equal(located.ticks, 5)
  assert.equal(located.label, "对话定位")
  assert.equal(located.jump, "跳转到第 1 条提问")
})

test("a subagent or workflow call opens its child agents' transcripts read-only over the conversation", { skip }, async () => {
  const now = new Date().toISOString()
  const stamp = now.replace(/[:.]/g, "-")
  const parentId = "e2e-parent-session"
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  const reply = (id, parentEntry, text) => ({
    type: "message", id, parentId: parentEntry, timestamp: now,
    message: { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "e2e", model: "e2e", usage, stopReason: "stop", timestamp: Date.now() },
  })
  const user = (id, parentEntry, text) => ({ type: "message", id, parentId: parentEntry, timestamp: now, message: { role: "user", content: text, timestamp: Date.now() } })
  const call = (id, parentEntry, toolId, name) => ({
    type: "message", id, parentId: parentEntry, timestamp: now,
    message: { role: "assistant", content: [{ type: "toolCall", id: toolId, name, arguments: {} }], api: "openai-completions", provider: "e2e", model: "e2e", usage, stopReason: "toolUse", timestamp: Date.now() },
  })
  const result = (id, parentEntry, toolId, name, details) => ({
    type: "message", id, parentId: parentEntry, timestamp: now,
    message: { role: "toolResult", toolCallId: toolId, toolName: name, content: [{ type: "text", text: "done" }], details, isError: false, timestamp: Date.now() },
  })
  const run = "wf_e2e0001"
  const subagentId = "subagent-e2e-linked"
  const parent = [
    { type: "session", version: 3, id: parentId, timestamp: now, cwd: workspace },
    user("p1", null, "delegate the wombat audit"),
    call("p2", "p1", "t1", "subagent"),
    result("p3", "p2", "t1", "subagent", { mode: "single", results: [{ agent: "explore", task: "audit wombat", sessionId: subagentId }] }),
    call("p4", "p3", "t2", "workflow"),
    result("p5", "p4", "t2", "workflow", { schemaVersion: 1, runId: run, name: "e2e" }),
    reply("p6", "p5", "All delegated."),
  ]
  const childLines = (id, task, answer) => [
    { type: "session", version: 3, id, timestamp: now, cwd: workspace, origin: "subagent", parentSessionId: parentId },
    user(`${id}-u`, null, task),
    reply(`${id}-a`, `${id}-u`, answer),
  ]
  const dir = join(base, "agent", "sessions", "--e2e-children--")
  await mkdir(dir, { recursive: true })
  const write = (id, lines) => writeFile(join(dir, `${stamp}_${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n")
  await write(parentId, parent)
  await write(subagentId, childLines(subagentId, "audit wombat", "Wombat audit finished."))
  await write(`workflow-${run}-${run}-1`, childLines(`workflow-${run}-${run}-1`, "first workflow agent", "First agent answer."))
  await write(`workflow-${run}-${run}-2`, childLines(`workflow-${run}-${run}-2`, "second workflow agent", "Second agent answer."))

  await browser.goto(`${origin}/`)
  const seen = await browser.run(`
    const row = await until(() => $('.session-row[data-session-id="${parentId}"]'), "parent session row");
    const listedChildren = $$(".session-row").filter((item) => /^(subagent|workflow)-/.test(item.dataset.sessionId)).length;
    row.click();
    const link = await until(() => $('.tool-child-link[data-child-session-id="${subagentId}"]'), "subagent link");
    link.click();
    const view = $("#childAgentView");
    await until(() => !view.hidden && view.textContent.includes("Wombat audit finished."), "child transcript");
    const single = {
      listedChildren,
      readOnlyBadge: Boolean(view.querySelector(".child-agent-badge")),
      actions: view.querySelectorAll(".message-actions, textarea, input").length,
      activeRow: $(".session-row.active")?.dataset.sessionId,
    };
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await until(() => view.hidden, "child view closed by Escape");

    $('.tool-child-link[data-workflow-run="${run}"]').click();
    await until(() => !view.hidden && view.textContent.includes("First agent answer."), "first workflow agent");
    const agentTabs = $$(".child-agent-tab").map((tab) => tab.textContent);
    const tabHints = $$(".child-agent-tab").map((tab) => tab.nextElementSibling?.getAttribute("role") === "tooltip" && tab.nextElementSibling.textContent);
    $$(".child-agent-tab")[1].click();
    await until(() => view.textContent.includes("Second agent answer."), "second workflow agent");
    $("#childAgentBack").click();
    await until(() => view.hidden, "child view closed");
    return { ...single, tabs: agentTabs, tabHints };
  `)
  assert.deepEqual(seen, {
    listedChildren: 0,
    readOnlyBadge: true,
    actions: 0,
    activeRow: parentId,
    tabs: ["#1first workflow agent", "#2second workflow agent"],
    tabHints: ["first workflow agent", "second workflow agent"],
  })

  const refused = await browser.run(`
    const other = await fetch("/api/v1/sessions/${parentId}/children/${encodeURIComponent("../etc")}");
    const notChild = await fetch("/api/v1/sessions/${parentId}/children/e2e-search-session");
    return [other.status, notChild.status];
  `)
  assert.deepEqual(refused, [404, 404])
})
