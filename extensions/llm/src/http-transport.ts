import type {
  LlmTraceContext,
  LlmTraceRecord,
  LlmTraceResponsePayload,
} from "@step-cli/protocol";

export interface HttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  trace?: LlmTraceContext;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  bodyText: string;
}

export interface HttpStreamEvent {
  event: string;
  data: string;
}

export interface HttpTransport {
  request(request: HttpRequest): Promise<HttpResponse>;
  requestStream?(
    request: HttpRequest,
    onEvent: (event: HttpStreamEvent) => Promise<void> | void,
  ): Promise<HttpResponse>;
}

export type HttpTraceRecord = LlmTraceRecord;

export interface HttpTraceRecorder {
  record(record: HttpTraceRecord): Promise<void> | void;
}

export interface FetchHttpTransportOptions {
  traceRecorder?: HttpTraceRecorder;
  maxTraceBodyBytes?: number;
  traceHeaderInjectionBaseUrls?: string[];
}

export class FetchHttpTransport implements HttpTransport {
  private readonly traceRecorder?: HttpTraceRecorder;
  private readonly maxTraceBodyBytes: number;
  private readonly traceHeaderInjectionBaseUrls: string[];

  constructor(options: FetchHttpTransportOptions = {}) {
    this.traceRecorder = options.traceRecorder;
    this.maxTraceBodyBytes = Math.max(
      256,
      options.maxTraceBodyBytes ?? 1 << 20,
    );
    this.traceHeaderInjectionBaseUrls = normalizeBaseUrlList(
      options.traceHeaderInjectionBaseUrls,
    );
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    return withAbortHandling(request, async (signal, headers) => {
      const startedAt = Date.now();
      const requestHeaders = injectTraceHeaders(
        request,
        headers,
        this.traceHeaderInjectionBaseUrls,
      );
      try {
        const response = await fetch(
          request.url,
          buildFetchInit(request, signal, requestHeaders),
        );

        const bodyText = await response.text();
        await this.recordTrace(
          buildTraceRecord({
            trace: request.trace,
            request,
            headers: requestHeaders,
            startedAt,
            maxTraceBodyBytes: this.maxTraceBodyBytes,
            response: {
              status: response.status,
              headers: cloneFetchHeaders(response.headers),
              body: truncateTraceText(bodyText, this.maxTraceBodyBytes),
            },
          }),
        );

        return {
          status: response.status,
          ok: response.ok,
          bodyText,
        };
      } catch (error) {
        await this.recordTrace(
          buildTraceRecord({
            trace: request.trace,
            request,
            headers: requestHeaders,
            startedAt,
            maxTraceBodyBytes: this.maxTraceBodyBytes,
            error: describeError(error),
          }),
        );
        throw error;
      }
    });
  }

  async requestStream(
    request: HttpRequest,
    onEvent: (event: HttpStreamEvent) => Promise<void> | void,
  ): Promise<HttpResponse> {
    return withAbortHandling(request, async (signal, headers) => {
      const startedAt = Date.now();
      const requestHeaders = injectTraceHeaders(
        request,
        headers,
        this.traceHeaderInjectionBaseUrls,
      );
      try {
        const response = await fetch(
          request.url,
          buildFetchInit(request, signal, requestHeaders),
        );

        if (!response.ok) {
          const bodyText = await response.text();
          await this.recordTrace(
            buildTraceRecord({
              trace: request.trace,
              request,
              headers: requestHeaders,
              startedAt,
              maxTraceBodyBytes: this.maxTraceBodyBytes,
              response: {
                status: response.status,
                headers: cloneFetchHeaders(response.headers),
                body: truncateTraceText(bodyText, this.maxTraceBodyBytes),
              },
            }),
          );
          return {
            status: response.status,
            ok: response.ok,
            bodyText,
          };
        }

        if (!response.body) {
          await this.recordTrace(
            buildTraceRecord({
              trace: request.trace,
              request,
              headers: requestHeaders,
              startedAt,
              maxTraceBodyBytes: this.maxTraceBodyBytes,
              response: {
                status: response.status,
                headers: cloneFetchHeaders(response.headers),
                body: "",
              },
            }),
          );
          return {
            status: response.status,
            ok: response.ok,
            bodyText: "",
          };
        }

        const bodyText = await consumeSseStream(response.body, onEvent);
        await this.recordTrace(
          buildTraceRecord({
            trace: request.trace,
            request,
            headers: requestHeaders,
            startedAt,
            maxTraceBodyBytes: this.maxTraceBodyBytes,
            response: {
              status: response.status,
              headers: cloneFetchHeaders(response.headers),
              body: truncateTraceText(bodyText, this.maxTraceBodyBytes),
            },
          }),
        );

        return {
          status: response.status,
          ok: response.ok,
          bodyText: "",
        };
      } catch (error) {
        await this.recordTrace(
          buildTraceRecord({
            trace: request.trace,
            request,
            headers: requestHeaders,
            startedAt,
            maxTraceBodyBytes: this.maxTraceBodyBytes,
            error: describeError(error),
          }),
        );
        throw error;
      }
    });
  }

  private async recordTrace(record: HttpTraceRecord | null): Promise<void> {
    if (!record || !this.traceRecorder) {
      return;
    }

    try {
      await this.traceRecorder.record(record);
    } catch {
      // Trace capture is best-effort and must not affect request handling.
    }
  }
}

function buildFetchInit(
  request: HttpRequest,
  signal: AbortSignal,
  headers: Record<string, string>,
): RequestInit {
  const init: RequestInit = {
    method: request.method,
    headers,
    signal,
  };

  if (request.body.length > 0) {
    init.body = request.body;
  }

  return init;
}

async function withAbortHandling<T>(
  request: HttpRequest,
  work: (signal: AbortSignal, headers: Record<string, string>) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(request.signal?.reason);
  request.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
  const headers = withDefaultHeader(
    withDefaultHeader(request.headers, "accept", "*/*"),
    "user-agent",
    "step-cli/0.1",
  );

  try {
    return await work(controller.signal, headers);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      if (request.signal?.aborted) {
        throw new Error(
          `HTTP request aborted: ${String(request.signal.reason ?? "interrupted")}`,
        );
      }
      throw new Error(`HTTP request timed out after ${request.timeoutMs}ms`);
    }
    throw createHttpRequestError(request.url, error);
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", abortFromCaller);
  }
}

async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: HttpStreamEvent) => Promise<void> | void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let rawBody = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = decoder
        .decode(value, { stream: true })
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
      rawBody += chunk;
      buffer += chunk;

      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) {
          break;
        }

        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseEvent(rawEvent);
        if (parsed) {
          await onEvent(parsed);
        }
      }
    }

    const tail = decoder.decode().replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    rawBody += tail;
    buffer += tail;
    const parsed = parseSseEvent(buffer);
    if (parsed) {
      await onEvent(parsed);
    }
  } finally {
    reader.releaseLock();
  }

  return rawBody;
}

function parseSseEvent(rawEvent: string): HttpStreamEvent | null {
  const trimmed = rawEvent.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let event = "message";
  const dataLines: string[] = [];

  for (const line of rawEvent.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trimStart() || "message";
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event,
    data: dataLines.join("\n"),
  };
}

function withDefaultHeader(
  headers: Record<string, string>,
  name: string,
  value: string,
): Record<string, string> {
  const hasHeader = Object.keys(headers).some(
    (key) => key.toLowerCase() === name,
  );
  if (hasHeader) {
    return headers;
  }

  return {
    ...headers,
    [name]: value,
  };
}

function createHttpRequestError(url: string, error: unknown): Error {
  const message = `HTTP request to ${url} failed: ${describeError(error)}`;
  return error instanceof Error
    ? new Error(message, { cause: error })
    : new Error(message);
}

function describeError(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      current = "cause" in current ? current.cause : undefined;
      continue;
    }

    messages.push(String(current));
    break;
  }

  return messages.join("; caused by: ");
}

function buildTraceRecord(input: {
  trace: LlmTraceContext | undefined;
  request: HttpRequest;
  headers: Record<string, string>;
  startedAt: number;
  maxTraceBodyBytes: number;
  response?: LlmTraceResponsePayload;
  error?: string;
}): HttpTraceRecord | null {
  const trace = input.trace;
  if (!trace?.sessionId || !trace.spanId || !trace.provider || !trace.model) {
    return null;
  }

  const finishedAt = new Date();
  return {
    ...trace,
    sessionId: trace.sessionId,
    spanId: trace.spanId,
    provider: trace.provider,
    model: trace.model,
    startedAt: new Date(input.startedAt).toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - input.startedAt),
    request: {
      method: input.request.method,
      url: input.request.url,
      headers: cloneRequestHeaders(input.headers),
      body: truncateTraceText(input.request.body, input.maxTraceBodyBytes),
    },
    ...(input.response ? { response: input.response } : undefined),
    ...(input.error ? { error: input.error } : undefined),
  };
}

function cloneRequestHeaders(
  headers: Record<string, string>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      [redactTraceHeader(key, value)],
    ]),
  );
}

function cloneFetchHeaders(headers: Headers): Record<string, string[]> {
  const cloned: Record<string, string[]> = {};
  headers.forEach((value, key) => {
    cloned[key] = [redactTraceHeader(key, value)];
  });
  return cloned;
}

const SENSITIVE_TRACE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie",
]);

function redactTraceHeader(name: string, value: string): string {
  return SENSITIVE_TRACE_HEADERS.has(name.toLowerCase()) ? "[REDACTED]" : value;
}

function truncateTraceText(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxBytes - 17))}\n...[truncated]`;
}

function normalizeBaseUrlList(baseUrls: string[] | undefined): string[] {
  if (!baseUrls || baseUrls.length === 0) {
    return [];
  }

  return [
    ...new Set(
      baseUrls.map((entry) => normalizeUrlPrefix(entry)).filter(Boolean),
    ),
  ];
}

function normalizeUrlPrefix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.replace(/\/+$/, "");
}

function injectTraceHeaders(
  request: HttpRequest,
  headers: Record<string, string>,
  allowedBaseUrls: string[],
): Record<string, string> {
  if (
    !request.trace ||
    allowedBaseUrls.length === 0 ||
    !matchesConfiguredBaseUrl(request.url, allowedBaseUrls)
  ) {
    return headers;
  }

  const injected = { ...headers };
  setHeaderIfPresent(injected, "x-step-session-id", request.trace.sessionId);
  setHeaderIfPresent(injected, "x-step-goal-id", request.trace.goalId);
  setHeaderIfPresent(injected, "x-step-attempt-id", request.trace.attemptId);
  setHeaderIfPresent(injected, "x-step-harness-id", request.trace.harnessId);
  setHeaderIfPresent(injected, "x-step-span-id", request.trace.spanId);
  return injected;
}

function setHeaderIfPresent(
  headers: Record<string, string>,
  name: string,
  value: string | undefined,
): void {
  if (!value) {
    return;
  }
  headers[name] = value;
}

function matchesConfiguredBaseUrl(
  requestUrl: string,
  allowedBaseUrls: string[],
): boolean {
  const normalizedRequestUrl = normalizeUrlPrefix(requestUrl);
  return allowedBaseUrls.some((baseUrl) => {
    return (
      normalizedRequestUrl === baseUrl ||
      normalizedRequestUrl.startsWith(`${baseUrl}/`) ||
      normalizedRequestUrl.startsWith(`${baseUrl}?`) ||
      normalizedRequestUrl.startsWith(`${baseUrl}#`)
    );
  });
}
