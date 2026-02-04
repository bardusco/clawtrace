import fs from "fs";
import path from "path";

/**
 * ClawTrace plugin service:
 * - Registers HTTP routes for UI + SSE.
 * - Hooks before/after tool calls to append redacted events.
 *
 * Runs in-process with the Gateway. Treat as trusted code.
 */

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function safeReadFile(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function parseLines(txt) {
  return txt.split(/\r?\n/).filter(Boolean);
}

function tailLines(filePath, maxLines = 200) {
  const txt = safeReadFile(filePath);
  if (txt == null) return [];
  const lines = parseLines(txt);
  return lines.slice(Math.max(0, lines.length - maxLines));
}

function loadAgentNameFromIdentity(workspaceDir) {
  // Try to read agent name from IDENTITY.md (format: "- **Name:** Pi")
  const identityPath = path.join(workspaceDir, "IDENTITY.md");
  const txt = safeReadFile(identityPath);
  if (!txt) return null;
  const match = txt.match(/^-\s*\*\*Name:\*\*\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

function createSanitizer({ maxString, dropKeysRe }) {
  const isSensitiveKey = (k) => dropKeysRe.test(k);
  const sanitizeAny = (v) => {
    if (v == null) return v;
    if (typeof v === "string") {
      if (v.length > maxString) return `<redacted:${v.length}>`;
      if (/^sk-[A-Za-z0-9_-]{10,}$/.test(v)) return "<redacted:sk>";
      if (/^Bearer\s+\S+/i.test(v)) return "<redacted:bearer>";
      return v;
    }
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (Array.isArray(v)) return v.map(sanitizeAny);
    if (typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (isSensitiveKey(k)) continue;
        out[k] = sanitizeAny(val);
      }
      return out;
    }
    return String(v);
  };
  return sanitizeAny;
}

function pickPaths(args) {
  const paths = [];
  const walk = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && (k === "path" || k === "filePath" || k === "file_path" || k === "outPath" || k === "jsonlPath")) {
        paths.push(v);
      } else if (Array.isArray(v)) {
        v.forEach(walk);
      } else if (typeof v === "object") {
        walk(v);
      }
    }
  };
  walk(args);
  return [...new Set(paths)].slice(0, 6);
}

function pickUrl(args) {
  const candidates = [];
  const walk = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && (k.toLowerCase().includes("url") || k === "targetUrl")) candidates.push(v);
      else if (typeof v === "object") walk(v);
    }
  };
  walk(args);
  return candidates.find(Boolean);
}

function summarize(toolName, params) {
  if (toolName === "exec") {
    const cmd = params?.command ? String(params.command) : "";
    const short = cmd.length > 160 ? cmd.slice(0, 157) + "..." : cmd;
    return short;
  }
  if (toolName === "write" || toolName === "edit" || toolName === "read") {
    return params?.path || params?.filePath || params?.file_path || "";
  }
  if (toolName === "browser") {
    const action = params?.action || "";
    const url = params?.targetUrl || "";
    return `${action}${url ? " " + url : ""}`.trim();
  }
  if (toolName === "message") {
    const action = params?.action || "";
    const channel = params?.channel || "";
    return `${action}${channel ? " " + channel : ""}`.trim();
  }
  if (toolName === "cron") {
    const action = params?.action || "";
    return `${action}`.trim();
  }
  return "";
}

function loadSessionMap(openclawDir, agentId = "main") {
  const file = path.join(openclawDir, "agents", agentId, "sessions", "sessions.json");
  try {
    const raw = fs.readFileSync(file, "utf8");
    const obj = JSON.parse(raw);
    const out = {};
    for (const [sessionKey, info] of Object.entries(obj || {})) {
      if (!info?.sessionId) continue;
      const originLabel = info?.origin?.label;
      const deliveryTo = info?.deliveryContext?.to;
      let lastTo = deliveryTo;
      if (!lastTo && typeof originLabel === "string") {
        const m = originLabel.match(/\bid:(\d+)\b/);
        if (m) lastTo = m[1];
      }

      out[sessionKey] = {
        sessionId: info.sessionId,
        channel: info?.channel || info?.origin?.channel || info?.deliveryContext?.channel,
        lastTo,
        // Keep a basic label here; we will prefer session-meta labels when available.
        label: originLabel || deliveryTo || sessionKey,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function loadSessionMetaMap(workspaceDir) {
  const file = path.join(workspaceDir, "memory", "session-meta.json");
  try {
    const raw = fs.readFileSync(file, "utf8");
    const obj = JSON.parse(raw);
    const sessions = obj?.sessions || {};
    const out = {};
    for (const [sessionId, info] of Object.entries(sessions)) {
      out[sessionId] = {
        label: info?.label || info?.displayName || info?.key || "",
        channel: info?.channel || null,
        lastTo: info?.lastTo || null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function loadCronJobNameMap(openclawDir) {
  const cronStorePath = path.join(openclawDir, "cron", "jobs.json");
  try {
    const raw = fs.readFileSync(cronStorePath, "utf8");
    const obj = JSON.parse(raw);
    const jobs = obj?.jobs;
    const out = {};

    if (Array.isArray(jobs)) {
      for (const job of jobs) {
        const id = job?.id;
        const name = job?.name;
        if (typeof id === "string" && typeof name === "string" && name.trim()) out[id] = name.trim();
      }
      return out;
    }

    if (jobs && typeof jobs === "object") {
      for (const [k, job] of Object.entries(jobs)) {
        const id = job?.id || k;
        const name = job?.name;
        if (typeof id === "string" && typeof name === "string" && name.trim()) out[id] = name.trim();
      }
      return out;
    }

    return out;
  } catch {
    return {};
  }
}

export function createClawTraceService(api) {
  return {
    id: "clawtrace",

    start(ctx) {
      const cfg = api.pluginConfig || {};
      const enabled = cfg.enabled !== false;
      if (!enabled) {
        ctx.logger.info("[clawtrace] disabled");
        return;
      }

      const prefix = (cfg.pathPrefix || "/ledger").replace(/\/$/, "");
      const workspaceDir = ctx.workspaceDir || process.cwd();
      const openclawDir = ctx.openclawDir || path.join(process.env.HOME || "/tmp", ".openclaw");
      const ledgerPath = cfg.ledgerPath || path.join(workspaceDir, "memory", "clawtrace.jsonl");
      const agentId = ctx.agentId || "main";

      const maxString = Number.isFinite(cfg.maxString) ? cfg.maxString : 160;
      const dropKeysRe = new RegExp(cfg.dropKeysRegex || "(token|secret|password|authorization|cookie|apiKey|apikey|bearer|accessToken|refreshToken|privateKey)", "i");
      const sanitizeAny = createSanitizer({ maxString, dropKeysRe });

      ensureDirForFile(ledgerPath);

      // SSE clients
      const clients = new Set();
      const sseSend = (client, event, data) => {
        try {
          if (event) client.write(`event: ${event}\n`);
          const payload = typeof data === "string" ? data : JSON.stringify(data);
          payload.split(/\r?\n/).forEach((line) => client.write(`data: ${line}\n`));
          client.write("\n");
        } catch {
          clients.delete(client);
        }
      };

      const emitLedger = (entry) => {
        try {
          fs.appendFileSync(ledgerPath, JSON.stringify(entry) + "\n");
        } catch (e) {
          ctx.logger.warn(`[clawtrace] failed to append ledger: ${String(e)}`);
        }
        for (const c of clients) sseSend(c, "line", entry);
      };

      const fingerprint = (sessionKey, toolName, params, summary) => {
        // Stable-ish matching for start/done without a toolCallId.
        const paths = pickPaths(params).join("|");
        const url = pickUrl(params) || "";
        const s = (summary || "").slice(0, 80);
        return `${sessionKey || ""}|${toolName}|${paths}|${url}|${s}`;
      };

      // Keep a fresh sessionKey -> {sessionId,label} map and a sessionId->label map.
      let sessionMap = loadSessionMap(openclawDir, agentId);
      let sessionMetaMap = loadSessionMetaMap(workspaceDir);
      let cronJobNameMap = loadCronJobNameMap(openclawDir);
      const refreshSessionMaps = () => {
        // sessions.json should always parse; if it doesn't, keep last good.
        try {
          const nextSessionMap = loadSessionMap(openclawDir, agentId);
          if (nextSessionMap && Object.keys(nextSessionMap).length) sessionMap = nextSessionMap;
        } catch {}

        // session-meta.json can be rewritten periodically; avoid wiping map on transient parse errors.
        try {
          const nextMeta = loadSessionMetaMap(workspaceDir);
          if (nextMeta && Object.keys(nextMeta).length) sessionMetaMap = nextMeta;
        } catch {}

        // cron jobs map (jobId -> name)
        try {
          const nextCronMap = loadCronJobNameMap(openclawDir);
          if (nextCronMap && Object.keys(nextCronMap).length) cronJobNameMap = nextCronMap;
        } catch {}
      };

      const sessionMapTimer = setInterval(refreshSessionMaps, 15000);

      // On startup, session-meta.json might be mid-write; retry quickly until we have at least one label.
      if (!sessionMetaMap || Object.keys(sessionMetaMap).length === 0) {
        const retry = setInterval(() => {
          refreshSessionMaps();
          if (sessionMetaMap && Object.keys(sessionMetaMap).length > 0) clearInterval(retry);
        }, 1000);
        setTimeout(() => clearInterval(retry), 15000);
      }

      const resolveLabel = (sessionKey, sessionId, fallback) => {
        if (sessionId && sessionMetaMap?.[sessionId]?.label) return sessionMetaMap[sessionId].label;

        // If it's a cron session, resolve directly from jobs.json (avoids any dependency on session-meta.json).
        const sk = String(sessionKey || "");
        if (sk.includes(":cron:")) {
          const jobId = sk.split(":cron:")[1];
          const name = cronJobNameMap?.[jobId];
          if (name) return `cron:${name}`;
        }

        // One-shot reload attempt (covers race where the map wasn't ready yet)
        try {
          const next = loadSessionMetaMap(workspaceDir);
          if (next && Object.keys(next).length) {
            sessionMetaMap = next;
            if (sessionId && sessionMetaMap?.[sessionId]?.label) return sessionMetaMap[sessionId].label;
          }
        } catch {}

        return fallback;
      };

      const resolveChannel = (sessionKey, sessionId, fallback) => {
        if (sessionId && sessionMetaMap?.[sessionId]?.channel) return sessionMetaMap[sessionId].channel;
        const sk = String(sessionKey || "");
        // For main session, try to get channel from sessionMap first
        if (sk === "agent:main:main") {
          const mainInfo = sessionMap?.[sk];
          if (mainInfo?.channel) return mainInfo.channel;
        }
        if (sk.includes(":cron:")) return "cron";
        return fallback;
      };

      // Agent display name: config > IDENTITY.md > agentId
      const agentDisplayName = cfg.agentName || loadAgentNameFromIdentity(workspaceDir) || agentId;

      const enableNotes = cfg.enableNotes !== false;

      // HTTP routes
      const uiPath = new URL("./ui.html", import.meta.url).pathname;

      api.registerHttpRoute({
        path: `${prefix}`,
        handler: (req, res) => {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          res.end(safeReadFile(uiPath) || "<h1>Missing UI</h1>");
        },
      });

      api.registerHttpRoute({
        path: `${prefix}/api/recent`,
        handler: (req, res) => {
          const u = new URL(req.url, `http://${req.headers.host}`);
          const n = Math.min(2000, Math.max(1, parseInt(u.searchParams.get("n") || "200", 10)));
          const lines = tailLines(ledgerPath, n);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ ok: true, lines }));
        },
      });

      api.registerHttpRoute({
        path: `${prefix}/api/export`,
        handler: async (req, res) => {
          // Download JSONL ledger.
          // Optional query params:
          // - n=<number>: last N lines
          // - sinceTs=<iso>: only entries with ts >= sinceTs
          const u = new URL(req.url, `http://${req.headers.host}`);
          const nRaw = u.searchParams.get("n");
          const sinceTs = u.searchParams.get("sinceTs");
          const n = nRaw ? Math.max(1, Math.min(500000, parseInt(nRaw, 10) || 0)) : null;

          const filename = `clawtrace-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
          res.writeHead(200, {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Content-Disposition": `attachment; filename=\"${filename}\"`,
            "Cache-Control": "no-store",
          });

          try {
            // Fast-path: tail N lines (loads file, but bounded)
            if (n) {
              const lines = tailLines(ledgerPath, n);
              for (const line of lines) res.write(line + "\n");
              res.end();
              return;
            }

            // Stream line-by-line and optionally filter by ts.
            const readline = await import("readline");
            const stream = fs.createReadStream(ledgerPath, { encoding: "utf8" });
            const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

            for await (const line of rl) {
              if (!line) continue;
              if (sinceTs) {
                try {
                  const obj = JSON.parse(line);
                  const ts = obj?.ts;
                  if (typeof ts === "string" && ts < sinceTs) continue;
                } catch {
                  // ignore parse errors and pass through
                }
              }
              res.write(line + "\n");
            }
            res.end();
          } catch {
            res.end("\n");
          }
        },
      });

      api.registerHttpRoute({
        path: `${prefix}/api/note`,
        handler: async (req, res) => {
          if (!enableNotes) {
            res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("notes disabled");
            return;
          }
          // Accept POST with JSON { text, sessionKey? }
          if (req.method !== "POST") {
            res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("method not allowed");
            return;
          }
          let body = "";
          for await (const chunk of req) body += chunk;
          let payload;
          try { payload = JSON.parse(body || "{}"); } catch { payload = {}; }

          const text = String(payload.text || "").trim();
          if (!text) {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("missing text");
            return;
          }

          const sessionKey = payload.sessionKey ? String(payload.sessionKey) : undefined;
          const sessionInfo = sessionKey ? sessionMap[sessionKey] : undefined;
          const sessionId = sessionInfo?.sessionId;
          const label = resolveLabel(sessionKey, sessionId, sessionInfo?.label);
          const channel = resolveChannel(sessionKey, sessionId, sessionInfo?.channel);

          emitLedger({
            ts: nowIso(),
            source: "plugin",
            agent: {
              id: agentId,
              name: agentDisplayName,
            },
            session: { key: sessionKey, id: sessionId, label, channel },
            tool: "note",
            summary: text,
            details: { result: "ok" },
          });

          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true }));
        },
      });

      api.registerHttpRoute({
        path: `${prefix}/events`,
        handler: (req, res) => {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
          });
          res.write(": connected\n\n");
          clients.add(res);
          sseSend(res, "hello", { ok: true });
          const ping = setInterval(() => {
            try {
              res.write(": ping\n\n");
            } catch {}
          }, 15000);
          req.on("close", () => {
            clearInterval(ping);
            clients.delete(res);
          });
        },
      });

      // Capture "start" params so we can join them into the later tool_result_persist (which contains duration).
      // We do NOT emit start lines (keeps the feed clean); we store a short, sanitized summary only.
      const recentStarts = new Map(); // sessionKey -> toolName -> [{tsMs, summary, paths, url}]

      function pushStart(sessionKey, toolName, params) {
        if (!sessionKey || !toolName) return;
        const byTool = recentStarts.get(sessionKey) || new Map();
        const q = byTool.get(toolName) || [];
        q.push({
          tsMs: Date.now(),
          summary: summarize(toolName, params),
          paths: pickPaths(params),
          url: pickUrl(params),
        });
        while (q.length > 40) q.shift();
        byTool.set(toolName, q);
        recentStarts.set(sessionKey, byTool);
      }

      function popRecentStart(sessionKey, toolName, maxAgeMs = 30000) {
        const byTool = recentStarts.get(sessionKey);
        if (!byTool) return;
        const q = byTool.get(toolName);
        if (!q || !q.length) return;
        const now = Date.now();
        // Drop too-old
        while (q.length && (now - q[0].tsMs) > maxAgeMs) q.shift();
        if (!q.length) return;
        return q.shift();
      }

      api.on("before_tool_call", (event, hookCtx) => {
        const sessionKey = hookCtx?.sessionKey;
        const toolName = event.toolName;
        const params = sanitizeAny(event.params || {});
        pushStart(sessionKey, toolName, params);
      });

      // Hook: after_tool_call (preferred: has params+duration) — keep it, but it still seems not to fire on some builds.
      api.on("after_tool_call", (event, hookCtx) => {
        const sessionKey = hookCtx?.sessionKey;
        const toolName = event.toolName;
        const params = sanitizeAny(event.params || {});
        const sessionInfo = sessionKey ? sessionMap[sessionKey] : undefined;
        const sessionId = sessionInfo?.sessionId;
        const label = resolveLabel(sessionKey, sessionId, sessionInfo?.label);
        const channel = resolveChannel(sessionKey, sessionId, sessionInfo?.channel);

        emitLedger({
          ts: nowIso(),
          source: "plugin",
          agent: {
            id: hookCtx?.agentId || "main",
            name: hookCtx?.agentId === agentId ? agentDisplayName : (hookCtx?.agentId || agentId),
          },
          session: {
            key: sessionKey,
            id: sessionId,
            label,
            channel,
          },
          tool: toolName,
          phase: "done",
          fingerprint: `${sessionKey || ''}|after|${toolName}|${summarize(toolName, params)}`,
          summary: summarize(toolName, params),
          details: {
            durationMs: event.durationMs,
            error: event.error,
            paths: pickPaths(params),
            url: pickUrl(params),
            result: event.error ? "error" : "ok",
          },
        });
      });

      // Hook: tool results persisted (reliable DONE signal). We join the prior start summary back in.
      api.on("tool_result_persist", (event, hookCtx) => {
        const sessionKey = hookCtx?.sessionKey;
        const sessionInfo = sessionKey ? sessionMap[sessionKey] : undefined;
        const sessionId = sessionInfo?.sessionId;
        const label = resolveLabel(sessionKey, sessionId, sessionInfo?.label);
        const channel = resolveChannel(sessionKey, sessionId, sessionInfo?.channel);

        const msg = event?.message?.message || event?.message || {};
        const toolName = msg.toolName || event.toolName || hookCtx?.toolName || "";
        const isError = Boolean(msg.isError);
        const durationMs = msg?.details?.durationMs;

        const st = popRecentStart(sessionKey, toolName);

        emitLedger({
          ts: nowIso(),
          source: "plugin",
          agent: {
            id: hookCtx?.agentId || "main",
            name: hookCtx?.agentId === agentId ? agentDisplayName : (hookCtx?.agentId || agentId),
          },
          session: {
            key: sessionKey,
            id: sessionId,
            label,
            channel,
          },
          tool: toolName,
          phase: "done",
          fingerprint: hookCtx?.toolCallId || msg.toolCallId,
          summary: st?.summary || toolName,
          details: {
            durationMs,
            paths: st?.paths,
            url: st?.url,
            error: isError ? "tool error" : undefined,
            result: isError ? "error" : "ok",
          },
        });
      });

      // Keep a note in diagnostics
      ctx.logger.info(`[clawtrace] routes mounted at ${prefix} (served by gateway port)`);
      ctx.logger.info(`[clawtrace] ledgerPath=${ledgerPath}`);

      // Cleanup on stop
      ctx.__clawtraceStop = () => {
        clearInterval(sessionMapTimer);
      };
    },

    stop(ctx) {
      try {
        ctx.__clawtraceStop?.();
      } catch {}
    },
  };
}
