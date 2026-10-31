// The factory's HTTP API as the CLI (and the tests) use it: JSON in and out, the API token as a
// bearer, the server's own error message on failure, and the live event stream read as SSE.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export type Options = { url?: string; token?: string; fetch?: typeof fetch };
export type SseMessage = { event: string; data: string; id?: string };

export type Client = {
  url: string;
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  /** Opens a server-sent event stream; the caller reads it with `sse(res.body)`. */
  stream(path: string, signal?: AbortSignal): Promise<Response>;
};

export function client(o: Options = {}): Client {
  const url = (o.url || process.env.FACTORY_URL || "http://127.0.0.1:8282").replace(/\/+$/, "");
  const token = o.token ?? process.env.FACTORY_TOKEN ?? "";
  const f = o.fetch ?? fetch;
  const headers = (extra: Record<string, string> = {}) => ({ accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra });

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await f(`${url}${path}`, { method, headers: headers(body === undefined ? {} : { "content-type": "application/json" }), body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new ApiError(0, `cannot reach the factory at ${url}: ${e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)}`);
    }
    const text = await res.text();
    let data: unknown = undefined;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
    if (!res.ok) {
      const msg = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : text.trim().slice(0, 300) || res.statusText;
      throw new ApiError(res.status, res.status === 401 && !token ? `${msg} (set FACTORY_TOKEN to an API token from Settings)` : msg);
    }
    return data as T;
  }

  return {
    url,
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body ?? {}),
    async stream(path, signal) {
      const res = await f(`${url}${path}`, { headers: headers({ accept: "text/event-stream" }), signal });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        let msg = text.trim().slice(0, 300) || res.statusText;
        try { msg = String(JSON.parse(text).error ?? msg); } catch { /* not JSON */ }
        throw new ApiError(res.status, msg);
      }
      return res;
    },
  };
}

/** Reads a server-sent event stream message by message (event, data, id), tolerating chunks split anywhere. */
export async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  let buf = "";
  let msg: { event?: string; data: string[]; id?: string } = { data: [] };
  const done = () => { const m = msg.data.length || msg.event ? { event: msg.event || "message", data: msg.data.join("\n"), id: msg.id } : null; msg = { data: [] }; return m; };
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n/)) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + (buf[i] === "\r" ? 2 : 1));
      if (line === "") { const m = done(); if (m) yield m; continue; }
      if (line.startsWith(":")) continue;
      const c = line.indexOf(":");
      const field = c < 0 ? line : line.slice(0, c);
      const value = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
      if (field === "event") msg.event = value;
      else if (field === "data") msg.data.push(value);
      else if (field === "id") msg.id = value;
    }
  }
  const m = done();
  if (m) yield m;
}
