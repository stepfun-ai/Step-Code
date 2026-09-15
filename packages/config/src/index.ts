export {
	type KeybindingsMigrationResult,
	type KeybindingsMigrator,
	migrateAuthToAuthJson,
	migrateSessionsFromAgentRoot,
	type RunMigrationsOptions,
	runMigrations,
	showDeprecationWarnings,
} from "./migrations.ts";
