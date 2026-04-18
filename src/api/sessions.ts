import { Elysia, t} from "elysia";
import { listSessions, capture, sendKeys, selectWindow } from "../core/transport/ssh";
import { checkPaneIdle } from "../commands/shared/comm-send";
import { findWindow } from "../core/runtime/find-window";
import { getAggregatedSessions, findPeerForTarget, sendKeysToPeer } from "../core/transport/peers";
import { loadConfig } from "../config";
import { curlFetch } from "../core/transport/curl-fetch";
import { resolveTarget } from "../core/routing";
import { processMirror } from "../commands/plugins/overview/impl";
import { resolveFleetSession } from "../commands/shared/wake";
import { WakeBody, SleepBody, SendBody } from "../lib/schemas";
import { FLEET_DIR } from "../core/paths";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const sessionsApi = new Elysia();

/** Synthesize virtual sessions from fleet-config when tmux is unavailable
 *  (Windows without WSL, minimal install, etc). Windows show active:false
 *  so UIs that render them as idle rooms rather than live panes. */
function virtualSessionsFromFleet(): Array<{ name: string; windows: Array<{ name: string; active: boolean }>; source: string }> {
  try {
    if (!existsSync(FLEET_DIR)) return [];
    const files = readdirSync(FLEET_DIR).filter(f => f.endsWith(".json"));
    return files.map(f => {
      try {
        const cfg = JSON.parse(readFileSync(join(FLEET_DIR, f), "utf-8"));
        const windows = (cfg.windows || []).map((w: any) => ({ name: w.name, active: false }));
        return { name: cfg.name || f.replace(/\.json$/, ""), windows, source: "fleet" };
      } catch { return null; }
    }).filter((x): x is NonNullable<typeof x> => x !== null && x.windows.length > 0);
  } catch { return []; }
}

/** Resolve oracle name → tmux target, same logic as local peek (#273). */
function resolveCapture(query: string, sessions: { name: string }[]): string {
  const config = loadConfig();
  const mapped = (config.sessions as Record<string, string>)?.[query];
  if (mapped) {
    const filtered = sessions.filter(s => s.name === mapped);
    if (filtered.length > 0) return findWindow(filtered, query) || query;
  }
  const fleetSession = resolveFleetSession(query);
  if (fleetSession) {
    const filtered = sessions.filter(s => s.name === fleetSession);
    if (filtered.length > 0) return findWindow(filtered, query) || query;
  }
  return findWindow(sessions, query) || query;
}

sessionsApi.get("/sessions", async ({ query }) => {
  const local = await listSessions();
  if (query.local === "true") {
    return local.map(s => ({ ...s, source: "local" }));
  }
  const aggregated = await getAggregatedSessions(local);
  if (aggregated.length === 0) {
    const virtual = virtualSessionsFromFleet();
    if (virtual.length > 0) return virtual;
  }
  return aggregated;
}, {
  query: t.Object({
    local: t.Optional(t.String()),
  }),
});

sessionsApi.get("/capture", async ({ query, set}) => {
  const target = query.target;
  if (!target) { set.status = 400; return { error: "target required" }; }
  try {
    const sessions = await listSessions();
    const resolved = resolveCapture(target, sessions);
    return { content: await capture(resolved) };
  } catch (e: any) {
    return { content: "", error: e.message };
  }
}, {
  query: t.Object({
    target: t.Optional(t.String()),
  }),
});

sessionsApi.get("/mirror", async ({ query, set}) => {
  const target = query.target;
  if (!target) { set.status = 400; return "target required"; }
  const lines = +(query.lines || "40");
  const sessions = await listSessions();
  const resolved = resolveCapture(target, sessions);
  const raw = await capture(resolved);
  return processMirror(raw, lines);
}, {
  query: t.Object({
    target: t.Optional(t.String()),
    lines: t.Optional(t.String()),
  }),
});

sessionsApi.post("/send", async ({ body, set}) => {
  try {
    const { target, text, force } = body;

    const config = loadConfig();
    const local = await listSessions();

    // --- Unified resolution via resolveTarget (#201) ---
    const result = resolveTarget(target, config, local);

    // Also try with -oracle stripped (backwards compat)
    const isResolved = result && result.type !== "error";
    const altResult = !isResolved ? resolveTarget(target.replace(/-oracle$/, ""), config, local) : null;
    const altResolved = altResult && altResult.type !== "error";
    const resolved = isResolved ? result : altResolved ? altResult : (result || altResult);

    // Local or self-node → send via tmux
    if (resolved?.type === "local" || resolved?.type === "self-node") {
      // #405: idle guard — reject if user has in-progress input on the prompt line
      if (!force) {
        let idleCheck = await checkPaneIdle(resolved.target);
        if (!idleCheck.idle) {
          await Bun.sleep(500);
          idleCheck = await checkPaneIdle(resolved.target);
          if (!idleCheck.idle) {
            set.status = 409;
            return { ok: false, error: "pane not idle", target: resolved.target, lastInput: idleCheck.lastInput };
          }
        }
      }
      await sendKeys(resolved.target, text);
      await Bun.sleep(150);
      let lastLine = "";
      try { const content = await capture(resolved.target, 3); lastLine = content.split("\n").filter(l => l.trim()).pop() || ""; } catch {}
      return { ok: true, target: resolved.target, text, source: "local", lastLine };
    }

    // Remote peer → federation HTTP
    if (resolved?.type === "peer") {
      const res = await curlFetch(`${resolved.peerUrl}/api/send`, {
        method: "POST",
        body: JSON.stringify({ target: resolved.target, text }),
        timeout: 10000,
      });
      if (res.ok && res.data?.ok) {
        return { ok: true, target: res.data.target || target, text, source: resolved.peerUrl, lastLine: res.data.lastLine || "" };
      }
      set.status = 502; return { error: `${resolved.node} → ${resolved.target} send failed`, target, source: resolved.peerUrl };
    }

    // Fallback: async peer discovery
    const peerUrl = await findPeerForTarget(target, local);
    if (peerUrl) {
      const ok = await sendKeysToPeer(peerUrl, target, text);
      if (ok) return { ok: true, target, text, source: peerUrl };
      set.status = 502; return { error: "Failed to send to peer", target, source: peerUrl };
    }

    const errDetail = resolved?.type === "error" ? { reason: resolved.reason, detail: resolved.detail, hint: resolved.hint } : {};
    set.status = 404; return { error: `target not found: ${target}`, target, ...errDetail };
  } catch (err) {
    set.status = 500; return { error: String(err) };
  }
}, {
  body: SendBody,
});

sessionsApi.post("/select", async ({ body, set}) => {
  const { target } = body;
  if (!target) { set.status = 400; return { error: "target required" }; }
  await selectWindow(target);
  return { ok: true, target };
}, {
  body: t.Object({ target: t.String() }),
});

sessionsApi.post("/wake", async ({ body, set}) => {
  try {
    const { target, task } = body;
    const { cmdWake } = await import("../commands/shared/wake");
    await cmdWake(target, { noAttach: true, task });
    return { ok: true, target };
  } catch (err) {
    set.status = 500; return { error: String(err) };
  }
}, {
  body: WakeBody,
});

sessionsApi.post("/sleep", async ({ body, set}) => {
  try {
    const { target } = body;
    const { cmdSleepOne } = await import("../commands/plugins/sleep/impl");
    await cmdSleepOne(target);
    return { ok: true, target };
  } catch (err) {
    set.status = 500; return { error: String(err) };
  }
}, {
  body: SleepBody,
});
