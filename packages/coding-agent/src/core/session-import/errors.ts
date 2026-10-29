export class SessionImportError extends Error {
	readonly status: number;

	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}
