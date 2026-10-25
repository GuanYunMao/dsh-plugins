/**
 * dsh-backup-button 的 client 半（浏览器）—— v2「配置快照」。
 *
 * 手写 bundle，遵循 DSH 客户端插件装载协议：
 * window.__ModuleLoader__.load({ id, factory }) —— id 必须等于包名；
 * factory 返回的模块导出 { apply, inject }（与官方 client 插件一致）。
 *
 * 行为：
 * - 向 sidebar.footer.action 槽注册一个占位条目（作为生命周期锚点）；
 * - 侧边栏 wide（展开）模式：快照按钮以绝对定位放置到「设置」按钮所在行的
 *   右端（与备份按钮的传统位置一致，随内边距自适应）；
 * - 侧边栏 rail（收起）模式：按钮回落到 footer.action 槽内居中渲染；
 * - 点击后 fetch /backup/api/backup 触发全量配置快照（9 个关键文件，含凭据），
 *   toast 显示「已快照 N 个配置文件 → snapshots/<目录>」。
 *   harness 每次启动还会自动做去重快照（内容无变化则跳过），无需手动操作。
 * - 恢复：tools\dsh-snapshot-restore.ps1（ZCode 接口；旧版平铺 .bak 仍走 dsh-restore.bat）。
 *
 * 安全底线：只注入按钮、只请求 /backup/api/*；任何 DOM 结构不兼容都静默
 * 降级（按钮不显示），绝不拖垮整个界面。
 */
window.__ModuleLoader__.load({
  id: "dsh-backup-button",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

    /* ---------- 样式（data-plugin-css 模式，随插件装载注入） ---------- */
    var CSS = [
      ".dsh-backup-button{display:inline-flex;align-items:center;justify-content:center;flex:none;border:none;background:transparent;border-radius:50%;cursor:pointer;padding:0;color:var(--dsw-alias-label-secondary,#8a8f98);line-height:1}",
      ".dsh-backup-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18))}",
      ".dsh-backup-button:disabled{opacity:.55;cursor:default}",
      ".dsh-backup-spin{animation:dsh-backup-spin 900ms linear infinite;transform-origin:center}",
      "@keyframes dsh-backup-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}",
      ".dsh-backup-toast{position:fixed;top:16px;right:16px;z-index:99999;max-width:min(520px,calc(100vw - 32px));padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.5;word-break:break-all;box-shadow:0 6px 24px rgba(0,0,0,.18);pointer-events:auto;cursor:pointer;border:1px solid transparent}",
      ".dsh-backup-toast.ok{background:var(--dsw-specific-surface-overlay,#1f2329);color:var(--dsw-alias-label-primary,#e8eaed);border-color:rgba(46,160,67,.55)}",
      ".dsh-backup-toast.err{background:var(--dsw-specific-surface-overlay,#1f2329);color:var(--dsw-alias-label-primary,#e8eaed);border-color:rgba(248,81,73,.6)}",
      ".dsh-backup-toast.warn{background:var(--dsw-specific-surface-overlay,#1f2329);color:var(--dsw-alias-label-primary,#e8eaed);border-color:rgba(230,168,0,.65)}"
    ].join("");

    (function injectStyle() {
      if (typeof document === "undefined") return;
      var tagId = "dsh-backup-button/styles";
      if (document.querySelector("style[data-plugin-css=\"" + tagId + "\"]")) return;
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-backup-button";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    })();

    /* ---------- 页面级 toast（用真实 DOM，避免被侧边栏 overflow 裁剪） ---------- */
    function showToast(text, kind, onClick) {
      if (typeof document === "undefined") return;
      var old = document.querySelector(".dsh-backup-toast");
      if (old) old.remove();
      var el = document.createElement("div");
      el.className = "dsh-backup-toast " + kind;
      el.textContent = text;
      el.title = typeof onClick === "function" ? "点击确认" : "点击关闭";
      el.addEventListener("click", function () {
        if (typeof onClick === "function") {
          try { onClick(); } catch (err) { console.warn("[dsh-backup-button] toast 动作失败：", err); }
        }
        el.remove();
      });
      document.body.appendChild(el);
      setTimeout(function () { el.remove(); }, 10000);
    }

    /* ---------- 配置快照请求（宽/窄两种按钮共用） ---------- */
    function runBackup(onState) {
      if (typeof onState === "function") onState(true);
      fetch("/backup/api/backup", { method: "GET", headers: { "Accept": "application/json" } })
        .then(function (res) {
          return res.json().catch(function () { return null; }).then(function (data) {
            if (res.ok && data && data.ok === true) {
              showToast("已快照 " + data.files + " 个配置文件 → snapshots/" + data.dir + "（保留最近 " + data.kept + " 份）", "ok");
            } else {
              var reason = data && data.error ? data.error : ("HTTP " + res.status);
              showToast("快照失败：" + reason, "err");
            }
          });
        })
        .catch(function (err) {
          showToast("快照失败：" + (err && err.message ? err.message : String(err)), "err");
        })
        .finally(function () { if (typeof onState === "function") onState(false); });
    }

    /* ============================================================
     * wide 模式专用：把备份按钮放到「设置」按钮右侧，右留白 = 左留白。
     *
     * DOM 结构（ui-sidebar 的 footArea，竖排两行）：
     *   div.footArea
     *     ├─ div.footerActions   ← sidebar.footer.action 槽（本插件的锚点在此）
     *     └─ div.settingsArea    ← sidebar.settings 槽（设置触发器 button[aria-haspopup="dialog"]）
     *
     * 做法：从锚点向上取 footArea → 在 footArea 内找设置触发器按钮 →
     * 把独立创建的 DOM 按钮挂到 settingsArea（绝对定位、垂直居中），
     * right 值 = 实测「设置按钮左边缘距侧边栏左框的距离」，
     * 从而保证按钮右边缘距侧边栏右框的距离与之相等（左右对称）。
     * 该按钮不归 React 管理（React 锚点渲染 null），避免 DOM 冲突。
     * ============================================================ */
    var domButton = null;
    var domTimer = null;
    var placementRef = null; // { settingsArea, trigger, footArea, rootEl }

    function findPlacement(anchorEl) {
      try {
        // 锚点：槽内渲染的隐藏占位 span。注意：真实 shell 中 renderSlot 会在
        // 每行外层包一层 <div data-slot="..." style="display:contents"> 包装，
        // 所以锚点的直接父元素不是 footerActions 行本身。这里从锚点向上爬，
        // 找到 class 含 "footArea" 的容器（侧边栏底部两行：footerActions + settingsArea）。
        var el = anchorEl ? anchorEl.parentElement : null;
        var footArea = null;
        while (el) {
          var p = el.parentElement;
          if (p && typeof p.className === 'string' && p.className.indexOf('footArea') !== -1) {
            footArea = p;
            break;
          }
          el = p;
        }
        if (!footArea) return null;
        // 在 footArea 的兄弟行里找设置触发器（跳过锚点所在行）
        var trigger = null;
        var settingsArea = null;
        var rows = Array.prototype.slice.call(footArea.children);
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].contains(anchorEl)) continue;
          var t = rows[i].querySelector('button[aria-haspopup="dialog"]');
          if (t) { trigger = t; settingsArea = rows[i]; break; }
        }
        if (!trigger || !settingsArea) {
          // 兜底：footArea 内、且不在锚点行里的任意 aria-haspopup 按钮
          var btns = footArea.querySelectorAll('button[aria-haspopup="dialog"]');
          for (var j = 0; j < btns.length; j++) {
            if (!btns[j].parentElement || !btns[j].parentElement.contains(anchorEl)) {
              trigger = btns[j];
              settingsArea = btns[j].parentElement;
              break;
            }
          }
        }
        if (!trigger || !settingsArea) return null;
        return { settingsArea: settingsArea, trigger: trigger, footArea: footArea, rootEl: footArea.parentElement };
      } catch (err) {
        console.warn("[dsh-backup-button] 定位设置按钮失败：", err);
        return null;
      }
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
        var rightGap = 0;
        if (p.rootEl) {
          rightGap = p.rootEl.getBoundingClientRect().right - p.settingsArea.getBoundingClientRect().right;
        }
        domButton.style.position = "absolute";
        domButton.style.right = Math.max(0, Math.round(inset - rightGap) + DOM_ROW_BASE + DOM_ROW_OFFSET) + "px";
        domButton.style.top = "50%";
        domButton.style.transform = "translateY(-50%)";
        domButton.style.width = "28px";
        domButton.style.height = "28px";
        domButton.style.fontSize = "15px";
      } catch (err) {
        console.warn("[dsh-backup-button] 按钮定位失败：", err);
      }
    }

    function onDomButtonClick() {
      if (domButton && domButton.disabled) return;
      if (domButton) { domButton.disabled = true; domButton.innerHTML = BACKUP_SPIN_SVG; }
      runBackup(function (busy) {
        if (domButton) {
          domButton.disabled = busy;
          domButton.innerHTML = busy ? BACKUP_SPIN_SVG : BACKUP_ICON_SVG;
        }
      });
    }

    /* ---------- 图标：「设置」行四颗按钮共用一套线条语言 ----------
       单色内联 SVG、stroke=currentColor（继承 .dsh-backup-button 的次要色与悬停态）、
       viewBox 16×16、stroke-width 1.35、圆头圆角；墨迹外框恒定 9.95~10.35 × 12.05~12.15、
       重心精确落在 (8,8)，四颗摆一排光学重心才对得齐。
       本枚是「存盘」：下箭头 + 开口托盘（托盘只三边、不闭合，避免读成方框）。
       原先的 💾 是全彩位图 emoji，和分支图 / 知识库两枚描边图标不是一套；
       忙碌态同时把 ⏳ 换成可旋转的弧线。 */
    var BACKUP_ICON_D = ["M8 2.6v7.7", "M5.1 7.5 8 10.4 10.9 7.5", "M3.7 11.5v1.9h8.6v-1.9"];
    function backupSvgHtml(inner) {
      return '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" ' +
        'stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">' +
        inner + "</svg>";
    }
    var BACKUP_ICON_SVG = backupSvgHtml(BACKUP_ICON_D.map(function (d) { return '<path d="' + d + '"/>'; }).join(""));
    var BACKUP_SPIN_SVG = backupSvgHtml('<circle cx="8" cy="8" r="5.4" stroke-dasharray="9 25"/>');

    function backupGlyph(size, spinning) {
      return React.createElement("svg", {
        width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true",
        stroke: "currentColor", strokeWidth: 1.35, strokeLinecap: "round", strokeLinejoin: "round",
        className: spinning ? "dsh-backup-spin" : void 0
      }, spinning
        ? React.createElement("circle", { cx: 8, cy: 8, r: 5.4, strokeDasharray: "9 25", key: "spin" })
        : BACKUP_ICON_D.map(function (d, i) { return React.createElement("path", { d: d, key: "p" + i }); }));
    }

    /* 本按钮在「设置」行内的横向偏移：备份 = 0、监视 = +30、分支图 = +60、知识库 = +90。
       DOM_ROW_BASE 是四颗共用的基准归一化量：实测 round(inset - rightGap) = -2
       （侧栏内边距 12px，而「设置」触发器左右各外溢 2px），不补这 2px 的话
       本颗会被 Math.max(0,…) 夹到 0，步进退化成 28px，四颗间隙就变成 2/2/0 一大一小。 */
    var DOM_ROW_OFFSET = 0;
    var DOM_ROW_BASE = 2;

    function ensureDomButton(anchorEl) {
      if (domButton) { positionDomButton(); return true; }
      var p = findPlacement(anchorEl);
      if (!p) return false;
      placementRef = p;
      try {
        domButton = document.createElement("button");
        domButton.type = "button";
        domButton.className = "dsh-backup-button";
        domButton.title = "存档匣（9 个关键配置文件）";
        domButton.setAttribute("aria-label", "存档匣");
        domButton.innerHTML = BACKUP_ICON_SVG;
        domButton.addEventListener("click", onDomButtonClick);
        p.settingsArea.style.position = "relative";
        p.settingsArea.appendChild(domButton);
        positionDomButton();
        return true;
      } catch (err) {
        console.warn("[dsh-backup-button] 创建按钮失败：", err);
        domButton = null;
        return false;
      }
    }

    function removeDomButton() {
      if (domTimer) { clearInterval(domTimer); domTimer = null; }
      if (domButton) {
        try { domButton.remove(); } catch (err) { /* 忽略 */ }
        domButton = null;
      }
      placementRef = null;
    }

    /* ---------- 槽内组件 ---------- */
    function BackupButton(props) {
      var wide = !!(props && props.wide);
      var anchorRef = React.useRef(null);
      var busy = React.useState(false);
      var isBusy = busy[0];
      var setBusy = busy[1];
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
            // DOM 探测/定位失败必须回退到槽内按钮：否则 wide 分支只渲染一个 display:none 锚点，
            // 按钮会永久消失（侧栏 DOM 改版、或首次渲染时侧栏还没展开，都会命中）。
            setMode(tries <= 10 ? "dom" : "inline");
          }
        }, 500);
        return function () {
          if (domTimer) { clearInterval(domTimer); domTimer = null; }
          removeDomButton();
        };
      }, [wide, mode]);

      if (wide && mode !== "inline") {
        // 旧版 wide：真实按钮由 DOM 管理（放设置按钮右侧），此处只留隐藏锚点
        return React.createElement("span", { ref: anchorRef, style: { display: "none" } });
      }

      // rail（收起）模式：槽内渲染真实按钮（居中图标列）
      function onClick() {
        if (isBusy) return;
        setBusy(true);
        runBackup(setBusy);
      }
      return React.createElement("button", {
        className: "dsh-backup-button",
        "data-dsh-part": "entry",
        onClick: onClick,
        disabled: isBusy,
        title: "存档匣（9 个关键配置文件）",
        "aria-label": "存档匣",
        style: { width: 36, height: 36 }
      }, backupGlyph(17, isBusy));
    }

    /* ---------- 插件入口 ---------- */
    var inject = ["slots"];

    function apply(ctx) {
      try {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") {
          console.warn("[dsh-backup-button] 当前版本无 slots API，备份按钮未注入（安全降级）");
          return;
        }
        ctx.slots.inject("sidebar.footer.action", function () {
          return ctx.slots.register(
            { name: "sidebar.footer.action", id: "backup-button", order: 30, label: "存档匣" },
            BackupButton
          );
        });
      } catch (err) {
        console.warn("[dsh-backup-button] 注入失败，已安全降级：", err);
      }
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
