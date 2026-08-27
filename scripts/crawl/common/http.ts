import { lookup as dnsLookup } from "node:dns/promises";
import { readFile, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { join } from "node:path";
import { isIP } from "node:net";
import { withFileLock } from "./files.ts";

export type HttpErrorCode =
  | "UNSAFE_URL"
  | "TIMEOUT"
  | "HTTP_STATUS"
  | "CONTENT_TYPE"
  | "RESPONSE_TOO_LARGE"
  | "REDIRECT"
  | "REDIRECT_LIMIT";

export class CrawlerHttpError extends Error {
  public readonly code: HttpErrorCode;
  public readonly details: Record<string, unknown>;

  constructor(code: HttpErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CrawlerHttpError";
    this.code = code;
    this.details = details;
  }
}

export interface OfficialHttpResponse {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

export type PinnedFetchImpl = (url: URL, init: RequestInit, address: string) => Promise<Response>;

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
  pinnedFetchImpl?: PinnedFetchImpl;
  lookup?: (hostname: string) => Promise<string[]>;
}

const lastRequestAt = new Map<string, number>();
const retryableStatus = (status: number) => status === 429 || status >= 500;

function parseIpv4Words(value: string): number[] | undefined {
  if (isIP(value) !== 4) return undefined;
  const words = value.split(".").map(Number);
  return words.length === 4 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 255) ? words : undefined;
}

function parseIpv6Words(value: string): number[] | undefined {
  let normalized = value;
  if (normalized.includes(".")) {
    const separator = normalized.lastIndexOf(":");
    if (separator < 0) return undefined;
    const ipv4 = parseIpv4Words(normalized.slice(separator + 1));
    if (!ipv4) return undefined;
    const first = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const second = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    normalized = `${normalized.slice(0, separator + 1)}${first}:${second}`;
  }
  const sections = normalized.split("::");
  if (sections.length > 2) return undefined;
  const parseSection = (section: string): number[] => section ? section.split(":").map((part) => {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) throw new Error("invalid IPv6 section");
    return Number.parseInt(part, 16);
  }) : [];
  try {
    const left = parseSection(sections[0]);
    const right = sections.length === 2 ? parseSection(sections[1]) : [];
    if (sections.length === 1 && left.length !== 8) return undefined;
    if (sections.length === 2 && left.length + right.length >= 8) return undefined;
    return sections.length === 2 ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right] : left;
  } catch {
    return undefined;
  }
}

function isUnsafeIpv4(words: number[]): boolean {
  const [first, second] = words;
  return first === 0 || first === 10 || first === 127 || first === 169 && second === 254
    || first === 172 && second >= 16 && second <= 31
    || first === 192 && second === 0 || first === 192 && second === 168
    || first === 198 && (second === 18 || second === 19 || second === 51)
    || first === 203 && second === 0
    || first === 100 && second >= 64 && second <= 127
    || first >= 240;
}

function isPrivateAddress(rawAddress: string): boolean {
  const address = rawAddress.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv4 = parseIpv4Words(address);
  if (ipv4) return isUnsafeIpv4(ipv4);
  if (isIP(address) === 0) return false;
  if (isIP(address) !== 6) return true;
  const words = parseIpv6Words(address);
  if (!words) return true;
  const allZero = words.every((word) => word === 0);
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const mapped = words.slice(0, 5).every((word) => word === 0) && (words[5] === 0 || words[5] === 0xffff);
  if (mapped) return isUnsafeIpv4([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255]);
  return allZero || loopback
    || (words[0] & 0xfe00) === 0xfc00
    || (words[0] & 0xffc0) === 0xfe80
    || (words[0] === 0x2001 && words[1] === 0x0db8)
    || (words[0] & 0xff00) === 0xff00;
}

async function assertResolvedHost(hostname: string, lookup: FetchOfficialOptions["lookup"]): Promise<string[]> {
  if (isIP(hostname) !== 0) {
    throw new CrawlerHttpError("UNSAFE_URL", `IP literal is not allowed: ${hostname}`);
  }
  let addresses: string[];
  try {
    addresses = await (lookup ?? (async (host) => (await dnsLookup(host, { all: true })).map(({ address }) => address)))(hostname);
  } catch (error) {
    throw new CrawlerHttpError("UNSAFE_URL", `host could not be resolved: ${hostname}`, { cause: (error as Error).message });
  }
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((address) => isIP(address) === 0 || isPrivateAddress(address))) {
    throw new CrawlerHttpError("UNSAFE_URL", `host did not resolve to safe public addresses: ${hostname}`);
  }
  return addresses;
}

function redactedUrl(rawUrl: string, base?: URL): string {
  try {
    const url = base ? new URL(rawUrl, base) : new URL(rawUrl);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

async function assertSafeUrl(rawUrl: string, allowedHosts: string[], lookup: FetchOfficialOptions["lookup"]): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CrawlerHttpError("UNSAFE_URL", "invalid URL");
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || !allowedHosts.map((host) => host.toLowerCase()).includes(hostname)) {
    throw new CrawlerHttpError("UNSAFE_URL", `URL is not an allowed HTTPS official URL: ${redactedUrl(rawUrl)}`);
  }
  const addresses = await assertResolvedHost(hostname, lookup);
  return { url, addresses };
}

async function waitForHost(host: string, intervalMs: number): Promise<void> {
  const lockName = host.replace(/[^a-z0-9.-]/gi, "_");
  const lockPath = join(tmpdir(), "game-event-gantt-crawler-host-locks", `${lockName}.throttle`);
  const timestampPath = `${lockPath}.state`;
  await withFileLock(lockPath, async () => {
    let previous = lastRequestAt.get(host) ?? 0;
    try {
      const persisted = Number(await readFile(timestampPath, "utf8"));
      if (Number.isFinite(persisted)) previous = Math.max(previous, persisted);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const waitMs = Math.max(0, intervalMs - (Date.now() - previous));
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    const reservedAt = Date.now();
    lastRequestAt.set(host, reservedAt);
    await writeFile(timestampPath, `${reservedAt}\n`, "utf8");
  });
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

function nodeRequestHeaders(init: RequestInit, url: URL): Record<string, string> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
  headers.host = url.host;
  if (!("accept-encoding" in headers)) headers["accept-encoding"] = "identity";
  return headers;
}

function fetchPinned(url: URL, init: RequestInit, address: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const signal = init.signal;
    const abortError = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    let settled = false;
    const request = httpsRequest({
      hostname: address,
      agent: false,
      port: url.port ? Number(url.port) : 443,
      method: init.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      servername: url.hostname,
      headers: nodeRequestHeaders(init, url),
    }, (incoming) => {
      settled = true;
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      resolve(new Response(Readable.toWeb(incoming) as ReadableStream, {
        status: incoming.statusCode ?? 0,
        statusText: incoming.statusMessage ?? "",
        headers,
      }));
    });
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      request.destroy();
      if (!settled) {
        settled = true;
        reject(abortError);
      }
    };
    request.once("error", (error) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    request.once("close", cleanup);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    request.end();
  });
}

export async function fetchOfficial(rawUrl: string, options: FetchOfficialOptions): Promise<OfficialHttpResponse> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const intervalMs = options.minHostIntervalMs ?? 1_000;
  const retryDelays = options.retryDelaysMs ?? [1_000, 5_000];
  const maxRedirects = options.maxRedirects ?? 5;
  let url: string = rawUrl;
  let attempt = 0;
  let redirects = 0;

  while (true) {
    const validated = await assertSafeUrl(url, options.allowedHosts, options.lookup);
    const requestUrl = validated.url;
    const address = validated.addresses[0];
    if (redirects > maxRedirects) throw new CrawlerHttpError("REDIRECT_LIMIT", `redirect limit exceeded: ${maxRedirects}`);
    await waitForHost(requestUrl.hostname, intervalMs);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        const init: RequestInit = {
          redirect: "manual",
          signal: controller.signal,
          headers: { accept: "application/json, text/html, text/plain", "user-agent": options.userAgent ?? "game-event-gantt-crawler/phase1" },
        };
        if (options.pinnedFetchImpl) response = await options.pinnedFetchImpl(requestUrl, init, address);
        else if (options.fetchImpl) response = await options.fetchImpl(requestUrl, init);
        else response = await fetchPinned(requestUrl, init, address);
      } catch (error) {
        if (error instanceof CrawlerHttpError) throw error;
        if ((error as Error).name === "AbortError") throw new CrawlerHttpError("TIMEOUT", `request timed out after ${timeoutMs}ms`);
        throw new CrawlerHttpError("HTTP_STATUS", (error as Error).message);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new CrawlerHttpError("REDIRECT", "redirect response has no location", { status: response.status });
        if (redirects >= maxRedirects) throw new CrawlerHttpError("REDIRECT_LIMIT", `redirect limit exceeded: ${maxRedirects}`);
        await response.body?.cancel().catch(() => undefined);
        redirects += 1;
        let redirectedUrl: string;
        try {
          redirectedUrl = new URL(location, requestUrl).toString();
        } catch {
          throw new CrawlerHttpError("REDIRECT", "redirect location is invalid", { status: response.status, location: redactedUrl(location, requestUrl) });
        }
        url = redirectedUrl;
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
      const allowedContentTypes = (options.allowedContentTypes ?? ["application/json", "text/html", "text/plain"])
        .map((value) => value.toLowerCase().split(";", 1)[0].trim());
      if (!contentType || !allowedContentTypes.includes(contentType)) {
        throw new CrawlerHttpError("CONTENT_TYPE", `unsupported content type: ${contentType || "missing"}`, { contentType });
      }
      return { url: requestUrl.toString(), status: response.status, contentType, body: await readLimitedBody(response, maxBytes, controller.signal) };
    } finally {
      clearTimeout(timeout);
    }
  }
}
