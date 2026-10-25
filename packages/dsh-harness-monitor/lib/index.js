/**
 * dsh-harness-monitor 的 host 半（Node 侧）。
 *
 * 注册前缀路由 /harness-monitor/api：
 *   GET  /list   —— 运行 lib/query.ps1，列出本机全部 dsh harness 进程并分类
 *                   （background / dev / desktop，见 query.ps1 注释）；
 *   GET  /whoami —— v4 新增：返回自身身份，并尽力返回"正在服务的会话"
 *                   （探查宿主侧会话归属接口，见 collectServing 的探查顺序）；
 *   POST /kill   —— v4 分级释放：请求体 { pids, kind?, confirm? }；
 *                   kind=background（默认）直接放行，dev/desktop 必须带
 *                   confirm:true；交给 lib/kill.ps1，脚本侧再对每个 pid 做
 *                   进程身份二次校验（类别必须与请求一致，且只结束 dsh
 *                   harness 进程），返回 { killed, skipped, refused }。
 *
 * 安全底线：whoami 与 kill 只接受回环地址（127.0.0.1/::1）的请求；
 * kill 只针对服务端重新校验过身份的进程；失败返回 { ok:false, error }。
 */
import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const KIND_WHITELIST = new Set(["background", "dev", "desktop"]);
const SELF_VERSION = "0.4.0";

/** /list 结果的短缓存：面板打开/刷新每次都跑两轮 WMI + Get-NetTCPConnection（秒级）。
 *  kill 成功后主动清空，避免看到旧列表。 */
let listCache = { at: 0, value: null };
const LIST_CACHE_MS = 2000;

/** 请求的 Site 归属（浏览器自动带；非浏览器为空串）。 */
function fetchSite(req) {
  return String((req.headers && req.headers["sec-fetch-site"]) || "").toLowerCase();
}

/** Origin 的 host 部分；解析失败回空串（当作不同源处理）。 */
function safeHost(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return "";
  }
}

/** 回环判定：只有本机请求能探测 whoami 或触发释放。 */
function isLoopback(req) {
  const addr = (req.socket && req.socket.remoteAddress) || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(body));
}

/** 运行一个 PowerShell 脚本并解析其 JSON 输出（单元素数组会被 ConvertTo-Json 摊平）。 */
function runPs(script, args = []) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).slice(0, 400)));
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error("无法解析 PowerShell 输出: " + String(stdout).slice(0, 200)));
        }
      }
    );
  });
}

/** 会话标题：header.title（本版本没有该字段，留作向前兼容）→ 末条 session/title 事件 → cwd 叶名。 */
function sessionTitle(session) {
  try {
    const header = (session && session.header) || {};
    if (typeof header.title === "string" && header.title.trim() !== "") return header.title.trim();
    if (typeof session.snapshotEvents === "function") {
      const events = session.snapshotEvents() || [];
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        const data = event && event.data;
        if (event && event.type === "session/title" && data && typeof data.title === "string" && data.title.trim() !== "") {
          return data.title.trim();
        }
      }
    }
    if (typeof header.cwd === "string" && header.cwd !== "") return basename(header.cwd) || header.cwd;
  } catch {
    /* 标题读取失败不能影响 whoami */
  }
  return typeof session.id === "string" ? session.id : "未知会话";
}

/**
 * "正在服务的会话"探查（v4）。
 *
 * 探查顺序与结论：
 *  1) ctx.sessions（@deepseek-ai/dsh-session 的活动会话注册表）——本进程当前挂载
 *     （attach）的会话，正是"这个后端正在服务谁"；配合 ctx.agents(id).status
 *     判定 running（正在执行任务）。可用 → 采用。
 *  2) ctx.sessionPersistence（@deepseek-ai/dsh-session-persistence）——只提供
 *     create/open/stat/list，list() 返回该 profile 全部已落盘会话，无法判定
 *     "哪个进程在服务它"；其"活动写句柄"保存在 jsonl 后端私有的 writers Map 与
 *     claimWrite/releaseClaim 里，公开 API 不暴露，探不到 → 不采用，仅记结论。
 */
function collectServing(ctx) {
  const notes = [];
  try {
    const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
    if (sessions && typeof sessions.list === "function") {
      const agents = typeof ctx.get === "function" ? ctx.get("agents") : undefined;
      const items = [];
      for (const session of sessions.list()) {
        const id = session && typeof session.id === "string" ? session.id : undefined;
        if (id === undefined || id === "") continue;
        const header = (session && session.header) || {};
        if (header.origin === "subagent") continue; // 子代理会话不是"对话"
        let running = false;
        try {
          const agent = agents && typeof agents.get === "function" ? agents.get(id) : undefined;
          running = agent !== undefined && agent !== null && agent.status === "running";
        } catch {
          /* 状态读不到就按空闲处理 */
        }
        items.push({ id, title: sessionTitle(session), running });
      }
      items.sort((a, b) => (a.running === b.running ? a.title.localeCompare(b.title) : a.running ? -1 : 1));
      return {
        supported: true,
        source: "ctx.sessions.list()（dsh-session 活动会话注册表）+ ctx.agents(id).status",
        count: items.length,
        items,
        titles: items.map((item) => (item.running ? item.title + "（执行中）" : item.title))
      };
    }
    notes.push("ctx.sessions 不可用（本轮运行的版本没有活动会话注册表）");
  } catch (error) {
    notes.push("ctx.sessions 探查失败: " + String(error && error.message ? error.message : error).slice(0, 160));
  }

  try {
    const persistence = typeof ctx.get === "function" ? ctx.get("sessionPersistence") : undefined;
    if (persistence && typeof persistence.list === "function") {
      notes.push("ctx.sessionPersistence 只有 create/open/stat/list：list() 是全部已落盘会话，判定不了进程归属；活动写句柄在 jsonl 后端私有 writers/claimWrite 中，无公开接口");
    } else {
      notes.push("ctx.sessionPersistence 不可用");
    }
  } catch (error) {
    notes.push("ctx.sessionPersistence 探查失败: " + String(error && error.message ? error.message : error).slice(0, 160));
  }

  return { supported: false, source: null, count: 0, items: [], titles: [], reason: notes.join("；") };
}

/** 自身身份：面板用它核对 whoami 回声（PID/端口/cwd）。 */
function selfIdentity(ctx) {
  let port;
  try {
    port = ctx.webServer && typeof ctx.webServer.port === "number" ? ctx.webServer.port : undefined;
  } catch {
    port = undefined;
  }
  let startedAt;
  try {
    startedAt = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
  } catch {
    startedAt = undefined;
  }
  return {
    service: "dsh-harness-monitor",
    version: SELF_VERSION,
    pid: process.pid,
    platform: process.platform,
    cwd: process.cwd(),
    workspace: basename(process.cwd()),
    port,
    startedAt,
    uptimeSec: Math.round(process.uptime())
  };
}

const HarnessMonitorHost = {
  name: "harness-monitor-host",
  inject: ["webServer"],
  apply(ctx, config = {}) {
    if (process.platform !== "win32") {
      ctx.logger.warn("[harness-monitor] 非 Windows 平台，监视功能停用（依赖 PowerShell）");
      // 仍然注册路由并回 available:false：前端据此隐藏入口，而不是点了之后 404。
      ctx.effect(() => ctx.webServer.register({
        kind: "prefix",
        path: "/harness-monitor/api",
        handler: (req, res) => {
          if (req.method === "GET" && String(req.url ?? "").startsWith("/harness-monitor/api/whoami")) {
            sendJson(res, 200, { ok: true, available: false, identity: null, serving: { supported: false, items: [] }, capabilities: { whoami: true } });
            return;
          }
          sendJson(res, 200, { ok: true, available: false, items: [] });
        }
      }));
      return;
    }
    ctx.effect(() => ctx.webServer.register({
      kind: "prefix",
      path: "/harness-monitor/api",
      handler: async (req, res) => {
        try {
          const pathname = new URL(req.url ?? "/", "http://x").pathname;
          if (!isLoopback(req)) {
            ctx.logger.warn(`[harness-monitor] 拒绝非回环请求: ${req.socket && req.socket.remoteAddress}`);
            sendJson(res, 403, { ok: false, error: "仅限本机回环访问" });
            return;
          }
          if (req.method === "OPTIONS") {
            // 跨源预检只放 "同站"（同主机不同端口）的来源。之前回 `*`，
            // 等于任何网站都能跨源打这个服务的写接口。
            const site = fetchSite(req);
            const origin = String(req.headers.origin || "");
            if (site === "cross-site") {
              sendJson(res, 403, { ok: false, error: "跨源预检被拒绝" });
              return;
            }
            res.writeHead(204, {
              "access-control-allow-origin": origin !== "" ? origin : "null",
              "access-control-allow-methods": "GET, POST, OPTIONS",
              "access-control-allow-headers": "content-type",
              "vary": "origin"
            });
            res.end();
            return;
          }
          if (req.method === "GET" && pathname === "/harness-monitor/api/list") {
            if (listCache.value !== null && Date.now() - listCache.at < LIST_CACHE_MS) {
              sendJson(res, 200, { ...listCache.value, self: process.pid });
              return;
            }
            const raw = await runPs(join(here, "query.ps1"));
            const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
            listCache = { at: Date.now(), value: { ok: true, items } };
            // self = 面板所在 harness 自己的 PID（客户端用它标"本界面"）
            sendJson(res, 200, { ok: true, self: process.pid, items });
            return;
          }
          if (req.method === "GET" && pathname === "/harness-monitor/api/whoami") {
            // v4：自身身份 + 尽力返回"正在服务的会话"。跨端口探测是跨源 GET，
            // 因此这里放开 CORS（仍只服务回环请求）。
            const serving = collectServing(ctx);
            sendJson(res, 200, {
              ok: true,
              identity: selfIdentity(ctx),
              serving,
              capabilities: { whoami: true, gradedRelease: true, kinds: [...KIND_WHITELIST] }
            }, fetchSite(req) === "cross-site" ? {} : { "access-control-allow-origin": String(req.headers.origin || "null"), "vary": "origin" });
            return;
          }
          if (req.method === "POST" && pathname === "/harness-monitor/api/kill") {
            // 破坏性接口：只接受同源请求。浏览器跨源 POST 一定带 sec-fetch-site，
            // 这里直接拒；没有该头的本机脚本（curl/node）不受影响。
            const site = fetchSite(req);
            const origin = String(req.headers.origin || "");
            const host = String(req.headers.host || "");
            const sameOrigin = site === "same-origin" || (origin !== "" && safeHost(origin) === host);
            if (site !== "" && !sameOrigin) {
              sendJson(res, 403, { ok: false, error: "拒绝跨源释放请求" });
              return;
            }
            let body = "";
            const MAX_BODY = 64 * 1024;
            for await (const chunk of req) {
              body += chunk;
              if (body.length > MAX_BODY) {
                sendJson(res, 413, { ok: false, error: "请求体超过 64KB" });
                req.destroy();
                return;
              }
            }
            let pids = [];
            let kind = "background";
            let confirm = false;
            try {
              const parsed = JSON.parse(body || "{}");
              if (Array.isArray(parsed.pids)) pids = parsed.pids;
              if (typeof parsed.kind === "string" && parsed.kind !== "") kind = parsed.kind;
              confirm = parsed.confirm === true;
            } catch {}
            pids = [...new Set(pids.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 64);
            if (!pids.length) {
              sendJson(res, 400, { ok: false, error: "请求体需为 { pids: number[] }" });
              return;
            }
            if (!KIND_WHITELIST.has(kind)) {
              sendJson(res, 400, { ok: false, error: `未知类别 ${kind}（只接受 background/dev/desktop）` });
              return;
            }
            if (kind !== "background" && confirm !== true) {
              sendJson(res, 400, { ok: false, error: `${kind} 释放必须显式携带 confirm 标记` });
              return;
            }
            const actor = `${process.pid}@${(req.socket && req.socket.remoteAddress) || "?"} cwd=${process.cwd()}`;
            const args = ["-Pids", pids.join(","), "-Kind", kind, "-Actor", actor];
            if (confirm) args.push("-Confirm");
            const result = await runPs(join(here, "kill.ps1"), args);
            listCache = { at: 0, value: null }; // 杀完必须让下一次 /list 重新查
            ctx.logger.info(
              `[harness-monitor] 释放请求 kind=${kind} confirm=${confirm ? "yes" : "no"} ` +
              `killed=${(result.killed || []).join(",") || "无"} skipped=${(result.skipped || []).join(",") || "无"}`
            );
            sendJson(res, 200, { ok: true, kind, confirm, ...result });
            return;
          }
          sendJson(res, 404, { ok: false, error: "未知端点" });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.logger.warn(`[harness-monitor] 请求失败: ${message}`);
          sendJson(res, 500, { ok: false, error: message });
        }
      }
    }), "harness-monitor: /harness-monitor/api 路由");
  }
};

export default HarnessMonitorHost;
