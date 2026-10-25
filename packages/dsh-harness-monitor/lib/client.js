/**
 * dsh-harness-monitor 的 client 半（浏览器）—— v4「会话映射 + 分级单个释放」。
 *
 * 手写 bundle，遵循 DSH 客户端插件装载协议：
 * window.__ModuleLoader__.load({ id, factory }) —— id 必须等于包名；
 * factory 返回的模块导出 { apply, inject }。
 *
 * 行为：
 * - 向 sidebar.footer.action 槽注册条目（与备份按钮同一排）；
 * - wide 模式：DOM 按钮放在「设置」行内、备份按钮左侧一格；
 * - rail 模式：按钮回落到槽内居中渲染；
 * - 点击弹出占用面板：列出全部 harness（后台占用者/Desktop/dev）：
 *     · 本界面行显示"正在服务：…”——直接读本页的 sessions 快照
 *       （tree-panel 同款字段容错读取），能对应到运行中的会话时"执行任务中"
 *       徽标具体化为"执行任务中：<会话标题>"；
 *     · 其它行对 127.0.0.1:<端口> 逐个探测 GET /harness-monitor/api/whoami
 *       （1.5s 超时，失败静默显示"—"，绝不阻塞面板打开）；
 *     · 每行都有释放按钮，按类别分级：background 直接释放；dev 需确认
 *       "结束将终止该实例上正在执行的任务（如有）"；desktop 的按钮是
 *       "重启后端"，确认文案见 RELEASE 表；
 *     · 「全部释放」保持只针对后台编码搭档。
 *
 * 安全底线：只注入按钮/面板、只请求 /harness-monitor/api/*；
 * 分级释放的 confirm 标记只在用户点过确认框后才发出（服务端还会二次校验）；
 * 后端未加载 v4（没有 /whoami）时不显示 dev/desktop 释放按钮；
 * 任何 DOM 结构不兼容都静默降级（按钮不显示），绝不拖垮整个界面。
 */
window.__ModuleLoader__.load({
  id: "dsh-harness-monitor",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

    /* ---------- 样式：亮/暗双主题，打开面板时按页面实际背景亮度显式选择，
       不依赖应用主题变量（部分版本变量缺失或不匹配会把文字变成同色隐形） ---------- */
    var CSS = [
      ".dsh-hm-button{display:inline-flex;align-items:center;justify-content:center;flex:none;border:none;background:transparent;border-radius:50%;cursor:pointer;padding:0;color:var(--dsw-alias-label-secondary,#8a8f98);line-height:1}",
      ".dsh-hm-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18))}",
      ".dsh-hm-button.has-busy{color:#e3a008}",
      /* 暗色（默认） */
      ".dsh-hm-panel{position:fixed;left:12px;bottom:76px;z-index:99998;width:min(540px,calc(100vw - 24px));display:flex;flex-direction:column;background:#1f2329;color:#e8eaed;border:1px solid rgba(128,128,128,.35);border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.4);font-size:13px;line-height:1.5}",
      ".dsh-hm-head{display:flex;align-items:center;gap:8px;padding:10px 12px 6px;font-weight:600}",
      ".dsh-hm-head .dsh-hm-count{color:#9aa0a6;font-size:12px;font-weight:400}",
      ".dsh-hm-head .dsh-hm-close{margin-left:auto;border:none;background:transparent;color:inherit;cursor:pointer;font-size:15px;padding:2px 7px;border-radius:6px}",
      ".dsh-hm-head .dsh-hm-close:hover{background:rgba(128,128,128,.2)}",
      ".dsh-hm-status{margin:0 12px 4px;padding:5px 8px;border-radius:7px;background:rgba(90,140,230,.16);color:#a9c4f7;font-size:12px}",
      ".dsh-hm-list{overflow:auto;padding:0 8px 8px;max-height:min(400px,calc(100vh - 220px))}",
      ".dsh-hm-row{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;flex-wrap:wrap}",
      ".dsh-hm-row.self{background:rgba(90,140,230,.14);outline:1px solid rgba(90,140,230,.35)}",
      ".dsh-hm-line1{display:flex;align-items:center;gap:8px;min-width:0;flex:1}",
      ".dsh-hm-line2{width:100%;padding-left:2px;color:#9aa0a6;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dsh-hm-who{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-hm-pid{font-variant-numeric:tabular-nums;color:#9aa0a6;flex:none;margin-left:auto}",
      ".dsh-hm-tag{flex:none;padding:1px 8px;border-radius:999px;font-size:11px;line-height:17px}",
      ".dsh-hm-tag.bg{background:rgba(230,168,0,.22);color:#e8b23f}",
      ".dsh-hm-tag.dt{background:rgba(70,160,90,.22);color:#5cb56e}",
      ".dsh-hm-tag.dv{background:rgba(90,140,230,.22);color:#84aaf0}",
      ".dsh-hm-tag.selftag{background:rgba(90,140,230,.28);color:#9cbaf7}",
      ".dsh-hm-tag.livetag{background:rgba(70,200,110,.22);color:#5ad07e;max-width:54%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-hm-actions{flex:none;display:flex;gap:6px;margin-left:auto}",
      ".dsh-hm-kill{flex:none;border:1px solid rgba(248,81,73,.5);background:transparent;color:#f26d64;border-radius:6px;cursor:pointer;padding:2px 8px;font-size:12px}",
      ".dsh-hm-kill:hover{background:rgba(248,81,73,.15)}",
      ".dsh-hm-kill.restart{border-color:rgba(230,168,0,.5);color:#e8b23f}",
      ".dsh-hm-kill.restart:hover{background:rgba(230,168,0,.15)}",
      ".dsh-hm-confirm{width:100%;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 8px;border-radius:8px;background:rgba(248,81,73,.12);border:1px solid rgba(248,81,73,.38)}",
      ".dsh-hm-confirm .dsh-hm-confirm-text{flex:1;min-width:180px;font-size:12px;color:#f0a9a4}",
      ".dsh-hm-confirm button{flex:none;border-radius:6px;cursor:pointer;padding:3px 10px;font-size:12px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit}",
      ".dsh-hm-confirm button:hover{background:rgba(128,128,128,.15)}",
      ".dsh-hm-confirm button.danger{border-color:rgba(248,81,73,.55);color:#f26d64}",
      ".dsh-hm-confirm button.danger:hover{background:rgba(248,81,73,.18)}",
      ".dsh-hm-foot{display:flex;flex-wrap:wrap;gap:8px;padding:8px 12px 10px;border-top:1px solid rgba(128,128,128,.25)}",
      ".dsh-hm-foot button{flex:1;border-radius:8px;padding:7px 0;cursor:pointer;font-size:13px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit}",
      ".dsh-hm-foot button:hover{background:rgba(128,128,128,.15)}",
      ".dsh-hm-foot button.danger{border-color:rgba(248,81,73,.5);color:#f26d64}",
      ".dsh-hm-empty{padding:14px 12px;text-align:center;color:#9aa0a6}",
      ".dsh-hm-helpbtn{flex:none;width:22px;height:22px;padding:0;border:1px solid rgba(255,255,255,.22);border-radius:50%;background:transparent;color:#8a8f98;font-size:12px;line-height:1;cursor:pointer}",
      ".dsh-hm-helpbtn:hover{background:rgba(255,255,255,.08);color:#e6e9ee}",
      ".dsh-hm-help{display:none;padding:8px 12px 10px;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);font-size:11px;line-height:1.6;color:#9aa1a9}",
      ".dsh-hm-help.on{display:block}",
      ".dsh-hm-help div{display:flex;gap:8px;margin:2px 0}",
      ".dsh-hm-help b{flex:none;color:#c6ccd3;font-weight:600}",
      ".dsh-hm-missing{padding:7px 8px;border-radius:8px;background:rgba(230,168,0,.12);color:#e8b23f;font-size:12px}",
      /* 亮色覆盖 */
      ".dsh-hm-panel.dsh-hm-light{background:#ffffff;color:#1f2329;border-color:rgba(0,0,0,.14);box-shadow:0 10px 34px rgba(0,0,0,.18)}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-head .dsh-hm-count{color:#6b7075}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-status{background:rgba(70,120,230,.10);color:#2f5fc4}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-line2{color:#6b7075}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-pid{color:#6b7075}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-row.self{background:rgba(70,120,230,.10);outline-color:rgba(70,120,230,.35)}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-tag.bg{background:rgba(214,158,0,.16);color:#9a6d00}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-tag.dt{background:rgba(40,140,70,.14);color:#22743c}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-tag.dv{background:rgba(60,110,220,.14);color:#2f5fc4}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-tag.selftag{background:rgba(60,110,220,.18);color:#2f5fc4}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-tag.livetag{background:rgba(30,150,70,.14);color:#1e7a3c}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-kill{color:#c93a30;border-color:rgba(201,58,48,.45)}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-kill:hover{background:rgba(201,58,48,.08)}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-kill.restart{color:#9a6d00;border-color:rgba(154,109,0,.45)}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-kill.restart:hover{background:rgba(154,109,0,.08)}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-confirm{background:rgba(201,58,48,.08);border-color:rgba(201,58,48,.32)}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-confirm .dsh-hm-confirm-text{color:#a83129}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-confirm button{border-color:rgba(0,0,0,.16)}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-confirm button.danger{color:#c93a30;border-color:rgba(201,58,48,.45)}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-foot{border-top-color:rgba(0,0,0,.12)}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-foot button{border-color:rgba(0,0,0,.16)}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-foot button:hover{background:rgba(0,0,0,.06)}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-empty{color:#6b7075}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-helpbtn{border-color:rgba(0,0,0,.2);color:#5f6672}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-helpbtn:hover{background:rgba(0,0,0,.06);color:#1c2027}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-help{border-bottom-color:rgba(0,0,0,.08);background:rgba(0,0,0,.03);color:#5f6672}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-help b{color:#1c2027}",
      ".dsh-hm-panel.dsh-hm-light .dsh-hm-missing{background:rgba(214,158,0,.10);color:#9a6d00}"
    ].join("");

    (function injectStyle() {
      if (typeof document === "undefined") return;
      var tagId = "dsh-harness-monitor/styles";
      var existing = document.querySelector("style[data-plugin-css=\"" + tagId + "\"]");
      if (existing) {
        // 样式表已存在（HMR 之外的重复装载）：内容变了就原地刷新。
        try { if (existing.textContent !== CSS) existing.textContent = CSS; } catch (e) {}
        return;
      }
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-harness-monitor";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    })();

    var KIND_LABEL = {
      background: { text: "后台编码搭档 · 占用者", tag: "bg" },
      desktop: { text: "Desktop 后端", tag: "dt" },
      dev: { text: "固定端口 dev", tag: "dv" }
    };

    /* 分级释放语义表：background 直接放行；dev/desktop 必须先弹确认框，
       确认后才携带 confirm 标记请求服务端（服务端与 kill.ps1 都会再校验一次）。 */
    var RELEASE = {
      background: { label: "结束", confirmText: null },
      dev: { label: "结束", confirmText: "结束将终止该实例上正在执行的任务（如有）", confirmLabel: "确认结束" },
      desktop: { label: "重启后端", confirmText: "将重启 Desktop 的后端进程（应用窗口会自动重连；正在执行的任务会被终止）", confirmLabel: "确认重启" }
    };

    var DESKTOP_WHO = "共用后端 · 服务本窗口所有对话";
    /** 「?」里只放"看懂了才用得对"的四条；主面板不再出现解释性文案。 */
    var HELP_ROWS = [
      ["本界面", "打开本面板的窗口所连的后端"],
      ["多窗口", "Desktop 的对话共用一个后端，同 PID 会重复出现"],
      ["分级释放", "background 可直接释放，dev / desktop 需确认"],
      ["不在列表", "可能已重启、退出，或版本较旧"],
    ];
    var PROBE_TIMEOUT_MS = 1500;
    var SERVE_REFRESH_MS = 5000;
    var SERVE_TITLE_MAX = 14;
    var BADGE_TITLE_MAX = 18;

    /* ---------- 模块状态 ---------- */
    var panelEl = null;
    var sessionsService = null;   // apply(ctx) 注入：dsh-api-session-controller 的 client 半
    var whoamiCache = {};         // "<pid>@<port>" -> whoami 响应（失败为 null）
    var whoamiAt = {};            // 同键 -> 毫秒时间戳；10s TTL，避免"进程还在但会话变了"永远显示旧值
    var whoamiTtlMs = 10000;
    var outsideHandler = null;    // 面板外侧点击监听；closePanel 必须摘掉，否则每开一次多一个
    var hostGraded = null;        // null=未探测；true=后端已加载 v4 分级释放
    var serveTimer = null;
    var lastItems = null;         // 最近一次 /list 的进程行
    var lastSelfPid = 0;
    var pendingConfirm = null;    // { pid, kind } —— 正在确认框里的释放请求
    var statusText = "";

    /* ---------- 会话快照读取（tree-panel 同款：字段名按运行版本容错） ---------- */

    function listSnapshot() {
      try {
        if (!sessionsService || !sessionsService.list) return null;
        var list = sessionsService.list;
        if (typeof list.getSnapshot === "function") return list.getSnapshot();
        if (typeof list.getListSnapshot === "function") return list.getListSnapshot();
        return list;
      } catch (e) {
        return null;
      }
    }

    function basename(path) {
      if (typeof path !== "string" || path === "") return "";
      return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || "";
    }

    function titleOf(item, id) {
      var t = item.displayTitle || item.title || item.name;
      if (typeof t === "string" && t.trim() !== "") return t;
      // 无标题的新会话：回退到工作区目录名，再回退到 id。
      return basename(item.cwd) || id;
    }

    function shortTitle(text, max) {
      var t = typeof text === "string" ? text : "";
      return t.length > max ? t.slice(0, max) + "…" : t;
    }

    /** 归一化会话行；快照读不到返回 null（与"没有会话"区分开）。 */
    function sessionRows() {
      try {
        var snap = listSnapshot();
        if (snap === null || snap === void 0) return null;
        var raw = null;
        if (Array.isArray(snap.ids) && snap.byId && typeof snap.byId === "object") {
          raw = snap.ids.map(function (id) { return snap.byId[id]; }).filter(function (row) { return row !== void 0 && row !== null; });
        } else if (Array.isArray(snap.items)) {
          raw = snap.items;
        } else if (Array.isArray(snap)) {
          raw = snap;
        } else {
          return null;
        }
        return raw.map(function (item) {
          var id = item.id || item.sessionId;
          if (typeof id !== "string" || id === "") return null;
          return {
            id: id,
            title: titleOf(item, id),
            running: item.running === true,
            updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
            subagent: item.origin === "subagent"
          };
        }).filter(function (row) { return row !== null; });
      } catch (e) {
        return null;
      }
    }

    /** 本页当前对话的会话 id（每个窗口各自一份，所以两窗口的"本对话"不同）。 */
    function currentSessionId() {
      try {
        var snap = listSnapshot();
        if (snap && typeof snap.current === "string" && snap.current !== "") return snap.current;
      } catch (e) {}
      return null;
    }

    function runningFirst(list, currentId) {
      return list.slice().sort(function (a, b) {
        if (a.running !== b.running) return a.running ? -1 : 1;
        if (currentId) {
          if (a.id === currentId) return -1;
          if (b.id === currentId) return 1;
        }
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
    }

    /** 本机（本界面行）：直接读本页会话快照。 */
    function localServing() {
      var rows = sessionRows();
      if (rows === null) return null;
      var conv = rows.filter(function (row) { return !row.subagent; });
      var current = currentSessionId();
      var currentRow = null;
      var rest = [];
      conv.forEach(function (row) {
        if (current !== null && row.id === current) currentRow = row;
        else rest.push(row);
      });
      rest = runningFirst(rest, null);
      var items = [];
      if (currentRow) items.push({ title: currentRow.title, state: currentRow.running ? "执行中" : "本对话" });
      for (var i = 0; i < rest.length && items.length < 2; i++) {
        items.push({ title: rest[i].title, state: rest[i].running ? "执行中" : "空闲" });
      }
      var running = conv
        .filter(function (row) { return row.running; })
        .sort(function (a, b) {
          if (current !== null) {
            if (a.id === current) return -1;
            if (b.id === current) return 1;
          }
          return (b.updatedAt || 0) - (a.updatedAt || 0);
        })
        .map(function (row) { return row.title; });
      return { items: items, total: conv.length, running: running };
    }

    /** 它机（whoami 探测）：能对应到运行中的会话时返回标题，用于具体化徽标。 */
    function peerServing(it) {
      if (!it.portActual) return null;
      var key = it.pid + "@" + it.portActual;
      if (!(key in whoamiCache)) return { pending: true };
      var data = whoamiCache[key];
      if (!data || data.ok !== true || !data.serving || data.serving.supported !== true) return { failed: true };
      var items = data.serving.items || [];
      return {
        items: items.slice(0, 2).map(function (s) { return { title: s.title, state: s.running === true ? "执行中" : "空闲" }; }),
        total: Number.isFinite(data.serving.count) ? data.serving.count : items.length,
        running: items.filter(function (s) { return s.running === true; }).map(function (s) { return s.title; })
      };
    }

    function serveText(serving, isPeer) {
      if (serving === null || serving === void 0) return "正在服务：—";
      if (serving.pending) return "正在服务：探测中…";
      if (serving.failed) return "正在服务：—";
      var items = serving.items || [];
      // 本界面行读的是本后端的会话快照（含全部会话）；它机行读的是对端
      // 挂载中的会话，所以"空"的含义不同：一个是没有会话，一个是没有活动会话。
      if (!items.length) return isPeer ? "正在服务：无活动会话" : "正在服务：无会话";
      var parts = items.map(function (item) { return shortTitle(item.title, SERVE_TITLE_MAX) + "（" + item.state + "）"; });
      return "正在服务：" + parts.join("、") + " · 共 " + serving.total + " 个";
    }

    function serveTooltip(serving, extra) {
      var bits = [];
      if (serving && serving.items && serving.items.length) {
        bits.push(serving.items.map(function (item) { return item.title + "（" + item.state + "）"; }).join("\n"));
      }
      if (serving && serving.failed) bits.push("whoami 探测失败或对端未加载本插件（只显示 —）");
      if (extra) bits.push(extra);
      return bits.join("\n");
    }

    /** 徽标：能对应到运行中的会话就用具体标题，否则退回通用文案。 */
    function badgeInfo(serving, processActive) {
      var running = serving && serving.running ? serving.running : [];
      if (running.length) {
        return { text: "执行任务中：" + shortTitle(running[0], BADGE_TITLE_MAX), title: "执行任务中：" + running.join("、") };
      }
      if (processActive) return { text: "执行任务中", title: "进程内有工具子任务在跑，但没能对应到运行中的会话" };
      return null;
    }

    function statsText(it) {
      var bits = [];
      if (it.portActual) bits.push("端口 " + it.portActual);
      if (it.profile && it.profile !== "web") bits.push("profile " + it.profile);
      var secs = Number(it.uptimeSec);
      var mins = secs > 90 ? Math.round(secs / 60) + " 分钟" : (Number.isFinite(secs) ? secs + " 秒" : "?");
      bits.push("已运行 " + mins);
      bits.push(it.started || "");
      return bits.join(" · ");
    }

    /* ---------- 面板 ---------- */
    function closePanel() {
      if (serveTimer) { clearInterval(serveTimer); serveTimer = null; }
      if (outsideHandler) { try { document.removeEventListener("mousedown", outsideHandler); } catch (e) {} outsideHandler = null; }
      pendingConfirm = null;
      lastItems = null;
      if (panelEl) { try { panelEl.remove(); } catch (e) {} panelEl = null; }
    }

    function fetchJson(url, timeoutMs) {
      return new Promise(function (resolve) {
        var settled = false;
        var controller = null;
        var timer = null;
        try { controller = new AbortController(); } catch (e) { controller = null; }
        var finish = function (value) {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(value);
        };
        timer = setTimeout(function () {
          try { if (controller) controller.abort(); } catch (e) {}
          finish(null);
        }, timeoutMs);
        var opts = { headers: { "Accept": "application/json" } };
        if (controller) opts.signal = controller.signal;
        try {
          fetch(url, opts)
            .then(function (r) { return r.json().catch(function () { return null; }); })
            .then(function (data) { finish(data); })
            .catch(function () { finish(null); });
        } catch (e) {
          finish(null);
        }
      });
    }

    /** 后端能力探测（同源）：v4 之前没有 /whoami，据此隐藏 dev/desktop 释放按钮。 */
    function probeHost() {
      return fetchJson("/harness-monitor/api/whoami", PROBE_TIMEOUT_MS).then(function (data) {
        var graded = !!(data && data.ok === true && data.capabilities && data.capabilities.gradedRelease === true);
        hostGraded = graded;
        if (data && data.ok === true && data.serving && data.serving.supported === true) {
          selfWhoami = data.serving;
        }
        renderRows();
        return data;
      });
    }

    var selfWhoami = null;

    /** 其它进程逐个探测 whoami（仅 127.0.0.1，1.5s 超时，失败静默）。 */
    function probePeers(items, selfPid) {
      (items || []).forEach(function (it) {
        if (it.pid === selfPid) return;
        if (!it.portActual) return;
        var key = it.pid + "@" + it.portActual;
        // 10s 内命中缓存就跳过；过期后重新探测（进程还在但会话变了也能刷新）。
        if (key in whoamiCache && Date.now() - (whoamiAt[key] || 0) < whoamiTtlMs) return;
        whoamiCache[key] = null; // 占位：避免重复发起
        whoamiAt[key] = Date.now();
        fetchJson("http://127.0.0.1:" + it.portActual + "/harness-monitor/api/whoami", PROBE_TIMEOUT_MS).then(function (data) {
          whoamiCache[key] = data && data.ok === true ? data : null;
          renderRows();
        });
      });
    }

    function runKill(pid, kind, confirm) {
      var payload = { pids: [pid], kind: kind, confirm: confirm === true };
      statusText = (kind === "desktop" ? "正在重启后端（PID " + pid + "）…" : "正在释放 PID " + pid + "（" + kind + "）…");
      renderStatus();
      return fetch("/harness-monitor/api/kill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (d) {
          if (d && d.ok) {
            var killed = (d.killed || []).length;
            var refused = (d.refused || []).length;
            var skipped = (d.skipped || []).length;
            statusText = (kind === "desktop" ? "重启请求已发出：" : "释放请求已发出：") +
              "已结束 " + killed + " 个" + (refused ? "，被拒绝 " + refused + " 个（需确认）" : "") +
              (skipped ? "，跳过 " + skipped + " 个（身份校验未通过）" : "");
            renderStatus();
            whoamiCache = {}; whoamiAt = {};
            refreshList();
          } else {
            statusText = "释放失败：" + (d && d.error ? d.error : "未知错误");
            renderStatus();
          }
        })
        .catch(function (e) {
          statusText = "释放失败：" + (e && e.message ? e.message : String(e));
          renderStatus();
        });
    }

    function renderStatus() {
      if (!panelEl) return;
      var box = panelEl.querySelector(".dsh-hm-status");
      if (!box) return;
      box.textContent = statusText || "";
      box.style.display = statusText ? "" : "none";
    }

    /** 单行渲染；确认框状态来自模块级 pendingConfirm，重渲染不会丢。 */
    function buildRow(it, selfPid) {
      var isSelf = it.pid === selfPid;
      var kind = KIND_LABEL[it.kind] || { text: it.kind, tag: "dv" };
      var row = document.createElement("div");
      row.className = "dsh-hm-row" + (isSelf ? " self" : "");
      row.dataset.pid = String(it.pid);

      var line1 = document.createElement("div");
      line1.className = "dsh-hm-line1";
      var tag = document.createElement("span");
      tag.className = "dsh-hm-tag " + kind.tag;
      tag.textContent = kind.text;
      line1.appendChild(tag);
      if (isSelf) {
        var selfTag = document.createElement("span");
        selfTag.className = "dsh-hm-tag selftag";
        selfTag.textContent = "本界面";
        line1.appendChild(selfTag);
      }

      var who = document.createElement("span");
      who.className = "dsh-hm-who";
      // Desktop 不再固定显示"主客户端"；工作目录降级为悬浮 tooltip。
      who.textContent = it.kind === "desktop" ? DESKTOP_WHO : (it.workspace || it.cwd || "未知来源");
      who.title = (it.cwd || "") + (it.kind === "desktop" ? "\n" + DESKTOP_WHO : "");
      line1.appendChild(who);

      var serving = isSelf ? (localServing() || (selfWhoami ? {
        items: (selfWhoami.items || []).slice(0, 2).map(function (s) { return { title: s.title, state: s.running === true ? "执行中" : "空闲" }; }),
        total: Number.isFinite(selfWhoami.count) ? selfWhoami.count : (selfWhoami.items || []).length,
        running: (selfWhoami.items || []).filter(function (s) { return s.running === true; }).map(function (s) { return s.title; })
      } : null)) : peerServing(it);

      var badge = badgeInfo(serving, it.active === true);
      if (badge) {
        var live = document.createElement("span");
        live.className = "dsh-hm-tag livetag";
        live.textContent = badge.text;
        live.title = badge.title;
        line1.appendChild(live);
      }

      var pid = document.createElement("span");
      pid.className = "dsh-hm-pid";
      pid.textContent = "PID " + it.pid;
      line1.appendChild(pid);
      row.appendChild(line1);

      // 非本界面行保留统计行；本界面行的统计信息进服务行 tooltip，第二行留给"正在服务"。
      if (!isSelf) {
        var stats = document.createElement("div");
        stats.className = "dsh-hm-line2";
        stats.textContent = statsText(it);
        stats.title = it.argv || "";
        row.appendChild(stats);
      }

      var serve = document.createElement("div");
      serve.className = "dsh-hm-line2 dsh-hm-serve";
      serve.textContent = serveText(serving, !isSelf);
      serve.title = serveTooltip(serving, isSelf ? statsText(it) + "\n" + (it.argv || "") : (it.argv || ""));
      row.appendChild(serve);

      // 释放动作（分级）
      var rule = RELEASE[it.kind];
      if (rule) {
        var supported = it.kind === "background" || hostGraded === true;
        if (supported) {
          if (pendingConfirm && pendingConfirm.pid === it.pid && pendingConfirm.kind === it.kind && rule.confirmText) {
            var box = document.createElement("div");
            box.className = "dsh-hm-confirm";
            var text = document.createElement("span");
            text.className = "dsh-hm-confirm-text";
            text.textContent = rule.confirmText;
            var cancel = document.createElement("button");
            cancel.type = "button";
            cancel.textContent = "取消";
            cancel.addEventListener("click", function () { pendingConfirm = null; renderRows(); });
            var ok = document.createElement("button");
            ok.type = "button";
            ok.className = "danger";
            ok.textContent = rule.confirmLabel || "确认";
            ok.addEventListener("click", function () {
              pendingConfirm = null;
              runKill(it.pid, it.kind, true);
            });
            box.appendChild(text); box.appendChild(cancel); box.appendChild(ok);
            row.appendChild(box);
          } else {
            var actions = document.createElement("div");
            actions.className = "dsh-hm-actions";
            var kill = document.createElement("button");
            kill.className = "dsh-hm-kill" + (it.kind === "desktop" ? " restart" : "");
            kill.type = "button";
            kill.textContent = rule.label;
            kill.title = rule.confirmText ? rule.confirmText : "直接释放该后台占用者";
            kill.addEventListener("click", function () {
              if (rule.confirmText) { pendingConfirm = { pid: it.pid, kind: it.kind }; renderRows(); }
              else runKill(it.pid, it.kind, false);
            });
            actions.appendChild(kill);
            row.appendChild(actions);
          }
        }
      }
      return row;
    }

    function renderRows() {
      if (!panelEl) return;
      var list = panelEl.querySelector(".dsh-hm-list");
      if (!list) return;
      try {
        if (lastItems === null) return;
        list.textContent = "";
        if (!lastItems.length) {
          var empty = document.createElement("div");
          empty.className = "dsh-hm-empty";
          empty.textContent = "当前没有运行中的 harness。";
          list.appendChild(empty);
          return;
        }
        var selfSeen = false;
        for (var i = 0; i < lastItems.length; i++) {
          var it = lastItems[i];
          if (it.pid === lastSelfPid) selfSeen = true;
          list.appendChild(buildRow(it, lastSelfPid));
        }
        if (lastSelfPid && !selfSeen) {
          var missing = document.createElement("div");
          missing.className = "dsh-hm-missing";
      missing.textContent = "本界面（PID " + lastSelfPid + "）不在列表里（可能已重启/退出）";
          list.appendChild(missing);
        }
      } catch (e) {
        list.textContent = "面板渲染失败（已安全降级）";
      }
    }

    function refreshList() {
      if (!panelEl) return;
      var list = panelEl.querySelector(".dsh-hm-list");
      list.textContent = "加载中…";
      fetch("/harness-monitor/api/list", { headers: { "Accept": "application/json" } })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (d) {
          if (!panelEl) return;
          // 宿主明确说"这个平台不支持"：收起面板并摘掉入口，别让用户点开只看到 404。
          if (d && d.available === false) {
            try { closePanel(); } catch (e) {}
            removeDomButton();
            return;
          }
          if (d && d.ok) {
            lastItems = d.items || [];
            lastSelfPid = d.self || 0;
            renderRows();
            var count = panelEl.querySelector(".dsh-hm-count");
            if (count) count.textContent = lastItems.length + " 个进程";
            var bg = lastItems.filter(function (x) { return x.kind === "background"; }).length;
            var btn = document.querySelector(".dsh-hm-button-anchor");
            if (btn) btn.classList.toggle("has-busy", bg > 0);
            probeHost();
            probePeers(lastItems, lastSelfPid);
          } else {
            list.textContent = "查询失败：" + (d && d.error ? d.error : "未知错误");
          }
        })
        .catch(function (e) {
          if (panelEl) list.textContent = "查询失败：" + (e && e.message ? e.message : String(e));
        });
    }

    /** 采样页面实际背景亮度 → 面板套亮/暗配色（不依赖应用主题变量）。 */
    function pageIsLight() {
      try {
        var el = document.body;
        for (var i = 0; i < 8 && el; i++) {
          var bg = getComputedStyle(el).backgroundColor;
          var m = bg && bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
          if (m && (m[4] === undefined || Number(m[4]) > 0.5)) {
            var lum = (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
            return lum > 0.55;
          }
          el = el.parentElement;
        }
      } catch (e) {}
      return false;
    }

    function openPanel() {
      closePanel();
      panelEl = document.createElement("div");
      panelEl.className = "dsh-hm-panel" + (pageIsLight() ? " dsh-hm-light" : "");
      var head = document.createElement("div");
      head.className = "dsh-hm-head";
      var titleSpan = document.createElement("span");
      titleSpan.textContent = "监视台";
      var countSpan = document.createElement("span");
      countSpan.className = "dsh-hm-count";
      head.appendChild(titleSpan); head.appendChild(countSpan);
      var helpBtn = document.createElement("button");
      helpBtn.type = "button"; helpBtn.className = "dsh-hm-helpbtn"; helpBtn.textContent = "?";
      helpBtn.title = "说明"; helpBtn.setAttribute("aria-label", "说明"); helpBtn.setAttribute("aria-expanded", "false");
      var help = document.createElement("div");
      help.className = "dsh-hm-help";
      HELP_ROWS.forEach(function (row) {
        var line = document.createElement("div");
        var label = document.createElement("b"); label.textContent = row[0];
        var text = document.createElement("span"); text.textContent = row[1];
        line.appendChild(label); line.appendChild(text); help.appendChild(line);
      });
      helpBtn.addEventListener("click", function () {
        var on = help.classList.toggle("on");
        helpBtn.setAttribute("aria-expanded", on ? "true" : "false");
      });
      head.appendChild(helpBtn);
      var close = document.createElement("button");
      close.className = "dsh-hm-close"; close.type = "button"; close.textContent = "×";
      close.addEventListener("click", closePanel);
      head.appendChild(close);
      var status = document.createElement("div");
      status.className = "dsh-hm-status";
      status.style.display = "none";
      var list = document.createElement("div");
      list.className = "dsh-hm-list";
      var foot = document.createElement("div");
      foot.className = "dsh-hm-foot";
      var refresh = document.createElement("button");
      refresh.type = "button"; refresh.textContent = "刷新";
      refresh.addEventListener("click", function () { whoamiCache = {}; whoamiAt = {}; refreshList(); });
      var releaseAll = document.createElement("button");
      releaseAll.type = "button"; releaseAll.className = "danger"; releaseAll.textContent = "全部释放";
      releaseAll.addEventListener("click", function () {
        // 「全部释放」语义不变：只针对后台编码搭档。
        fetch("/harness-monitor/api/list", { headers: { "Accept": "application/json" } })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            var pids = ((d && d.items) || []).filter(function (x) { return x.kind === "background"; }).map(function (x) { return x.pid; });
            if (pids.length) {
              statusText = "正在释放 " + pids.length + " 个后台编码搭档…";
              renderStatus();
              fetch("/harness-monitor/api/kill", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pids: pids, kind: "background", confirm: false })
              })
                .then(function (r) { return r.json().catch(function () { return null; }); })
                .then(function (res) {
                  statusText = res && res.ok
                    ? "已释放 " + (res.killed || []).length + " 个后台编码搭档" + ((res.refused || []).length ? "，被拒绝 " + res.refused.length + " 个" : "")
                    : "释放失败：" + (res && res.error ? res.error : "未知错误");
                  renderStatus();
                  whoamiCache = {}; whoamiAt = {};
                  refreshList();
                })
                .catch(function () {});
            } else {
              refreshList();
            }
          })
          .catch(function () {});
      });
      foot.appendChild(refresh); foot.appendChild(releaseAll);
      panelEl.appendChild(head); panelEl.appendChild(help); panelEl.appendChild(status); panelEl.appendChild(list); panelEl.appendChild(foot);
      document.body.appendChild(panelEl);
      outsideHandler = function (ev) {
        if (panelEl && !panelEl.contains(ev.target)) { closePanel(); }
      };
      setTimeout(function () { if (outsideHandler) document.addEventListener("mousedown", outsideHandler); }, 0);
      // 会话状态（谁在跑）会变：面板开着时每 5s 只重画行，不重新跑 PowerShell 查询。
      serveTimer = setInterval(function () { if (panelEl) renderRows(); }, SERVE_REFRESH_MS);
      refreshList();
    }

    /* ---------- wide 模式：DOM 按钮放备份按钮左侧一格（设置行内） ---------- */
    var domButton = null;
    var domTimer = null;
    var placementRef = null;

    function findPlacement(anchorEl) {
      try {
        var el = anchorEl ? anchorEl.parentElement : null;
        var footArea = null;
        while (el) {
          var p = el.parentElement;
          if (p && typeof p.className === "string" && p.className.indexOf("footArea") !== -1) { footArea = p; break; }
          el = p;
        }
        if (!footArea) return null;
        var trigger = null, settingsArea = null;
        var rows = Array.prototype.slice.call(footArea.children);
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].contains(anchorEl)) continue;
          var t = rows[i].querySelector("button[aria-haspopup=\"dialog\"]");
          if (t) { trigger = t; settingsArea = rows[i]; break; }
        }
        if (!trigger || !settingsArea) return null;
        return { settingsArea: settingsArea, trigger: trigger, footArea: footArea, rootEl: footArea.parentElement };
      } catch (err) { return null; }
    }

    /* 新版侧栏（dsh 0.2.x / 全家桶 0.4.x）把「设置」从窄齿轮改成了整行长条
       （本机实测 188px 宽）。此时再把图标绝对定位到它左侧，就会整排压在设置条上、
       并和它的点击区冲突。新版自身用的是 footer 行里 36×36 的图标按钮
       （如「检查更新」「远程访问」）。所以：探到「宽条设置」即放弃 DOM 手术，
       改为在槽位内联渲染 36×36 图标，跟随新版布局。 */
    var WIDE_TRIGGER_PX = 60;
    function isWideSettingsTrigger(trigger) {
      try {
        if (!trigger) return false;
        return trigger.getBoundingClientRect().width > WIDE_TRIGGER_PX;
      } catch (err) {
        return false;
      }
    }

    function positionDomButton() {
      if (!domButton || !placementRef) return;
      try {
        var p = placementRef;
        var leftRef = p.rootEl || p.footArea || p.settingsArea;
        var inset = p.trigger.getBoundingClientRect().left - leftRef.getBoundingClientRect().left;
        var rightGap = p.rootEl ? p.rootEl.getBoundingClientRect().right - p.settingsArea.getBoundingClientRect().right : 0;
        // 备份按钮占位 = inset - rightGap；本按钮再往左一格（30px），不与它重叠。
        domButton.style.position = "absolute";
        domButton.style.right = Math.max(0, Math.round(inset - rightGap) + HM_ROW_BASE + HM_ROW_OFFSET) + "px";
        domButton.style.top = "50%";
        domButton.style.transform = "translateY(-50%)";
        domButton.style.width = "28px";
        domButton.style.height = "28px";
        domButton.style.fontSize = "15px";
      } catch (err) { /* 忽略 */ }
    }

    /* ---------- 图标：「设置」行四颗按钮共用一套线条语言 ----------
       单色内联 SVG、stroke=currentColor（继承 .dsh-hm-button 的次要色与悬停态）、
       viewBox 16×16、stroke-width 1.35、圆头圆角；墨迹外框恒定 9.95~10.35 × 12.05~12.15、
       重心精确落在 (8,8)，四颗摆一排光学重心才对得齐。
       本枚是「脉冲 / 活动监视」；原先的 📡 emoji 是全彩位图，与另外三枚描边图标不是一套。 */
    var HM_ICON_D = "M3.5 8h1.9l1.7-5.4 2.3 10.8 1.7-5.4h1.4";
    var HM_ICON_SVG =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" ' +
      'stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="' + HM_ICON_D + '"/>' +
      "</svg>";

    function monitorGlyph(size) {
      return React.createElement("svg", {
        width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true",
        stroke: "currentColor", strokeWidth: 1.35, strokeLinecap: "round", strokeLinejoin: "round"
      }, React.createElement("path", { d: HM_ICON_D, key: "p" }));
    }

    /* 本按钮在「设置」行内的横向偏移：备份 = 0、监视 = +30、分支图 = +60、知识库 = +90。
       HM_ROW_BASE 是四颗共用的基准归一化量：实测 round(inset - rightGap) = -2
       （侧栏内边距 12px，而「设置」触发器左右各外溢 2px），不补这 2px 的话
       偏移 0 那颗会被 Math.max(0,…) 夹到 0，步进退化成 28px，四颗间隙就变成 2/2/0。 */
    var HM_ROW_OFFSET = 30;
    var HM_ROW_BASE = 2;

    function ensureDomButton(anchorEl) {
      if (domButton) { positionDomButton(); return true; }
      var p = findPlacement(anchorEl);
      if (!p) return false;
      placementRef = p;
      try {
        domButton = document.createElement("button");
        domButton.type = "button";
        domButton.className = "dsh-hm-button dsh-hm-button-anchor";
        domButton.title = "监视台（查看/释放被占住的会话）";
        domButton.setAttribute("aria-label", "监视台");
        domButton.innerHTML = HM_ICON_SVG;
        domButton.addEventListener("click", function () {
          if (panelEl) closePanel(); else openPanel();
        });
        p.settingsArea.style.position = "relative";
        p.settingsArea.appendChild(domButton);
        positionDomButton();
        return true;
      } catch (err) { domButton = null; return false; }
    }

    function removeDomButton() {
      if (domTimer) { clearInterval(domTimer); domTimer = null; }
      if (domButton) { try { domButton.remove(); } catch (e) {} domButton = null; }
      placementRef = null;
    }

    /* ---------- 槽内组件 ---------- */
    function MonitorButton(props) {
      var wide = !!(props && props.wide);
      var anchorRef = React.useRef(null);
      // 定位模式：unknown（先渲染隐藏锚点用于探测）/ dom（旧版：绝对定位到设置行）/ inline（新版：跟随槽位布局）
      var modeState = React.useState("unknown");
      var mode = modeState[0];
      var setMode = modeState[1];

      React.useEffect(function () {
        if (!wide) { removeDomButton(); return; }
        if (mode === "inline") { removeDomButton(); return; }
        var anchor = anchorRef.current;
        // 新版侧栏（设置是宽条）：不做 DOM 手术，直接内联渲染
        var probe = findPlacement(anchor);
        if (probe && isWideSettingsTrigger(probe.trigger)) {
          removeDomButton();
          setMode("inline");
          return;
        }
        if (ensureDomButton(anchor)) {
          setMode("dom");
          var onResize = function () { positionDomButton(); };
          window.addEventListener("resize", onResize);
          return function () {
            window.removeEventListener("resize", onResize);
            removeDomButton();
          };
        }
        // 侧边栏尚未就绪：有限重试（期间一旦发现宽条设置就切内联）
        var tries = 0;
        domTimer = setInterval(function () {
          tries++;
          var anchorNow = anchorRef.current;
          var probeNow = findPlacement(anchorNow);
          if (probeNow && isWideSettingsTrigger(probeNow.trigger)) {
            clearInterval(domTimer);
            domTimer = null;
            removeDomButton();
            setMode("inline");
            return;
          }
          if (ensureDomButton(anchorNow) || tries > 10) {
            clearInterval(domTimer);
            domTimer = null;
            if (tries <= 10) setMode("dom");
          }
        }, 500);
        return function () {
          if (domTimer) { clearInterval(domTimer); domTimer = null; }
          removeDomButton();
        };
      }, [wide, mode]);

      // 旧版 wide：真实按钮由 DOM 管理（放设置行内），此处只留隐藏锚点
      if (wide && mode !== "inline") return React.createElement("span", { ref: anchorRef, style: { display: "none" } });

      return React.createElement("button", {
        className: "dsh-hm-button dsh-hm-button-anchor",
        "data-dsh-part": "entry",
        onClick: function () { if (panelEl) closePanel(); else openPanel(); },
        title: "监视台",
        "aria-label": "监视台",
        style: { width: 36, height: 36 }
      }, monitorGlyph(17));
    }

    /* ---------- 插件入口 ---------- */
    var inject = ["slots", "sessions"];

    function apply(ctx) {
      try {
        try {
          sessionsService = (ctx && ctx.sessions) || (ctx && typeof ctx.get === "function" ? ctx.get("sessions") : null) || null;
        } catch (e) {
          sessionsService = null;
        }
        // HMR 重载/插件停用时收掉面板与按钮，避免留下孤儿 DOM。
        try {
          if (ctx && typeof ctx.on === "function") {
            ctx.on("dispose", function () {
              try { closePanel(); removeDomButton(); } catch (e) {}
            });
          }
        } catch (e) {}
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") {
          console.warn("[dsh-harness-monitor] 无 slots API，监视按钮未注入（安全降级）");
          return;
        }
        ctx.slots.inject("sidebar.footer.action", function () {
          return ctx.slots.register(
            { name: "sidebar.footer.action", id: "harness-monitor", order: 32, label: "监视台" },
            MonitorButton
          );
        });
      } catch (err) {
        console.warn("[dsh-harness-monitor] 注入失败，已安全降级：", err);
      }
    }

    exports.inject = inject;
    exports.apply = apply;

    /* 只读调试钩子（与 tree-panel 的 __treePanelDebug 同款，便于面板自检）：
       返回本行渲染实际采到的会话映射，不改任何状态。 */
    try {
      window.__harnessMonitorDebug = function () {
        var rows = sessionRows();
        var mine = null;
        try { mine = listSnapshot(); } catch (e) {}
        var theirs = null;
        try { if (typeof window.__treePanelDebug === "function") theirs = window.__treePanelDebug().snapshot; } catch (e) {}
        return {
          hostGraded: hostGraded,
          current: currentSessionId(),
          mineCurrent: mine ? mine.current : null,
          mineKeys: mine && typeof mine === "object" ? Object.keys(mine) : null,
          treePanelCurrent: theirs ? theirs.current : null,
          sameSnapshotObject: mine === theirs,
          sameRowObject: !!(mine && theirs && mine.byId && theirs.byId && mine.byId[mine.current] === theirs.byId[mine.current]),
          rowCount: rows === null ? null : rows.length,
          rows: (rows || []).slice(0, 4),
          serving: localServing(),
          panelOpen: panelEl !== null
        };
      };
    } catch (e) {}

    return module.exports;
  }
});
