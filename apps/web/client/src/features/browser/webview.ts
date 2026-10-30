/**
 * The slice of Electron's `<webview>` element the embedded browser uses. The client has no Electron
 * dependency, so the element is described here; it exists only inside StepCode Desktop, whose main process
 * approves every attachment (`apps/desktop/src/browser-guests.ts`). The JSX element itself is declared by
 * `@types/react` (`webview`).
 */
export interface WebviewElement extends HTMLElement {
	loadURL(url: string): Promise<void>;
	getURL(): string;
	getTitle(): string;
	canGoBack(): boolean;
	canGoForward(): boolean;
	goBack(): void;
	goForward(): void;
	reload(): void;
	stop(): void;
	isLoading(): boolean;
	setZoomFactor(factor: number): void;
}

/** A string field of a webview event (`url`, `title`, `errorDescription`), or undefined. */
export function eventString(event: Event, field: string): string | undefined {
	const value: unknown = Reflect.get(event, field);
	return typeof value === "string" ? value : undefined;
}

/** A number field of a webview event (`errorCode`), or undefined. */
export function eventNumber(event: Event, field: string): number | undefined {
	const value: unknown = Reflect.get(event, field);
	return typeof value === "number" ? value : undefined;
}

/** A boolean field of a webview event (`isMainFrame`), or undefined. */
export function eventBoolean(event: Event, field: string): boolean | undefined {
	const value: unknown = Reflect.get(event, field);
	return typeof value === "boolean" ? value : undefined;
}
