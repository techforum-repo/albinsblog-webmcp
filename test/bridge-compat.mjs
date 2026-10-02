// Runs Cloudflare's own WebMCP bridge MCP client (mcpListTools / mcpCallTool)
// against an /mcp endpoint. The bridge is downloaded at run time from a site
// with Cloudflare WebMCP enabled; no Cloudflare code is stored in this repo.
//
// Usage: node test/bridge-compat.mjs [endpoint] [bridgeUrl]
//   endpoint  default http://localhost:8787/mcp   (npm run dev)
//   bridgeUrl default https://www.albinsblog.com/.webmcp/bridge.js

const endpoint = process.argv[2] ?? "http://localhost:8787/mcp";
const bridgeUrl = process.argv[3] ?? "https://www.albinsblog.com/.webmcp/bridge.js";

const START = "// src/bridge/packs/mcp-server-client/mcp-client.ts";
const END = "// src/bridge/packs/mcp-server-client/";

const res = await fetch(bridgeUrl);
if (!res.ok) throw new Error(`Could not download bridge: HTTP ${res.status}`);
const src = await res.text();
const a = src.indexOf(START);
const b = src.indexOf(END, a + START.length);
if (a < 0 || b < 0) throw new Error("Bridge layout changed: MCP client section not found");

const moduleSrc = src.slice(a, b) + "\nexport { mcpListTools, mcpCallTool };\n";
const { mcpListTools, mcpCallTool } = await import(
  "data:text/javascript;base64," + Buffer.from(moduleSrc).toString("base64")
);

const defs = await mcpListTools(endpoint);
console.log("bridge mcpListTools ->", defs.map((d) => d.name).join(", "));

const r = await mcpCallTool(endpoint, "search_posts", { query: "sling model", limit: 2 });
console.log("bridge mcpCallTool  ->", JSON.parse(r.content[0].text).results.map((p) => p.title));

const bad = await mcpCallTool(endpoint, "get_post", { url: "https://evil.example/2026/01/x.html" });
console.log("bridge isError      ->", bad.isError, bad.content[0].text);
