import type { Component, Container } from "@step-harness/pi-tui";

interface TaskUpdateTranscriptState {
	nextOrdinal: number;
	callOrdinals: Map<string, number>;
	latestSuccessful?: {
		ordinal: number;
		component: Component;
	};
}

const transcriptStates = new WeakMap<Container, TaskUpdateTranscriptState>();

export function resetTaskUpdateTranscript(container: Container): void {
	transcriptStates.set(container, {
		nextOrdinal: 0,
		callOrdinals: new Map(),
	});
}

export function registerTaskUpdateCall(container: Container, toolCallId: string): void {
	const state = getState(container);
	if (state.callOrdinals.has(toolCallId)) return;
	state.nextOrdinal += 1;
	state.callOrdinals.set(toolCallId, state.nextOrdinal);
}

export function keepLatestTaskUpdateResult(
	container: Container,
	toolCallId: string,
	component: Component,
	isError: boolean,
): void {
	const state = getState(container);
	const ordinal = state.callOrdinals.get(toolCallId);
	if (ordinal === undefined) return;
	state.callOrdinals.delete(toolCallId);
	if (isError) return;

	if (state.latestSuccessful && ordinal < state.latestSuccessful.ordinal) {
		container.removeChild(component);
		return;
	}

	if (state.latestSuccessful && state.latestSuccessful.component !== component) {
		container.removeChild(state.latestSuccessful.component);
	}
	state.latestSuccessful = { ordinal, component };
}

function getState(container: Container): TaskUpdateTranscriptState {
	let state = transcriptStates.get(container);
	if (!state) {
		resetTaskUpdateTranscript(container);
		state = transcriptStates.get(container)!;
	}
	return state;
}
