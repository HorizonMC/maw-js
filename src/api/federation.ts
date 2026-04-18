import { Elysia, t} from "elysia";
import { getFederationStatus } from "../core/transport/peers";
import { loadConfig } from "../config";
import { listSnapshots, loadSnapshot, latestSnapshot } from "../core/fleet/snapshot";
import { hostedAgents } from "../commands/shared/federation-sync";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { FLEET_DIR } from "../core/paths";
import { verify } from "../lib/federation-auth";

// Re-export so existing importers (and any future code) can still reach
// hostedAgents via the API module. The canonical home is federation-sync.ts.
export { hostedAgents };

export const federationApi = new Elysia();

// PUBLIC FEDERATION API (v1) — no auth. Shape is load-bearing for lens
// clients; `peers[].node` and `peers[].agents` are optional (commit 9a0546d+).
// See docs/federation.md before changing fields.
federationApi.get("/federation/status", async () => {
  const status = await getFederationStatus();
  return status;
});

/** Snapshots API — list and view fleet time machine snapshots */
federationApi.get("/snapshots", () => {
  return listSnapshots();
});

federationApi.get("/snapshots/:id", ({ params, set}) => {
  const snap = loadSnapshot(params.id);
  if (!snap) { set.status = 404; return { error: "snapshot not found" }; }
  return snap;
});

/** Node identity — public endpoint for federation dedup (#192) + clock health (#268). */
federationApi.get("/identity", async () => {
  const config = loadConfig();
  const node = config.node ?? "local";
  const agents = hostedAgents(config.agents || {}, node);
  const pkg = require("../../package.json");
  return {
    node,
    version: pkg.version,
    agents,
    uptime: Math.floor(process.uptime()),
    clockUtc: new Date().toISOString(),
  };
});

/** Message log — query maw-log.jsonl for federation link data */
federationApi.get("/messages", ({ query }) => {
  const from = query.from;
  const to = query.to;
  const limit = Math.min(parseInt(query.limit || "100"), 1000);
  const logFile = join(homedir(), ".oracle", "maw-log.jsonl");
  try {
    const lines = readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
    interface MawMessage { ts: string; from: string; to: string; msg: string; host?: string; route?: string }
    let messages: MawMessage[] = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (from) messages = messages.filter(m => m.from?.includes(from));
    if (to) messages = messages.filter(m => m.to?.includes(to));
    return { messages: messages.slice(-limit), total: messages.length };
  } catch {
    return { messages: [], total: 0 };
  }
}, {
  query: t.Object({
    from: t.Optional(t.String()),
    to: t.Optional(t.String()),
    limit: t.Optional(t.String()),
  }),
});

/** Fleet configs — serve fleet/*.json with lineage data */
federationApi.get("/fleet", () => {
  try {
    const files = readdirSync(FLEET_DIR).filter(f => f.endsWith(".json") && !f.endsWith(".disabled"));
    const configs = files.map(f => {
      try { return { file: f, ...JSON.parse(readFileSync(join(FLEET_DIR, f), "utf-8")) }; } catch { return null; }
    }).filter(Boolean);
    return { fleet: configs };
  } catch {
    return { fleet: [] };
  }
});

/** Mailbox-drop — async federation messaging for sleeping/virtual agents.
 *  Signed HMAC POST. Writes to ψ/inbox/federation/<target>/<ts>.md in
 *  cwd. Lets peers deliver messages to agents that never live in tmux
 *  (Claude Code sessions, non-tmux hosts, offline fleets). */
federationApi.post("/federation/inbox", async ({ request, body, set }) => {
  const config = loadConfig();
  const token = config.federationToken;
  if (!token) { set.status = 503; return { error: "federation disabled: no token configured" }; }

  const tsHeader = request.headers.get("x-maw-timestamp");
  const sigHeader = request.headers.get("x-maw-signature");
  if (!tsHeader || !sigHeader) { set.status = 401; return { error: "missing auth headers" }; }
  const ts = parseInt(tsHeader, 10);
  if (!Number.isFinite(ts)) { set.status = 401; return { error: "invalid timestamp" }; }
  if (!verify(token, "POST", "/api/federation/inbox", ts, sigHeader)) {
    set.status = 401; return { error: "invalid signature" };
  }

  const b = body as { target?: unknown; text?: unknown; sender?: unknown; type?: unknown };
  const target = typeof b.target === "string" && /^[a-zA-Z0-9_.\-]+$/.test(b.target) ? b.target : null;
  const text = typeof b.text === "string" ? b.text : null;
  if (!target || !text) { set.status = 400; return { error: "target (safe chars) + text required" }; }
  const sender = typeof b.sender === "string" ? b.sender : "unknown";
  const type = typeof b.type === "string" ? b.type : "message";

  const tsStr = new Date().toISOString().replace(/[:.]/g, "-");
  const inboxRoot = process.env.MAW_INBOX_ROOT || process.cwd();
  const dir = join(inboxRoot, "ψ", "inbox", "federation", target);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${tsStr}-from-${sender}.md`);
  const content = `---\nfrom: ${sender}\ntarget: ${target}\ntype: ${type}\nreceived: ${new Date().toISOString()}\n---\n\n${text}\n`;
  writeFileSync(file, content, "utf8");
  const rel = file.slice(inboxRoot.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
  return { ok: true, target, file: rel, id: `fed-${tsStr}` };
});

/** Auth status — public diagnostic endpoint (never reveals the token) */
federationApi.get("/auth/status", () => {
  const config = loadConfig();
  const token = config.federationToken;
  return {
    enabled: !!token,
    tokenConfigured: !!token,
    tokenPreview: token ? token.slice(0, 4) + "****" : null,
    method: token ? "HMAC-SHA256" : "none",
    clockUtc: new Date().toISOString(),
    node: config.node ?? "local",
  };
});
