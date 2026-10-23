export { attachSessionIndex, withSessionIndex } from "./attach.ts";
export {
	defaultSessionIndexRoots,
	type OpenSessionIndexOptions,
	openSessionIndex,
	type SessionIndexRoot,
} from "./client.ts";
export { runSessionIndexCommand, type SessionIndexCommandOptions } from "./command.ts";
export { deleteIndexDatabase, getSessionIndexPath } from "./schema.ts";
export {
	type ReindexOptions,
	type ReindexProgress,
	type SessionIndex,
	type SessionIndexCoverage,
	type SessionIndexHit,
	type SessionIndexHitBatch,
	type SessionIndexQuery,
	type SessionIndexStatus,
	type SessionListItem,
	type SessionListPage,
	type SessionListQuery,
	SNIPPET_MATCH_END,
	SNIPPET_MATCH_START,
} from "./types.ts";
