// Sends the exact request shape Cloudflare's WebMCP bridge uses (bridge.js mcpRpc):
// stateless JSON-RPC POST, no initialize, no session header.
// Usage: node test/smoke.mjs [endpoint]   (default http://localhost:8787/mcp)

const endpoint = process.argv[2] ?? "http://localhost:8787/mcp";
let failures = 0;

async function rpc(method, params) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function check(label, fn) {
  try {
    const detail = await fn();
    console.log(`PASS  ${label}${detail ? `  — ${detail}` : ""}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${label}  — ${err.message}`);
  }
}

const parse = (r) => {
  if (r.error) throw new Error(`rpc error ${r.error.code}: ${r.error.message}`);
  if (!Array.isArray(r.result?.content)) throw new Error("no content array");
  if (r.result.isError) throw new Error(`tool error: ${r.result.content[0]?.text}`);
  return JSON.parse(r.result.content[0].text);
};
const call = async (name, args) => parse(await rpc("tools/call", { name, arguments: args }));

let samplePost;

await check("tools/list (bridge startup call)", async () => {
  const r = await rpc("tools/list", {});
  const names = r.result.tools.map((t) => t.name);
  for (const t of r.result.tools) if (t.inputSchema?.type !== "object") throw new Error(`${t.name} schema not object`);
  return names.join(", ");
});

await check("get_recent_posts", async () => {
  const d = await call("get_recent_posts", { limit: 3 });
  if (d.results.length !== 3) throw new Error(`expected 3, got ${d.results.length}`);
  samplePost = d.results[0].url;
  return d.results.map((p) => p.title).join(" | ");
});

await check("get_recent_posts label=AEM", async () => {
  const d = await call("get_recent_posts", { limit: 2, label: "AEM" });
  if (!d.results.every((p) => p.labels.includes("AEM"))) throw new Error("label filter not applied");
  return d.results.map((p) => p.title).join(" | ");
});

await check("search_posts 'dispatcher'", async () => {
  const d = await call("search_posts", { query: "dispatcher", limit: 3 });
  if (d.results.length === 0) throw new Error("no results");
  return d.results.map((p) => p.title).join(" | ");
});

await check("list_labels", async () => {
  const d = await call("list_labels", {});
  if (d.count < 10) throw new Error(`only ${d.count} labels`);
  return `${d.count} labels`;
});

await check("get_post (latest)", async () => {
  const d = await call("get_post", { url: samplePost, maxChars: 800 });
  if (!d.text || d.text.length < 100) throw new Error("empty body");
  return `${d.title} — ${d.text.length} chars, truncated=${d.truncated}`;
});

await check("related_posts (latest)", async () => {
  const d = await call("related_posts", { url: samplePost, limit: 3 });
  return d.results.map((p) => `${p.title} [${p.sharedLabels.join(",")}]`).join(" | ") || "(none)";
});

await check("get_post rejects other hosts (isError)", async () => {
  const r = await rpc("tools/call", { name: "get_post", arguments: { url: "https://example.com/2026/01/x.html" } });
  if (!r.result?.isError) throw new Error("expected isError result");
  return r.result.content[0].text;
});

await check("unknown method → -32601", async () => {
  const r = await rpc("nope/nope", {});
  if (r.error?.code !== -32601) throw new Error(JSON.stringify(r));
});

await check("GET → 405", async () => {
  const res = await fetch(endpoint);
  if (res.status !== 405) throw new Error(`got ${res.status}`);
});

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
