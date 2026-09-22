/**
 * Step's product telemetry contract.
 *
 * Pi is the runtime underneath the Step facade, so this registry lives beside
 * the facade instead of in Pi's core package.  Keeping the names and fields in
 * one place is important for two reasons: producers can be checked against the
 * old Step collector contract, and the redactor can distinguish a safe
 * dimension such as `slash_command_used.command` from arbitrary user text.
 */

export type StepTelemetryPrimitive = string | number | boolean | null;

/** Flat payload constraint shared by the registry metadata and wire client. */
interface StepTelemetryEventPayloadShape {
	readonly [property: string]: StepTelemetryPrimitive;
}

export interface StepTelemetryEventPayloads {
	readonly cli_started: { readonly entrypoint: string; readonly os: string; readonly node_version: string };
	readonly cli_exited: { readonly duration_ms: number; readonly exit_reason: string };
	readonly session_started: { readonly resumed: boolean; readonly agent_mode: string; readonly ui_mode: string };
	readonly turn_completed: {
		readonly duration_ms: number;
		readonly step_count: number;
		readonly tool_call_count: number;
		readonly outcome: string;
		readonly input_token_count: number;
		readonly cached_input_token_count: number;
		readonly output_token_count: number;
	};
	readonly turn_steered: { readonly step: number; readonly input_count: number };
	readonly tool_call_completed: {
		readonly tool_name: string;
		readonly outcome: string;
		readonly error_code: string | null;
		readonly duration_ms: number;
	};
	readonly model_request_completed: {
		readonly provider: string;
		readonly model: string;
		readonly duration_ms: number;
		readonly ttft_ms: number | null;
		readonly endpoint_kind: string;
		readonly outcome: string;
		readonly status_code: number;
		readonly streamed: boolean;
		readonly routed_via_cloud_trace: boolean;
	};
	readonly first_launch: { readonly channel: string };
	readonly crash: { readonly error_type: string; readonly source: string };
	readonly system_metrics: {
		readonly process_uptime_ms: number;
		readonly rss_bytes: number;
		readonly heap_used_bytes: number;
		readonly heap_total_bytes: number;
		readonly external_bytes: number;
		readonly cpu_user_us: number;
		readonly cpu_system_us: number;
		readonly cpu_elapsed_us: number;
		readonly load_avg_1m: number;
		readonly free_mem_bytes: number;
		readonly total_mem_bytes: number;
		readonly cpu_count: number;
	};
	readonly tool_call_repeat: { readonly tool_name: string; readonly attempt_count: number; readonly limit: number };
	readonly permission_decision: {
		readonly tool_name: string;
		readonly mode: string;
		readonly risk: string;
		readonly hazardous: boolean;
	};
	readonly permission_approval_result: {
		readonly tool_name: string;
		readonly decision: string;
		readonly risk: string;
	};
	readonly autopilot_resume: {
		readonly outcome: string;
		readonly trigger: string;
		readonly probe_status: string;
		readonly probe_attempts: number;
		readonly consecutive_resumes: number;
		readonly give_up_reason: string;
	};
	readonly compaction_finished: {
		readonly mode: string;
		readonly summarized_message_count: number;
		readonly step: number;
	};
	readonly mcp_server_connected: {
		readonly server_name: string;
		readonly tool_count: number;
		readonly degraded: boolean;
	};
	readonly mcp_server_failed: { readonly server_name: string };
	readonly subagent_task_created: {
		readonly execution: string;
		readonly agent_type: string;
		readonly model_profile: string;
	};
	readonly subagent_task_finished: {
		readonly execution: string;
		readonly status: string;
		readonly duration_ms: number;
	};
	readonly background_command_finished: { readonly status: string; readonly duration_ms: number };
	readonly mr_created: {
		readonly provider: string;
		readonly host: string;
		readonly project_path: string;
		readonly mr_iid: string;
		readonly detection_source: string;
		readonly model: string | null;
		readonly workspace_name: string | null;
		readonly cwd_path: string | null;
		readonly stats_status: string;
		readonly additions_count: number | null;
		readonly deletions_count: number | null;
		readonly changed_files_count: number | null;
	};
	readonly slash_command_used: { readonly command: string; readonly recognized: boolean };
	readonly permission_mode_toggled: { readonly mode: string; readonly source: string };
	readonly clarification_resolved: {
		readonly outcome: string;
		readonly option_count: number;
		readonly duration_ms: number;
	};
	readonly plan_updated: {
		readonly item_count: number;
		readonly completed_count: number;
		readonly in_progress_count: number;
		readonly created: boolean;
		readonly source: string;
	};
	readonly plan_mode_entered: { readonly source: string };
	readonly plan_mode_exited: { readonly source: string; readonly outcome: string };
	readonly cron_scheduled: { readonly recurring: boolean };
	readonly cron_deleted: { readonly found: boolean };
	readonly cron_fired: { readonly recurring: boolean };
	readonly cron_missed: { readonly trigger_count: number };
	readonly cron_deferred: { readonly id: string; readonly defer_count: number };
	readonly cron_expired: { readonly id: string; readonly recurring: boolean };
	readonly workflow_started: { readonly phase_count: number };
	readonly workflow_phase: { readonly title_length: number; readonly phase_index: number };
	readonly workflow_agent_started: { readonly label_length: number; readonly phase_length: number };
	readonly workflow_agent_finished: {
		readonly status: string;
		readonly cached: boolean;
		readonly token_count: number;
	};
	readonly workflow_schema_failed: { readonly attempt: number; readonly error_count: number };
	readonly workflow_acl_blocked: { readonly operation: string; readonly reason_code: string };
	readonly workflow_budget_exceeded: { readonly spent_tokens: number; readonly requested_tokens: number };
	readonly workflow_resumed: { readonly cache_hits: number };
	readonly workflow_finished: {
		readonly status: string;
		readonly agent_count: number;
		readonly cache_hits: number;
		readonly spent_tokens: number;
	};
	readonly workflow_hoh_iteration: { readonly iteration: number };
	readonly workflow_hoh_evidence_written: {
		readonly iteration: number;
		readonly spec_coverage_percent: number;
		readonly coverage_delta_percent: number;
	};
	readonly workflow_hoh_finished: {
		readonly iterations: number;
		readonly stop_reason: string;
		readonly spec_coverage_percent: number;
	};
	readonly goal_command_used: { readonly subcommand: string };
	readonly goal_continued: { readonly iteration: number; readonly delivery: string };
	readonly error_raised: { readonly error_type: string; readonly where: string; readonly retryable: boolean };
	readonly feedback_submitted: {
		readonly category: string;
		readonly has_comment: boolean;
		readonly comment_length_count: number;
		readonly diagnostics_included: boolean;
		readonly surface: string;
		readonly delivered: boolean;
		readonly bundle_included: boolean;
		readonly bundle_bytes: number;
	};
	readonly tui_input_anomaly: {
		readonly kind: string;
		readonly chunk_count: number;
		readonly raw_bytes: number;
		readonly paste_open: boolean;
		readonly term: string;
		readonly is_tty: boolean;
		readonly trace_enabled: boolean;
	};
}

export type StepTelemetryKnownEventName = keyof StepTelemetryEventPayloads & string;

/** Stable event-name list used by diagnostics and release checks. */
export const STEP_TELEMETRY_EVENT_NAMES = Object.keys({
	cli_started: true,
	cli_exited: true,
	session_started: true,
	turn_completed: true,
	turn_steered: true,
	tool_call_completed: true,
	model_request_completed: true,
	first_launch: true,
	crash: true,
	system_metrics: true,
	tool_call_repeat: true,
	permission_decision: true,
	permission_approval_result: true,
	autopilot_resume: true,
	compaction_finished: true,
	mcp_server_connected: true,
	mcp_server_failed: true,
	subagent_task_created: true,
	subagent_task_finished: true,
	background_command_finished: true,
	mr_created: true,
	slash_command_used: true,
	permission_mode_toggled: true,
	clarification_resolved: true,
	plan_updated: true,
	plan_mode_entered: true,
	plan_mode_exited: true,
	cron_scheduled: true,
	cron_deleted: true,
	cron_fired: true,
	cron_missed: true,
	cron_deferred: true,
	cron_expired: true,
	workflow_started: true,
	workflow_phase: true,
	workflow_agent_started: true,
	workflow_agent_finished: true,
	workflow_schema_failed: true,
	workflow_acl_blocked: true,
	workflow_budget_exceeded: true,
	workflow_resumed: true,
	workflow_finished: true,
	workflow_hoh_iteration: true,
	workflow_hoh_evidence_written: true,
	workflow_hoh_finished: true,
	goal_command_used: true,
	goal_continued: true,
	error_raised: true,
	feedback_submitted: true,
	tui_input_anomaly: true,
}) as readonly StepTelemetryKnownEventName[];

const propertyNames = <K extends StepTelemetryKnownEventName>(
	// Make the payload lookup distributive over K. Without the conditional,
	// inference widens K to the full event union and `keyof` becomes `never`.
	...names: K extends unknown ? (keyof StepTelemetryEventPayloads[K] & string)[] : never
): readonly string[] => names;

/** Allowed fields per known event; unknown events use the conservative fallback. */
export const STEP_TELEMETRY_EVENT_PROPERTY_NAMES: Readonly<Record<StepTelemetryKnownEventName, readonly string[]>> = {
	cli_started: propertyNames("entrypoint", "os", "node_version"),
	cli_exited: propertyNames("duration_ms", "exit_reason"),
	session_started: propertyNames("resumed", "agent_mode", "ui_mode"),
	turn_completed: propertyNames(
		"duration_ms",
		"step_count",
		"tool_call_count",
		"outcome",
		"input_token_count",
		"cached_input_token_count",
		"output_token_count",
	),
	turn_steered: propertyNames("step", "input_count"),
	tool_call_completed: propertyNames("tool_name", "outcome", "error_code", "duration_ms"),
	model_request_completed: propertyNames(
		"provider",
		"model",
		"duration_ms",
		"ttft_ms",
		"endpoint_kind",
		"outcome",
		"status_code",
		"streamed",
		"routed_via_cloud_trace",
	),
	first_launch: propertyNames("channel"),
	crash: propertyNames("error_type", "source"),
	system_metrics: propertyNames(
		"process_uptime_ms",
		"rss_bytes",
		"heap_used_bytes",
		"heap_total_bytes",
		"external_bytes",
		"cpu_user_us",
		"cpu_system_us",
		"cpu_elapsed_us",
		"load_avg_1m",
		"free_mem_bytes",
		"total_mem_bytes",
		"cpu_count",
	),
	tool_call_repeat: propertyNames("tool_name", "attempt_count", "limit"),
	permission_decision: propertyNames("tool_name", "mode", "risk", "hazardous"),
	permission_approval_result: propertyNames("tool_name", "decision", "risk"),
	autopilot_resume: propertyNames(
		"outcome",
		"trigger",
		"probe_status",
		"probe_attempts",
		"consecutive_resumes",
		"give_up_reason",
	),
	compaction_finished: propertyNames("mode", "summarized_message_count", "step"),
	mcp_server_connected: propertyNames("server_name", "tool_count", "degraded"),
	mcp_server_failed: propertyNames("server_name"),
	subagent_task_created: propertyNames("execution", "agent_type", "model_profile"),
	subagent_task_finished: propertyNames("execution", "status", "duration_ms"),
	background_command_finished: propertyNames("status", "duration_ms"),
	mr_created: propertyNames(
		"provider",
		"host",
		"project_path",
		"mr_iid",
		"detection_source",
		"model",
		"workspace_name",
		"cwd_path",
		"stats_status",
		"additions_count",
		"deletions_count",
		"changed_files_count",
	),
	slash_command_used: propertyNames("command", "recognized"),
	permission_mode_toggled: propertyNames("mode", "source"),
	clarification_resolved: propertyNames("outcome", "option_count", "duration_ms"),
	plan_updated: propertyNames("item_count", "completed_count", "in_progress_count", "created", "source"),
	plan_mode_entered: propertyNames("source"),
	plan_mode_exited: propertyNames("source", "outcome"),
	cron_scheduled: propertyNames("recurring"),
	cron_deleted: propertyNames("found"),
	cron_fired: propertyNames("recurring"),
	cron_missed: propertyNames("trigger_count"),
	cron_deferred: propertyNames("id", "defer_count"),
	cron_expired: propertyNames("id", "recurring"),
	workflow_started: propertyNames("phase_count"),
	workflow_phase: propertyNames("title_length", "phase_index"),
	workflow_agent_started: propertyNames("label_length", "phase_length"),
	workflow_agent_finished: propertyNames("status", "cached", "token_count"),
	workflow_schema_failed: propertyNames("attempt", "error_count"),
	workflow_acl_blocked: propertyNames("operation", "reason_code"),
	workflow_budget_exceeded: propertyNames("spent_tokens", "requested_tokens"),
	workflow_resumed: propertyNames("cache_hits"),
	workflow_finished: propertyNames("status", "agent_count", "cache_hits", "spent_tokens"),
	workflow_hoh_iteration: propertyNames("iteration"),
	workflow_hoh_evidence_written: propertyNames("iteration", "spec_coverage_percent", "coverage_delta_percent"),
	workflow_hoh_finished: propertyNames("iterations", "stop_reason", "spec_coverage_percent"),
	goal_command_used: propertyNames("subcommand"),
	goal_continued: propertyNames("iteration", "delivery"),
	error_raised: propertyNames("error_type", "where", "retryable"),
	feedback_submitted: propertyNames(
		"category",
		"has_comment",
		"comment_length_count",
		"diagnostics_included",
		"surface",
		"delivered",
		"bundle_included",
		"bundle_bytes",
	),
	tui_input_anomaly: propertyNames(
		"kind",
		"chunk_count",
		"raw_bytes",
		"paste_open",
		"term",
		"is_tty",
		"trace_enabled",
	),
};

export function isKnownStepTelemetryEvent(event: string): event is StepTelemetryKnownEventName {
	return Object.hasOwn(STEP_TELEMETRY_EVENT_PROPERTY_NAMES, event);
}

/**
 * Review metadata for one telemetry event.
 *
 * The mapped `properties` member is intentional: adding a field to a payload
 * without documenting it (or documenting a field that is not emitted) is a
 * type error, just as it is in the original Step registry.
 */
export interface StepTelemetryEventMeta<Payload extends StepTelemetryEventPayloadShape> {
	readonly owner: string;
	readonly comment: string;
	readonly properties: { readonly [K in keyof Payload & string]: string };
}

/**
 * Product telemetry metadata, kept in lockstep with the former StepCode
 * registry.  Descriptions are deliberately about dimensions and outcomes;
 * they must never invite producers to add prompts, paths, or other user data.
 */
export const STEP_TELEMETRY_EVENT_DEFINITIONS: {
	readonly [K in StepTelemetryKnownEventName]: StepTelemetryEventMeta<StepTelemetryEventPayloads[K]>;
} = {
	cli_started: {
		owner: "runtime",
		comment: "Launch volume split by entrypoint.",
		properties: {
			entrypoint: "Subcommand used, root for the default REPL.",
			os: "Runtime platform identifier.",
			node_version: "Major and minor runtime version.",
		},
	},
	cli_exited: {
		owner: "runtime",
		comment: "Pairs with cli_started to measure process lifetime and exit health.",
		properties: {
			duration_ms: "Wall time from process start to shutdown.",
			exit_reason: "How the process ended.",
		},
	},
	session_started: {
		owner: "gateway",
		comment: "Resume-versus-new ratio and the interaction surface in use.",
		properties: {
			resumed: "Whether a persisted snapshot already existed.",
			agent_mode: "Mode the session opened in.",
			ui_mode: "Rendering surface hosting the session.",
		},
	},
	turn_completed: {
		owner: "core",
		comment: "Turn cost and shape, the primary agent-loop health signal.",
		properties: {
			duration_ms: "Wall time of the turn.",
			step_count: "Loop iterations consumed.",
			tool_call_count: "Tool invocations within the turn.",
			outcome: "How the turn ended.",
			input_token_count: "Uncached prompt tokens summed over the turn.",
			cached_input_token_count: "Prompt tokens served from cache.",
			output_token_count: "Completion tokens summed over the turn.",
		},
	},
	turn_steered: {
		owner: "core",
		comment: "How often users redirect a turn while it is running.",
		properties: {
			step: "Loop iteration where the input was appended.",
			input_count: "Prompts appended at that boundary.",
		},
	},
	tool_call_completed: {
		owner: "core",
		comment: "Per-tool reliability and latency.",
		properties: {
			tool_name: "Registered tool name.",
			outcome: "Success, failure, or denial.",
			error_code: "Allowlisted runtime failure code, or null on success.",
			duration_ms: "Wall time of the tool call.",
		},
	},
	model_request_completed: {
		owner: "llm",
		comment: "Provider latency and failure rate per model.",
		properties: {
			provider: "Configured provider identifier.",
			model: "Model identifier sent to the provider.",
			duration_ms: "Wall time of the request.",
			ttft_ms: "Time to the first stream event, or null when not streamed.",
			endpoint_kind: "Platform, operator endpoint, or localhost; never the address.",
			outcome: "Whether the request succeeded and how it failed.",
			status_code: "HTTP status, or zero when no response arrived.",
			streamed: "Whether the streaming path was used.",
			routed_via_cloud_trace: "Whether the server-side observer also recorded it.",
		},
	},
	first_launch: {
		owner: "runtime",
		comment: "New installs, counted once when the device identity is created.",
		properties: {
			channel: "Build channel where the install was first seen.",
		},
	},
	crash: {
		owner: "runtime",
		comment: "Unhandled failures observed before process termination.",
		properties: {
			error_type: "Error class or normalized code, never the message.",
			source: "Process-level handler that observed the failure.",
		},
	},
	system_metrics: {
		owner: "runtime",
		comment: "Periodic resource samples for memory and CPU regression triage.",
		properties: {
			process_uptime_ms: "Process uptime at the sample.",
			rss_bytes: "Resident set size.",
			heap_used_bytes: "Heap bytes in use.",
			heap_total_bytes: "Heap bytes reserved.",
			external_bytes: "Memory held outside the heap.",
			cpu_user_us: "User CPU microseconds since the previous sample.",
			cpu_system_us: "System CPU microseconds since the previous sample.",
			cpu_elapsed_us: "Wall time covered by the CPU counters.",
			load_avg_1m: "One-minute system load average.",
			free_mem_bytes: "System memory free at the sample.",
			total_mem_bytes: "System memory total.",
			cpu_count: "Logical CPU count.",
		},
	},
	tool_call_repeat: {
		owner: "core",
		comment: "The loop issued an identical tool call past its safety limit.",
		properties: {
			tool_name: "Registered tool name.",
			attempt_count: "Identical calls seen before the block.",
			limit: "Configured repeated-call limit.",
		},
	},
	permission_decision: {
		owner: "core",
		comment: "Policy decisions, including calls allowed without confirmation.",
		properties: {
			tool_name: "Registered tool name.",
			mode: "Policy outcome.",
			risk: "Risk class assigned by policy.",
			hazardous: "Whether policy marked the call hazardous.",
		},
	},
	permission_approval_result: {
		owner: "core",
		comment: "Answers to interactive tool confirmation prompts.",
		properties: {
			tool_name: "Registered tool name.",
			decision: "Approval result, cached result, or timeout.",
			risk: "Risk class assigned by policy.",
		},
	},
	autopilot_resume: {
		owner: "gateway",
		comment: "Whether an unattended model-error continuation recovered.",
		properties: {
			outcome: "Resumed or gave up.",
			trigger: "Failure kind that triggered the continuation.",
			probe_status: "Last connectivity probe status.",
			probe_attempts: "Probe attempts in this continuation ladder.",
			consecutive_resumes: "Restarts since the last successful turn or user input.",
			give_up_reason: "Fixed vocabulary for why the ladder stopped.",
		},
	},
	compaction_finished: {
		owner: "core",
		comment: "Context compaction frequency and size shape.",
		properties: {
			mode: "Compaction strategy applied.",
			summarized_message_count: "Messages folded into the summary.",
			step: "Loop step where compaction happened.",
		},
	},
	mcp_server_connected: {
		owner: "mcp",
		comment: "An MCP server started and contributed tools.",
		properties: {
			server_name: "Configured server key.",
			tool_count: "Tools exposed by the server.",
			degraded: "Whether the connection reported a warning.",
		},
	},
	mcp_server_failed: {
		owner: "mcp",
		comment: "An MCP server failed to connect while the CLI continued.",
		properties: {
			server_name: "Configured server key.",
		},
	},
	subagent_task_created: {
		owner: "core",
		comment: "Delegation volume split by blocking versus background execution.",
		properties: {
			execution: "Whether the delegation blocks or runs in a lane.",
			agent_type: "Requested agent preset.",
			model_profile: "Model profile bound to the delegate.",
		},
	},
	subagent_task_finished: {
		owner: "core",
		comment: "Terminal outcomes and latency of delegated work.",
		properties: {
			execution: "Whether the delegation blocked or ran in a lane.",
			status: "Terminal status.",
			duration_ms: "Wall time from creation to terminal status.",
		},
	},
	background_command_finished: {
		owner: "core",
		comment: "Background shell command outcomes, including timeouts.",
		properties: {
			status: "Terminal status.",
			duration_ms: "Wall time of the command.",
		},
	},
	mr_created: {
		owner: "core",
		comment: "Merge requests opened through a forge command during a session.",
		properties: {
			provider: "Forge provider.",
			host: "Forge hostname without scheme or path.",
			project_path: "Repository path with separators encoded for transport.",
			mr_iid: "Merge request or pull request number.",
			detection_source: "Tool surface where creation was observed.",
			model: "Session model identifier, or null.",
			workspace_name: "Workspace label, never an absolute path.",
			cwd_path: "Path relative to the workspace, with separators encoded.",
			stats_status: "Outcome of the follow-up statistics query.",
			additions_count: "Lines added, or null when unavailable.",
			deletions_count: "Lines deleted, or null when unavailable.",
			changed_files_count: "Files touched, or null when unavailable.",
		},
	},
	slash_command_used: {
		owner: "clients",
		comment: "Which slash commands are used, without recording arguments.",
		properties: {
			command: "Command name as typed, without arguments.",
			recognized: "Whether a handler was available.",
		},
	},
	permission_mode_toggled: {
		owner: "clients",
		comment: "Permission preset changes made through the UI.",
		properties: {
			mode: "Preset selected.",
			source: "Shortcut or slash command source.",
		},
	},
	clarification_resolved: {
		owner: "core",
		comment: "Whether a structured clarification was answered or abandoned.",
		properties: {
			outcome: "Option picked, freeform answer, or cancellation.",
			option_count: "Choices offered, zero for open-ended input.",
			duration_ms: "Time from prompt to resolution.",
		},
	},
	plan_updated: {
		owner: "core",
		comment: "Plan size and progress shape.",
		properties: {
			item_count: "Steps in the plan after the update.",
			completed_count: "Steps marked completed.",
			in_progress_count: "Steps currently in progress.",
			created: "Whether this was the first plan in the session.",
			source: "Who initiated the active plan mode: user, agent, or unknown.",
		},
	},
	plan_mode_entered: {
		owner: "core",
		comment: "Plan-mode entries split by who initiated planning.",
		properties: {
			source: "user for /plan or --plan, agent for enter_plan_mode.",
		},
	},
	plan_mode_exited: {
		owner: "core",
		comment: "Plan-mode exits with the approval outcome.",
		properties: {
			source: "Who initiated the exited plan mode: user, agent, or unknown.",
			outcome: "approved, toggled_off, auto_headless, or auto_rpc.",
		},
	},
	cron_scheduled: {
		owner: "core",
		comment: "Scheduled-task adoption split by recurring versus one-shot.",
		properties: {
			recurring: "Whether the job repeats.",
		},
	},
	cron_deleted: {
		owner: "core",
		comment: "Scheduled-task cancellations, including unknown ids.",
		properties: {
			found: "Whether the id matched a live job.",
		},
	},
	cron_fired: {
		owner: "gateway",
		comment: "Scheduled tasks that actually ran.",
		properties: {
			recurring: "Whether the job repeats.",
		},
	},
	cron_missed: {
		owner: "gateway",
		comment: "Fire times missed while a session was closed.",
		properties: {
			trigger_count: "Number of missed fire times.",
		},
	},
	cron_deferred: {
		owner: "gateway",
		comment: "Cron jobs held until the active turn becomes idle.",
		properties: {
			id: "Opaque cron job identifier.",
			defer_count: "Number of defer attempts for this job.",
		},
	},
	cron_expired: {
		owner: "gateway",
		comment: "Recurring jobs removed at the seven-day expiry boundary.",
		properties: {
			id: "Opaque cron job identifier.",
			recurring: "Whether the expired job was recurring.",
		},
	},
	workflow_started: {
		owner: "core",
		comment: "Isolated workflow runs started by the workflow tool.",
		properties: {
			phase_count: "Number of declared phases at start, without script contents.",
		},
	},
	workflow_phase: {
		owner: "core",
		comment: "Workflow phase transitions and their ordinal position.",
		properties: {
			title_length: "Length of the redacted phase title.",
			phase_index: "Zero-based phase index.",
		},
	},
	workflow_agent_started: {
		owner: "core",
		comment: "Agent calls launched by an isolated workflow.",
		properties: {
			label_length: "Length of the agent label, never its contents.",
			phase_length: "Length of the associated phase label.",
		},
	},
	workflow_agent_finished: {
		owner: "core",
		comment: "Terminal status and token shape for workflow agent calls.",
		properties: {
			status: "completed, failed, or cached.",
			cached: "Whether the result came from a resume journal.",
			token_count: "Input plus output tokens accounted for this call.",
		},
	},
	workflow_schema_failed: {
		owner: "core",
		comment: "Structured output validation retries.",
		properties: {
			attempt: "One-based validation attempt.",
			error_count: "Number of validation errors returned.",
		},
	},
	workflow_acl_blocked: {
		owner: "security",
		comment: "Workflow path or role access rejected by the ACL boundary.",
		properties: {
			operation: "Read, write, or execute operation class.",
			reason_code: "Fixed reason category.",
		},
	},
	workflow_budget_exceeded: {
		owner: "core",
		comment: "Workflow stopped after crossing its token budget.",
		properties: {
			spent_tokens: "Tokens spent before the rejected call.",
			requested_tokens: "Tokens requested by the rejected call.",
		},
	},
	workflow_resumed: {
		owner: "core",
		comment: "Workflow reused a verified journal prefix.",
		properties: {
			cache_hits: "Number of cached agent calls reused so far.",
		},
	},
	workflow_finished: {
		owner: "core",
		comment: "Workflow run terminal status and bounded cost dimensions.",
		properties: {
			status: "completed, failed, aborted, or budget_exceeded.",
			agent_count: "Logical agent calls in the run.",
			cache_hits: "Journal results reused by resume.",
			spent_tokens: "Input plus output tokens accounted for the run.",
		},
	},
	workflow_hoh_iteration: {
		owner: "core",
		comment: "HoH Planner, Developer, and QA iteration count.",
		properties: {
			iteration: "One-based iteration number.",
		},
	},
	workflow_hoh_evidence_written: {
		owner: "core",
		comment: "Structured HoH evidence persisted for replay and handoff.",
		properties: {
			iteration: "One-based iteration number.",
			spec_coverage_percent: "QA-reported specification coverage, rounded to percent.",
			coverage_delta_percent: "Coverage change from the previous iteration, rounded to percent.",
		},
	},
	workflow_hoh_finished: {
		owner: "core",
		comment: "HoH iteration terminal reason and achieved coverage.",
		properties: {
			iterations: "Number of completed or stopped iterations.",
			stop_reason: "Fixed termination category.",
			spec_coverage_percent: "Final specification coverage, rounded to percent.",
		},
	},
	goal_command_used: {
		owner: "clients",
		comment: "Which goal subcommands are used.",
		properties: {
			subcommand: "Subcommand invoked, root for the bare form.",
		},
	},
	goal_continued: {
		owner: "gateway",
		comment: "Native stop-boundary continuation for an active goal.",
		properties: {
			iteration: "Goal iteration that requested the continuation.",
			delivery: "queued while agent_end is settling, or immediate when idle.",
		},
	},
	error_raised: {
		owner: "runtime",
		comment: "Handled failures classified without exporting their messages.",
		properties: {
			error_type: "Error class or normalized code.",
			where: "Coarse call site from a closed vocabulary.",
			retryable: "Whether the runtime considered a retry.",
		},
	},
	feedback_submitted: {
		owner: "clients",
		comment: "Feedback volume and shape without recording its text.",
		properties: {
			category: "Fixed feedback category.",
			has_comment: "Whether any comment was supplied.",
			comment_length_count: "Comment length, never its contents.",
			diagnostics_included: "Whether bounded diagnostics were attached.",
			surface: "CLI or TUI submission surface.",
			delivered: "Whether the submission was accepted rather than queued.",
			bundle_included: "Whether a session archive was attached.",
			bundle_bytes: "Compressed archive size, or zero when absent.",
		},
	},
	tui_input_anomaly: {
		owner: "clients",
		comment: "Bounded shape/count signal for terminal input anomalies; no keystrokes are recorded.",
		properties: {
			kind: "Detector category.",
			chunk_count: "Raw chunks seen without dispatch.",
			raw_bytes: "Bytes in those chunks, never their content.",
			paste_open: "Whether a bracketed paste was still open.",
			term: "TERM value for terminal grouping.",
			is_tty: "Whether stdin was a terminal.",
			trace_enabled: "Whether a local full trace was also being written.",
		},
	},
};

/** Compatibility aliases matching the names used by the former registry. */
export const telemetryEventDefinitions = STEP_TELEMETRY_EVENT_DEFINITIONS;
export const telemetryEventNames = STEP_TELEMETRY_EVENT_NAMES;
