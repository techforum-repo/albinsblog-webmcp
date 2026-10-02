# albinsblog-webmcp

A Cloudflare Worker that makes a Blogger blog usable by AI agents through **WebMCP**.
It serves a read-only MCP endpoint at `https://www.albinsblog.com/mcp`. Cloudflare's
WebMCP feature then registers those tools in every visitor's browser tab, where
browser agents can discover and call them.

Built for [www.albinsblog.com](https://www.albinsblog.com), but the only blog-specific
settings are the domain and route in `wrangler.toml`. It works for any Blogger blog
on a custom domain proxied through Cloudflare.

> **Status:** WebMCP is an experimental browser API, and Cloudflare's WebMCP support is
> a developer preview. Expect browser flags and APIs to change.

## How it works

```
Chrome tab ──▶ Cloudflare edge ──▶ Blogger (all normal pages)
   │              │
   │              ├─ injects <script src="/.webmcp/bridge.js">   (Cloudflare WebMCP)
   │              │
   └─ bridge.js ──┴─▶ POST /mcp ──▶ this Worker ──▶ Blogger JSON feeds
                       tools/list, tools/call
```

1. Cloudflare's WebMCP preview (dashboard → **Agent Readiness → WebMCP**) adds
   `/.webmcp/bridge.js` to every HTML page.
2. The bridge's **Site MCP Server** pack sends JSON-RPC `tools/list` to the
   same-origin `/mcp` and registers each returned tool with the browser's
   `document.modelContext`.
3. Blogger can't answer `/mcp` (it returns HTTP 405), so this Worker takes
   **only that route**. Every other path still goes to Blogger.
4. Tool calls read Blogger's public JSON feeds (`/feeds/posts/...?alt=json`),
   cached at the edge for 5 minutes.

## Tools

| Tool | Arguments | Returns |
|---|---|---|
| `search_posts` | `query`, `limit` (1–20) | title, url, date, labels, snippet |
| `get_recent_posts` | `limit` (1–20), `label?` | latest posts, optionally for one label |
| `list_labels` | – | all labels |
| `get_post` | `url`, `maxChars` (500–50000) | post body as plain text, code blocks fenced |
| `related_posts` | `url`, `limit` (1–10) | posts sharing labels, then full-text matches on the labels |

All tools are **read-only** and use only public data. `get_post` and `related_posts`
accept only this blog's `/YYYY/MM/slug.html` post URLs.

Every tool is published with MCP annotations `readOnlyHint: true` and `openWorldHint: false`.
Direct MCP clients see them now. Cloudflare's bridge currently registers only name, description
and input schema in the browser, so browser agents don't receive the annotations yet.

## Project structure

```
src/index.js           Worker: JSON-RPC handling, tool definitions, Blogger feed helpers
test/smoke.mjs         10 checks against an endpoint, using the bridge's request shape
test/bridge-compat.mjs Runs Cloudflare's bridge MCP client (downloaded at run time) against an endpoint
wrangler.toml          Worker name, route (/mcp only), BLOG_ORIGIN
```

## Prerequisites

- A Cloudflare account with the blog's domain **proxied** through Cloudflare (orange cloud).
- Node.js 18 or newer. Wrangler 3 is pinned because it still supports Node 18.
- For browser testing: Chrome with the WebMCP flags enabled (see [Testing in Chrome](#testing-in-chrome)).

## First-time setup

```bash
git clone https://github.com/techforum-repo/albinsblog-webmcp.git
cd albinsblog-webmcp
npm install
npx wrangler login        # opens a browser to authorize Wrangler with your Cloudflare account
```

To use it for a **different blog**, edit `wrangler.toml`:

```toml
routes = [
  { pattern = "www.yourblog.com/mcp", zone_name = "yourblog.com" }
]

[vars]
BLOG_ORIGIN = "https://www.yourblog.com"
```

Then update the blog name in the `search_posts` description in `src/index.js`.
Agents read tool descriptions, so make them describe your content.

## Local development

```bash
npm run dev               # Worker on http://localhost:8787/mcp, reading the live blog's feeds
npm run smoke             # in a second terminal: 10 checks, should print "All checks passed"
npm run bridge-compat     # Cloudflare's own bridge client against the local Worker
```

Quick manual call:

```bash
curl -s -X POST http://localhost:8787/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_posts","arguments":{"query":"AEM","limit":3}}}'
```

## Deploy

### 1. Enable Cloudflare WebMCP (once)

Cloudflare dashboard → your zone → **Agent Readiness → WebMCP** → enable it and keep
the **Site MCP Server** pack selected. Check that it's working:

```bash
curl -s https://www.albinsblog.com/ | grep -o '<script[^>]*webmcp[^>]*>'
curl -sI https://www.albinsblog.com/.webmcp/bridge.js | head -1     # HTTP/2 200
```

### 2. Deploy the Worker

```bash
npm run deploy
```

This publishes the Worker and attaches the route `www.albinsblog.com/mcp` from `wrangler.toml`.
`workers_dev = false`, so there's no extra `*.workers.dev` URL.

### 3. Verify

```bash
node test/smoke.mjs https://www.albinsblog.com/mcp
node test/bridge-compat.mjs https://www.albinsblog.com/mcp
curl -s -o /dev/null -w "%{http_code}\n" https://www.albinsblog.com/     # blog still 200
```

Then follow [Testing in Chrome](#testing-in-chrome).

## Making changes and redeploying

1. Edit `src/index.js`. Tools live in the `TOOLS` array (name, description,
   `inputSchema`) and their handlers in `HANDLERS`. Every tool needs both.
2. Test locally: `npm run dev`, then `npm run smoke` and `npm run bridge-compat`.
   If you add a tool, add a check for it to `test/smoke.mjs`.
3. Deploy: `npm run deploy`.
4. Verify production: `node test/smoke.mjs https://www.albinsblog.com/mcp`.
5. Reload the blog in Chrome. The bridge calls `tools/list` on every page load, so new
   or changed tools show up immediately.

Guidelines:

- Keep tools **read-only** unless you've thought through the security model. The
  bridge sends the visitor's cookies to `/mcp`, so any tool runs as that visitor.
- `inputSchema` must have `type: "object"`, or the bridge skips the tool.
- Return failures as tool results (`isError: true` with a readable message) so the
  agent can recover. The handler wrapper already does this for thrown errors.
- Mark every new tool's side effects. Read-only tools get the shared `READ_ONLY` annotations
  automatically; a tool that changes state needs its own `annotations` (and a hard look at the security model).
- Watch logs during testing: `npx wrangler tail`.

## Logs and monitoring

Each JSON-RPC call writes one structured log line:

```json
{"event":"mcp_call","method":"tools/call","tool":"search_posts","ok":true,"ms":103}
```

Tool arguments are deliberately not logged, because search queries come from visitors.
`[observability] enabled = true` in `wrangler.toml` keeps these lines in Workers Logs:

- **Live:** `npx wrangler tail`
- **History and queries:** dashboard → Workers & Pages → `albinsblog-webmcp` → **Logs**. Filter on
  `event = mcp_call` to count calls per tool, failures, and latency.

The logs tell you *which tools* were called and how they performed. They cannot reliably tell you
*which AI agent* made a browser-originated call.

## Rollback

| Goal | How |
|---|---|
| Undo a bad change | `npx wrangler rollback` (to the previous version), or redeploy an earlier commit |
| Remove the Worker | `npx wrangler delete`. `/mcp` falls back to Blogger's 405 and the bridge registers 0 site tools |
| Turn off WebMCP entirely | Dashboard → Agent Readiness → WebMCP → disable. The script tag stops being injected |

None of these affect normal blog pages.

## Testing in Chrome

1. Use Chrome 150 or newer. Enable `chrome://flags/#enable-webmcp-testing` and
   `chrome://flags/#devtools-webmcp-support`, then relaunch.
2. Open the blog, then DevTools → **Console** with **Verbose** log level. Expect:
   ```
   [webmcp-interceptor] mcp-server-client: registered 5 site tool(s) from /mcp.
   ```
3. DevTools → **Application → WebMCP** lists the five tools plus Cloudflare's two C2PA tools.
4. Call a tool as an agent would (type `allow pasting` first if Chrome blocks the paste):
   ```js
   const t = (await document.modelContext.getTools()).find(x => x.name === "search_posts");
   await document.modelContext.executeTool(t, JSON.stringify({ query: "AEM SSO", limit: 3 }));
   ```
   The call appears under **Tool Activity**. The API shape has changed between Chrome
   versions; on some builds it is `navigator.modelContextTesting.executeTool("search_posts", json)`.

## Using it from AI agents

| Path | Setup |
|---|---|
| Browser agents | Read `document.modelContext` on the page; nothing extra to configure |
| Chrome DevTools MCP | `npx chrome-devtools-mcp@latest --categoryExperimentalWebmcp=true --chrome-arg=--enable-features=WebMCP` (Node 20.19+), then use `list_webmcp_tools` / `execute_webmcp_tool` |
| Direct MCP clients | Also a standard MCP endpoint: `claude mcp add --transport http albinsblog https://www.albinsblog.com/mcp` |

## Protocol notes

- Cloudflare's bridge is **stateless**: no `initialize`, no `Mcp-Session-Id`. It calls
  `tools/list` and `tools/call` directly and reads `result.tools` / `result.content`.
- The Worker also answers `initialize` and `ping`, so regular MCP clients (Streamable
  HTTP) can connect.
- Notifications (no `id`) get `202`. `GET` gets `405`. Batch requests are rejected.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Console: `tools/list failed for "/mcp" … HTTP 405` | Worker not deployed, or the route doesn't match the hostname (`www.` vs apex) |
| Console: `document.modelContext is not available` | Chrome WebMCP flags not enabled, or Chrome is too old |
| No `webmcp-interceptor` messages at all | WebMCP not enabled for the zone, or the Console filter or log level hides them |
| Tool listed but calls fail | Check `npx wrangler tail`; Blogger feed errors surface as `Blog feed returned HTTP …` |
| `wrangler deploy` route error | The domain must be an active zone in the same Cloudflare account |
| `npm run dev` compatibility-date warning | Harmless with wrangler 3; the date is pinned to what it supports |

## Costs

On Workers' free plan (100,000 requests/day), each page view from a WebMCP-enabled
browser makes one `tools/list` request, plus one request per tool call. Feed fetches
are cached for 5 minutes. Usage: dashboard → Workers & Pages → `albinsblog-webmcp` → Metrics.
Workers Logs has its own included volume and retention per plan; check Cloudflare's current
Workers pricing if traffic grows.

## License

[MIT](LICENSE) © 2026 Albin Issac
