/**
 * dsh-kb 的 client 半（浏览器侧）—— 第三轮改版。
 *
 * 改版目标（用户三条）：
 * 1. 去 AI 痕迹：面板里不再出现自述式解释（"窗口：最近最多 8 轮…""触发 auto · 模型 … 耗时 6.9s"
 *    "手改区不会被自动覆盖""源文档与索引不一致，建议重建索引"等一律删掉）；数字只留必要的，
 *    诊断信息收进「运行详情」按需展开。文案统一为短标签。
 * 2. 交互安全：结果卡不再"点哪儿都复制"；所有动作都是看得见的文字按钮；重建索引（会花 embedding
 *    费用）与版本回退（会覆盖当前记忆）一律先出确认条；动作条内联展开，不用浮层菜单；
 *    Esc 关闭面板；DOM 顺序 = 视觉顺序（不再用 CSS order 复排）。
 * 3. 库与工作区对应：顶部常驻"当前会话 → 库"（带工作区路径）；库管理页每个库标类型
 *    （工作区 / 文档 / 空）、工作区路径、以及「当前」标记。
 *
 * 协议：window.__ModuleLoader__.load({ id, factory })，id = 包名，导出 { apply, inject }。
 * 数据全部来自宿主半 /kb/api 路由，本文件零业务逻辑。
 * 安全底线：所有 fetch / DOM 包 try/catch 静默降级；不 require 任何未注入模块。
 */
window.__ModuleLoader__.load({
	id: "dsh-kb",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var react_jsx_runtime = require("react/jsx-runtime");
		var react_dom_client = require("react-dom/client");

		/**
		 * v2 版面板开关：`?ui=v2` 或 `?kbui=v2`。
		 * 旧界面保持默认，方便一键对比/回退；v2 只换外壳与页签，数据与动作完全复用。
		 */
		var UI2 = (function () {
			try {
				var q = String(window.location.search || "");
				// 2026-10-24 起默认就是 v2；要对比旧界面：?ui=v1（或 ?kbui=v1）。
				if (/(?:^|[?&])(?:ui|kbui)=v1(?:&|$)/.test(q)) return false;
				return true;
			} catch (e) {
				return true;
			}
		})();

		/** 极简 jsx 包装：children 走 props，key 走第三参（与 jsx() 语义一致）。 */
		function h(type, props, key) {
			var p = props ? Object.assign({}, props) : {};
			if (key !== undefined) p.key = key;
			return react_jsx_runtime.jsx(type, p);
		}

		/* ---------- 样式 ---------- */
		/* 一套色板 + 一套间距（4/8/12/16）。暗色为默认，亮色由 .dsh-kb-light 覆盖；
		   两套都写死在本文件，不引用应用主题变量（缺变量会让文字隐形）。
		   面板内不使用 !important、不使用 order 复排 DOM。 */
		var CSS = [
			/* 面板外壳与色板 */
			".dsh-kb-panel{position:fixed;top:64px;right:12px;width:460px;max-height:calc(100vh - 96px);display:flex;flex-direction:column;background:var(--kb-bg);color:var(--kb-fg);border:1px solid var(--kb-line);border-radius:10px;box-shadow:0 14px 44px rgba(0,0,0,.34);font-size:13px;line-height:1.5;z-index:9999;animation:dsh-kb-in 140ms ease;user-select:none}",
			".dsh-kb-panel{--kb-bg:#1c2026;--kb-fg:#e6e9ee;--kb-dim:rgba(230,233,238,.56);--kb-line:rgba(255,255,255,.10);--kb-hover:rgba(255,255,255,.07);--kb-field:rgba(255,255,255,.045);--kb-accent:#6f9df0;--kb-danger:#e2706a;--kb-warn:#d9a441}",
			".dsh-kb-panel.dsh-kb-light{--kb-bg:#ffffff;--kb-fg:#1d2126;--kb-dim:rgba(29,33,38,.55);--kb-line:rgba(0,0,0,.10);--kb-hover:rgba(0,0,0,.05);--kb-field:rgba(0,0,0,.035);--kb-accent:#2f5fc4;--kb-danger:#bf3b2f;--kb-warn:#9a6a09;box-shadow:0 14px 44px rgba(0,0,0,.16)}",
			".dsh-kb-panel,.dsh-kb-panel *{box-sizing:border-box}",
			"@keyframes dsh-kb-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}",
			"@keyframes dsh-kb-rot{to{transform:rotate(360deg)}}",
			/* 拖拽条：只在左边缘 5px，且 hover 才显示抓手底色 */
			".dsh-kb-resize{position:absolute;left:-3px;top:12px;bottom:12px;width:5px;border-radius:3px;cursor:ew-resize}",
			".dsh-kb-resize:hover{background:var(--kb-line)}",
			/* 头部 */
			".dsh-kb-header{display:flex;align-items:center;gap:8px;height:42px;padding:0 8px 0 12px;flex:none;border-bottom:1px solid var(--kb-line)}",
			".dsh-kb-header-icon{display:inline-flex;flex:none;color:var(--kb-accent)}",
			".dsh-kb-header-title{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-kb-header-title em{font-style:normal;font-weight:400;font-size:12px;color:var(--kb-dim)}",
			".dsh-kb-iconbtn{flex:none;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border:none;background:transparent;color:var(--kb-dim);border-radius:6px;cursor:pointer;font-size:15px;line-height:1}",
			".dsh-kb-iconbtn:hover{background:var(--kb-hover);color:var(--kb-fg)}",
			/* 头部只放一个齿轮（设置），不再藏二级菜单；改这里同时删掉 .dsh-kb-menu 相关样式 */
			".dsh-kb-sectionbtn{display:inline-flex;align-items:center;gap:6px;border:none;background:transparent;color:var(--kb-dim);font-size:11px;padding:8px 0 2px;cursor:pointer}",
			/* 页签 */
			".dsh-kb-tabs{display:flex;gap:4px;padding:8px 12px;flex:none}",
			".dsh-kb-tab{border:none;background:transparent;color:var(--kb-dim);font-size:12px;padding:4px 10px;border-radius:999px;cursor:pointer}",
			".dsh-kb-tab:hover{background:var(--kb-hover);color:var(--kb-fg)}",
			".dsh-kb-tab.on{background:var(--kb-field);color:var(--kb-fg);font-weight:600}",
			/* 主体 */
			".dsh-kb-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 12px 12px}",
			/* 当前会话条 */
			".dsh-kb-ctx{display:flex;align-items:center;gap:6px;min-width:0;padding:4px 0 8px;font-size:11px;color:var(--kb-dim)}",
			".dsh-kb-ctx b{font-size:12px;font-weight:600;color:var(--kb-fg);flex:none}",
			".dsh-kb-grow{flex:1;min-width:0}",
			".dsh-kb-ctx .dsh-kb-grow{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			/* 搜索 */
			".dsh-kb-search{display:flex;gap:6px;padding:0 0 4px}",
			".dsh-kb-input{flex:1;min-width:0;height:30px;padding:0 8px;border:1px solid var(--kb-line);border-radius:7px;background:var(--kb-field);color:inherit;font-size:13px;outline:none}",
			".dsh-kb-input:focus{border-color:var(--kb-accent)}",
			".dsh-kb-btn{flex:none;height:28px;padding:0 10px;border:1px solid var(--kb-line);border-radius:7px;background:transparent;color:var(--kb-fg);font-size:12px;white-space:nowrap;cursor:pointer}",
			".dsh-kb-btn:hover{background:var(--kb-hover)}",
			".dsh-kb-btn:disabled{opacity:.45;cursor:default}",
			".dsh-kb-btn.primary{background:var(--kb-accent);border-color:transparent;color:#0d1522;font-weight:600}",
			".dsh-kb-btn.primary:hover{filter:brightness(1.06)}",
			".dsh-kb-btn.danger{color:var(--kb-danger);border-color:var(--kb-danger)}",
			/* 标签 */
			".dsh-kb-tag{flex:none;font-size:10px;line-height:15px;padding:0 6px;border:1px solid var(--kb-line);border-radius:999px;color:var(--kb-dim);white-space:nowrap}",
			".dsh-kb-tag.cur{border-color:var(--kb-accent);color:var(--kb-accent)}",
			".dsh-kb-tag.warn{border-color:var(--kb-warn);color:var(--kb-warn)}",
			/* 检索结果：源行 + 两行摘要，动作以文字按钮挂在源行右侧（不做整卡点击） */
			".dsh-kb-hit{padding:10px 0;border-top:1px solid var(--kb-line);display:flex;flex-direction:column;gap:4px}",
			".dsh-kb-hit-src{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:11px;color:var(--kb-dim)}",
			".dsh-kb-hit-src .f{flex:0 1 auto;max-width:52%;color:var(--kb-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-kb-hit-src .h{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-kb-hit-src .m{flex:none;white-space:nowrap}",
			".dsh-kb-link{flex:none;border:none;background:transparent;color:var(--kb-dim);font-size:11px;line-height:1.2;padding:0 2px;white-space:nowrap;cursor:pointer}",
			".dsh-kb-link:hover{color:var(--kb-fg);text-decoration:underline}",
			".dsh-kb-hit-text{font-size:12px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;word-break:break-word}",
			/* 库行 / 记忆行 */
			".dsh-kb-row{display:flex;align-items:flex-start;gap:8px;padding:10px 0;border-top:1px solid var(--kb-line)}",
			".dsh-kb-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}",
			".dsh-kb-row-top{display:flex;align-items:center;gap:6px;min-width:0}",
			".dsh-kb-name{flex:none;max-width:60%;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-kb-sub{font-size:11px;color:var(--kb-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-kb-hint{font-size:11px;line-height:1.5;color:var(--kb-dim);opacity:.85;padding-top:2px}",
			".dsh-kb-acts{display:flex;gap:6px;flex-wrap:wrap;padding-top:3px}",
			/* 库内文件清单：卡片 + 分组 + 行 hover，别挤成一行字 */
			".dsh-kb-files{margin-top:8px;padding:6px;border:1px solid var(--kb-line);border-radius:10px;background:var(--kb-field);max-height:232px;overflow-y:auto}",
			".dsh-kb-filegroup + .dsh-kb-filegroup{margin-top:8px;padding-top:8px;border-top:1px solid var(--kb-line)}",
			".dsh-kb-filegroup-head{padding:2px 6px 4px;font-size:10px;letter-spacing:.08em;color:var(--kb-dim)}",
			".dsh-kb-filegroup-body{display:flex;flex-direction:column;gap:1px}",
			".dsh-kb-file{display:flex;align-items:center;gap:8px;min-width:0;padding:7px 8px;border-radius:7px;cursor:pointer}",
			".dsh-kb-file:hover{background:var(--kb-hover)}",
			".dsh-kb-file:hover .dsh-kb-file-name{color:var(--kb-fg)}",
			".dsh-kb-file-dot{flex:none;width:5px;height:5px;border-radius:50%;background:var(--kb-dim);opacity:.55}",
			".dsh-kb-file-dot.mem{background:var(--kb-accent);opacity:1}",
			".dsh-kb-file-name{flex:1;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-kb-file-meta{flex:none;font-size:11px;color:var(--kb-dim);font-variant-numeric:tabular-nums;white-space:nowrap}",
			".dsh-kb-file-more{padding:4px 6px;font-size:11px;color:var(--kb-dim)}",
			".dsh-kb-progress{height:3px;border-radius:999px;background:var(--kb-field);overflow:hidden;margin-top:2px}",
			".dsh-kb-progress i{display:block;height:100%;background:var(--kb-accent);transition:width 150ms ease}",
			".dsh-kb-spin{display:inline-block;width:11px;height:11px;border:1.5px solid var(--kb-line);border-top-color:var(--kb-accent);border-radius:50%;animation:dsh-kb-rot .7s linear infinite}",
			/* 确认条 */
			".dsh-kb-confirm{display:flex;flex-direction:column;gap:6px;margin-top:6px;padding:8px;border:1px solid var(--kb-line);border-radius:8px;background:var(--kb-field)}",
			".dsh-kb-confirm-text{font-size:12px;line-height:1.5}",
			".dsh-kb-confirm-acts{display:flex;gap:6px}",
			/* 记忆正文 / 详情 */
			".dsh-kb-memo{padding:10px 0 0;font-size:12px;line-height:1.65;word-break:break-word;user-select:text}",
			/* 记忆正文（渲染后的 markdown）：标题 / 段落 / 列表 / 引用 */
			".dsh-kb-md-h{margin:14px 0 6px;font-weight:600;line-height:1.4}",
			".dsh-kb-md-h2{font-size:14px}",
			".dsh-kb-md-h3{font-size:13px}",
			".dsh-kb-md-h4,.dsh-kb-md-h5{font-size:12px;color:var(--kb-dim)}",
			".dsh-kb-md-h:first-child{margin-top:2px}",
			".dsh-kb-md-p{margin:0 0 8px;font-size:12px;line-height:1.65}",
			".dsh-kb-md-ul{margin:0 0 8px;padding-left:18px;display:flex;flex-direction:column;gap:4px}",
			".dsh-kb-md-li{font-size:12px;line-height:1.6}",
			".dsh-kb-md-code{font-family:ui-monospace,Consolas,monospace;font-size:11px;background:var(--kb-field);padding:1px 4px;border-radius:4px}",
			".dsh-kb-md-q{margin:0 0 8px;padding-left:8px;border-left:2px solid var(--kb-line);color:var(--kb-dim);font-size:12px}",
			".dsh-kb-md-pre{margin:0 0 6px;font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--kb-dim);white-space:pre-wrap}",
			/* 记忆里的表格：细边框卡片、表头弱化、可横向滚动 */
			".dsh-kb-md-tablewrap{margin:0 0 10px;overflow-x:auto;border:1px solid var(--kb-line);border-radius:8px}",
			".dsh-kb-md-table{border-collapse:collapse;font-size:11.5px;width:100%}",
			".dsh-kb-md-table th{text-align:left;font-weight:600;color:var(--kb-dim);padding:6px 9px;border-bottom:1px solid var(--kb-line);white-space:nowrap}",
			".dsh-kb-md-table td{padding:6px 9px;border-bottom:1px solid var(--kb-line);vertical-align:top}",
			/* 第一列通常是短标签（定位/生成/注入…），别让它被挤成一列单字 */
			".dsh-kb-md-table th:first-child,.dsh-kb-md-table td:first-child{white-space:nowrap;width:1%;padding-right:14px;color:var(--kb-dim)}",
			".dsh-kb-md-table tbody tr:last-child td{border-bottom:0}",
			".dsh-kb-detail{padding:6px 0 0;font-size:11px;color:var(--kb-dim);display:flex;flex-direction:column;gap:2px}",
			".dsh-kb-detail b{color:var(--kb-fg);font-weight:600}",
			/* 空态 / 提示 / 错误 */
			".dsh-kb-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:28px 8px;text-align:center;color:var(--kb-dim);font-size:12px}",
			".dsh-kb-error{margin:8px 0 0;padding:6px 10px;border:1px solid var(--kb-danger);border-radius:8px;color:var(--kb-danger);font-size:11px}",
			".dsh-kb-toast{margin:8px 0 0;padding:6px 10px;border:1px solid var(--kb-line);border-radius:8px;background:var(--kb-field);font-size:11px}",
			/* 设置页字段 */
			".dsh-kb-field{display:flex;align-items:center;gap:8px;padding:6px 0}",
			".dsh-kb-field .lbl{flex:none;width:58px;font-size:12px;color:var(--kb-dim)}",
			".dsh-kb-field .dsh-kb-input{flex:1;height:28px;font-size:12px}",
			".dsh-kb-num{flex:none;width:58px;height:28px;padding:0 6px;border:1px solid var(--kb-line);border-radius:7px;background:var(--kb-field);color:inherit;font-size:12px;outline:none}",
			".dsh-kb-num:focus{border-color:var(--kb-accent)}",
			".dsh-kb-switch{display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer}",
			".dsh-kb-switch input{accent-color:var(--kb-accent);cursor:pointer}",
			".dsh-kb-section{padding:8px 0 2px;font-size:11px;color:var(--kb-dim)}",
			/* 键盘可达：焦点环只在键盘操作时出现 */
			".dsh-kb-panel button:focus-visible,.dsh-kb-panel input:focus-visible{outline:2px solid var(--kb-accent);outline-offset:1px}",
			/* 侧边栏底部按钮（与备份 / 监视同形制，仍用应用变量） */
			".dsh-kb-button{display:inline-flex;align-items:center;justify-content:center;flex:none;border:none;background:transparent;border-radius:50%;cursor:pointer;padding:0;color:var(--dsw-alias-label-secondary,#8a8f98);line-height:1}",
			".dsh-kb-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18))}",
			/* ===== v2（?ui=v2 时挂 .dsh-kb-v2）=====
			   1) 调色板改接宿主主题变量：深浅色由宿主决定，不再依赖 .dsh-kb-light 的两套写死色；
			   2) 页签从胶囊改成下划线分隔条（三个页签在 460px 里更省高度）；
			   3) 检索结果密度压紧：来源行 12px、摘要 3 行、命中块 padding 8px。 */
			".dsh-kb-panel.dsh-kb-v2{--kb-bg:var(--dsw-alias-bg-layer-2,#1c2026);--kb-fg:var(--dsw-alias-label-primary,#e6e9ee);--kb-dim:var(--dsw-alias-label-secondary,rgba(230,233,238,.56));--kb-line:var(--dsw-alias-border-l1,rgba(255,255,255,.10));--kb-hover:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.07));--kb-field:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.045));--kb-accent:var(--dsw-alias-brand-primary,#6f9df0);--kb-danger:var(--dsw-alias-state-error-primary,#e2706a);--kb-warn:var(--dsw-alias-state-warn-primary,#d9a441);box-shadow:0 16px 40px rgba(0,0,0,.18)}",
			".dsh-kb-v2 .dsh-kb-tabs{gap:14px;padding:2px 12px 0;border-bottom:1px solid var(--kb-line)}",
			".dsh-kb-v2 .dsh-kb-tab{padding:8px 0;border-radius:0;font-size:12px;background:transparent}",
			".dsh-kb-v2 .dsh-kb-tab:hover{background:transparent;color:var(--kb-fg)}",
			".dsh-kb-v2 .dsh-kb-tab.on{background:transparent;box-shadow:inset 0 -2px 0 var(--kb-accent);font-weight:600}",
			".dsh-kb-v2 .dsh-kb-body{padding:10px 12px 12px}",
			".dsh-kb-v2 .dsh-kb-hit{padding:8px 0;gap:3px}",
			".dsh-kb-v2 .dsh-kb-hit-text{font-size:12px;line-height:1.55;-webkit-line-clamp:3}",
			".dsh-kb-v2 .dsh-kb-hit-src .f{font-size:12px;font-weight:500;max-width:46%}",
			".dsh-kb-v2 .dsh-kb-search{padding:2px 0 6px}",
			".dsh-kb-v2 .dsh-kb-input,.dsh-kb-v2 .dsh-kb-btn{border-radius:8px}",
			".dsh-kb-v2 .dsh-kb-files{border-radius:10px;max-height:none}",
			".dsh-kb-v2 .dsh-kb-empty{padding:22px 8px}",
			".dsh-kb-v2 .dsh-kb-v2-files-pane{display:flex;flex-direction:column;gap:6px;padding-top:4px}",
			".dsh-kb-v2 .dsh-kb-v2-files-head{display:flex;align-items:center;gap:6px;min-width:0;padding:2px 0 4px}",
			".dsh-kb-v2 .dsh-kb-v2-files-head .dsh-kb-grow{flex:1;min-width:0}"
		].join("");

		function injectCss() {
			if (document.getElementById("dsh-kb-css")) return;
			var style = document.createElement("style");
			style.id = "dsh-kb-css";
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		/* ---------- 小工具 ---------- */
		/**
		 * 调宿主接口：带超时。没有超时时，一次挂起的请求会让按钮永久禁用、轮询永远停不下来。
		 * 重建大库可能真的很久，所以默认给 120s；调用方可以传 options.timeoutMs 覆盖。
		 */
		async function api(path, body, options) {
			var ms = options && options.timeoutMs ? options.timeoutMs : 120000;
			var init = body
				? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
				: { method: "GET" };
			try {
				init.signal = AbortSignal.timeout(ms);
			} catch (e) {
				/* 老浏览器没有 AbortSignal.timeout：退化成无超时 */
			}
			var res = await fetch(path, init);
			if (!res.ok) throw new Error("HTTP " + res.status);
			return res.json();
		}

		/** 复制一段文本到剪贴板：优先 navigator.clipboard（localhost 是安全上下文），退化到 execCommand。 */
		async function writeClipboard(text) {
			try {
				if (navigator.clipboard && navigator.clipboard.writeText) {
					await navigator.clipboard.writeText(text);
					return true;
				}
			} catch (e) { /* 退化到 execCommand */ }
			try {
				var ta = document.createElement("textarea");
				ta.value = text;
				ta.style.position = "fixed";
				ta.style.opacity = "0";
				document.body.appendChild(ta);
				ta.select();
				var ok = document.execCommand("copy");
				document.body.removeChild(ta);
				return ok === true;
			} catch (e2) {
				return false;
			}
		}

		/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前。 */
		function relativeTime(iso) {
			try {
				var t = Date.parse(iso);
				if (!Number.isFinite(t)) return "";
				var diff = Date.now() - t;
				if (diff < 60000) return "刚刚";
				if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
				if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
				return Math.floor(diff / 86400000) + " 天前";
			} catch (e) {
				return "";
			}
		}

		function baseName(p) {
			var s = String(p || "").replace(/[\\/]+$/, "");
			var i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
			return i >= 0 ? s.slice(i + 1) : s;
		}

		/** 秒数 → 简短时长（详情里用）。 */
		function duration(ms) {
			if (!Number.isFinite(ms) || ms < 0) return "";
			if (ms < 1000) return ms + "ms";
			var s = Math.round(ms / 1000);
			if (s < 60) return s + " 秒";
			return Math.floor(s / 60) + " 分 " + (s % 60) + " 秒";
		}

		/* ---------- 图标：书脊 + 三行文字线，纯描边不闭合（16px 下不会读成方框） ---------- */
		var KB_ICON_STROKES = [
			"M3.7 2.65v10.7",
			"M6.3 4.5h6",
			"M6.3 8h6",
			"M6.3 11.5h3.6"
		];
		function kbIcon(size) {
			return h("svg", {
				width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true",
				children: KB_ICON_STROKES.map(function (d, i) {
					return h("path", {
						d: d, stroke: "currentColor", strokeWidth: 1.35, strokeLinecap: "round", strokeLinejoin: "round"
					}, "s" + i);
				})
			});
		}
		/** 同一枚图标的静态字符串版本：DOM 按钮用 innerHTML 写入（内容是写死的常量，无注入面）。 */
		var KB_SVG_HTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
			+ KB_ICON_STROKES.map(function (d) {
				return '<path d="' + d + '" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>';
			}).join("")
			+ "</svg>";

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
			} catch (e) { /* 采样失败按暗色 */ }
			return false;
		}

		/* ---------- wide 模式：把按钮放进「设置」行（与备份 / 监视 / 分支图同排） ---------- */
		/* 「设置」行内四颗按钮的横向偏移：备份 = 0、监视 = +30、分支图 = +60、知识库 = +90；
		   CSS right 越大越靠左。按钮 28px、步进 30px。DOM_ROW_BASE 是四颗共用的基准归一化量。 */
		var DOM_BUTTON_OFFSET = 90;
		var DOM_ROW_BASE = 2;
		var domButton = null;
		var domTimer = null;
		var placementRef = null;
		var togglePanel = null;

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
			} catch (err) {
				return null;
			}
		}

		/* 新版侧栏把「设置」从窄齿轮改成整行长条，此时不再做 DOM 手术，改在槽位内联渲染。 */
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
				domButton.style.position = "absolute";
				domButton.style.right = Math.max(0, Math.round(inset - rightGap) + DOM_ROW_BASE + DOM_BUTTON_OFFSET) + "px";
				domButton.style.top = "50%";
				domButton.style.transform = "translateY(-50%)";
				domButton.style.width = "28px";
				domButton.style.height = "28px";
				domButton.style.fontSize = "15px";
			} catch (err) { /* 忽略 */ }
		}

		function ensureDomButton(anchorEl) {
			if (domButton) { positionDomButton(); return true; }
			var p = findPlacement(anchorEl);
			if (!p) return false;
			placementRef = p;
			try {
				domButton = document.createElement("button");
				domButton.type = "button";
				domButton.className = "dsh-kb-button dsh-kb-button-anchor";
				domButton.title = "知识阁";
				domButton.setAttribute("aria-label", "知识阁");
				domButton.innerHTML = KB_SVG_HTML;
				domButton.addEventListener("click", function () {
					if (typeof togglePanel === "function") togglePanel();
				});
				p.settingsArea.style.position = "relative";
				p.settingsArea.appendChild(domButton);
				positionDomButton();
				return true;
			} catch (err) {
				domButton = null;
				return false;
			}
		}

		function removeDomButton() {
			if (domTimer) { clearInterval(domTimer); domTimer = null; }
			if (domButton) { try { domButton.remove(); } catch (e) { /* 已移除 */ } domButton = null; }
			placementRef = null;
		}

		/* ---------- 面板零件 ---------- */
		function tag(text, tone, title) {
			return h("span", { className: "dsh-kb-tag" + (tone ? " " + tone : ""), title: title || undefined, children: text });
		}

		function hitRow(r, i, props) {
			var src = [
				tag(r.library),
				h("span", { className: "f", title: r.file, children: r.file }, "file"),
				r.heading ? h("span", { className: "h", title: r.heading, children: r.heading }, "head") : h("span", { className: "h" }, "head"),
				r.line ? h("span", { className: "m", children: "L" + r.line }, "line") : null,
				r.confidence === "low" ? tag("低置信", "warn", "相关度偏低，仅供参考") : null,
				h("button", { className: "dsh-kb-link", onClick: function () { props.onCopy(r); }, children: "复制" }, "copy"),
				h("button", { className: "dsh-kb-link", onClick: function () { props.onInsert(r); }, children: "插入" }, "ins")
			];
			return h("div", { className: "dsh-kb-hit", children: [
				h("div", { className: "dsh-kb-hit-src", children: src }, "src"),
				snippetText(r) ? h("div", { className: "dsh-kb-hit-text", children: snippetText(r) }, "text") : null
			] }, "hit" + i);
		}

		/** 摘要只给人看：去掉块首那行标题（源行里已经有 heading 了），避免同一句出现两次。 */
		function snippetText(r) {
			var lines = String(r && r.text ? r.text : "").trim().split(/\r?\n/);
			if (lines.length && /^#{1,6}\s+\S/.test(lines[0])) lines = lines.slice(1);
			var body = lines.join("\n").trim();
			if (!body || body === String(r.heading || "").trim()) return "";
			return body;
		}

		function SearchPane(props) {
			var st = props.state;
			var cur = st.current;
			var ctx = [h("span", { children: cur && cur.source === "recent" ? "最近窗口" : "当前窗口" }, "k")];
			if (cur) {
				// 把"哪个窗口"写在最前面：记忆是按窗口存的，只显示库名会让人误以为整个工作区共用一份。
				ctx.push(h("b", { title: cur.cwd || "", children: cur.title || baseName(cur.cwd) }, "lib"));
				if (cur.library && cur.exists === false) ctx.push(h("span", { className: "dsh-kb-tag warn", title: "这个库还没有目录（第一次更新记忆时会自动创建）", children: "未建库" }, "unbuilt"));
				ctx.push(h("span", { className: "dsh-kb-sub", children: cur.library || "" }, "libname"));
				ctx.push(h("span", { className: "dsh-kb-grow", title: cur.cwd, children: cur.cwd || "" }, "cwd"));
			} else {
				ctx.push(h("span", { className: "dsh-kb-grow", children: "未打开窗口" }, "none"));
			}
			var body = [];
			body.push(h("div", { className: "dsh-kb-ctx", children: ctx }, "ctx"));
			body.push(h("div", { className: "dsh-kb-search", children: [
				h("input", {
					className: "dsh-kb-input",
					ref: props.inputRef,
					placeholder: "搜索知识库",
					value: st.query,
					onChange: function (e) { props.onQuery(e.target.value); },
					onKeyDown: function (e) { if (e.key === "Enter") props.onSearch(); }
				}, "input"),
				h("button", { className: "dsh-kb-btn primary", disabled: st.searching === true, onClick: props.onSearch, children: st.searching === true ? "搜索中" : "搜索" }, "go")
			] }, "search"));
			if (st.results) {
				if (st.results.length === 0) body.push(h("div", { className: "dsh-kb-empty", children: st.searchNote || "没有命中" }, "none"));
				else for (var i = 0; i < st.results.length; i++) body.push(hitRow(st.results[i], i, props));
			}
			// 库列表回到首页（旧版就在检索页下面）：打开面板先看见"我有哪几个库"，
			// 而不是只剩一个搜索框。搜索过一次后默认收起，让结果占主视觉，标题行可再展开。
			var libs = sortedLibs(st.libraries);
			if (libs.length === 0) {
				body.push(h("div", { className: "dsh-kb-empty", children: [
					h("span", { children: "暂无知识库" }, "t"),
					h("button", { className: "dsh-kb-btn primary", onClick: props.onOpenDir, children: "打开目录" }, "open")
				] }, "empty"));
			} else {
				var libsOpen = st.libsOpen !== false;
				body.push(h("button", {
					className: "dsh-kb-sectionbtn",
					title: libsOpen ? "收起库列表" : "展开库列表",
					onClick: props.onToggleLibs,
					children: "知识库 " + libs.length + (libsOpen ? "" : " · 展开")
				}, "sect"));
				if (libsOpen) for (var j = 0; j < libs.length; j++) body.push(libRow(libs[j], st, props));
			}
			return h("div", { children: body });
		}

		/** 库列表排序：当前会话那个置顶，然后工作区 / 文档 / 空。 */
		function sortedLibs(list) {
			var libs = (list || []).slice();
			libs.sort(function (a, b) {
				var rank = function (x) { return x.isCurrent ? 0 : x.kind === "workspace" ? 1 : x.kind === "docs" ? 2 : 3; };
				var d = rank(a) - rank(b);
				return d !== 0 ? d : String(a.name).localeCompare(String(b.name), "zh");
			});
			return libs;
		}

		/* ---------- 记忆正文渲染（轻量 markdown → React，无依赖） ---------- */
		/** 行内片段：`代码` 与 **粗体**。 */
		function mdInline(text, keyPrefix) {
			var out = [];
			var re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
			var last = 0;
			var m;
			var n = 0;
			while ((m = re.exec(text)) !== null) {
				if (m.index > last) out.push(text.slice(last, m.index));
				var tok = m[0];
				if (tok.charAt(0) === "`") out.push(h("code", { className: "dsh-kb-md-code", children: tok.slice(1, -1) }, keyPrefix + "c" + n));
				else out.push(h("strong", { children: tok.slice(2, -2) }, keyPrefix + "b" + n));
				last = m.index + tok.length;
				n++;
			}
			if (last < text.length) out.push(text.slice(last));
			return out.length ? out : [text];
		}

		/** 把记忆文件渲染成给人看的块：标题 / 列表 / 引用 / 段落；HTML 注释（手改区标记）不显示。 */
		function mdBlocks(text, keyPrefix) {
			var src = String(text || "").replace(/<!--[\s\S]*?-->/gu, "").trim();
			if (!src) return null;
			var lines = src.split(/\r?\n/);
			var nodes = [];
			var para = [];
			var list = null;
			var k = 0;
			var push = function (node) {
				nodes.push(node);
			};
			var flushPara = function () {
				if (!para.length) return;
				push(h("p", { className: "dsh-kb-md-p", children: mdInline(para.join(" "), keyPrefix + "p" + k++) }));
				para = [];
			};
			var flushList = function () {
				if (!list) return;
				push(h("ul", { className: "dsh-kb-md-ul", children: list }, keyPrefix + "ul" + k++));
				list = null;
			};
			/** 表格行切格：跳过 `代码` 区段里的 |，并把 \| 还原成 |。 */
			var splitCells = function (row) {
				var s = row.trim().replace(/^\|/u, "").replace(/\|$/u, "");
				var cells = [];
				var cur = "";
				var inCode = false;
				for (var p = 0; p < s.length; p++) {
					var ch = s.charAt(p);
					if (ch === "\\" && s.charAt(p + 1) === "|") { cur += "|"; p++; continue; }
					if (ch === "`") { inCode = !inCode; cur += ch; continue; }
					if (ch === "|" && !inCode) { cells.push(cur.trim()); cur = ""; continue; }
					cur += ch;
				}
				cells.push(cur.trim());
				return cells;
			};
			/** 围栏代码块：块内原样收进一个 pre，不再当 markdown 解析。 */
			var fence = null;
			var flushFence = function () {
				if (!fence) return;
				push(h("pre", { className: "dsh-kb-md-pre dsh-kb-md-fence", children: fence.lines.join("\n") }, keyPrefix + "fence" + k++));
				fence = null;
			};
			for (var i = 0; i < lines.length; i++) {
				var line = lines[i];
				if (fence) {
					var closeFence = /^\s*(```+|~~~+)\s*$/u.exec(line);
					if (closeFence && closeFence[1].charAt(0) === fence.marker) { flushFence(); continue; }
					fence.lines.push(line);
					continue;
				}
				var openFence = /^\s*(```+|~~~+)(.*)$/u.exec(line);
				if (openFence) {
					flushPara(); flushList();
					fence = { marker: openFence[1].charAt(0), lines: [] };
					if (openFence[2].trim()) fence.lines.push(openFence[2].trim());
					continue;
				}
				if (/^\s*$/u.test(line)) { flushPara(); flushList(); continue; }
				var heading = /^(#{1,4})\s+(.*)$/u.exec(line);
				if (heading) {
					flushPara(); flushList();
					var level = Math.min(heading[1].length + 1, 5);
					push(h("div", { className: "dsh-kb-md-h dsh-kb-md-h" + level, children: mdInline(heading[2], keyPrefix + "h" + i) }, keyPrefix + "h" + k++));
					continue;
				}
				var bullet = /^\s*[-*]\s+(.*)$/u.exec(line);
				if (bullet) {
					flushPara();
					if (!list) list = [];
					list.push(h("li", { className: "dsh-kb-md-li", children: mdInline(bullet[1], keyPrefix + "li" + i) }, keyPrefix + "li" + i));
					continue;
				}
				var quote = /^\s*>\s?(.*)$/u.exec(line);
				if (quote) {
					flushPara(); flushList();
					push(h("blockquote", { className: "dsh-kb-md-q", children: mdInline(quote[1], keyPrefix + "q" + i) }, keyPrefix + "q" + k++));
					continue;
				}
				// 表格：连续的 | 行；第二行是 |---| 分隔时第一行当表头
				if (/^\s*\|/u.test(line)) {
					flushPara(); flushList();
					var tableRows = [];
					var j = i;
					while (j < lines.length && /^\s*\|/u.test(lines[j])) {
						tableRows.push(lines[j]);
						j++;
					}
					i = j - 1;
					var cells = tableRows.map(splitCells);
					var sepIdx = -1;
					for (var t = 0; t < cells.length; t++) {
						if (cells[t].every(function (c) { return /^:?-+:?$/u.test(c); }) && cells[t].some(function (c) { return c !== ""; })) { sepIdx = t; break; }
					}
					var headCells = sepIdx > 0 ? cells[0] : null;
					var bodyCells = sepIdx >= 0 ? cells.slice(sepIdx + 1) : cells;
					push(h("div", { className: "dsh-kb-md-tablewrap", children: [
						h("table", { className: "dsh-kb-md-table", children: [
							headCells ? h("thead", { children: h("tr", { children: headCells.map(function (c, ci) {
								return h("th", { children: mdInline(c, keyPrefix + "th" + ci) }, "th" + ci);
							}) }) }, "thead") : null,
							h("tbody", { children: bodyCells.map(function (row, ri) {
								return h("tr", { children: row.map(function (c, ci) {
									return h("td", { children: mdInline(c, keyPrefix + "td" + ri + "-" + ci) }, "td" + ri + "-" + ci);
								}) }, "tr" + ri);
							}) }, "tbody")
						] }, "table")
					] }, keyPrefix + "tw" + k++));
					continue;
				}
				para.push(line.trim());
			}
			flushFence();
			flushPara(); flushList();
			return nodes.length ? nodes : null;
		}

		function MemoryPane(props) {
			var st = props.state;
			var m = st.memory;
			if (!m) return h("div", { className: "dsh-kb-empty", children: st.memoryError || "读取中" });
			if (m.ok === false) {
				return h("div", { children: [
					h("div", { className: "dsh-kb-empty", children: m.error || "记忆不可用" }, "e"),
					h("div", { className: "dsh-kb-field", children: h("button", { className: "dsh-kb-btn", onClick: props.onRefreshMemory, children: "重试" }, "r") }, "retry")
				] });
			}
			var hasWindow = m.window !== null && m.window !== void 0;
			var w = m.window || {};
			var p = m.project || {};
			var s = m.settings || {};
			var busy = st.memoryBusy === true;
			var projectBusy = st.projectBusy === true;
			// 冷却秒数按"读到快照的时刻"折算，否则数字会冻在第一次渲染时的值
			var secondsLeft = w.cooldownMs > 0
				? Math.max(0, Math.ceil((Number(w.cooldownMs) - (Date.now() - (Number(st.memoryAt) || Date.now()))) / 1000))
				: 0;
			var versions = (w.versions || []).filter(function (v) { return v && v.exists !== false; });
			var projectVersions = (p.versions || []).filter(function (v) { return v && v.exists !== false; });
			var kids = [];

			/* ---- 本窗口记忆（自动） ---- */
			if (!hasWindow) {
				kids.push(h("div", { className: "dsh-kb-empty", children: "先打开一个窗口" }, "nowin"));
			} else {
				kids.push(h("div", { className: "dsh-kb-row", children: [
					h("div", { className: "dsh-kb-row-main", children: [
						h("div", { className: "dsh-kb-row-top", children: [
							tag("本窗口", "cur"),
							h("span", { className: "dsh-kb-name", title: w.title || w.id || "", children: w.title || w.id || "未识别窗口" }, "name"),
							w.detached ? tag("未挂载", "warn", "这个窗口没有运行中的会话") : null,
							w.truncated ? tag("已截断", "warn", "上次生成达到 token 上限") : null,
							h("span", { className: "dsh-kb-grow" }, "g"),
							h("span", { className: "dsh-kb-sub", children: w.exists ? (w.updatedAt ? relativeTime(w.updatedAt) + "更新" : "已生成") : "尚未生成" }, "upd")
						] }, "top"),
						h("div", { className: "dsh-kb-acts", children: [
							h("button", {
								className: "dsh-kb-btn",
								disabled: busy || secondsLeft > 0,
								title: secondsLeft > 0 ? "冷却 " + secondsLeft + " 秒" : "立即重写一次（平时每 " + (s.turns || 6) + " 轮自动更新）",
								onClick: props.onUpdateMemory,
								children: busy ? "更新中" : secondsLeft > 0 ? "冷却 " + secondsLeft + "s" : "立即更新"
							}, "run"),
							h("button", { className: "dsh-kb-btn", onClick: props.onToggleWindow, children: st.windowOpen ? "收起" : "展开" }, "fold"),
							h("button", { className: "dsh-kb-btn", onClick: props.onToggleMemoryActs, children: "更多" }, "more")
						] }, "acts")
					] }, "main")
				] }, "win"));

				if (st.memoryActs) {
					kids.push(h("div", { className: "dsh-kb-confirm-acts", style: { paddingTop: 6 }, children: [
						h("button", { className: "dsh-kb-btn", onClick: props.onToggleVersions, children: versions.length ? "版本 " + versions.length : "版本" }, "ver"),
						h("button", { className: "dsh-kb-btn", onClick: props.onToggleDetails, children: "运行详情" }, "det"),
						h("button", { className: "dsh-kb-btn", onClick: function () { props.onRevealScope("session"); }, children: "打开目录" }, "dir"),
						h("button", { className: "dsh-kb-btn", onClick: props.onCopyPath, children: "复制路径" }, "cp")
					] }, "extra"));
				}
				if (st.showVersions) {
					if (!versions.length) kids.push(h("div", { className: "dsh-kb-sub", style: { paddingTop: 6 }, children: "暂无历史版本" }, "nover"));
					else versions.forEach(function (v) { kids.push(versionRow(props, st, v, "session")); });
				}
				if (st.showDetails) {
					var usage = w.usage || {};
					kids.push(h("div", { className: "dsh-kb-detail", children: [
						h("span", { children: ["上次更新：", h("b", { children: w.updatedAt ? relativeTime(w.updatedAt) + "前" : "未运行" })] }, "d1"),
						w.model ? h("span", { children: ["模型：", h("b", { children: w.model })] }, "d2") : null,
						w.elapsedMs ? h("span", { children: ["耗时：", h("b", { children: duration(w.elapsedMs) })] }, "d3") : null,
						w.turns ? h("span", { children: ["输入：", h("b", { children: w.turns + " 轮 / " + (w.inputChars || 0) + " 字" })] }, "d4") : null,
						(usage.inputTokens || usage.outputTokens) ? h("span", { children: ["token：", h("b", { children: (usage.inputTokens || 0) + " / " + (usage.outputTokens || 0) })] }, "d5") : null
					] }, "details"));
				}
				if (st.windowOpen) {
					var windowBlocks = w.exists ? mdBlocks(w.text, "w") : null;
					kids.push(windowBlocks
						? h("div", { className: "dsh-kb-memo", children: windowBlocks }, "memo")
						: h("div", { className: "dsh-kb-empty", children: "尚未生成" }, "empty"));
				}
			}

			/* ---- 项目记忆（手动开启 → 自动维护；正文不注入） ---- */
			kids.push(h("div", { className: "dsh-kb-sep" }, "sep"));
			kids.push(h("div", { className: "dsh-kb-row", children: [
				h("div", { className: "dsh-kb-row-main", children: [
					h("div", { className: "dsh-kb-row-top", children: [
						tag("项目"),
						h("span", { className: "dsh-kb-name", title: p.path || "", children: p.library || "" }, "name"),
						h("span", { className: "dsh-kb-grow" }, "g"),
						h("span", { className: "dsh-kb-sub", children: p.updatedAt ? relativeTime(p.updatedAt) + "更新" : "尚未生成" }, "upd")
					] }, "top"),
					// 顺序与「本窗口」卡保持一致：立即更新 / 展开 / …，开关键放最后，两张卡的按钮才能左对齐
					h("div", { className: "dsh-kb-acts", children: [
						h("button", {
							className: "dsh-kb-btn",
							disabled: projectBusy,
							title: "立即更新一次项目记忆",
							onClick: props.onProjectUpdate,
							children: projectBusy ? "更新中" : "立即更新"
						}, "refresh"),
						h("button", { className: "dsh-kb-btn", onClick: props.onToggleProject, children: st.projectOpen ? "收起" : "展开" }, "view"),
						h("button", {
							className: "dsh-kb-btn" + (p.enabled ? "" : " primary"),
							title: p.enabled ? "关闭后不再自动维护" : "开启后每 " + (s.turns || 6) + " 轮自动维护",
							onClick: function () { props.onToggleProjectEnabled(!p.enabled); },
							children: p.enabled ? "关闭" : "开启"
						}, "toggle")
					] }, "acts")
				] }, "main")
			] }, "proj"));
			if (st.projectOpen) {
				if (projectVersions.length) projectVersions.forEach(function (v) { kids.push(versionRow(props, st, v, "project")); });
				var projectBlocks = p.exists ? mdBlocks(p.text, "pk") : null;
				kids.push(projectBlocks
					? h("div", { className: "dsh-kb-memo", children: projectBlocks }, "pmemo")
					: h("div", { className: "dsh-kb-empty", children: "尚未生成" }, "pempty"));
			}
			return h("div", { children: kids });
		}


		/** 一个历史版本行 + 行内确认条（session / project 共用）。 */
		function versionRow(props, st, v, scope) {
			var pending = st.pending && st.pending.kind === "rollback" && st.pending.slot === v.slot && st.pending.scope === scope;
			var row = h("div", { className: "dsh-kb-field", children: [
				h("span", { className: "dsh-kb-sub dsh-kb-grow", children: (scope === "project" ? "项目 " : "") + "v" + v.slot + " · " + relativeTime(v.savedAt) + " · " + v.lines + " 行" }, "meta"),
				pending ? null : h("button", { className: "dsh-kb-btn", onClick: function () { props.onAskRollback(scope, v.slot); }, children: "回退" }, "rb")
			] }, "v" + scope + v.slot);
			if (!pending) return row;
			return h("div", { children: [row, h("div", { className: "dsh-kb-confirm", children: [
				h("div", { className: "dsh-kb-confirm-text", children: "用 v" + v.slot + " 覆盖当前" + (scope === "project" ? "项目记忆" : "窗口记忆") + "？当前内容会先存进 v1。" }, "t"),
				h("div", { className: "dsh-kb-confirm-acts", children: [
					h("button", { className: "dsh-kb-btn", onClick: props.onCancelPending, children: "取消" }, "c"),
					h("button", { className: "dsh-kb-btn danger", onClick: props.onConfirmRollback, children: "覆盖" }, "ok")
				] }, "a")
			] }, "confirm")] }, "wrap" + scope + v.slot);
		}

		/** 一组文件（记忆 / 文档）：组标题 + 行（名称、大小 · 更新时间）。 */
		function fileGroup(label, files, props, library) {
			var shown = files.slice(0, 20);
			var rows = shown.map(function (f, idx) {
				var size = Number(f.size);
				var when = f.updatedAt ? relativeTime(f.updatedAt) : "";
				var meta = [Number.isFinite(size) ? Math.max(1, Math.round(size / 1024)) + " KB" : "", when].filter(Boolean).join(" · ");
				return h("div", {
					className: "dsh-kb-file",
					title: f.name + (meta ? "\n" + meta : "") + "\n点击用系统默认程序打开",
					role: "button",
					tabIndex: 0,
					onClick: function () { props.onOpenFile(f, library); },
					onKeyDown: function (e) {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							props.onOpenFile(f, library);
						}
					},
					children: [
						h("span", { className: "dsh-kb-file-dot" + (f.kind === "doc" ? "" : " mem") }, "dot"),
						h("span", { className: "dsh-kb-file-name", children: f.name }, "name"),
						f.kind === "window-memory"
							? h("span", { className: "dsh-kb-tag", children: "窗口" }, "kind")
							: null,
						h("span", { className: "dsh-kb-file-meta", children: meta }, "meta")
					]
				}, "f" + idx);
			});
			if (files.length > shown.length) rows.push(h("div", { className: "dsh-kb-file-more", children: "还有 " + (files.length - shown.length) + " 个" }, "more"));
			return h("div", { className: "dsh-kb-filegroup", children: [
				h("div", { className: "dsh-kb-filegroup-head", children: label + " · " + files.length }, "head"),
				h("div", { className: "dsh-kb-filegroup-body", children: rows }, "body")
			] }, "g:" + label);
		}

		function libRow(lib, st, props) {
			var open = st.expandedLib === lib.name;
			var pending = st.pending && st.pending.kind === "rebuild" && st.pending.name === lib.name;
			var kindTag = lib.kind === "workspace" ? tag("工作区") : lib.kind === "docs" ? tag("文档") : tag("空");
			var top = [
				h("span", { className: "dsh-kb-name", title: lib.name, children: lib.name }, "name"),
				kindTag,
				lib.isCurrent ? tag("当前", "cur") : null,
				lib.needsRebuild ? tag("需重建", "warn") : null,
				lib.progress ? h("span", { className: "dsh-kb-spin" }, "spin") : null
			];
			var meta = [];
			if (lib.documents) meta.push(lib.documents + " 篇");
			if (lib.chunks) meta.push(lib.chunks + " 块");
			if (lib.hasMemory) meta.push("记忆 " + relativeTime(lib.memoryUpdatedAt) + "更新");
			else if (lib.updatedAt) meta.push(relativeTime(lib.updatedAt) + "更新");
			var subText = lib.kind === "workspace" && lib.cwd ? lib.cwd : meta.join(" · ") || "空目录";
			var sub = [h("span", { className: "dsh-kb-grow", title: subText, children: subText }, "s1")];
			if (lib.kind === "workspace" && meta.length) sub.push(h("span", { className: "dsh-kb-sub", children: meta.join(" · ") }, "s2"));
			var acts = [h("button", { className: "dsh-kb-btn", onClick: function () { props.onToggleLib(lib.name); }, children: open ? "收起" : "操作" }, "act")];
			var kids = [
				h("div", { className: "dsh-kb-row", children: [
					h("div", { className: "dsh-kb-row-main", children: [
						h("div", { className: "dsh-kb-row-top", children: top }, "top"),
						h("div", { className: "dsh-kb-row-top", children: sub }, "sub"),
						lib.progress && lib.progress.total > 0
							? h("div", { className: "dsh-kb-progress", children: h("i", { style: { width: Math.round((lib.progress.done / lib.progress.total) * 100) + "%" } }) }, "bar")
							: null
					] }, "main"),
					h("div", { className: "dsh-kb-acts", children: acts }, "acts")
				] }, "row")
			];
			if (open) {
				kids.push(h("div", { className: "dsh-kb-acts", style: { paddingTop: 6 }, children: [
					h("button", { className: "dsh-kb-btn", onClick: function () { props.onAskRebuild(lib.name); }, children: "重建索引" }, "rebuild"),
					h("button", { className: "dsh-kb-btn", onClick: function () { props.onStartRename(lib.name); }, children: "重命名" }, "rename"),
					h("button", { className: "dsh-kb-btn", onClick: function () { props.onRevealLib(lib.name); }, children: "打开目录" }, "dir"),
					h("button", { className: "dsh-kb-btn danger", onClick: function () { props.onAskDelete(lib.name); }, children: "删除" }, "del")
				] }, "acts2"));
				// 文件清单：分「记忆 / 文档」两组，每行 名称 + 大小 · 时间，卡片内滚动
				var fileList = lib.files || [];
				var docs = fileList.filter(function (f) { return f.kind === "doc"; });
				var mems = fileList.filter(function (f) { return f.kind !== "doc"; });
				var groups = [];
				if (mems.length) groups.push(fileGroup("记忆", mems, props, lib.name));
				if (docs.length) groups.push(fileGroup("文档", docs, props, lib.name));
				kids.push(h("div", { className: "dsh-kb-files", children: groups }, "files"));
			}
			if (st.renameLib === lib.name) {
				kids.push(h("div", { className: "dsh-kb-field", children: [
					h("input", {
						className: "dsh-kb-input",
						value: st.renameDraft,
						autoFocus: true,
						onChange: function (e) { props.onRenameDraft(e.target.value); },
						onKeyDown: function (e) {
							if (e.key === "Enter") { e.stopPropagation(); props.onConfirmRename(); }
							// 不加 stopPropagation 的话，document 级别的 Esc 会同时"取消改名 + 关掉面板"
							if (e.key === "Escape") { e.stopPropagation(); props.onCancelPending(); }
						}
					}, "in"),
					h("button", { className: "dsh-kb-btn primary", onClick: props.onConfirmRename, children: "保存" }, "ok"),
					h("button", { className: "dsh-kb-btn", onClick: props.onCancelPending, children: "取消" }, "c")
				] }, "rename"));
			}
			if (st.pending && st.pending.kind === "delete" && st.pending.name === lib.name) {
				kids.push(h("div", { className: "dsh-kb-confirm", children: [
					h("div", { className: "dsh-kb-confirm-text", children: "把「" + lib.name + "」移入回收站？目录会挪到 kb/.trash/ 下（想找回可以自己搬回来），索引与记忆记录一并清掉。" }, "t"),
					h("div", { className: "dsh-kb-confirm-acts", children: [
						h("button", { className: "dsh-kb-btn", onClick: props.onCancelPending, children: "取消" }, "c"),
						h("button", { className: "dsh-kb-btn danger", onClick: props.onConfirmDelete, children: "移入回收站" }, "ok")
					] }, "a")
				] }, "delconfirm"));
			}
			if (pending) {
				kids.push(h("div", { className: "dsh-kb-confirm", children: [
					h("div", { className: "dsh-kb-confirm-text", children: "重建「" + lib.name + "」索引：重新计算 " + (lib.chunks || 0) + " 块的向量，会产生 embedding 调用。" }, "t"),
					h("div", { className: "dsh-kb-confirm-acts", children: [
						h("button", { className: "dsh-kb-btn", onClick: props.onCancelPending, children: "取消" }, "c"),
						h("button", { className: "dsh-kb-btn primary", onClick: props.onConfirmRebuild, children: "重建" }, "ok")
					] }, "a")
				] }, "confirm"));
			}
			return h("div", { children: kids }, "lib:" + lib.name);
		}

		/** 当前库：会话库名 → isCurrent → 唯一库；找不到返回 null。 */
		function currentLibOf(st) {
			var libs = (st && st.libraries) || [];
			var wanted = (st.current && st.current.library)
				|| (st.memory && st.memory.window && st.memory.window.library)
				|| "";
			var i;
			if (wanted) for (i = 0; i < libs.length; i++) if (libs[i].name === wanted) return libs[i];
			for (i = 0; i < libs.length; i++) if (libs[i].isCurrent) return libs[i];
			return libs.length === 1 ? libs[0] : null;
		}

		/**
		 * v2「文件」页签：当前库的记忆/文档清单。
		 * 行与动作复用 fileGroup()（点行用系统程序打开），这里只补库头与两个管理动作。
		 */
		function FilesPane(props) {
			var st = props.state;
			var lib = currentLibOf(st);
			if (!lib) {
				return h("div", { className: "dsh-kb-empty", children: [
					h("span", { children: "还没有可浏览的库" }, "t"),
					h("button", { className: "dsh-kb-btn primary", onClick: props.onOpenDir, children: "打开目录" }, "open")
				] }, "empty");
			}
			var list = lib.files || [];
			var docs = list.filter(function (f) { return f.kind === "doc"; });
			var mems = list.filter(function (f) { return f.kind !== "doc"; });
			var head = h("div", { className: "dsh-kb-v2-files-head", children: [
				h("span", { className: "dsh-kb-name", title: lib.name, children: lib.name }, "name"),
				lib.kind === "workspace" ? tag("工作区") : lib.kind === "docs" ? tag("文档") : tag("空"),
				lib.isCurrent ? tag("当前", "cur") : null,
				lib.needsRebuild ? tag("需重建", "warn") : null,
				h("span", { className: "dsh-kb-grow" }, "g"),
				h("span", { className: "dsh-kb-sub", children: (lib.documents || 0) + " 篇 · " + (lib.chunks || 0) + " 块" }, "meta")
			] }, "head");
			var acts = h("div", { className: "dsh-kb-acts", children: [
				h("button", { className: "dsh-kb-btn", onClick: function () { props.onAskRebuild(lib.name); }, children: "重建索引" }, "rebuild"),
				h("button", { className: "dsh-kb-btn", onClick: function () { props.onRevealLib(lib.name); }, children: "打开目录" }, "dir")
			] }, "acts");
			var groups = [];
			if (mems.length) groups.push(fileGroup("记忆", mems, props, lib.name));
			if (docs.length) groups.push(fileGroup("文档", docs, props, lib.name));
			var body = groups.length
				? h("div", { className: "dsh-kb-files", children: groups }, "files")
				: h("div", { className: "dsh-kb-empty", children: "这个库还没有文件" }, "empty");
			return h("div", { className: "dsh-kb-v2-files-pane", children: [head, acts, body] }, "pane");
		}

		function SettingsPane(props) {
			var st = props.state;
			var m = st.memory && st.memory.ok !== false ? st.memory : null;
			var s = (m && m.settings) || {};
			var kids = [];
			kids.push(h("div", { className: "dsh-kb-field", children: [
				h("span", { className: "lbl", children: "自动记忆" }, "l"),
				h("label", { className: "dsh-kb-switch", children: [
					h("input", {
						type: "checkbox",
						checked: s.enabled === true,
						onChange: function (e) { props.onToggleAuto(e.target.checked); }
					}, "cb"),
					h("span", { children: s.enabled === true ? "开" : "关" }, "t")
				] }, "sw")
			] }, "auto"));
			kids.push(h("div", { className: "dsh-kb-field", children: [
				h("span", { className: "lbl", children: "项目记忆" }, "l"),
				h("label", { className: "dsh-kb-switch", children: [
					h("input", {
						type: "checkbox",
						checked: s.projectEnabled === true,
						onChange: function (e) { props.onToggleProjectEnabled(e.target.checked); }
					}, "cb"),
					h("span", { children: s.projectEnabled === true ? "已开启（自动维护）" : "未开启" }, "t")
				] }, "sw")
			] }, "project"));
			kids.push(h("div", { className: "dsh-kb-field", children: [
				h("span", { className: "lbl", children: "更新间隔" }, "l"),
				h("input", {
					className: "dsh-kb-num",
					type: "number",
					min: 1,
					max: 200,
					value: st.turnsDraft === null || st.turnsDraft === undefined ? (s.turns || 6) : st.turnsDraft,
					onChange: function (e) { props.onTurnsDraft(e.target.value); },
					onKeyDown: function (e) { if (e.key === "Enter") props.onSaveTurns(); }
				}, "num"),
				h("span", { className: "dsh-kb-sub", children: "轮" }, "u"),
				h("button", { className: "dsh-kb-btn", onClick: props.onSaveTurns, children: "保存" }, "save")
			] }, "turns"));
			kids.push(h("div", { className: "dsh-kb-section", children: "存储位置" }, "sect"));
			kids.push(h("div", { className: "dsh-kb-field", children: [
				h("span", { className: "lbl", children: "知识库" }, "l"),
				h("input", {
					className: "dsh-kb-input",
					value: st.srcDraft,
					placeholder: st.pathInfo ? st.pathInfo.defaults.source : "默认",
					onChange: function (e) { props.onSrcDraft(e.target.value); }
				}, "i")
			] }, "src"));
			kids.push(h("div", { className: "dsh-kb-field", children: [
				h("span", { className: "lbl", children: "索引" }, "l"),
				h("input", {
					className: "dsh-kb-input",
					value: st.idxDraft,
					placeholder: st.pathInfo ? st.pathInfo.defaults.index : "默认",
					onChange: function (e) { props.onIdxDraft(e.target.value); }
				}, "i")
			] }, "idx"));
			kids.push(h("div", { className: "dsh-kb-field", children: [
				h("span", { className: "lbl" }, "l"),
				h("button", { className: "dsh-kb-btn primary", onClick: props.onSavePaths, children: "保存" }, "save"),
				h("button", { className: "dsh-kb-btn", onClick: props.onOpenDir, children: "打开记忆目录" }, "open")
			] }, "acts"));
			return h("div", { children: kids });
		}

		/* ---------- 面板本体 ---------- */
		var KB_WIDTH_KEY = "dsh-kb-panel.width.v2";
		function kbWidthLoad() {
			try {
				var w = parseInt(localStorage.getItem(KB_WIDTH_KEY), 10);
				if (w >= 380 && w <= 720) return w;
			} catch (e) { /* 忽略 */ }
			return 460;
		}
		function kbWidthSave(el) {
			try {
				var w = parseInt(el.style.width, 10);
				if (w >= 380 && w <= 720) localStorage.setItem(KB_WIDTH_KEY, String(w));
			} catch (e) { /* 忽略 */ }
		}
		function kbPanelRef(el) {
			if (!el) return;
			el.style.width = kbWidthLoad() + "px";
			if (el.__kbResizeWired) return;
			el.__kbResizeWired = true;
			var startX = 0, startW = 0;
			function onMove(e) {
				el.style.width = Math.min(720, Math.max(380, startW + (startX - e.clientX))) + "px";
			}
			function onUp() {
				document.removeEventListener("pointermove", onMove);
				document.removeEventListener("pointerup", onUp);
				kbWidthSave(el);
			}
			el.addEventListener("pointerdown", function (e) {
				var t = e.target;
				if (!t || !t.classList || !t.classList.contains("dsh-kb-resize")) return;
				e.preventDefault();
				startX = e.clientX;
				startW = el.getBoundingClientRect().width;
				document.addEventListener("pointermove", onMove);
				document.addEventListener("pointerup", onUp);
			});
		}

		function KbPanel(props) {
			var st = props.state;
			var view = st.view || "main";
			var head;
			if (view === "main") {
				// 标题旁的库名：优先当前会话；会话没挂载时退回记忆接口给的库名（否则面板头只剩"知识阁"）
				var curLib = (st.current && st.current.library)
					|| (st.memory && st.memory.window && st.memory.window.library)
					|| (st.memory && st.memory.project && st.memory.project.library)
					|| "";
				head = h("div", { className: "dsh-kb-header", children: [
					h("span", { className: "dsh-kb-header-icon", children: kbIcon(15) }, "icon"),
					h("div", { className: "dsh-kb-header-title", children: [
						"知识阁",
						curLib ? h("em", { title: (st.current && st.current.cwd) || "", children: " · " + curLib }, "sub") : null
					] }, "title"),
					h("button", { className: "dsh-kb-iconbtn", title: "设置", "aria-label": "设置", onClick: function () { props.onOpen("settings"); }, children: "⚙" }, "settings"),
					h("button", { className: "dsh-kb-iconbtn", title: "关闭", "aria-label": "关闭", onClick: props.onClose, children: "×" }, "close")
				] });
			} else {
				head = h("div", { className: "dsh-kb-header", children: [
					h("button", { className: "dsh-kb-iconbtn", title: "返回", "aria-label": "返回", onClick: props.onBack, children: "←" }, "back"),
					h("div", { className: "dsh-kb-header-title", children: "设置" }, "title"),
					h("button", { className: "dsh-kb-iconbtn", title: "关闭", "aria-label": "关闭", onClick: props.onClose, children: "×" }, "close")
				] });
			}
			var body = [];
			if (view === "main") {
				var tabDefs = [["search", "检索"], ["memory", "记忆"]];
				if (UI2) tabDefs.push(["files", "文件"]);
				body.push(h("div", { className: "dsh-kb-tabs", role: "tablist", "aria-label": "知识阁页签", children: tabDefs.map(function (t) {
					return h("button", {
						className: "dsh-kb-tab" + (st.tab === t[0] ? " on" : ""),
						role: "tab",
						"aria-selected": st.tab === t[0] ? "true" : "false",
						onClick: function () { props.onTab(t[0]); },
						children: t[1]
					}, t[0]);
				}) }, "tabs"));
			}
			var content;
			if (view === "settings") content = SettingsPane(props);
			else if (st.tab === "files" && UI2) content = FilesPane(props);
			else content = st.tab === "memory" ? MemoryPane(props) : SearchPane(props);
			body.push(h("div", { className: "dsh-kb-body", children: [
				content,
				st.error ? h("div", { className: "dsh-kb-error", role: "alert", children: st.error }, "err") : null,
				st.toast ? h("div", { className: "dsh-kb-toast", role: "status", "aria-live": "polite", children: st.toast }, "toast") : null
			] }, "body"));
			return h("div", { className: "dsh-kb-panel" + (props.light ? " dsh-kb-light" : "") + (UI2 ? " dsh-kb-v2" : ""), ref: kbPanelRef, role: "dialog", "aria-label": "知识阁", children: [
				h("div", { className: "dsh-kb-resize", title: "拖动调整宽度" }, "resize"),
				head,
				body
			] });
		}

		/* ---------- 槽内 / 设置行按钮 ---------- */
		function KbButton(props) {
			var wide = !!(props && props.wide);
			var anchorRef = React.useRef(null);
			var modeState = React.useState("unknown");
			var mode = modeState[0];
			var setMode = modeState[1];

			React.useEffect(function () {
				if (!wide) { removeDomButton(); return undefined; }
				if (mode === "inline") { removeDomButton(); return undefined; }
				var anchor = anchorRef.current;
				var probe = findPlacement(anchor);
				if (probe && isWideSettingsTrigger(probe.trigger)) {
					removeDomButton();
					setMode("inline");
					return undefined;
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
						// 探测失败必须回退 inline：否则 slot 里只留一个 display:none 的 span，入口按钮永久消失
						setMode(tries <= 10 ? "dom" : "inline");
					}
				}, 500);
				return function () {
					if (domTimer) { clearInterval(domTimer); domTimer = null; }
					removeDomButton();
				};
			}, [wide, mode]);

			if (wide && mode !== "inline") return h("span", { ref: anchorRef, style: { display: "none" } });
			return h("button", {
				className: "dsh-kb-button dsh-kb-button-anchor",
				"data-dsh-part": "entry",
				onClick: function () { if (typeof togglePanel === "function") togglePanel(); },
				title: "知识阁",
				"aria-label": "知识阁",
				style: { width: 36, height: 36, fontSize: 17 },
				children: kbIcon(17)
			});
		}

		/* ---------- 插件入口 ---------- */
		var inject = ["slots"];

		function apply(ctx) {
			try {
				if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") {
					console.warn("[dsh-kb] 当前版本无 slots API，面板未注入（安全降级）");
					return;
				}
				injectCss();

				var open = false;
				var container = null;
				var root = null;
				var disposed = false;
				var panelLight = false;
				var searchRef = { current: null };
				var toastTimer = null;
				var progressTimer = null;
				var memoryTimer = null;
				var onOtherPanelOpen = null;
				var cooldownTimer = null;

				var state = {
					view: "main",
					tab: "search",
					libsOpen: true,
					current: null,
					libraries: [],
					root: "",
					query: "",
					results: null,
					searchNote: "",
					searching: false,
					memory: null,
					memoryError: "",
					memoryAt: 0,
					memoryBusy: false,
					projectBusy: false,
					projectOpen: false,
					windowOpen: false,
					renameLib: "",
					renameDraft: "",
					memoryActs: false,
					showVersions: false,
					showDetails: false,
					expandedLib: "",
					pending: null,
					busyLib: "",
					turnsDraft: null,
					pathInfo: null,
					srcDraft: "",
					idxDraft: "",
					error: "",
					toast: ""
				};

				function showToast(text) {
					if (disposed) return;
					state.toast = text;
					if (toastTimer !== null) clearTimeout(toastTimer);
					toastTimer = setTimeout(function () {
						state.toast = "";
						toastTimer = null;
						render();
					}, 2200);
					render();
				}

				function fail(message) {
					if (disposed) return;
					state.error = String(message || "出错了");
					render();
				}

				/**
				 * 当前窗口的会话 id。
				 * 之前只认 `sessions.list.getSnapshot().current` 一个字段，取不到就返回空串；
				 * 宿主侧于是退化到"最近活动的会话"——面板就显示了别的窗口（REA）的记忆。
				 * 现在：快照里几种可能的字段都探一遍，再拿侧边栏选中行兜底；都拿不到就返回空串
				 * （宿主不再瞎猜，面板显示"未识别窗口"）。
				 */
				function snapshotSessionId(snap) {
					if (!snap || typeof snap !== "object") return "";
					var candidates = [snap.current, snap.currentId, snap.currentSessionId, snap.selected, snap.selectedId, snap.activeId];
					for (var i = 0; i < candidates.length; i++) {
						var v = candidates[i];
						if (typeof v === "string" && v) return v;
						if (v && typeof v === "object" && typeof v.id === "string" && v.id) return v.id;
					}
					var list = snap.items || snap.sessions || snap.list;
					if (Array.isArray(list)) {
						for (var j = 0; j < list.length; j++) {
							var item = list[j];
							if (item && item.selected === true && typeof item.id === "string") return item.id;
						}
					}
					return "";
				}

				/** 侧边栏里被选中的那一行（data-row-key="session:<id>"），作为快照取不到时的兜底。 */
				/** 会话 id 规范化：只认 `session-…` 的形状，别的都当没拿到。 */
				function normalizeSessionId(raw) {
					var id = typeof raw === "string" ? raw.trim() : "";
					if (!id) return "";
					if (id.indexOf("session:") === 0) id = id.slice("session:".length);
					return /^session-[0-9a-zA-Z-]{8,}$/.test(id) ? id : "";
				}

				/**
				 * 会话区挂着的 session id（`data-conversation-session`）。
				 * 这是最可靠的一条：侧栏收成 rail、会话行没渲染，它都还在。
				 */
				function mountedSessionId() {
					try {
						var el = document.querySelector("[data-conversation-session]");
						var id = el && normalizeSessionId(el.getAttribute("data-conversation-session"));
						if (id) return id;
						// 兜底：有些布局把 id 写在内容区的 data-session 上
						var alt = document.querySelector("[data-conversation-content][data-session], [data-session-id]");
						return alt ? normalizeSessionId(alt.getAttribute("data-session") || alt.getAttribute("data-session-id")) : "";
					} catch (e) {
						return "";
					}
				}

				/** 宿主持久化的"当前会话"（`dsh.sessions.current` = {"sessionId":"…"}）。 */
				function storedSessionId() {
					try {
						var raw = localStorage.getItem("dsh.sessions.current");
						if (!raw) return "";
						var parsed = JSON.parse(raw);
						return normalizeSessionId(parsed && (parsed.sessionId || parsed.id || parsed.current));
					} catch (e) {
						return "";
					}
				}

				function domSessionId() {
					try {
						var row = document.querySelector('[data-row-key^="session:session-"][aria-selected="true"]');
						if (!row) row = document.querySelector('[data-row-key^="session:"][aria-selected="true"]');
						if (!row) return "";
						return normalizeSessionId(row.getAttribute("data-row-key") || "");
					} catch (e) {
						return "";
					}
				}

				function currentSessionId() {
					// 1) 会话区正在显示的那个 id（与侧栏是否折叠无关）
					var mounted = mountedSessionId();
					if (mounted) return mounted;
					// 2) 侧边栏选中行
					var dom = domSessionId();
					if (dom) return dom;
					// 3) 宿主持久化的当前会话
					var stored = storedSessionId();
					if (stored) return stored;
					// 2) 控制器快照：{ ids, byId, phase, projectionsBySession }，只加载了一个会话时就是它
					try {
						var sessions = typeof ctx.get === "function" ? ctx.get("sessions") : void 0;
						var snap = sessions && sessions.list && typeof sessions.list.getSnapshot === "function" ? sessions.list.getSnapshot() : null;
						var fromSnapshot = snapshotSessionId(snap);
						if (fromSnapshot) return fromSnapshot;
						if (snap && Array.isArray(snap.ids) && snap.ids.length === 1 && typeof snap.ids[0] === "string") return snap.ids[0];
					} catch (e) { /* 拿不到就返回空串 */ }
					return "";
				}

				function sessionQuery(base) {
					var sid = currentSessionId();
					return base + (sid ? (base.indexOf("?") >= 0 ? "&" : "?") + "sessionId=" + encodeURIComponent(sid) : "");
				}

				/** 把一段命中原文追加到当前会话的输入框。 */
				async function insertIntoChat(r) {
					try {
						var sessionId = currentSessionId();
						if (!sessionId) { fail("没有当前会话"); return; }
						var sessions = typeof ctx.get === "function" ? ctx.get("sessions") : void 0;
						var conversation = typeof ctx.get === "function" ? ctx.get("conversation") : void 0;
						if (!conversation || !conversation.input || typeof conversation.input.for !== "function") {
							fail("当前版本没有输入框通道");
							return;
						}
						var actx = sessions && typeof sessions.scope === "function" ? sessions.scope(sessionId) : void 0;
						if (!actx) { fail("拿不到会话作用域"); return; }
						var shell = conversation.input.for(actx);
						if (!shell) { fail("输入框控制器不可用"); return; }
						var current = "";
						try {
							if (shell.state && typeof shell.state.getSnapshot === "function") {
								var snap = shell.state.getSnapshot();
								current = snap && typeof snap.draft === "string" ? snap.draft : "";
							}
						} catch (e) { /* 没有草稿就按空处理 */ }
						var label = "〔" + r.library + "/" + r.file + (r.heading ? " · " + r.heading : "") + (r.line ? " L" + r.line : "") + "〕";
						shell.setDraft(current + (current && !/\s$/.test(current) ? "\n\n" : "") + label + "\n" + r.text);
						showToast("已插入");
					} catch (err) {
						fail("插入失败：" + String(err && err.message ? err.message : err).slice(0, 80));
					}
				}

				async function copyResult(r) {
					var ok = await writeClipboard(r.text);
					showToast(ok ? "已复制" : "浏览器拒绝了剪贴板写入");
				}

				/* ---- 数据 ---- */
				function refresh() {
					return api(sessionQuery("/kb/api/status"))
						.then(function (data) {
							state.libraries = data.libraries || [];
							state.current = data.current || null;
							state.root = data.root || "";
							state.error = "";
						})
						.catch(function (e) { fail("读取状态失败：" + e.message); });
				}

				/** 记忆查询串：会话 id 优先；没有活动会话时带 library，面板仍能看项目记忆。 */
				function memoryQuery() {
					var parts = [];
					var sid = currentSessionId();
					if (sid) parts.push("sessionId=" + encodeURIComponent(sid));
					var lib = state.current && state.current.library;
					if (!lib) {
						// 没有活动窗口时退而求其次：唯一的"工作区"库，或唯一的库
						var all = state.libraries || [];
						var workspaces = all.filter(function (l) { return l.kind === "workspace"; });
						if (workspaces.length === 1) lib = workspaces[0].name;
						else if (all.length === 1) lib = all[0].name;
					}
					if (lib) parts.push("library=" + encodeURIComponent(lib));
					return "/kb/api/memory" + (parts.length ? "?" + parts.join("&") : "");
				}

				function refreshMemory() {
					return api(memoryQuery())
						.then(function (data) {
							state.memory = data;
							state.memoryAt = Date.now();
							state.memoryError = "";
							scheduleCooldownTick(data);
						})
						.catch(function (e) { state.memory = null; state.memoryError = "读取记忆失败：" + e.message; });
				}

				/** 冷却倒计时：快照里的 cooldownMs 不会自己变，用它起一个 1s 的局部重绘直到归零。 */
				function scheduleCooldownTick(data) {
					if (cooldownTimer !== null) { try { clearTimeout(cooldownTimer); } catch (e) { /* 忽略 */ } cooldownTimer = null; }
					var left = cooldownSecondsLeft(state.memory || data);
					if (left <= 0) return;
					cooldownTimer = setTimeout(function () {
						cooldownTimer = null;
						if (disposed) return;
						render();
						// 还在冷却就继续每秒重绘一次，直到归零
						if (cooldownSecondsLeft(state.memory || data) > 0) scheduleCooldownTick(state.memory || data);
					}, 1000);
				}

				/** 剩余冷却秒数（按"读到快照的时刻"折算，而不是冻结的 cooldownMs）。 */
				function cooldownSecondsLeft(mem) {
					var ms = Number(mem && mem.window && mem.window.cooldownMs) || 0;
					if (ms <= 0) return 0;
					var base = Number(state.memoryAt) || Date.now();
					return Math.max(0, Math.ceil((ms - (Date.now() - base)) / 1000));
				}

				function loadPaths() {
					return api("/kb/api/paths")
						.then(function (r) {
							if (!r || !r.ok) return;
							state.pathInfo = r;
							if (state.srcDraft === "") state.srcDraft = r.source.configured || "";
							if (state.idxDraft === "") state.idxDraft = r.index.configured || "";
						})
						.catch(function () { /* 没配置过就按默认 */ });
				}

				function startProgressPolling() {
					if (progressTimer !== null) return;
					progressTimer = setInterval(function () {
						if (disposed || !state.busyLib) {
							clearInterval(progressTimer);
							progressTimer = null;
							return;
						}
						refresh().then(function () { if (open) render(); });
					}, 800);
				}

				function startMemoryPolling() {
					if (memoryTimer !== null) return;
					memoryTimer = setInterval(function () {
						if (disposed || (!state.memoryBusy && !state.projectBusy)) {
							clearInterval(memoryTimer);
							memoryTimer = null;
							return;
						}
						refreshMemory().then(function () { if (open) render(); });
					}, 1500);
				}

				/* ---- 动作 ---- */
				var actions = {
					onClose: function () {
						open = false;
						if (container) container.style.display = "none";
					},
					onBack: function () {
						state.view = "main";
						state.pending = null;
						state.expandedLib = "";
						render();
					},
					onOpen: function (view) {
						state.view = view;
						state.pending = null;
						state.error = "";
						render();
						if (view === "settings") refreshMemory().then(function () { return loadPaths(); }).then(render);
					},
					onToggleLibs: function () {
						state.libsOpen = state.libsOpen === false;
						render();
					},
					onTab: function (id) {
						state.tab = id;
						state.error = "";
						render();
						if (id === "memory") refreshMemory().then(render);
					},
					onQuery: function (v) {
						state.query = v;
						state.error = "";
						render();
					},
					onSearch: function () {
						var q = String(state.query || "").trim();
						if (!q) return;
						// 竞态守卫：连按回车时只保留最新一次请求的结果
						if (state.searching) return;
						state.searching = true;
						state.error = "";
						var seq = (state.searchSeq = (state.searchSeq || 0) + 1);
						render();
						api("/kb/api/search", { query: q, topK: 6, sessionId: currentSessionId() })
							.then(function (data) {
								if (seq !== state.searchSeq) return;
								state.results = Array.isArray(data.results) ? data.results : [];
								state.searchNote = data && data.matched === false ? (data.note || "没有找到相关内容") : "";
								state.libsOpen = false; // 有结果时先看结果，库列表收成一行标题
								if (!data.ok) fail(data.error || "搜索失败");
							})
							.catch(function (e) {
								if (seq === state.searchSeq) fail("搜索失败：" + e.message);
							})
							.finally(function () {
								if (seq !== state.searchSeq) return;
								state.searching = false;
								render();
							});
					},
					onCopy: function (r) { copyResult(r); },
					onInsert: function (r) { insertIntoChat(r); },
					onToggleLib: function (name) {
						state.expandedLib = state.expandedLib === name ? "" : name;
						state.pending = null;
						render();
					},
					onAskRebuild: function (name) {
						state.pending = { kind: "rebuild", name: name };
						render();
					},
					onStartRename: function (name) {
						state.renameLib = name;
						state.renameDraft = name;
						state.pending = null;
						render();
					},
					onRenameDraft: function (value) {
						state.renameDraft = value;
						render();
					},
					onConfirmRename: function () {
						var from = state.renameLib;
						var to = String(state.renameDraft || "").trim();
						if (!from) return;
						if (!to) { fail("库名不能为空"); return; }
						api("/kb/api/library/rename", { from: from, to: to })
							.then(function (r) {
								if (r && r.ok) {
									state.renameLib = "";
									state.renameDraft = "";
									showToast("已改名：" + from + " → " + r.to);
									return refresh().then(function () { return refreshMemory(); }).then(render);
								}
								fail((r && r.error) || "改名失败");
							})
							.catch(function (e) { fail("改名失败：" + e.message); });
					},
					onAskDelete: function (name) {
						state.pending = { kind: "delete", name: name };
						render();
					},
					onConfirmDelete: function () {
						var name = state.pending && state.pending.name;
						if (!name) return;
						state.pending = null;
						state.error = "";
						// 带上 sessionId：宿主用"当前窗口的工作区库"做删除保护
						api("/kb/api/library/delete", { name: name, sessionId: currentSessionId() })
							.then(function (r) {
								if (r && r.ok) {
									showToast("已移入回收站：" + name);
									state.expandedLib = "";
									return refresh().then(function () { return refreshMemory(); }).then(render);
								}
								fail((r && r.error) || "删除失败");
							})
							.catch(function (e) { fail("删除失败：" + e.message); });
					},
					onCancelPending: function () {
						state.pending = null;
						state.renameLib = "";
						state.renameDraft = "";
						render();
					},
					onConfirmRebuild: function () {
						var name = state.pending && state.pending.name;
						if (!name) return;
						state.pending = null;
						state.busyLib = name;
						state.error = "";
						render();
						startProgressPolling();
						// 重建大库可能远超默认 120s：客户端先给 10 分钟，别再"面板报失败、宿主还在算钱"。
					api("/kb/api/rebuild", { library: name }, { timeoutMs: 600000 })
							.then(function (data) {
								var bad = (data.outcomes || []).filter(function (o) { return !o.ok; })[0];
								if (!data.ok && bad) fail(bad.error || "重建失败");
								else {
									var hit = (data.outcomes || [])[0];
									showToast(hit ? "已重建：" + hit.chunks + " 块（新算 " + hit.embedded + "）" : "已重建");
								}
								return refresh();
							})
							.catch(function (e) { fail("重建失败：" + e.message); })
							.finally(function () { state.busyLib = ""; render(); });
					},
					onRevealLib: function (name) {
						api("/kb/api/memory/reveal", { library: name })
							.then(function (r) { showToast(r && r.ok ? "已打开目录" : (r && r.error) || "打开失败"); })
							.catch(function (e) { fail("打开失败：" + e.message); });
					},
					onOpenDir: function () {
						api("/kb/api/memory/reveal", { sessionId: currentSessionId() })
							.then(function (r) { showToast(r && r.ok ? "已打开目录" : (r && r.error) || "打开失败"); })
							.catch(function (e) { fail("打开失败：" + e.message); });
					},
					onRefreshMemory: function () { refreshMemory().then(render); },
					onUpdateMemory: function () {
						if (state.memoryBusy) return;
						state.memoryBusy = true;
						state.error = "";
						render();
						startMemoryPolling();
						api("/kb/api/memory/update", { sessionId: currentSessionId(), scope: "session" })
							.then(function (data) {
								if (data.ok) showToast(data.changed ? "本窗口记忆已重写（" + (data.diffText || "") + "）" : "没有实质变化");
								else fail(data.error || "记忆更新失败");
							})
							.catch(function (e) { fail("记忆更新失败：" + e.message); })
							.finally(function () {
								state.memoryBusy = false;
								refreshMemory().then(function () { return refresh(); }).then(render);
							});
					},
					onProjectUpdate: function () {
						if (state.projectBusy) return;
						state.projectBusy = true;
						state.error = "";
						render();
						startMemoryPolling();
						api("/kb/api/memory/update", { sessionId: currentSessionId(), scope: "project" })
							.then(function (data) {
								if (data.ok) showToast(data.changed ? "项目记忆已重写（" + (data.diffText || "") + "）" : "没有实质变化");
								else fail(data.error || "项目记忆更新失败");
							})
							.catch(function (e) { fail("项目记忆更新失败：" + e.message); })
							.finally(function () {
								state.projectBusy = false;
								refreshMemory().then(render);
							});
					},
					onToggleWindow: function () {
						state.windowOpen = !state.windowOpen;
						render();
					},
					onToggleProject: function () {
						state.projectOpen = !state.projectOpen;
						state.pending = null;
						render();
					},
					/** 项目记忆总开关：用户手动开启/关闭；开启后按轮次自动维护（正文仍不注入） */
					onToggleProjectEnabled: function (enabled) {
						api("/kb/api/memory/settings", { projectEnabled: enabled === true })
							.then(function (data) {
								if (!data.ok) fail(data.error || "设置失败");
								else showToast(enabled ? "已开启项目记忆（之后自动维护）" : "已关闭项目记忆（不再自动维护）");
							})
							.catch(function (e) { fail("设置失败：" + e.message); })
							.finally(function () { refreshMemory().then(render); });
					},
					/** 点文件行：用系统默认程序打开（宿主侧校验路径） */
					onOpenFile: function (file, library) {
						if (!file || !library) return;
						api("/kb/api/file/open", { library: library, name: file.name, kind: file.kind })
							.then(function (r) {
								if (r && r.ok) showToast("已打开：" + file.name);
								else fail((r && r.error) || "打开失败");
							})
							.catch(function (e) { fail("打开失败：" + e.message); });
					},
					onToggleMemoryActs: function () {
						state.memoryActs = !state.memoryActs;
						if (!state.memoryActs) { state.showVersions = false; state.showDetails = false; state.pending = null; }
						render();
					},
					onToggleVersions: function () {
						state.showVersions = !state.showVersions;
						state.pending = null;
						render();
					},
					onToggleDetails: function () {
						state.showDetails = !state.showDetails;
						render();
					},
					onAskRollback: function (scope, slot) {
						state.pending = { kind: "rollback", scope: scope === "project" ? "project" : "session", slot: slot };
						render();
					},
					onConfirmRollback: function () {
						var pending = state.pending;
						if (!pending || !pending.slot) return;
						state.pending = null;
						state.error = "";
						api("/kb/api/memory/rollback", { slot: pending.slot, scope: pending.scope, sessionId: currentSessionId() })
							.then(function (data) {
								if (data.ok) showToast("已回退到 v" + pending.slot);
								else fail(data.error || "回退失败");
							})
							.catch(function (e) { fail("回退失败：" + e.message); })
							.finally(function () { refreshMemory().then(function () { return refresh(); }).then(render); });
					},
					onRevealScope: function (scope) {
						api("/kb/api/memory/reveal", { sessionId: currentSessionId(), scope: scope === "project" ? "project" : "session" })
							.then(function (r) { showToast(r && r.ok ? "已打开目录" : (r && r.error) || "打开失败"); })
							.catch(function (e) { fail("打开失败：" + e.message); });
					},
					onCopyPath: function () {
						var path = state.memory && state.memory.window && state.memory.window.path;
						if (!path) return;
						writeClipboard(path).then(function (ok) { showToast(ok ? "已复制路径" : "剪切板不可用"); });
					},
					onToggleAuto: function (enabled) {
						api("/kb/api/memory/settings", { enabled: enabled })
							.then(function (data) {
								if (!data.ok) fail(data.error || "设置失败");
								else showToast(enabled ? "自动更新已开启" : "自动更新已关闭");
							})
							.catch(function (e) { fail("设置失败：" + e.message); })
							.finally(function () { refreshMemory().then(render); });
					},
					onTurnsDraft: function (value) {
						state.turnsDraft = value;
						render();
					},
					onSaveTurns: function () {
						var turns = Number(state.turnsDraft);
						if (!Number.isFinite(turns) || turns < 1 || turns > 200) {
							fail("轮数需为 1~200");
							return;
						}
						api("/kb/api/memory/settings", { turns: Math.floor(turns) })
							.then(function (data) {
								if (!data.ok) fail(data.error || "设置失败");
								else {
									state.turnsDraft = null;
									showToast("已改为每 " + Math.floor(turns) + " 轮");
								}
							})
							.catch(function (e) { fail("设置失败：" + e.message); })
							.finally(function () { refreshMemory().then(render); });
					},
					onSrcDraft: function (v) { state.srcDraft = v; render(); },
					onIdxDraft: function (v) { state.idxDraft = v; render(); },
					onSavePaths: function () {
						api("/kb/api/paths", { source: state.srcDraft, index: state.idxDraft })
							.then(function (r) {
								if (r && r.ok) {
									state.pathInfo = r;
									state.error = "";
									showToast("已保存");
									return refresh();
								}
								fail((r && r.error) || "保存失败");
							})
							.catch(function (e) { fail("保存失败：" + e.message); });
					}
				};

				function render() {
					if (disposed || !root) return;
					root.render(h(KbPanel, Object.assign({ state: state, light: panelLight }, actions)));
				}

				function ensurePanel() {
					injectCss();
					if (container === null) {
						container = document.createElement("div");
						container.dataset.dshPlugin = "dsh-kb";
						document.body.appendChild(container);
						root = react_dom_client.createRoot(container);
					}
					if (open) panelLight = pageIsLight();
					container.style.display = open ? "" : "none";
					if (open) {
						// 每次打开都回到「检索」首页：不留上次的页签 / 子页 / 展开态，
						// 否则会出现"一点开就停在记忆页"这种莫名其妙的落点。
						state.view = "main";
						state.tab = "search";
						state.libsOpen = true;
						state.pending = null;
						state.expandedLib = "";
						state.memoryActs = false;
						state.showVersions = false;
						state.showDetails = false;
						state.projectOpen = false;
						state.windowOpen = false;
						state.renameLib = "";
						state.renameDraft = "";
						state.error = "";
						refresh().then(function () {
							return state.tab === "memory" || state.view !== "main" ? refreshMemory() : null;
						}).then(function () {
							return state.view === "settings" ? loadPaths() : null;
						}).then(function () {
							render();
							try {
								if (state.view === "main" && state.tab === "search" && searchRef.current) searchRef.current.focus();
							} catch (e) { /* 焦点失败无所谓 */ }
						});
					}
					render();
				}

				// Esc 关闭面板（键盘兜底，避免只能靠点 ×）
				// 改名输入框/确认条会在自己的 onKeyDown 里 stopPropagation，所以这里不会被连带触发
				function onKeyDown(e) {
					if (!open) return;
					if (e && (e.key === "Escape" || e.key === "Esc")) {
						if (e.defaultPrevented) return;
						open = false;
						if (container) container.style.display = "none";
					}
				}
				try { document.addEventListener("keydown", onKeyDown); } catch (e) { /* 忽略 */ }

				try {
					onOtherPanelOpen = function (e) {
						if (!open || !e || !e.detail || e.detail === "kb") return;
						open = false;
						if (container) container.style.display = "none";
					};
					window.addEventListener("dsh-panel-open", onOtherPanelOpen);
				} catch (e) { /* 忽略 */ }

				togglePanel = function () {
					if (!open) {
						try { window.dispatchEvent(new CustomEvent("dsh-panel-open", { detail: "kb" })); } catch (e) { /* 忽略 */ }
					}
					open = !open;
					ensurePanel();
				};

				ctx.slots.inject("sidebar.footer.action", function () {
					return ctx.slots.register(
						{ name: "sidebar.footer.action", id: "kb", order: 41, label: "知识阁" },
						KbButton
					);
				});

				try {
					if (typeof ctx.on === "function") {
						ctx.on("dispose", function () {
							disposed = true;
							try { document.removeEventListener("keydown", onKeyDown); } catch (e) { /* 忽略 */ }
							try { if (onOtherPanelOpen) window.removeEventListener("dsh-panel-open", onOtherPanelOpen); } catch (e) { /* 忽略 */ }
							if (toastTimer !== null) { try { clearTimeout(toastTimer); } catch (e) { /* 忽略 */ } toastTimer = null; }
							if (progressTimer !== null) { try { clearInterval(progressTimer); } catch (e) { /* 忽略 */ } progressTimer = null; }
							if (memoryTimer !== null) { try { clearInterval(memoryTimer); } catch (e) { /* 忽略 */ } memoryTimer = null; }
							if (cooldownTimer !== null) { try { clearTimeout(cooldownTimer); } catch (e) { /* 忽略 */ } cooldownTimer = null; }
							try { removeDomButton(); } catch (e) { /* 忽略 */ }
							try { if (root) root.unmount(); } catch (e) { /* 忽略 */ }
							try { if (container && container.parentNode) container.parentNode.removeChild(container); } catch (e) { /* 忽略 */ }
							root = null;
							container = null;
							try { delete window.__kbPanelDebug; } catch (e) { /* 忽略 */ }
						});
					}
				} catch (e) { /* 忽略 */ }

				// 调试辅助：__kbPanelDebug() 看状态，__kbPanelDebug().ui 驱动同一段代码。
				try {
					window.__kbPanelDebug = function () {
						return {
							state: state,
							open: open,
							ui: {
								open: function () { if (!open) togglePanel(); return open; },
								close: actions.onClose,
								view: function (v) { actions.onOpen(v); return v; },
								back: actions.onBack,
								tab: function (id) { actions.onTab(id); return id; },
								search: function (q) {
									state.query = q;
									actions.onSearch();
									return true;
								},
								libs: actions.onToggleLibs,
								lib: actions.onToggleLib,
								askRebuild: actions.onAskRebuild,
								confirmRebuild: actions.onConfirmRebuild,
								cancel: actions.onCancelPending,
								memoryActs: actions.onToggleMemoryActs,
								versions: actions.onToggleVersions,
								details: actions.onToggleDetails,
								askRollback: actions.onAskRollback,
								confirmRollback: actions.onConfirmRollback,
								updateMemory: actions.onUpdateMemory,
								win: actions.onToggleWindow,
								project: actions.onToggleProject,
								projectUpdate: actions.onProjectUpdate,
								projectEnabled: actions.onToggleProjectEnabled,
								rename: actions.onStartRename,
								renameDraft: actions.onRenameDraft,
								confirmRename: actions.onConfirmRename,
								askDelete: actions.onAskDelete,
								confirmDelete: actions.onConfirmDelete,
								toggleAuto: actions.onToggleAuto,
								saveTurns: actions.onSaveTurns,
								turnsDraft: actions.onTurnsDraft,
								srcDraft: actions.onSrcDraft,
								idxDraft: actions.onIdxDraft,
								savePaths: actions.onSavePaths,
								reveal: actions.onRevealScope,
								revealLib: actions.onRevealLib,
								refresh: function () { return refresh().then(function () { render(); return state; }); },
								memory: function () { return refreshMemory().then(function () { render(); return state.memory; }); },
								probeSession: function () {
									var out = { url: location.href, hasSessions: false, fromSnapshot: "", fromDom: domSessionId(), snapshot: null };
									try {
										var sessions = ctx.get("sessions");
										out.hasSessions = !!sessions;
										var snap = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
										out.fromSnapshot = snapshotSessionId(snap);
										out.snapshot = snap
											? JSON.parse(JSON.stringify(snap, function (k, v) {
													if (Array.isArray(v) && v.length > 4) return ["…" + v.length + " 项"];
													if (k === "events" || k === "messages" || k === "content") return "[…]";
													return v;
												}))
											: null;
									} catch (e) {
										out.error = String((e && e.message) || e);
									}
									return out;
								}
							}
						};
					};
				} catch (e) { /* 忽略 */ }
			} catch (err) {
				console.warn("[dsh-kb] 注入失败，已安全降级：", err);
			}
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
