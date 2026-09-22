import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { convert } from "html-to-text";

/**
 * Retrieval for the researcher's `fetch_page` tool.
 *
 * The URL here is untrusted model output, so this module is as much a guard as
 * a fetcher: it decides what the server is allowed to request, how long it may
 * take, and how much of the response is allowed into the model's context.
 *
 * Failures are returned, never thrown. A dead link is a normal outcome the
 * agent has to keep working through — Feature 4 depends on that.
 */

/** Request timeout. Long enough for a slow news site, short enough to bound a run. */
const TIMEOUT_MS = 10_000;
/** Ceiling on bytes read off the wire, enforced while reading. */
const MAX_BYTES = 1_000_000;
/**
 * Ceiling on extracted text handed to the model. Roughly 3k tokens.
 *
 * This is the main driver of a run's bill: the text lands in the conversation
 * and is re-sent on every subsequent turn. The answer to a focused
 * sub-question is near the top of a page far more often than not, so the
 * second half of a long article mostly buys tokens rather than evidence.
 */
const MAX_TEXT_CHARS = 12_000;
/** Redirects are followed by hand so each hop can be re-validated. */
const MAX_REDIRECTS = 5;

export type FetchPageResult =
  | {
      ok: true;
      url: string;
      title?: string;
      text: string;
      bytes: number;
      ms: number;
    }
  | { ok: false; url: string; error: string; ms: number };

/**
 * IPv4 ranges that must never be reachable from a user-supplied URL.
 *
 * `169.254.0.0/16` is the one that matters most: it holds the cloud instance
 * metadata endpoint, which is the standard SSRF target.
 */
function isBlockedIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n)))
    return true;
  const [a, b] = parts;

  return (
    a === 0 || // unspecified
    a === 10 || // private
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, incl. instance metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

function isBlockedIPv6(address: string): boolean {
  const value = address.toLowerCase().split("%")[0];

  // IPv4-mapped addresses re-enter the IPv4 rules. `new URL()` rewrites the
  // readable form (::ffff:10.0.0.1) into hex (::ffff:a00:1), so both shapes
  // have to be recognised or 10.0.0.1 walks straight through as IPv6.
  const dotted = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isBlockedIPv4(dotted[1]);

  const hex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return isBlockedIPv4(
      [high >> 8, high & 0xff, low >> 8, low & 0xff].join("."),
    );
  }

  return (
    value === "::" ||
    value === "::1" || // loopback
    value.startsWith("fc") || // unique local
    value.startsWith("fd") || // unique local
    value.startsWith("fe8") || // link-local
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb")
  );
}

function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIPv4(address);
  if (version === 6) return isBlockedIPv6(address);
  return true;
}

/**
 * Decides whether one URL may be requested.
 *
 * Checks the scheme, obvious local hostnames, and — when the host is a literal
 * IP — the address itself. Hostnames are resolved and every returned address
 * checked, which is what stops `evil.example.com A 169.254.169.254`.
 *
 * Exported for tests; `fetchPage` calls it on every redirect hop, not just the
 * first URL.
 */
export async function assertFetchable(raw: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a valid URL";
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `unsupported scheme ${url.protocol.replace(":", "")}`;
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    return "host is not publicly routable";
  }

  if (isIP(host)) {
    return isBlockedAddress(host) ? "host is not publicly routable" : null;
  }

  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.length === 0) return "host did not resolve";
    if (addresses.some((entry) => isBlockedAddress(entry.address))) {
      return "host resolves to a non-public address";
    }
  } catch {
    return "host did not resolve";
  }

  return null;
}

/** Reads a body up to `MAX_BYTES`, aborting the stream rather than buffering past it. */
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        chunks.push(
          decoder.decode(
            value.slice(0, value.byteLength - (total - MAX_BYTES)),
            { stream: false },
          ),
        );
        break;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return chunks.join("");
}

/** Pulls the `<title>` out of raw HTML. html-to-text drops it, and it labels the source in the UI. */
function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = match?.[1]?.replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 200) : undefined;
}

/** Strips a page to readable prose and caps its length. Exported for tests. */
export function extractText(html: string): string {
  const text = convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "noscript", format: "skip" },
      { selector: "nav", format: "skip" },
      { selector: "header", format: "skip" },
      { selector: "footer", format: "skip" },
      { selector: "aside", format: "skip" },
      { selector: "form", format: "skip" },
      { selector: "img", format: "skip" },
      { selector: "a", options: { ignoreHref: true } },
    ],
  })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[truncated]`
    : text;
}

/**
 * Fetches one page as readable text.
 *
 * Redirects are followed manually so that every hop passes `assertFetchable` —
 * validating only the first URL would let a public host redirect the server
 * into a private one.
 */
export async function fetchPage(rawUrl: string): Promise<FetchPageResult> {
  const started = Date.now();
  const fail = (error: string, url = rawUrl): FetchPageResult => ({
    ok: false,
    url,
    error,
    ms: Date.now() - started,
  });

  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const blocked = await assertFetchable(current);
    if (blocked) return fail(blocked, current);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(current, {
        signal: controller.signal,
        redirect: "manual",
        cache: "no-store",
        headers: {
          // Some sites serve a blank shell to an unrecognised agent.
          "User-Agent":
            "QuorumResearchBot/1.0 (+https://github.com/kalebWond/quorum)",
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
        },
      });
    } catch (error) {
      clearTimeout(timer);
      return fail(
        controller.signal.aborted
          ? `timed out after ${TIMEOUT_MS / 1000}s`
          : error instanceof Error
            ? error.message
            : "request failed",
        current,
      );
    }

    try {
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return fail(`redirect without a location`, current);
        current = new URL(location, current).toString();
        continue;
      }

      if (!response.ok) {
        return fail(`HTTP ${response.status}`, current);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
        return fail(
          `unsupported content type ${contentType.split(";")[0] || "unknown"}`,
          current,
        );
      }

      const body = await readCapped(response);
      const isHtml = /html/i.test(contentType);
      const text = isHtml ? extractText(body) : body.slice(0, MAX_TEXT_CHARS);

      if (!text) return fail("page had no readable text", current);

      return {
        ok: true,
        url: current,
        title: isHtml ? extractTitle(body) : undefined,
        text,
        bytes: Buffer.byteLength(body),
        ms: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return fail(`more than ${MAX_REDIRECTS} redirects`, current);
}
