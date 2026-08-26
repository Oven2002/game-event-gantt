import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type HttpErrorCode =
  | "UNSAFE_URL"
  | "TIMEOUT"
  | "HTTP_STATUS"
  | "CONTENT_TYPE"
  | "RESPONSE_TOO_LARGE"
  | "REDIRECT"
  | "REDIRECT_LIMIT";

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

export interface FetchOfficialOptions {
  allowedHosts: string[];
  allowedContentTypes?: string[];
  timeoutMs?: number;
  maxBytes?: number;
  minHostIntervalMs?: number;
  retryDelaysMs?: number[];
  maxRedirects?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  lookup?: (hostname: string) => Promise<string[]>;
}

const lastRequestAt = new Map<string, number>();
const retryableStatus = (status: number) => status === 429 || status >= 500;

function isPrivateAddress(rawAddress: string): boolean {
  const address = rawAddress.toLowerCase().replace(/^\[|\]$/g, "");
  const mappedIpv4 = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mappedIpv4 ?? (isIP(address) === 4 ? address : undefined);
  if (ipv4) {
    const octets = ipv4.split(".").map(Number);
    const [first, second] = octets;
    return first === 0 || first === 10 || first === 127 || first === 169 && second === 254
      || first === 172 && second >= 16 && second <= 31
      || first === 192 && second === 0 || first === 192 && second === 168
      || first === 198 && (second === 18 || second === 19)
      || first === 100 && second >= 64 && second <= 127;
  }
  if (isIP(address) !== 6) return false;
  return address === "::1" || address === "::" || address.startsWith("fc") || address.startsWith("fd")
    || address.startsWith("fe8") || address.startsWith("fe9") || address.startsWith("fea") || address.startsWith("feb")
    || address.startsWith("fec") || address.startsWith("fed") || address.startsWith("fee") || address.startsWith("fef");
}

async function assertResolvedHost(hostname: string, lookup: FetchOfficialOptions["lookup"]): Promise<void> {
  if (isPrivateAddress(hostname)) {
    throw new CrawlerHttpError("UNSAFE_URL", `private address is not allowed: ${hostname}`);
  }
  if (isIP(hostname) === 0) {
    let addresses: string[];
    try {
      addresses = await (lookup ?? (async (host) => (await dnsLookup(host, { all: true })).map(({ address }) => address)))(hostname);
    } catch (error) {
      throw new CrawlerHttpError("UNSAFE_URL", `host could not be resolved: ${hostname}`, { cause: (error as Error).message });
    }
    if (addresses.some(isPrivateAddress)) throw new CrawlerHttpError("UNSAFE_URL", `host resolves to a private address: ${hostname}`);
  }
}

async function assertSafeUrl(rawUrl: string, allowedHosts: string[], lookup: FetchOfficialOptions["lookup"]): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CrawlerHttpError("UNSAFE_URL", "invalid URL");
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || !allowedHosts.map((host) => host.toLowerCase()).includes(hostname)) {
    throw new CrawlerHttpError("UNSAFE_URL", `URL is not an allowed HTTPS official URL: ${rawUrl}`);
  }
  await assertResolvedHost(hostname, lookup);
  return url;
}

async function waitForHost(host: string, intervalMs: number): Promise<void> {
  const previous = lastRequestAt.get(host) ?? 0;
  const waitMs = Math.max(0, intervalMs - (Date.now() - previous));
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastRequestAt.set(host, Date.now());
}

async function readLimitedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new CrawlerHttpError("TIMEOUT", "response body timed out"));
    signal.addEventListener("abort", () => reject(new CrawlerHttpError("TIMEOUT", "response body timed out")), { once: true });
  });
  try {
    while (true) {
      const item = await Promise.race([reader.read(), abort]);
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new CrawlerHttpError("RESPONSE_TOO_LARGE", `response exceeds ${maxBytes} bytes`);
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof CrawlerHttpError) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    await reader.cancel().catch(() => undefined);
    throw error;
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
  const maxRedirects = options.maxRedirects ?? 5;
  const fetchImpl = options.fetchImpl ?? fetch;
  let url = await assertSafeUrl(rawUrl, options.allowedHosts, options.lookup);
  let attempt = 0;
  let redirects = 0;

  while (true) {
    if (redirects > maxRedirects) throw new CrawlerHttpError("REDIRECT_LIMIT", `redirect limit exceeded: ${maxRedirects}`);
    await waitForHost(url.hostname, intervalMs);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
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
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new CrawlerHttpError("REDIRECT", "redirect response has no location", { status: response.status });
        await response.body?.cancel().catch(() => undefined);
        redirects += 1;
        url = await assertSafeUrl(new URL(location, url).toString(), options.allowedHosts, options.lookup);
        continue;
      }

      if (!response.ok) {
        if (retryableStatus(response.status) && attempt < retryDelays.length) {
          await response.body?.cancel().catch(() => undefined);
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
      return { url: url.toString(), status: response.status, contentType, body: await readLimitedBody(response, maxBytes, controller.signal) };
    } finally {
      clearTimeout(timeout);
    }
  }
}
