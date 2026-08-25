import { isIP } from "node:net";

export type HttpErrorCode =
  | "UNSAFE_URL"
  | "TIMEOUT"
  | "HTTP_STATUS"
  | "CONTENT_TYPE"
  | "RESPONSE_TOO_LARGE"
  | "REDIRECT";

export class CrawlerHttpError extends Error {
  constructor(
    public readonly code: HttpErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CrawlerHttpError";
  }
}

export interface OfficialHttpResponse {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

interface FetchOfficialOptions {
  allowedHosts: string[];
  allowedContentTypes?: string[];
  timeoutMs?: number;
  maxBytes?: number;
  minHostIntervalMs?: number;
  retryDelaysMs?: number[];
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

const lastRequestAt = new Map<string, number>();
const retryableStatus = (status: number) => status === 429 || status >= 500;

function assertSafeUrl(rawUrl: string, allowedHosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CrawlerHttpError("UNSAFE_URL", "invalid URL");
  }
  const hostname = url.hostname.toLowerCase();
  const privateIp = isIP(hostname) > 0 && (
    hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname.startsWith("10.")
    || hostname.startsWith("192.168.")
    || hostname.startsWith("169.254.")
    || hostname.startsWith("fc")
    || hostname.startsWith("fd")
  );
  if (url.protocol !== "https:" || url.username || url.password || privateIp || !allowedHosts.map((host) => host.toLowerCase()).includes(hostname)) {
    throw new CrawlerHttpError("UNSAFE_URL", `URL is not an allowed HTTPS official URL: ${rawUrl}`);
  }
  return url;
}

async function waitForHost(host: string, intervalMs: number): Promise<void> {
  const previous = lastRequestAt.get(host) ?? 0;
  const waitMs = Math.max(0, intervalMs - (Date.now() - previous));
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastRequestAt.set(host, Date.now());
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maxBytes) throw new CrawlerHttpError("RESPONSE_TOO_LARGE", `response exceeds ${maxBytes} bytes`);
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function fetchOfficial(rawUrl: string, options: FetchOfficialOptions): Promise<OfficialHttpResponse> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const intervalMs = options.minHostIntervalMs ?? 1_000;
  const retryDelays = options.retryDelaysMs ?? [1_000, 5_000];
  const fetchImpl = options.fetchImpl ?? fetch;
  let url = assertSafeUrl(rawUrl, options.allowedHosts);
  let attempt = 0;

  while (true) {
    await waitForHost(url.hostname, intervalMs);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "application/json, text/html, text/plain", "user-agent": options.userAgent ?? "game-event-gantt-crawler/phase1" },
      });
    } catch (error) {
      if (error instanceof CrawlerHttpError) throw error;
      if ((error as Error).name === "AbortError") throw new CrawlerHttpError("TIMEOUT", `request timed out after ${timeoutMs}ms`);
      throw new CrawlerHttpError("HTTP_STATUS", (error as Error).message);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new CrawlerHttpError("REDIRECT", "redirect response has no location", { status: response.status });
      url = assertSafeUrl(new URL(location, url).toString(), options.allowedHosts);
      continue;
    }

    if (!response.ok) {
      if (retryableStatus(response.status) && attempt < retryDelays.length) {
        const delay = retryDelays[attempt++];
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw new CrawlerHttpError("HTTP_STATUS", `official endpoint returned HTTP ${response.status}`, { status: response.status });
    }

    const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (!contentType || (options.allowedContentTypes && !options.allowedContentTypes.includes(contentType))) {
      throw new CrawlerHttpError("CONTENT_TYPE", `unsupported content type: ${contentType || "missing"}`, { contentType });
    }
    return { url: url.toString(), status: response.status, contentType, body: await readLimitedBody(response, maxBytes) };
  }
}
