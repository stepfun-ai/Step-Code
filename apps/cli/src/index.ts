// @step-harness/cli library surface.
//
// The process entry is src/main.ts (a runnable module). It is intentionally NOT
// re-exported here: importing this package must not launch the CLI. Consumers
// that want the entry run the bin/dev script, which targets src/main.ts.
export { CLI_PACKAGE_NAME } from "#version";
