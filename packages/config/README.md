# @step-harness/config

Product-neutral configuration format, loading, and one-time startup migrations
for the Step harness.

This package owns the mechanics of startup config migrations (auth, sessions,
managed binaries, keybindings file, extension-system deprecations). It takes
every filesystem root as an explicit input (`agentDir`, `configDirName`) and
receives the keybindings migrator by injection, so it never depends on the
coding-agent product package. Product-specific defaults (Step storage context,
app identity, resource resolution such as `getThemesDir`) stay in the product
package and are passed in.
