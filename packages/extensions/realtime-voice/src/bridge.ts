/** Vendor / transport bridge (S6-2). First-phase MOCK: no real ASR/TTS or transport. */
export interface MockBridge {
	dispose(): Promise<void>;
}

export function createMockBridge(): MockBridge {
	return {
		async dispose() {},
	};
}
