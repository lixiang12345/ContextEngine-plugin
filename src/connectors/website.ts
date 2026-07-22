import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { nonPublicHostReason } from "../server/model-endpoint-policy.js";
import {
  SourceConnectorError,
  type ConnectorFileSnapshot,
  type ConnectorSnapshot,
  type SourceConnectorPlugin,
} from "./types.js";

const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_PAGE_BYTES = 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const MAX_LINKS_PER_PAGE = 500;
const MAX_CURSOR_LINKS = 2_000;
const MAX_CONTENT_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_CONTENT_LOCATIONS = 2_000;
const USER_AGENT = "ContextEngineBot/0.4 (+https://github.com/lixiang12345/ContextEngine-plugin)";

interface WebsiteConfig extends Record<string, unknown> {
  start_url: string;
  path_prefix: string;
  max_pages: number;
  max_depth: number;
  max_page_bytes: number;
  max_total_bytes: number;
}

interface SafeResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  url: URL;
}

interface CursorPage {
  url: string;
  path: string;
  revision: string;
  bytes: number;
  etag?: string;
  last_modified?: string;
  links: string[];
}

interface WebsiteCursor extends Record<string, unknown> {
  kind: "website-v1";
  origin: string;
  revision: string;
  pages: CursorPage[];
}

export interface WebsiteSourceConnectorOptions {
  allowPrivateNetwork?: boolean;
  timeoutMs?: number;
  lookup?: typeof dnsLookup;
}

export class WebsiteConnectorError extends SourceConnectorError {
  constructor(message: string) {
    super(message);
    this.name = "WebsiteConnectorError";
  }
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new WebsiteConnectorError(`${name} must be from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function normalizedPathPrefix(value: unknown, start: URL): string {
  const fallback = start.pathname.endsWith("/")
    ? start.pathname
    : start.pathname.slice(0, start.pathname.lastIndexOf("/") + 1);
  const raw = value === undefined ? fallback || "/" : value;
  if (
    typeof raw !== "string" ||
    !raw.startsWith("/") ||
    raw.includes("\\") ||
    /[\u0000-\u001f\u007f?#]/.test(raw)
  ) {
    throw new WebsiteConnectorError("Website path_prefix must be an absolute URL path");
  }
  const decoded = raw.split("/");
  if (decoded.some((segment) => segment === "." || segment === "..")) {
    throw new WebsiteConnectorError("Website path_prefix must not contain traversal segments");
  }
  return raw.endsWith("/") ? raw : `${raw}/`;
}

function websiteConfig(input: unknown, allowPrivateNetwork: boolean): WebsiteConfig {
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new WebsiteConnectorError("Website source configuration must be an object");
  }
  const value = input as Record<string, unknown>;
  if (typeof value.start_url !== "string" || value.start_url.length > 2048) {
    throw new WebsiteConnectorError("Website start_url is invalid");
  }
  let start: URL;
  try {
    start = new URL(value.start_url);
  } catch {
    throw new WebsiteConnectorError("Website start_url is invalid");
  }
  if (
    (start.protocol !== "https:" && !(allowPrivateNetwork && start.protocol === "http:")) ||
    start.username ||
    start.password ||
    start.hash ||
    start.search
  ) {
    throw new WebsiteConnectorError(
      "Website start_url must use HTTPS without credentials, a query, or a fragment",
    );
  }
  if (!allowPrivateNetwork) {
    const reason = nonPublicHostReason(start.hostname);
    if (reason) throw new WebsiteConnectorError(`Website start_url targets ${reason}`);
  }
  start.hash = "";
  const maxPageBytes = boundedInteger(
    value.max_page_bytes,
    DEFAULT_MAX_PAGE_BYTES,
    16 * 1024,
    5 * 1024 * 1024,
    "max_page_bytes",
  );
  const maxTotalBytes = boundedInteger(
    value.max_total_bytes,
    DEFAULT_MAX_TOTAL_BYTES,
    64 * 1024,
    100 * 1024 * 1024,
    "max_total_bytes",
  );
  if (maxTotalBytes < maxPageBytes) {
    throw new WebsiteConnectorError("max_total_bytes must be at least max_page_bytes");
  }
  const pathPrefix = normalizedPathPrefix(value.path_prefix, start);
  if (!canonicalUrl(new URL(start), start.origin, pathPrefix)) {
    throw new WebsiteConnectorError(
      "Website start_url must be inside path_prefix and identify an HTML page",
    );
  }
  return {
    start_url: start.toString(),
    path_prefix: pathPrefix,
    max_pages: boundedInteger(value.max_pages, DEFAULT_MAX_PAGES, 1, 500, "max_pages"),
    max_depth: boundedInteger(value.max_depth, DEFAULT_MAX_DEPTH, 0, 10, "max_depth"),
    max_page_bytes: maxPageBytes,
    max_total_bytes: maxTotalBytes,
  };
}

function canonicalUrl(input: URL, origin: string, prefix: string): URL | null {
  if (input.origin !== origin || input.username || input.password || input.hash) return null;
  if (input.search) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(input.pathname);
  } catch {
    return null;
  }
  if (!input.pathname.startsWith(prefix) && input.pathname !== prefix.replace(/\/$/, "")) {
    return null;
  }
  if (/\.(?:avif|bmp|css|csv|docx?|eot|epub|gif|gz|ico|jpe?g|json|mp3|mp4|pdf|png|pptx?|rar|rss|svg|tar|tgz|ttf|webm|webp|woff2?|xlsx?|xml|zip)$/i.test(pathname)) {
    return null;
  }
  input.hash = "";
  return input;
}

function documentPath(url: URL): string {
  let pathname = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (!pathname || pathname.endsWith("/")) pathname += "index";
  pathname = pathname
    .split("/")
    .map((segment) => segment.replace(/[^A-Za-z0-9._-]+/g, "-") || "page")
    .join("/");
  return `website/${pathname}.md`;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const radix = entity[1]?.toLowerCase() === "x" ? 16 : 10;
      const digits = radix === 16 ? entity.slice(2) : entity.slice(1);
      const code = Number.parseInt(digits, radix);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function htmlToDocument(html: string, url: URL): { content: Buffer; links: string[] } {
  const links = new Set<string>();
  const hrefPattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of html.matchAll(hrefPattern)) {
    const href = decodeEntities(match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (
      !href ||
      href.length > 2048 ||
      links.size >= MAX_LINKS_PER_PAGE ||
      /^(?:data|javascript|mailto|tel):/i.test(href)
    ) continue;
    try {
      links.add(new URL(href, url).toString());
    } catch {
      // Ignore malformed author-provided links.
    }
  }
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  let text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|hr)\b[^>]*\/?\s*>/gi, "\n")
    .replace(/<\/?(?:article|aside|blockquote|dd|div|dl|dt|figcaption|figure|footer|form|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tbody|td|th|thead|tr|ul)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  text = decodeEntities(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
  const title = titleMatch
    ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()
    : url.pathname;
  const markdown = `# ${title || url.hostname}\n\nSource: ${url.toString()}\n\n${text}\n`;
  return { content: Buffer.from(markdown, "utf8"), links: [...links].sort() };
}

function responseDocument(
  response: SafeResponse,
): { content: Buffer; links: string[] } | null {
  const contentType = String(response.headers["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
    return null;
  }
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(
    String(response.headers["content-type"] ?? ""),
  )?.[1] ?? "utf-8";
  let html: string;
  try {
    html = new TextDecoder(charset).decode(response.body);
  } catch {
    throw new WebsiteConnectorError(`Website returned unsupported charset ${charset}`);
  }
  return htmlToDocument(html, response.url);
}

interface RobotsRule {
  allow: boolean;
  path: string;
}

function robotsRules(text: string): RobotsRule[] {
  const groups: Array<{ agents: string[]; rules: RobotsRule[] }> = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let seenRule = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (!current || seenRule) {
        current = { agents: [], rules: [] };
        groups.push(current);
        seenRule = false;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current || (field !== "allow" && field !== "disallow")) continue;
    seenRule = true;
    if (value) current.rules.push({ allow: field === "allow", path: value });
  }
  const specific = groups.filter((group) =>
    group.agents.some((agent) => "contextenginebot".startsWith(agent.replace(/\/$/, "")))
  );
  const selected = specific.length
    ? specific
    : groups.filter((group) => group.agents.includes("*"));
  return selected.flatMap((group) => group.rules);
}

function robotsAllows(rules: readonly RobotsRule[], url: URL): boolean {
  const target = `${url.pathname}${url.search}`;
  let winner: RobotsRule | null = null;
  for (const rule of rules) {
    const anchored = rule.path.endsWith("$");
    const source = rule.path
      .replace(/\$$/, "")
      .split("*")
      .map((part) => part.replace(/[\\^$+?.()|[\]{}]/g, "\\$&"))
      .join(".*");
    if (!new RegExp(`^${source}${anchored ? "$" : ""}`).test(target)) continue;
    if (
      !winner ||
      rule.path.length > winner.path.length ||
      (rule.path.length === winner.path.length && rule.allow)
    ) {
      winner = rule;
    }
  }
  return winner?.allow ?? true;
}

function parsedCursor(
  value: Readonly<Record<string, unknown>> | null,
  origin: string,
): Map<string, CursorPage> {
  if (
    !value ||
    value.kind !== "website-v1" ||
    value.origin !== origin ||
    !Array.isArray(value.pages) ||
    value.pages.length > 500
  ) {
    return new Map();
  }
  const pages = new Map<string, CursorPage>();
  for (const raw of value.pages) {
    if (!raw || Array.isArray(raw) || typeof raw !== "object") return new Map();
    const page = raw as unknown as CursorPage;
    if (
      typeof page.url !== "string" ||
      typeof page.path !== "string" ||
      typeof page.revision !== "string" ||
      !Number.isSafeInteger(page.bytes) ||
      !Array.isArray(page.links) ||
      page.links.some((link) => typeof link !== "string")
    ) {
      return new Map();
    }
    pages.set(page.url, page);
  }
  return pages;
}

class SafeWebsiteFetcher {
  private readonly requestLookup: typeof dnsLookup;

  constructor(
    private readonly allowPrivateNetwork: boolean,
    private readonly timeoutMs: number,
    lookup: typeof dnsLookup | undefined,
  ) {
    this.requestLookup = lookup ?? dnsLookup;
  }

  async get(
    input: URL,
    maxBytes: number,
    headers: Record<string, string> = {},
    expectedOrigin = input.origin,
  ): Promise<SafeResponse> {
    let url = new URL(input);
    let requestHeaders = headers;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      if (url.origin !== expectedOrigin) {
        throw new WebsiteConnectorError("Website redirect left the configured origin");
      }
      const response = await this.getOnce(url, maxBytes, requestHeaders);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.location;
      if (typeof location !== "string" || redirects === MAX_REDIRECTS) {
        throw new WebsiteConnectorError("Website redirect is invalid or exceeds the limit");
      }
      url = new URL(location, url);
      url.hash = "";
      requestHeaders = {};
    }
    throw new WebsiteConnectorError("Website redirect exceeds the limit");
  }

  private async getOnce(
    url: URL,
    maxBytes: number,
    headers: Record<string, string>,
  ): Promise<SafeResponse> {
    if (
      (url.protocol !== "https:" && !(this.allowPrivateNetwork && url.protocol === "http:")) ||
      url.username ||
      url.password
    ) {
      throw new WebsiteConnectorError("Website request URL is not allowed");
    }
    const addresses = await this.requestLookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length) throw new WebsiteConnectorError("Website hostname did not resolve");
    if (!this.allowPrivateNetwork) {
      const blocked = addresses.find((item) => nonPublicHostReason(item.address));
      if (blocked) {
        throw new WebsiteConnectorError(
          `Website hostname resolved to ${nonPublicHostReason(blocked.address)}`,
        );
      }
    }
    const address = addresses[0];
    const pinnedLookup = (
      _hostname: string,
      _options: unknown,
      callback: (error: NodeJS.ErrnoException | null, address: string, family: 4 | 6) => void,
    ): void => callback(null, address.address, address.family as 4 | 6);
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise<SafeResponse>((resolve, reject) => {
      const req = request(url, {
        method: "GET",
        headers: {
          accept: "text/html,text/plain;q=0.9,*/*;q=0.1",
          "accept-encoding": "identity",
          "user-agent": USER_AGENT,
          ...headers,
        },
        lookup: pinnedLookup,
      }, (response) => {
        const declared = Number(response.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) {
          response.destroy();
          reject(new WebsiteConnectorError("Website response exceeds the page size limit"));
          return;
        }
        const encoding = response.headers["content-encoding"];
        if (encoding && encoding !== "identity") {
          response.destroy();
          reject(new WebsiteConnectorError("Website returned an unsupported content encoding"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy(new WebsiteConnectorError(
              "Website response exceeds the page size limit",
            ));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks, size),
          url,
        }));
        response.on("error", reject);
      });
      req.setTimeout(this.timeoutMs, () =>
        req.destroy(new WebsiteConnectorError("Website request timed out"))
      );
      req.on("error", reject);
      req.end();
    });
  }
}

export class WebsiteSourceConnector implements SourceConnectorPlugin {
  readonly provider = "website";
  readonly displayName = "Static website";
  private readonly allowPrivateNetwork: boolean;
  private readonly fetcher: SafeWebsiteFetcher;
  private readonly content = new Map<string, Buffer>();
  private readonly locations = new Map<string, string>();
  private contentBytes = 0;

  constructor(options: WebsiteSourceConnectorOptions = {}) {
    this.allowPrivateNetwork = options.allowPrivateNetwork ?? false;
    const timeoutMs = boundedInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      500,
      120_000,
      "Website timeout",
    );
    this.fetcher = new SafeWebsiteFetcher(
      this.allowPrivateNetwork,
      timeoutMs,
      options.lookup,
    );
  }

  validateConfig(input: unknown): WebsiteConfig {
    return websiteConfig(input, this.allowPrivateNetwork);
  }

  externalId(config: Readonly<Record<string, unknown>>): string {
    return websiteConfig(config, this.allowPrivateNetwork).start_url;
  }

  rootAlias(config: Readonly<Record<string, unknown>>): string {
    const start = new URL(websiteConfig(config, this.allowPrivateNetwork).start_url);
    return `website:${start.hostname}`.slice(0, 100);
  }

  private async loadRobots(
    start: URL,
    maxPageBytes: number,
  ): Promise<{ rules: RobotsRule[]; bytes: number }> {
    const robotsUrl = new URL("/robots.txt", start.origin);
    const response = await this.fetcher.get(
      robotsUrl,
      Math.min(maxPageBytes, 512 * 1024),
      {},
      start.origin,
    );
    let rules: RobotsRule[] = [];
    if (response.status === 200) {
      rules = robotsRules(response.body.toString("utf8"));
    } else if (response.status === 401 || response.status === 403) {
      rules = [{ allow: false, path: "/" }];
    } else if (
      response.status === 429 ||
      (response.status !== 404 && response.status >= 500)
    ) {
      throw new WebsiteConnectorError(
        `Website robots.txt is temporarily unavailable (${response.status})`,
      );
    }
    return { rules, bytes: response.body.length };
  }

  async listFiles(
    config: Readonly<Record<string, unknown>>,
    previousCursor: Readonly<Record<string, unknown>> | null,
  ): Promise<ConnectorSnapshot> {
    const value = websiteConfig(config, this.allowPrivateNetwork);
    const start = new URL(value.start_url);
    const robots = await this.loadRobots(start, value.max_page_bytes);
    const rules = robots.rules;
    if (!robotsAllows(rules, start)) {
      throw new WebsiteConnectorError("Website robots.txt disallows the configured start URL");
    }

    const previous = parsedCursor(previousCursor, start.origin);
    const queue: Array<{ url: URL; depth: number }> = [{ url: start, depth: 0 }];
    const queued = new Set([start.toString()]);
    const pages: CursorPage[] = [];
    let retainedCursorLinks = 0;
    let totalBytes = robots.bytes;
    let fetchedPages = 0;

    while (queue.length && fetchedPages < value.max_pages) {
      const next = queue.shift()!;
      if (!robotsAllows(rules, next.url)) continue;
      fetchedPages += 1;
      const prior = previous.get(next.url.toString());
      const conditionalHeaders: Record<string, string> = {};
      if (prior?.etag) conditionalHeaders["if-none-match"] = prior.etag;
      if (prior?.last_modified) {
        conditionalHeaders["if-modified-since"] = prior.last_modified;
      }
      const response = await this.fetcher.get(
        next.url,
        value.max_page_bytes,
        conditionalHeaders,
        start.origin,
      );
      const finalUrl = canonicalUrl(
        new URL(response.url),
        start.origin,
        value.path_prefix,
      );
      if (!finalUrl) {
        if (next.depth === 0) {
          throw new WebsiteConnectorError(
            "Website start URL redirected outside the configured path prefix",
          );
        }
        continue;
      }
      let page: CursorPage | null = null;
      if (response.status === 304 && prior) {
        page = prior;
      } else if (response.status >= 200 && response.status < 300) {
        totalBytes += response.body.length;
        if (totalBytes > value.max_total_bytes) {
          throw new WebsiteConnectorError("Website crawl exceeds the total byte limit");
        }
        const document = responseDocument(response);
        if (!document) {
          if (next.depth === 0) {
            throw new WebsiteConnectorError("Website start URL did not return HTML");
          }
          continue;
        }
        const revision = createHash("sha256").update(document.content).digest("hex");
        this.cacheContent(revision, finalUrl, document.content);
        page = {
          url: finalUrl.toString(),
          path: documentPath(finalUrl),
          revision,
          bytes: document.content.length,
          etag:
            typeof response.headers.etag === "string" ? response.headers.etag : undefined,
          last_modified:
            typeof response.headers["last-modified"] === "string"
              ? response.headers["last-modified"]
              : undefined,
          links: document.links,
        };
      } else if (next.depth === 0) {
        throw new WebsiteConnectorError(
          `Website start URL returned HTTP ${response.status}`,
        );
      }
      if (!page) continue;
      if (pages.some((existing) => existing.url === page!.url)) continue;
      const duplicatePath = pages.find((existing) => existing.path === page!.path);
      if (duplicatePath && duplicatePath.url !== page.url) {
        page.path = page.path.replace(
          /\.md$/,
          `--${createHash("sha256").update(page.url).digest("hex").slice(0, 8)}.md`,
        );
      }
      pages.push(page);
      if (next.depth >= value.max_depth) continue;
      const retainedLinks: string[] = [];
      for (const rawLink of page.links) {
        const link = canonicalUrl(new URL(rawLink), start.origin, value.path_prefix);
        if (!link) continue;
        retainedLinks.push(link.toString());
        if (queued.has(link.toString()) || queued.size >= value.max_pages) continue;
        queued.add(link.toString());
        queue.push({ url: link, depth: next.depth + 1 });
      }
      const remainingCursorLinks = Math.max(0, MAX_CURSOR_LINKS - retainedCursorLinks);
      page.links = [...new Set(retainedLinks)].slice(
        0,
        Math.min(value.max_pages, remainingCursorLinks),
      );
      retainedCursorLinks += page.links.length;
      queue.sort((left, right) => left.url.toString().localeCompare(right.url.toString()));
    }
    pages.sort((left, right) => left.url.localeCompare(right.url));
    const revision = createHash("sha256")
      .update(pages.map((page) => `${page.url}\0${page.revision}`).join("\n"))
      .digest("hex");
    const cursor: WebsiteCursor = {
      kind: "website-v1",
      origin: start.origin,
      revision,
      pages,
    };
    return {
      revision,
      cursor,
      files: pages.map((page) => ({
        path: page.path,
        revision: page.revision,
        bytes: page.bytes,
      })),
    };
  }

  async readFile(
    config: Readonly<Record<string, unknown>>,
    file: Readonly<ConnectorFileSnapshot>,
  ): Promise<Buffer> {
    const content = this.content.get(file.revision);
    if (content) {
      this.content.delete(file.revision);
      this.content.set(file.revision, content);
      return content;
    }
    const location = this.locations.get(file.revision);
    if (!location) {
      throw new WebsiteConnectorError(
        `Website page content is unavailable for revision ${file.revision}`,
      );
    }
    const value = websiteConfig(config, this.allowPrivateNetwork);
    const start = new URL(value.start_url);
    const url = canonicalUrl(new URL(location), start.origin, value.path_prefix);
    if (!url) throw new WebsiteConnectorError("Website page location is outside crawl scope");
    const robots = await this.loadRobots(start, value.max_page_bytes);
    if (!robotsAllows(robots.rules, url)) {
      throw new WebsiteConnectorError("Website robots.txt now disallows this page");
    }
    const response = await this.fetcher.get(url, value.max_page_bytes, {}, start.origin);
    const finalUrl = canonicalUrl(response.url, start.origin, value.path_prefix);
    if (response.status !== 200 || !finalUrl) {
      throw new WebsiteConnectorError("Website page could not be reloaded");
    }
    const document = responseDocument({ ...response, url: finalUrl });
    if (!document) throw new WebsiteConnectorError("Website page could not be reloaded");
    const revision = createHash("sha256").update(document.content).digest("hex");
    if (revision !== file.revision || document.content.length !== file.bytes) {
      throw new WebsiteConnectorError("Website page changed while its snapshot was being read");
    }
    this.cacheContent(revision, finalUrl, document.content);
    return document.content;
  }

  private cacheContent(revision: string, url: URL, content: Buffer): void {
    const prior = this.content.get(revision);
    if (prior) {
      this.contentBytes -= prior.length;
      this.content.delete(revision);
    }
    this.content.set(revision, content);
    this.contentBytes += content.length;
    while (this.contentBytes > MAX_CONTENT_CACHE_BYTES && this.content.size > 1) {
      const oldest = this.content.keys().next().value;
      if (!oldest) break;
      const removed = this.content.get(oldest);
      this.content.delete(oldest);
      this.contentBytes -= removed?.length ?? 0;
    }
    this.locations.delete(revision);
    this.locations.set(revision, url.toString());
    while (this.locations.size > MAX_CONTENT_LOCATIONS) {
      const oldest = this.locations.keys().next().value;
      if (!oldest) break;
      this.locations.delete(oldest);
    }
  }
}
