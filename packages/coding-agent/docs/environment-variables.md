# Environment Variables

Step reads the variables below. Configuration shared across launches belongs in
`~/.stepcode/config.toml` or the project `.stepcode/config.toml`.

| Variable | Description |
|----------|-------------|
| `STEP_CODING_AGENT_DIR` | Override the agent directory; default is `~/.stepcode/agent` |
| `STEP_CODING_AGENT_SESSION_DIR` | Override session storage; `--session-dir` takes precedence |
| `STEP_API_KEY` | StepFun API credential |
| `STEP_BASE_URL` | Override the StepFun API endpoint |
| `STEP_PROVIDER`, `STEP_MODEL` | Default provider and model selection |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

The CLI sets `AI_AGENT=step`. Child processes inherit this process marker and the
ordinary shell environment. Shell tools do not inject session IDs, transcript
paths, model IDs, or reasoning levels into command environments.

Custom shell tools can adjust the environment through `spawnHook`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Terminal images, hyperlinks, truecolor, and the hardware cursor are configured
through [terminal settings](terminal-setup.md#capability-overrides). Escape-key
reassembly uses 100 ms over SSH and 10 ms locally. Provider cache retention defaults
to `short`; SDK callers can set `cacheRetention` explicitly per request.
