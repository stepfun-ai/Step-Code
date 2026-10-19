# Recent models

The `/model` selector shows a **Recent** section above the existing model list when the search is empty and history contains models available in the active scope. Recent rows are removed from the remaining list. Search hides the sections and searches the original list once, preserving fuzzy ranking and default-model search.

Successful interactive selections (Enter, Ctrl+S, exact `/model provider/id`, and model cycling) record a provider/id pair. Selecting the same pair again moves it to the front. The history keeps at most ten distinct pairs; identical IDs from different providers remain separate. Cancelling or a failed selection does not record history. Startup and session restoration do not rewrite it.

History is stored as the global settings field `recentModels`, using Step's existing `config.toml` storage adapter (or the embedded host's settings storage). It is global-only, is validated when read, and concurrent sessions merge selections under the existing storage lock. No credentials or model objects are stored. Recent history does not change startup defaults or model cycling order. With `STEPCODE_CONFIG_PATH`, default selection still writes the external active model; history uses the wrapped global settings storage.

The selector only receives history references. Settings persistence stays in `packages/coding-agent`; `packages/tui` is unchanged. Unavailable references are hidden rather than deleting offline history. Scoped mode filters Recent to scoped models and preserves the order of the remaining scoped models.

## Reference

Behavior was checked against OpenCode v1.2.0, not copied into StepCode:

- [Model dialog](https://github.com/anomalyco/opencode/blob/v1.2.0/packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx): Recent section, unavailable-model filtering, search without duplicated rows.
- [Local model state](https://github.com/anomalyco/opencode/blob/v1.2.0/packages/opencode/src/cli/cmd/tui/context/local.tsx): provider/model identity, move-to-front history, ten-entry limit.
