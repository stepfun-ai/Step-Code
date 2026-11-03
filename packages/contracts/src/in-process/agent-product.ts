// The agent-product facade: how a host discovers a product's capabilities and
// opens sessions. Mirrors §2.3 of the architecture redesign. coding-agent
// implements AgentProduct. These types are self-contained so the contracts
// package stays dependency-free.

import type { AgentSessionHandle } from "./session-handle.ts";

/** Identifier for a concrete agent product. Only "coding" exists today. */
export type AgentProductId = "coding";

/** The surfaces a session can be driven through. */
export type InteractionSurface = "text";

/** Options a host passes when opening a session. */
export interface CreateAgentSessionOptions {
	/** Working directory the session operates against. */
	readonly cwd?: string;
	/** Surface the host will drive this session through. Defaults to "text". */
	readonly surface?: InteractionSurface;
	/** Resume an existing persisted session instead of starting fresh. */
	readonly resumeSessionId?: string;
	/** Opaque, product-specific model selector (e.g. a profile/model id). */
	readonly model?: string;
}

/** A snapshot of what a product can do, returned by describeCapabilities(). */
export interface AgentCapabilitySnapshot {
	readonly id: AgentProductId;
	readonly version: string;
	/** Surfaces this product's sessions can be driven through. */
	readonly surfaces: readonly InteractionSurface[];
	/** Tool names available to sessions, if the product exposes a static set. */
	readonly toolNames?: readonly string[];
}

/**
 * The stable product facade a host composes against. A host asks the product for
 * capabilities and opens sessions; it never imports product internals.
 */
export interface AgentProduct {
	readonly id: AgentProductId;
	readonly version: string;
	createSession(options: CreateAgentSessionOptions): Promise<AgentSessionHandle>;
	describeCapabilities(): AgentCapabilitySnapshot;
}
