// Same-origin MCP endpoint for www.albinsblog.com.
//
// Cloudflare's WebMCP bridge (/.webmcp/bridge.js, "mcp-server-client" pack)
// POSTs stateless JSON-RPC to /mcp: no `initialize`, no session id, just
// `tools/list` and `tools/call`. It reads `result.tools` / `result.content`.
// Data comes from Blogger's public JSON feeds, so every tool is read-only.

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "albinsblog-webmcp", version: "0.1.0" };
const FEED_CACHE_TTL = 300;
const POST_PATH_RE = /^\/\d{4}\/\d{2}\/[^/]+\.html$/;

const TOOLS = [
  {
    name: "search_posts",
    description:
      "Full-text search across Albin's Tech Mastery blog (AEM, Adobe Experience Cloud, cloud, AI, SSO, DevOps). Returns matching posts with title, URL, publish date, labels and a short snippet.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 2, description: "Search keywords, e.g. \"dispatcher cache\"." },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 5, description: "Max results (default 5)." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_recent_posts",
    description: "List the most recently published posts, optionally only those with a given label (use list_labels for valid labels).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 20, default: 5, description: "Max results (default 5)." },
        label: { type: "string", description: "Optional label to filter by, e.g. \"AEM\"." },
      },
      required: [],
    },
  },
  {
    name: "list_labels",
    description: "List every label (topic tag) used on the blog. Use these values with get_recent_posts.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_post",
    description:
      "Fetch one blog post by URL and return its title, date, labels and body as plain text (code blocks kept as fenced blocks). Pass the current page URL to read the post the user is on.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Post URL or path, e.g. https://www.albinsblog.com/2026/07/some-post.html" },
        maxChars: { type: "integer", minimum: 500, maximum: 50000, default: 12000, description: "Truncate body text to this many characters." },
      },
      required: ["url"],
    },
  },
  {
    name: "related_posts",
    description: "Find other posts related to the given post: first by shared labels, then by full-text matches on its labels when few posts share them. Each result says how it matched.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Post URL or path." },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 5, description: "Max results (default 5)." },
      },
      required: ["url"],
    },
  },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") {
      return new Response("MCP endpoint: POST JSON-RPC 2.0 here.", { status: 405, headers: { allow: "POST" } });
    }

    let msg;
    try {
      msg = await request.json();
    } catch {
      return rpcResponse(rpcError(null, -32700, "Parse error"));
    }
    if (Array.isArray(msg)) {
      return rpcResponse(rpcError(null, -32600, "Batch requests are not supported"));
    }
    // Notifications (no id) get no body.
    if (msg?.id === undefined || msg?.id === null) {
      return new Response(null, { status: 202 });
    }

    const origin = env.BLOG_ORIGIN || url.origin;
    try {
      const result = await dispatch(msg.method, msg.params ?? {}, { origin, ctx });
      return rpcResponse({ jsonrpc: "2.0", id: msg.id, result });
    } catch (err) {
      if (err instanceof RpcError) return rpcResponse(rpcError(msg.id, err.code, err.message));
      console.error("mcp error", err);
      return rpcResponse(rpcError(msg.id, -32603, "Internal error"));
    }
  },
};

async function dispatch(method, params, env) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return callTool(params.name, params.arguments ?? {}, env);
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

async function callTool(name, args, env) {
  const handler = HANDLERS[name];
  if (!handler) throw new RpcError(-32602, `Unknown tool: ${name}`);
  try {
    const data = await handler(args, env);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    // Tool-level failures go back to the agent as isError results, per MCP.
    return { content: [{ type: "text", text: String(err.message || err) }], isError: true };
  }
}

const HANDLERS = {
  async search_posts({ query, limit }, env) {
    query = String(query ?? "").trim();
    if (query.length < 2) throw new Error("`query` must be at least 2 characters.");
    const n = clampInt(limit, 1, 20, 5);
    const feed = await getFeed(env, "/feeds/posts/summary", { q: query, "max-results": n });
    return { query, results: entries(feed).map(toSummary) };
  },

  async get_recent_posts({ limit, label }, env) {
    const n = clampInt(limit, 1, 20, 5);
    const path = label ? `/feeds/posts/summary/-/${encodeURIComponent(String(label))}` : "/feeds/posts/summary";
    const feed = await getFeed(env, path, { "max-results": n, orderby: "published" });
    return { label: label ?? null, results: entries(feed).map(toSummary) };
  },

  async list_labels(_args, env) {
    const feed = await getFeed(env, "/feeds/posts/summary", { "max-results": 0 });
    const labels = (feed.category ?? []).map((c) => c.term).sort((a, b) => a.localeCompare(b));
    return { count: labels.length, labels };
  },

  async get_post({ url, maxChars }, env) {
    const entry = await getPostEntry(env, url);
    const max = clampInt(maxChars, 500, 50000, 12000);
    const text = htmlToText(entry.content?.$t ?? "");
    return {
      ...toSummary(entry),
      snippet: undefined,
      truncated: text.length > max,
      text: text.length > max ? text.slice(0, max) + "\n…[truncated]" : text,
    };
  },

  async related_posts({ url, limit }, env) {
    const entry = await getPostEntry(env, url);
    const self = postUrl(entry);
    const labels = labelsOf(entry);
    if (labels.length === 0) return { url: self, labels, results: [] };

    const n = clampInt(limit, 1, 10, 5);
    const feeds = await Promise.all(
      labels.slice(0, 6).map((l) =>
        getFeed(env, `/feeds/posts/summary/-/${encodeURIComponent(l)}`, { "max-results": 25 }).catch(() => null)
      )
    );
    const scored = new Map();
    for (const feed of feeds) {
      for (const e of entries(feed)) {
        const u = postUrl(e);
        if (!u || u === self || scored.has(u)) continue;
        const shared = labelsOf(e).filter((l) => labels.includes(l));
        scored.set(u, { ...toSummary(e), sharedLabels: shared, matchedBy: "labels", score: shared.length * 10 });
      }
    }
    // Many posts carry one-off labels; fall back to full-text search on each
    // label and rank by how many of them a post mentions.
    if (scored.size < n) {
      const terms = labels.slice(0, 8);
      const hits = new Map();
      const searches = await Promise.all(
        terms.map((l) => getFeed(env, "/feeds/posts/summary", { q: l, "max-results": 10 }).catch(() => null))
      );
      searches.forEach((feed, i) => {
        for (const e of entries(feed)) {
          const u = postUrl(e);
          if (!u || u === self || scored.has(u)) continue;
          const h = hits.get(u) ?? { entry: e, terms: [] };
          h.terms.push(terms[i]);
          hits.set(u, h);
        }
      });
      [...hits.entries()]
        .sort((a, b) => b[1].terms.length - a[1].terms.length)
        .slice(0, n - scored.size)
        .forEach(([u, h]) => scored.set(u, { ...toSummary(h.entry), sharedLabels: [], matchedBy: `text:${h.terms.join(",")}`, score: h.terms.length }));
    }
    const results = [...scored.values()]
      .sort((a, b) => b.score - a.score || b.published.localeCompare(a.published))
      .slice(0, n)
      .map(({ score, ...p }) => p);
    return { url: self, labels, results };
  },
};

// ---- Blogger feed helpers -------------------------------------------------

async function getFeed(env, path, params) {
  const u = new URL(path, env.origin);
  u.searchParams.set("alt", "json");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const res = await fetch(u, { cf: { cacheTtl: FEED_CACHE_TTL, cacheEverything: true } });
  if (!res.ok) throw new Error(`Blog feed returned HTTP ${res.status}`);
  return (await res.json()).feed ?? {};
}

async function getPostEntry(env, url) {
  const path = toPostPath(url, env.origin);
  const feed = await getFeed(env, "/feeds/posts/default", { path });
  const entry = entries(feed)[0];
  if (!entry) throw new Error(`No post found at ${path}`);
  return entry;
}

function toPostPath(input, origin) {
  if (!input || typeof input !== "string") throw new Error("`url` is required.");
  let u;
  try {
    u = new URL(input, origin);
  } catch {
    throw new Error("`url` is not a valid URL or path.");
  }
  const blogHost = new URL(origin).hostname.replace(/^www\./, "");
  if (u.hostname.replace(/^www\./, "") !== blogHost) throw new Error(`Only ${blogHost} posts are supported.`);
  if (!POST_PATH_RE.test(u.pathname)) throw new Error("`url` must be a post URL like /YYYY/MM/slug.html.");
  return u.pathname;
}

const entries = (feed) => feed?.entry ?? [];
const labelsOf = (e) => (e.category ?? []).map((c) => c.term);
const postUrl = (e) => (e.link ?? []).find((l) => l.rel === "alternate")?.href ?? null;

function toSummary(e) {
  const raw = e.summary?.$t ?? e.content?.$t ?? "";
  return {
    title: (e.title?.$t ?? "").trim(),
    url: postUrl(e),
    published: e.published?.$t ?? "",
    labels: labelsOf(e),
    snippet: collapse(htmlToText(raw)).slice(0, 280),
  };
}

// ---- small utilities ------------------------------------------------------

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => `\n\`\`\`\n${stripTags(code.replace(/<br\s*\/?>/gi, "\n"))}\n\`\`\`\n`)
      .replace(/<h([1-6])[^>]*>/gi, (_, l) => "\n\n" + "#".repeat(Number(l)) + " ")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|ul|ol|table|tr|blockquote)>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/\n- *\n+/g, "\n- ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const stripTags = (s) => s.replace(/<[^>]+>/g, "");
const collapse = (s) => s.replace(/\s+/g, " ").trim();

function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === "#") {
      const cp = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return named[code.toLowerCase()] ?? m;
  });
}

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

function rpcResponse(body) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
