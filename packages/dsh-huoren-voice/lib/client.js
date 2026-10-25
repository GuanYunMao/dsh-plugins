/**
 * dsh-huoren-voice 的 client 半（浏览器侧）。
 *
 * 手写 bundle，遵循 DSH 客户端插件装载协议：
 *   window.__ModuleLoader__.load({ id, factory }) —— id 必须等于包名；
 *   factory 返回 { apply, inject }。
 *
 * 职责：在 设置 → 声线 注册一个 section，开关 / 追加文本 / 字符上限 / 预览，
 * 数据全部来自宿主 /api/huoren-voice/*（本机回环），本文件不存任何状态。
 * 任何 DOM / fetch 失败都静默降级成一行提示，绝不拖垮设置面板。
 */
window.__ModuleLoader__.load({
  id: "dsh-huoren-voice",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var jsx = require("react/jsx-runtime").jsx;

    function h(type, props, key) {
      var p = props ? Object.assign({}, props) : {};
      if (key !== undefined) p.key = key;
      var kids = Array.prototype.slice.call(arguments, 3);
      if (kids.length === 1) p.children = kids[0];
      else if (kids.length > 1) p.children = kids;
      return jsx(type, p);
    }

    /* ---------------- 样式（data-plugin-css：随插件装载注入，幂等） ---------------- */
    var CSS = [
      ".hv-wrap{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,#e8e8e8)}",
      ".hv-lead{margin:0;color:var(--dsw-alias-label-secondary,#a0a0a0);font-size:12px}",
      ".hv-group{display:flex;flex-direction:column;gap:6px}",
      ".hv-group-title{font-size:12px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#8a8f98);text-transform:none}",
      ".hv-row{display:grid;grid-template-columns:1fr auto;align-items:center;gap:10px;padding:7px 10px;border:1px solid var(--dsw-alias-line-secondary,rgba(128,128,128,.18));border-radius:8px;background:var(--dsw-alias-bg-secondary,rgba(128,128,128,.05))}",
      ".hv-row-main{display:flex;flex-direction:column;gap:1px;min-width:0}",
      ".hv-row-title{font-weight:500}",
      ".hv-row-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
      ".hv-switch{position:relative;flex:none;width:38px;height:22px;border:1px solid var(--dsw-alias-line-secondary,rgba(128,128,128,.3));border-radius:999px;background:transparent;cursor:pointer;padding:0;transition:background .15s ease,border-color .15s ease}",
      ".hv-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-secondary,#9aa0a6);transition:transform .15s ease,background .15s ease}",
      ".hv-switch[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary,#4f8cff);background:color-mix(in srgb, var(--dsw-alias-brand-primary,#4f8cff) 26%, transparent)}",
      ".hv-switch[aria-pressed=true]::after{transform:translateX(16px);background:var(--dsw-alias-brand-primary,#4f8cff)}",
      ".hv-chips{display:flex;flex-wrap:wrap;gap:6px}",
      ".hv-chip{padding:4px 10px;border:1px solid var(--dsw-alias-line-secondary,rgba(128,128,128,.3));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);font-size:12px;cursor:pointer}",
      ".hv-chip:hover{color:var(--dsw-alias-label-primary,#e6e9ee);border-color:var(--dsw-alias-label-tertiary,#8a8f98)}",
      ".hv-chip.on{border-color:var(--dsw-alias-brand-primary,#4f8cff);color:var(--dsw-alias-brand-primary,#4f8cff);background:color-mix(in srgb, var(--dsw-alias-brand-primary,#4f8cff) 14%, transparent)}",
      ".hv-label{font-size:12px;color:var(--dsw-alias-label-secondary,#a0a0a0);display:block;margin-bottom:4px}",
      ".hv-textarea,.hv-number{width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;line-height:1.5;color:inherit;background:var(--dsw-alias-bg-primary,transparent);border:1px solid var(--dsw-alias-line-secondary,rgba(128,128,128,.24));border-radius:8px;padding:8px 10px;resize:vertical}",
      ".hv-textarea{min-height:64px;max-height:180px}",
      ".hv-number{max-width:140px}",
      ".hv-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".hv-btn{font:inherit;font-size:12px;border:1px solid var(--dsw-alias-line-secondary,rgba(128,128,128,.3));background:transparent;color:inherit;border-radius:7px;padding:5px 12px;cursor:pointer}",
      ".hv-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}",
      ".hv-btn-danger{color:var(--dsw-alias-label-danger,#e5484d);border-color:color-mix(in srgb, var(--dsw-alias-label-danger,#e5484d) 40%, transparent)}",
      ".hv-status{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f98);min-height:16px}",
      ".hv-status-err{color:var(--dsw-alias-label-danger,#e5484d)}",
      ".hv-preview{margin:0}",
      ".hv-preview pre{white-space:pre-wrap;word-break:break-word;font-size:11.5px;line-height:1.55;max-height:240px;overflow:auto;margin:6px 0 0;padding:10px;border:1px dashed var(--dsw-alias-line-secondary,rgba(128,128,128,.3));border-radius:8px;background:var(--dsw-alias-bg-primary,transparent)}",
      ".hv-preview summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary,#a0a0a0)}",
      ".hv-foot{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8f98);word-break:break-all}",
    ].join("\n");

    function injectCss() {
      try {
        var id = "dsh-huoren-voice/settings.css";
        if (document.querySelector('style[data-plugin-css="' + id + '"]')) return;
        var tag = document.createElement("style");
        tag.dataset.pluginCss = id;
        tag.dataset.plugin = "dsh-huoren-voice";
        tag.textContent = CSS;
        document.head.appendChild(tag);
      } catch (error) {
        console.warn("[huoren-voice] 样式注入失败：", error);
      }
    }

    /* ---------------- 与宿主通信 ---------------- */
    // 宿主路由前缀。**不在** /api 下：/api 被 dsh-api-gateway 的 RPC 通道接管，
    // 插件注册到 /api/<name> 会被挡成 404（0.2.0-rc.2 实测）。
    var API_PREFIX = "/huoren-voice/api";

    function api(path, body) {
      var init = body === undefined
        ? { method: "GET" }
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
      return fetch(API_PREFIX + path, init).then(function (res) {
        if (!res.ok) {
          return res.text().then(function (text) {
            throw new Error("HTTP " + res.status + (text ? " · " + text.slice(0, 120) : ""));
          });
        }
        return res.json();
      });
    }

    var ROWS = [
      { key: "warm", title: "热情", hint: "先接住再展开，多走一步，夸具体的" },
      { key: "rigor", title: "严谨", hint: "事实/推断/猜测分开说，数字先查再解释" },
      { key: "wild", title: "天马行空", hint: "一个标明代价的脑洞；头脑风暴可多给" },
      { key: "humor", title: "幽默", hint: "一句话就停，自嘲优先，严肃内容不抖机灵" },
    ];
    var FEEL_ROWS = [
      { key: "rhythm", title: "节奏", hint: "结论先行，再展开说清；段落 2–4 句，别写电报体" },
      { key: "concrete", title: "具体", hint: "细节 + 例子；抽象判断后面跟一句「比如」" },
      { key: "forbidTable", title: "替换表", hint: "把「需要注意的是」这类套话换成具体说法" },
      { key: "antiSlop", title: "反 AI 腔", hint: "禁比喻/排比/抒情套话；上下文变长也按这条" },
      { key: "emoji", title: "emoji 密度", hint: "整条回复 3–8 个，一段最多一个，放段落收尾；别每句一个" },
      { key: "tailEcho", title: "末尾回声", hint: "提示词末尾再放一句声线，约 +60 字/请求" },
      { key: "examples", title: "例句", hint: "「你会这样说 / 你不会这样说」两段参照，效果比规则本身大" },
    ];
    var TONE_OPTIONS = [
      { key: "default", title: "默认" },
      { key: "blunt", title: "直白" },
      { key: "deadpan", title: "冷幽默" },
      { key: "scifi", title: "科幻" },
      { key: "academic", title: "学术" },
      { key: "gentle", title: "温和" },
    ];

    function Switch(props) {
      return h("button", {
        type: "button",
        className: "hv-switch",
        role: "switch",
        "aria-pressed": props.on ? "true" : "false",
        "aria-label": props.title,
        onClick: props.onToggle,
      });
    }

    function Row(props) {
      return h("div", { className: "hv-row" }, undefined,
        h("div", { className: "hv-row-main" }, "main",
          h("span", { className: "hv-row-title" }, "t", props.title),
          h("span", { className: "hv-row-hint" }, "h", props.hint),
        ),
        h(Switch, { "on": props.on, title: props.title, onToggle: props.onToggle }, "sw"),
      );
    }

    function VoiceSection() {
      var stateHook = React.useState(null);
      var state = stateHook[0];
      var setState = stateHook[1];
      var statusHook = React.useState("加载中…");
      var status = statusHook[0];
      var setStatus = statusHook[1];
      var draftHook = React.useState("");
      var draft = draftHook[0];
      var setDraft = draftHook[1];
      var charsHook = React.useState(4000);
      var chars = charsHook[0];
      var setChars = charsHook[1];
      var samplesHook = React.useState("");
      var draftSamples = samplesHook[0];
      var setDraftSamples = samplesHook[1];
      var appendTimer = React.useRef(null);
      var samplesTimer = React.useRef(null);
      var aliveRef = React.useRef(true);

      React.useEffect(function () {
        aliveRef.current = true;
        api("/state").then(function (next) {
          if (!aliveRef.current) return;
          setState(next);
          setDraft(String(next.config.append || ""));
          setDraftSamples(String(next.config.samples || ""));
          setChars(next.config.maxChars | 0);
          setStatus("");
        }).catch(function (error) {
          if (!aliveRef.current) return;
          setStatus("读不到配置（宿主路由未加载？重启一次 DSH 再试）· " + error.message);
        });
        return function () {
          aliveRef.current = false;
          if (appendTimer.current) clearTimeout(appendTimer.current);
          if (samplesTimer.current) clearTimeout(samplesTimer.current);
        };
      }, []);

      function save(patch, doneText) {
        setStatus("保存中…");
        return api("/config", patch).then(function (next) {
          if (!aliveRef.current) return next;
          setState(next);
          setDraft(String(next.config.append || ""));
          setDraftSamples(String(next.config.samples || ""));
          setChars(next.config.maxChars | 0);
          setStatus(doneText || "已保存，下一个请求生效");
          return next;
        }).catch(function (error) {
          if (!aliveRef.current) return;
          setStatus("保存失败：" + error.message);
        });
      }

      function toggle(key) {
        if (!state) return;
        var config = state.config;
        var patch = {};
        patch[key] = !config[key];
        save(patch, patch[key] ? "已开启，下一个请求生效" : "已关闭，下一个请求生效");
      }

      function scheduleAppendSave(value) {
        if (appendTimer.current) clearTimeout(appendTimer.current);
        appendTimer.current = setTimeout(function () {
          save({ append: value }, value.trim() ? "追加文本已保存" : "追加文本已清空");
        }, 600);
      }

      function onAppendChange(event) {
        var value = event.target.value;
        setDraft(value);
        scheduleAppendSave(value);
      }

      function scheduleSamplesSave(value) {
        if (samplesTimer.current) clearTimeout(samplesTimer.current);
        samplesTimer.current = setTimeout(function () {
          save({ samples: value }, value.trim() ? "样例已保存" : "样例已清空");
        }, 600);
      }

      function onSamplesChange(event) {
        var value = event.target.value;
        setDraftSamples(value);
        scheduleSamplesSave(value);
      }

      function onCharsCommit() {
        var num = parseInt(chars, 10);
        if (!Number.isFinite(num) || num <= 0) {
          setStatus("字符上限要是正整数");
          return;
        }
        save({ maxChars: Math.min(num, 20000) }, "字符上限已保存");
      }

      function onReset() {
        if (!window.confirm("恢复 patch 里的基线配置？设置页里改过的开关和追加文本都会清掉。")) return;
        setStatus("恢复中…");
        api("/reset", {}).then(function (next) {
          if (!aliveRef.current) return;
          setState(next);
          setDraft(String(next.config.append || ""));
          setDraftSamples(String(next.config.samples || ""));
          setChars(next.config.maxChars | 0);
          setStatus("已恢复基线");
        }).catch(function (error) {
          if (!aliveRef.current) return;
          setStatus("恢复失败：" + error.message);
        });
      }

      if (!state) {
        return h("div", { className: "hv-wrap" }, undefined,
          h("p", { className: "hv-lead" }, "l", "声线设置正在加载…"),
          h("div", { className: "hv-status" + (status.indexOf("读不到") === 0 ? " hv-status-err" : "") }, "s", status),
        );
      }

      var config = state.config;
      var body = [];
      body.push(h("div", { className: "hv-row" }, "master",
        h("div", { className: "hv-row-main" }, "m",
          h("span", { className: "hv-row-title" }, "mt", "总开关"),
          h("span", { className: "hv-row-hint" }, "mh", "关掉后整段声线都不注入，但插件还装着" ),
        ),
        h(Switch, { "on": config.enabled, title: "总开关", onToggle: function () { toggle("enabled"); } }, "ms"),
      ));

      var toneTitle = (TONE_OPTIONS.filter(function (o) { return o.key === (config.tone || "default"); })[0] || TONE_OPTIONS[0]).title;
      var sampleCount = String(config.samples || "").split("\n").filter(function (line) { return line.trim(); }).length;
      body.push(h("p", { className: "hv-lead" }, "now",
        "当前：" + (config.emoji ? "emoji 开" : "emoji 关")
        + " · 例句 " + (config.examples ? "开" : "关")
        + " · 回声 " + (config.tailEcho ? "开" : "关")
        + " · 语气 " + toneTitle
        + " · 每轮锚 " + (config.turnAnchor ? "开" : "关")
        + " · 样例 " + sampleCount + " 条"
        + " · 正文 " + (state.text ? state.text.length : 0) + " 字"
      ));

      var traitRows = ROWS.map(function (row) {
        return h(Row, {
          key: row.key,
          title: row.title,
          hint: row.hint,
          "on": config[row.key],
          onToggle: function () { toggle(row.key); },
        });
      });
      var feelRows = FEEL_ROWS.map(function (row) {
        return h(Row, {
          key: row.key,
          title: row.title,
          hint: row.hint,
          "on": config[row.key],
          onToggle: function () { toggle(row.key); },
        });
      });

      body.push(h("div", { className: "hv-group" }, "traits",
        h("div", { className: "hv-group-title" }, "tt", "四个方向"),
        traitRows,
      ));
      body.push(h("div", { className: "hv-group" }, "feel",
        h("div", { className: "hv-group-title" }, "ft", "手感"),
        feelRows,
      ));

      body.push(h("div", { className: "hv-group" }, "tone",
        h("div", { className: "hv-group-title" }, "tonet", "语气（可换，但都带反 AI 腔）"),
        h("div", { className: "hv-chips" }, "tones",
          TONE_OPTIONS.map(function (opt) {
            return h("button", {
              key: opt.key,
              type: "button",
              className: "hv-chip" + ((config.tone || "default") === opt.key ? " on" : ""),
              onClick: function () { save({ tone: opt.key }, "语气已切换，下一个请求生效"); },
            }, "tone-" + opt.key, opt.title);
          }),
        ),
      ));
      body.push(h("div", { className: "hv-group" }, "append",
        h("label", { className: "hv-label", htmlFor: "hv-append" }, "al", "追加你自己的话（原样注入段末）"),
        h("textarea", {
          id: "hv-append",
          className: "hv-textarea",
          value: draft,
          placeholder: "例：可以叫我老周；偶尔用上海话；汇报时先给人话再给术语。",
          onChange: onAppendChange,
          onBlur: function () { if (draft !== String(config.append || "")) save({ append: draft }, "追加文本已保存"); },
        }, "ta"),
      ));

      body.push(h("div", { className: "hv-group" }, "samples",
        h("label", { className: "hv-label", htmlFor: "hv-samples" }, "sl", "你喜欢的句子（一行一句，最多 6 句）"),
        h("textarea", {
          id: "hv-samples",
          className: "hv-textarea",
          value: draftSamples,
          placeholder: "例：这版先别发，等我把边界条件补完。\n你信不信这条命令能跑通？\n我赌三分钟，跑不通我请你喝咖啡。",
          onChange: onSamplesChange,
          onBlur: function () { if (draftSamples !== String(config.samples || "")) save({ samples: draftSamples }, "样例已保存"); },
        }, "sa"),
      ));

      body.push(h("div", { className: "hv-group" }, "chars",
        h("label", { className: "hv-label", htmlFor: "hv-maxchars" }, "cl", "主段字符上限"),
        h("input", {
          id: "hv-maxchars",
          className: "hv-number",
          type: "number",
          min: 200,
          max: 20000,
          value: chars,
          onChange: function (event) { setChars(event.target.value); },
          onBlur: onCharsCommit,
        }, "ci"),
      ));

      body.push(h("div", { className: "hv-actions" }, "acts",
        h("button", { type: "button", className: "hv-btn hv-btn-danger", onClick: onReset }, "reset", "恢复基线"),
        h("span", { className: "hv-status" + (status.indexOf("失败") >= 0 || status.indexOf("读不到") >= 0 || status.indexOf("要是") >= 0 ? " hv-status-err" : "") }, "st", status || "改动下一个请求生效，不用重启"),
      ));

      body.push(h("details", { className: "hv-preview" }, "preview",
        h("summary", null, "sum", "看模型实际读到的正文（" + ((state.text ? state.text.length : 0) + (state.samplesText ? state.samplesText.length : 0)) + " 字）"),
        h("pre", null, "pre", [state.text, state.samplesText].filter(Boolean).join("\n\n") || "（总开关关着，当前不注入）"),
      ));

      body.push(h("div", { className: "hv-foot" }, "foot", "配置存于 " + state.storeFile + "；patch 里的 config 只是基线，" + "这里改的会覆盖它。"));

      return h("div", { className: "hv-wrap" }, "wrap", body);
    }

    /* ---------------- 插件入口 ---------------- */
    var inject = ["slots"];

    function apply(ctx) {
      try {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") {
          console.warn("[huoren-voice] 当前版本无 slots API，设置页未注册（安全降级）");
          return;
        }
        injectCss();
        ctx.slots.inject("settings.section", function () {
          return ctx.slots.register(
            { name: "settings.section", id: "huoren-voice", order: 65, label: "声线" },
            VoiceSection
          );
        });
      } catch (error) {
        console.warn("[huoren-voice] 设置页注册失败，已安全降级：", error);
      }
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
