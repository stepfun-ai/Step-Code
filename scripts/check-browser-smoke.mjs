import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { build } from "esbuild"

const outputPath = join(tmpdir(), "pi-browser-smoke.js")
const errorLogPath = join(tmpdir(), "pi-browser-smoke-errors.log")
const generatedCatalogDataDir = join(
  process.cwd(),
  "packages/providers/src/providers/data",
)

function listFiles(directory, extensions) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(path, extensions))
    else if (extensions.some((extension) => entry.name.endsWith(extension)))
      files.push(path)
  }
  return files
}

/**
 * The Web client is a React + Vite app under apps/web/client. These guards keep
 * the first-release surface from silently regressing: the source must still
 * talk to the session API, carry the structural ids and classes, keep the
 * design tokens and the two-column layout, and leave out unbuilt UI.
 */
function checkWebClientSurface() {
  const clientRoot = join(process.cwd(), "apps/web/client")
  const sourceRoot = join(clientRoot, "src")
  const index = readFileSync(join(clientRoot, "index.html"), "utf8")
  if (
    !index.includes('id="root"') ||
    !index.includes('src="/src/main.tsx"')
  ) {
    throw new Error(
      "apps/web/client/index.html does not mount the React entry (#root, /src/main.tsx)",
    )
  }
  const sourceFiles = listFiles(sourceRoot, [".ts", ".tsx"])
  const source = sourceFiles
    .map((path) => readFileSync(path, "utf8"))
    .join("\n")
  const markup = sourceFiles
    .filter((path) => path.endsWith(".tsx"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n")
  if (!source.includes("EventSource") || !source.includes("/api/v1/sessions")) {
    throw new Error(
      "apps/web/client/src does not contain the session stream client",
    )
  }
  for (const required of [
    "/policy",
    "/model",
    "/files",
    "/api/v1/logout",
    "renderMarkdown",
    "workspaceBrowserModal",
    "stepcode.theme",
    "stepcode.locale",
  ]) {
    if (!source.includes(required)) {
      throw new Error(
        `apps/web/client/src is missing a first-release interaction: ${required}`,
      )
    }
  }
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // A class may sit in a plain string or in the first string of cx(...).
  const hasClass = (name) =>
    new RegExp(
      `className=\\{?(?:cx\\()?"(?:[^"]*\\s)?${escape(name)}(?:\\s[^"]*)?"`,
    ).test(markup)
  const hasId = (name) => markup.includes(`id="${name}"`)
  const missing = [
    ...["sidebar", "main", "composer-card", "view-tabs"].filter(
      (name) => !hasClass(name),
    ),
    ...[
      "workspaceButton",
      "workspaceBrowserModal",
      "settingsButton",
      "remoteControlButton",
      "settingsView",
      "logoutButton",
    ].filter((name) => !hasId(name)),
    // The upgrade link follows the account's region; its mainland default
    // lives in a shared helper, which may be a .ts file.
    ...["https://platform.stepfun.com/step-plan"].filter(
      (url) => !source.includes(url),
    ),
  ]
  if (missing.length) {
    throw new Error(
      `apps/web/client/src is missing the first-release structure: ${missing.join(", ")}`,
    )
  }
  const globalCssPath = join(sourceRoot, "styles/global.css")
  const globalCss = readFileSync(globalCssPath, "utf8")
  if (
    !globalCss.includes("--sidebar: var(--workbench)") ||
    !globalCss.includes("--sidebar-glass: rgb(240 246 253 / 72%)") ||
    !globalCss.includes("--workbench: #edf4fc") ||
    !globalCss.includes('html[data-theme="violet"]') ||
    !globalCss.includes("--ink: #171718") ||
    !globalCss.includes("--composer-width: 760px")
  ) {
    throw new Error(
      "apps/web/client/src/styles/global.css is missing the first-release tokens",
    )
  }
  // A single stray brace silently drops every rule after it, which is how the
  // search dialog once lost `position: fixed` and flowed into the page layout.
  // Nothing above would notice: the strings are all still present. Balance is
  // cheap to assert and catches the whole class of failure.
  const stylesheets = listFiles(sourceRoot, [".css"])
  let styles = ""
  for (const path of stylesheets) {
    const css = readFileSync(path, "utf8")
    styles += `${css}\n`
    let braceDepth = 0
    for (const character of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
      if (character === "{") braceDepth += 1
      else if (character === "}") braceDepth -= 1
      if (braceDepth < 0) {
        throw new Error(
          `${path} has a closing brace with no matching opening brace`,
        )
      }
    }
    if (braceDepth !== 0) {
      throw new Error(`${path} has ${braceDepth} unclosed brace(s)`)
    }
  }
  if (
    !globalCss.includes(
      "grid-template-columns: var(--sidebar-width) minmax(0, 1fr)",
    ) ||
    styles.includes("changes-panel") ||
    markup.includes("changes-panel")
  ) {
    throw new Error(
      "apps/web/client does not preserve the two-column no-right-rail layout",
    )
  }
  if (hasClass("topbar") || styles.includes(".topbar {")) {
    throw new Error("apps/web/client still contains the removed main-area header")
  }
  // Attachments and voice dictation shipped, so the guards that kept them out
  // of the first release no longer apply. The rest are still unbuilt.
  for (const forbidden of [
    "hudToggle",
    'className="hud"',
    'class="hud"',
    "cronPlaceholder",
  ]) {
    if (index.includes(forbidden) || source.includes(forbidden)) {
      throw new Error(`apps/web/client contains post-release UI: ${forbidden}`)
    }
  }
}

// Fresh checkouts do not materialize provider JSON until model data is hydrated.
const generatedCatalogDataPlugin = {
  name: "generated-model-catalog",
  setup(build) {
    build.onResolve({ filter: /^\.\/data\/[^/]+\.json$/ }, (args) => {
      const path = resolve(dirname(args.importer), args.path)
      if (dirname(path) !== generatedCatalogDataDir || existsSync(path)) return
      return { path, namespace: "empty-generated-model-catalog" }
    })
    build.onLoad(
      { filter: /.*/, namespace: "empty-generated-model-catalog" },
      () => ({
        contents: "{}",
        loader: "json",
      }),
    )
  },
}

try {
  checkWebClientSurface()
  // Browser-safety smoke: bundle the browser-facing package exports and fail on
  // any Node-only runtime import leaking into them. The Step-only build has no
  // built-in providers, so the former selective-provider tree-shake assertions
  // (which required the deleted anthropic catalog) no longer apply.
  await build({
    entryPoints: ["scripts/browser-smoke-entry.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    logLevel: "silent",
    outfile: outputPath,
    plugins: [generatedCatalogDataPlugin],
  })

  process.exit(0)
} catch (error) {
  let detailedErrors = ""
  if (
    error &&
    typeof error === "object" &&
    "errors" in error &&
    Array.isArray(error.errors)
  ) {
    detailedErrors = error.errors
      .map((entry) => {
        const location = entry.location
          ? `${entry.location.file}:${entry.location.line}:${entry.location.column}`
          : ""
        return [location, entry.text].filter(Boolean).join(" ")
      })
      .join("\n")
  }

  const baseError =
    error instanceof Error ? (error.stack ?? error.message) : String(error)
  writeFileSync(
    errorLogPath,
    [detailedErrors, baseError].filter(Boolean).join("\n\n"),
    "utf-8",
  )
  console.error(`Browser smoke check failed. See ${errorLogPath}`)
  process.exit(1)
}
