import { config } from "../config.js";

export type QueryValue = string | number | boolean | undefined | null;

export interface HttpGetOptions {
  params?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Response parsing. Defaults to "json". */
  accept?: "json" | "text";
  /** Retries on 429 / 5xx. Defaults to 2. */
  retries?: number;
}

export class HttpError extends Error {
  /** Provider-specific guidance safe to show to the MCP client. */
  hint?: string;

  constructor(
    public status: number,
    public url: string,
    public body: string,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

/** Append query params to a URL, dropping undefined/null values. */
export function withParams(
  base: string,
  params?: Record<string, QueryValue>,
): string {
  if (!params) return base;
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Map a thrown error into a concise, actionable message for the model. */
export function formatHttpError(err: unknown): string {
  if (err instanceof HttpError) {
    const tag = `(HTTP ${err.status})`;
    switch (err.status) {
      case 400:
        return `Bad request ${tag} — check parameters (symbol/id/date formats).`;
      case 401:
        return `Unauthorized ${tag} — this endpoint now requires auth or a crumb/token.`;
      case 403:
        return `Forbidden ${tag} — the provider refused the request; the response does not establish why.${err.hint ? ` ${err.hint}` : ""}`;
      case 404:
        return `Not found ${tag} — verify the identifier (ticker/CIK/instId/series/slug).`;
      case 429:
        return `Rate limited ${tag} — wait and retry, or reduce request frequency.`;
      case 451:
        return `Geo-restricted ${tag} — this provider blocks your region; use the documented alternative.`;
      default:
        if (err.status >= 500) {
          return `Upstream server error ${tag} — often transient or caused by too-large a query; narrow the range/period and retry.`;
        }
        return `Request failed ${tag}.`;
    }
  }
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return "Request timed out — the upstream source was slow; retry or narrow the query.";
    }
    return `Unexpected error: ${err.message}`;
  }
  return `Unexpected error: ${String(err)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function httpGet<T = unknown>(
  url: string,
  opts: HttpGetOptions = {},
): Promise<T> {
  const finalUrl = withParams(url, opts.params);
  const timeoutMs = opts.timeoutMs ?? config.httpTimeoutMs;
  const retries = opts.retries ?? 2;
  const accept = opts.accept ?? "json";

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(finalUrl, {
        method: "GET",
        signal: controller.signal,
        headers: {
          Accept: accept === "json" ? "application/json" : "text/plain, */*",
          // Node's undici defaults to `Accept-Language: *`, which some servers
          // (e.g. OECD SDMX) can't parse and answer with a 500. Send a valid tag.
          "Accept-Language": "en",
          ...opts.headers,
        },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // Retry transient failures.
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          await sleep(400 * (attempt + 1));
          lastError = new HttpError(res.status, finalUrl, body);
          continue;
        }
        throw new HttpError(res.status, finalUrl, body);
      }

      if (accept === "text") return (await res.text()) as T;
      const text = await res.text();
      if (!text) return null as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        // Some APIs mislabel content-type; fall back to raw text.
        return text as T;
      }
    } catch (err) {
      lastError = err;
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (attempt < retries && (isAbort || err instanceof TypeError)) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error(`Request failed: ${finalUrl}`);
}
