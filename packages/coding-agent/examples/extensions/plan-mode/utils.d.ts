/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 */
export declare function isSafeCommand(command: string): boolean;
export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}
export declare function cleanStepText(text: string): string;
export declare function extractTodoItems(message: string): TodoItem[];
export declare function extractDoneSteps(message: string): number[];
export declare function markCompletedSteps(text: string, items: TodoItem[]): number;
//# sourceMappingURL=utils.d.ts.map
