/**
 * Step entrypoint signal.
 *
 * This module is imported first by the app entry, before the coding-agent
 * barrel (and therefore before coding-agent/config.ts) is evaluated. ESM runs a
 * side-effect import's subtree to completion before the next import in source
 * order, so setting STEPCODE_ENTRYPOINT here guarantees config.ts observes it
 * while deriving APP_NAME / CONFIG_DIR_NAME / VERSION and applying the Step
 * environment.
 *
 * The app's launcher file is main.ts, which the filename heuristic in
 * isStepEntrypoint() cannot recognise; this explicit signal covers every launch
 * channel (tsx dev, node --strip, bundled step.js, bun step-bin) uniformly.
 * Ordinary `pi` launches never import this module and never set the variable.
 */
process.env.STEPCODE_ENTRYPOINT ??= "1";
