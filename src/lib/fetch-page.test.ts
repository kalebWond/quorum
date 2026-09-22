import { describe, expect, it } from "vitest";
import { assertFetchable, extractText } from "./fetch-page";

/**
 * The URL reaching `fetch_page` is model output, so these are the tests that
 * keep a research question from turning into a request against the host's own
 * network. They run without touching it: every case below is either a literal
 * IP or a scheme, so nothing resolves.
 */
describe("assertFetchable", () => {
  it("allows an ordinary public https URL", async () => {
    expect(await assertFetchable("https://example.com/article")).toBeNull();
  });

  it.each([
    ["loopback", "http://127.0.0.1/"],
    ["loopback range", "http://127.19.4.2/"],
    ["private 10/8", "http://10.0.0.1/"],
    ["private 172.16/12", "http://172.20.10.5/"],
    ["private 192.168/16", "http://192.168.1.1/"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["unspecified", "http://0.0.0.0/"],
    ["carrier-grade NAT", "http://100.64.0.1/"],
    ["multicast", "http://239.255.255.250/"],
    ["ipv6 loopback", "http://[::1]/"],
    ["ipv6 unique local", "http://[fd00::1]/"],
    ["ipv6 link-local", "http://[fe80::1]/"],
    ["ipv4-mapped private", "http://[::ffff:10.0.0.1]/"],
  ])("blocks %s", async (_label, url) => {
    expect(await assertFetchable(url)).toBe("host is not publicly routable");
  });

  it.each([
    ["localhost", "http://localhost:3000/"],
    ["localhost subdomain", "http://api.localhost/"],
    [".internal", "http://metadata.internal/"],
    [".local", "http://printer.local/"],
  ])("blocks %s by name", async (_label, url) => {
    expect(await assertFetchable(url)).toBe("host is not publicly routable");
  });

  it.each([
    ["file", "file:///etc/passwd"],
    ["ftp", "ftp://example.com/x"],
    ["data", "data:text/html,<h1>hi</h1>"],
  ])("blocks the %s scheme", async (label, url) => {
    expect(await assertFetchable(url)).toBe(`unsupported scheme ${label}`);
  });

  it("rejects a string that is not a URL", async () => {
    expect(await assertFetchable("not a url")).toBe("not a valid URL");
  });
});

describe("extractText", () => {
  it("keeps prose and drops script, style, and chrome", () => {
    const text = extractText(`
      <html>
        <head><title>T</title><style>body { color: red }</style></head>
        <body>
          <nav>Home About Contact</nav>
          <script>console.log("tracking")</script>
          <p>The regulation takes effect in 2027.</p>
          <footer>Copyright</footer>
        </body>
      </html>
    `);

    expect(text).toContain("The regulation takes effect in 2027.");
    expect(text).not.toContain("tracking");
    expect(text).not.toContain("color: red");
    expect(text).not.toContain("Home About Contact");
    expect(text).not.toContain("Copyright");
  });

  it("truncates a very long page and marks it", () => {
    const text = extractText(`<p>${"word ".repeat(20_000)}</p>`);

    expect(text.endsWith("[truncated]")).toBe(true);
    // The cap plus the marker, not the full page.
    expect(text.length).toBeLessThan(25_000);
  });

  it("returns empty string for a page with no readable content", () => {
    expect(extractText("<html><body><script>x=1</script></body></html>")).toBe(
      "",
    );
  });
});
