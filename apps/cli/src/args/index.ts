/**
 * Argument surface for the app shell: the parser, its parsed-args type, and the
 * application-mode resolution the shell's dispatch switch consumes.
 *
 * Mode resolution is now surfaced here (previously withheld while pi's delegated
 * `main()` owned dispatch): after S3 the shell runs `prepareMain()` and its own
 * `switch (appMode)`, so it needs `AppMode` / `toPrintOutputMode` as first-class
 * argv-layer vocabulary. The parser and both the mode rules stay pi-owned; this
 * barrel just re-exports them through one door (see #args/definitions, #args/mode).
 */
export { type Args, parseArgs } from "#args/definitions";
export { type AppMode, resolveAppMode, toPrintOutputMode } from "#args/mode";
