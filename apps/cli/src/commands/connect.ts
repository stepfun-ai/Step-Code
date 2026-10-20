export type ConnectIntent = "connect" | "disconnect" | "invalid";

export function parseConnectCommand(args: string): ConnectIntent {
	const value = args.trim().replace(/\s+/g, " ");
	if (value === "" || value === "lark") return "connect";
	if (value === "off" || value === "lark off") return "disconnect";
	return "invalid";
}
