/**
 * dsh-tree-panel 的 client 半（浏览器侧）。
 *
 * 手写 bundle，遵守 DSH 客户端插件装载协议：
 * window.__ModuleLoader__.load({ id, factory }) —— id 必须等于包名，
 * factory 返回的模块导出 { apply, inject }（与官方 client 插件一致）。
 *
 * 模块表红线：只 require("react") / ("react/jsx-runtime") / ("react-dom/client")
 * 这三个平台种子词。本文件**不 require 任何 @deepseek-ai/* 模块**，
 * 因此 package.json 的 dsh.client.client.inject 保持为空。
 *
 * ============================ 本轮的形态 ============================
 * 第四轮把面板从"会话级列表"重构成"轮次级枝干图"（git 提交图式）：
 *   - 所有会话折成一张合并图：父子两侧共享的历史轮次只画一个节点（主干）；
 *   - 每个分叉从"分歧轮次"处分出一条轨道（lane = 树深度，父轨道在左）；
 *   - 轨道用 SVG 画（竖线 + 圆角拐弯），节点卡片是绝对定位的 HTML；
 *   - 点节点 = 打开该会话并滚动定位到该轮；右键节点 = 分叉/打开/复制 id；
 *   - 子代理（origin==="subagent"）不进图，折叠为父节点下的"+N 子任务"汇总节点。
 *
 * 数据底座（都在 dev profile 真机实测过，见 TASK.md 第四轮记录）：
 *   1) 每会话轮次表：projectionValues.turnOutline = [{ turn, seq, prompt, response }]
 *      —— 后两个字段是本轮实测到的：**逐轮的用户输入与回复摘要**就在列表快照里，
 *      不需要注入任何模块、也不需要解析 DOM。
 *   2) 分叉边：列表行的 parentId（会话文件头里叫 parentSession）。
 *   3) 分歧点检测（免锚点）：fork 是把父会话前 N 轮**整轮**复制给子会话
 *      （实测 atSeq=449 时子会话拿到 turns 1..3，seq 6/71/449，与父完全一致），
 *      所以"父子按轮号对齐后第一个 seq 不一致（或子会话没有）的轮次"
 *      就是子会话的第一轮自有轮次，再往前一轮即分叉点。
 *      优先级：已记录 call 锚点 > seq 对齐推算 > 子会话起点（父已删）。
 *
 * 安全底线：所有 DOM 注入包 try/catch 静默降级；不请求任何 /api 路由；
 * 不写共享 .dsh 存储（布局、锚点、标记、图状态只进 localStorage）。
 */
window.__ModuleLoader__.load({
	id: "dsh-tree-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var react_jsx_runtime = require("react/jsx-runtime");
		var react_dom_client = require("react-dom/client");

		/* ---------- 常量与持久化 ---------- */
		/** 构建号：同时出现在按钮 tooltip、首次点击回执和失败提示里，用来确认"浏览器里跑的是哪一版"。 */
		var BUILD_TAG = "v15";
		var LS_KEY = "dsh-tree-panel.layout.v1";
		var LS_FORKS = "dsh-tree-panel.forks.v1";
		/** MARK-6：标星/归档标记表 { [sessionId]: { star?: true, archive?: true, time } }。 */
		var LS_MARKS = "dsh-tree-panel.marks.v1";
		/** 第四轮：图状态（展开了哪些分支的折叠轮次 / 子任务组 / 空会话组）。 */
		var LS_GRAPH = "dsh-tree-panel.graph.v1";
		/** open：面板是否展开（刷新后保持布局，含开合状态）。 */
		var DEFAULT_LAYOUT = { width: 420, right: 12, top: 64, order: [], open: false };
		/** UI 锚点提示的有效期：超时就不再认它，避免关联到过期的分叉点。 */
		var FORK_CAPTURE_TTL_MS = 60000;

		/* ---- 图形几何（视口虚拟化依赖"行高固定"这一点） ---- */
		var ROW_H = 96;
		var LANE_W = 20;
		var LANE_PAD = 8;
		var CARD_GAP = 6;
		/** 每个分支默认只展开最近 N 轮，其余折叠成"⋯ N 轮已折叠"节点。 */
		var TAIL_TURNS = 3;
		/** 视口外多渲染几行（滚动时不闪白）。 */
		var OVERSCAN = 6;

		/**
		 * v2 视觉开关：`?ui=v2`（与 kb 用同一个开关名，方便一次对比）。
		 * 只影响外观与缩略图，图结构/数据/交互都不变；旧外观仍是默认。
		 */
		var UI2 = (function () {
			try {
				var q = String(window.location.search || "");
				// 2026-10-24 起默认就是 v2；要对比旧外观：?ui=v1（或 ?treeui=v1）。
				if (/(?:^|[?&])(?:ui|treeui)=v1(?:&|$)/.test(q)) return false;
				return true;
			} catch (e) {
				return true;
			}
		})();
		/* 「设置」行内四颗按钮的横向偏移（各自插件内写死，互不引用）：
		   备份 = 0、监视 = +30、分支图 = +60、知识库 = +90；CSS right 越大越靠左，
		   所以数值越大越靠左一格。按钮 28px 宽、步进 30px，相邻留 2px 间隙。
		   DOM_ROW_BASE 是四颗共用的基准归一化量：实测 round(inset - rightGap) = -2
		   （侧栏内边距 12px，而「设置」触发器左右各外溢 2px），不补这 2px 的话
		   偏移 0 的那颗会被 Math.max(0,…) 夹到 0，步进退化成 28px，
		   四颗的间隙就会变成 2/2/0 一大一小。 */
		var DOM_BUTTON_OFFSET = 60;
		var DOM_ROW_BASE = 2;
		/** 轨道配色：按 lane 序号取，深浅区分主干与分叉。 */
		var LANE_COLORS = [
			"rgba(150,175,215,.85)",
			"rgba(126,196,255,.85)",
			"rgba(255,196,120,.85)",
			"rgba(160,225,160,.85)",
			"rgba(220,160,235,.85)",
			"rgba(240,160,170,.85)",
			"rgba(180,180,250,.85)",
			"rgba(130,225,215,.85)"
		];

		function loadLayout() {
			try {
				var raw = localStorage.getItem(LS_KEY);
				if (!raw) return Object.assign({}, DEFAULT_LAYOUT);
				var parsed = JSON.parse(raw);
								var layout = Object.assign({}, DEFAULT_LAYOUT, parsed);
				if (parsed && parsed.width === 380 && DEFAULT_LAYOUT.width !== 380) {
					layout.width = DEFAULT_LAYOUT.width;
					try { localStorage.setItem(LS_KEY, JSON.stringify(layout)); } catch (e) {}
				}
				return layout;
			} catch {
				return Object.assign({}, DEFAULT_LAYOUT);
			}
		}
		function saveLayout(layout) {
			try {
				localStorage.setItem(LS_KEY, JSON.stringify(layout));
			} catch {}
		}

		/**
		 * 分叉锚点表：{ [childId]: { parentId, atSeq, parentTitle, time, source } }。
		 * fork API 不持久化分叉点 seq，所以由本插件在 fork 发生时抓一次存这里。
		 * source 记录锚点来源：
		 *   "call"    fork 调用方自己给的 atSeq（右键"从此轮分叉"走这条，**真分叉点**）；
		 *   "ui"      界面上的锚点提示（当前无公开接口可读，仅保留捕获点）；
		 *   "derived" fork 那一刻父会话的末尾 seq（推定值）。
		 */
		function loadForks() {
			try {
				var raw = localStorage.getItem(LS_FORKS);
				if (!raw) return {};
				var parsed = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
				var out = {};
				for (var key of Object.keys(parsed)) {
					var row = parsed[key];
					if (!row || typeof row !== "object") continue;
					if (row.atSeq !== null && row.atSeq !== void 0 && !Number.isFinite(row.atSeq)) continue;
					out[key] = {
						parentId: typeof row.parentId === "string" ? row.parentId : void 0,
						atSeq: Number.isFinite(row.atSeq) ? row.atSeq : null,
						parentTitle: typeof row.parentTitle === "string" ? row.parentTitle : "",
						time: Number.isFinite(row.time) ? row.time : 0,
						source: typeof row.source === "string" ? row.source : "unknown"
					};
				}
				return out;
			} catch {
				return {};
			}
		}
		function saveForks(table) {
			try {
				localStorage.setItem(LS_FORKS, JSON.stringify(table));
			} catch {}
		}
		var forks = loadForks();
		function recordFork(childId, entry) {
			if (typeof childId !== "string" || childId === "") return;
			if (!entry || typeof entry !== "object") return;
			try {
				var prev = forks[childId] || {};
				forks[childId] = {
					parentId: entry.parentId !== void 0 && entry.parentId !== null ? entry.parentId : prev.parentId,
					atSeq: entry.atSeq !== void 0 ? entry.atSeq : prev.atSeq,
					parentTitle: entry.parentTitle !== void 0 && entry.parentTitle !== "" ? entry.parentTitle : prev.parentTitle || "",
					time: entry.time !== void 0 ? entry.time : prev.time || Date.now(),
					source: entry.source !== void 0 ? entry.source : prev.source || "unknown"
				};
				saveForks(forks);
			} catch {}
		}

		/* ---------- MARK-6：标星 / 归档标记 ---------- */
		function loadMarks() {
			try {
				var raw = localStorage.getItem(LS_MARKS);
				if (!raw) return {};
				var parsed = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
				var out = {};
				for (var key of Object.keys(parsed)) {
					var row = parsed[key];
					if (!row || typeof row !== "object") continue;
					var star = row.star === true;
					var archive = row.archive === true;
					if (!star && !archive) continue; // 空标记不值得留
					out[key] = { star: star, archive: archive, time: Number.isFinite(row.time) ? row.time : 0 };
				}
				return out;
			} catch {
				return {};
			}
		}
		function saveMarks(table) {
			try {
				localStorage.setItem(LS_MARKS, JSON.stringify(table));
			} catch {}
		}
		var marks = loadMarks();
		function toggleMark(id, field) {
			try {
				if (typeof id !== "string" || id === "" || (field !== "star" && field !== "archive")) return false;
				var prev = marks[id] || {};
				var next = { star: prev.star === true, archive: prev.archive === true };
				next[field] = !next[field];
				if (!next.star && !next.archive) delete marks[id];
				else marks[id] = { star: next.star, archive: next.archive, time: Date.now() };
				saveMarks(marks);
				return next[field];
			} catch {
				return false;
			}
		}
		function marksOf(id) {
			var row = marks[id];
			return { star: row !== void 0 && row.star === true, archive: row !== void 0 && row.archive === true };
		}
		/** 短码：取 uuid 后 8 位（避免和 id 前缀 session- 混淆），拿不到就退原串。 */
		function shortCode(id) {
			if (typeof id !== "string" || id === "") return "未知";
			var tail = id.replace(/^session-/, "").replace(/-/g, "");
			return tail.length > 8 ? tail.slice(-8) : tail || id;
		}

		/* ---------- 图状态：展开了哪些分支 / 子任务组 / 空会话组 ---------- */
		function loadGraphState() {
			try {
				var raw = localStorage.getItem(LS_GRAPH);
				if (!raw) return { branches: [], subs: [], empty: false };
				var parsed = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object") return { branches: [], subs: [], empty: false };
				return {
					branches: Array.isArray(parsed.branches) ? parsed.branches.filter(function (x) { return typeof x === "string"; }) : [],
					subs: Array.isArray(parsed.subs) ? parsed.subs.filter(function (x) { return typeof x === "string"; }) : [],
					empty: parsed.empty === true
				};
			} catch {
				return { branches: [], subs: [], empty: false };
			}
		}
		function saveGraphState(state) {
			try {
				localStorage.setItem(
					LS_GRAPH,
					JSON.stringify({
						branches: [...state.expandedBranches],
						subs: [...state.expandedSubs],
						empty: state.expandedEmpty === true
					})
				);
			} catch {}
		}

		/* ---------- 样式（data-plugin-css 模式，随插件装载注入） ----------
		   设计基线（对齐官方设置页的观感）：
		     · 间距只用 4 / 8 / 12 / 16 / 24（8px 栅格）
		     · 圆角：卡片 10px、控件（按钮 / 输入框）8px、胶囊徽标 999px
		     · 边框统一 1px：暗色 rgba(255,255,255,.10)、亮色 rgba(0,0,0,.10)
		     · 颜色与背景的悬停 / 按下 / 聚焦一律 transition 150ms ease
		     · 字号：主标题 13px/600、元信息 11px + 60% 不透明度、徽标统一胶囊
		   配色写**两套显式值**：暗色为默认，亮色由 .dsh-tp-light 覆盖；
		   面板内部不引用任何应用主题变量（变量缺失会让文字与背景同色隐形）。
		   唯一例外是面板外的按钮外壳 .dsh-tree-btn —— 它沿用 var(--dsw-alias-…)，
		   与备份 / 监视两颗按钮完全同款，四颗一排才统一。 ---------- */
		var CSS = [
			".dsh-tree-panel-overlay,.dsh-tree-tip,.dsh-tree-mini,.dsh-tree-menu{--tp-fg:var(--dsw-alias-label-primary,#e8eaed);--tp-fg2:var(--dsw-alias-label-secondary,#98a0ab);--tp-bg:var(--dsw-alias-bg-layer-1,#1f2329);--tp-pop:var(--dsw-alias-bg-overlay,#23272e);--tp-line:var(--dsw-alias-border-l1,rgba(255,255,255,.10));--tp-line2:var(--dsw-alias-border-l2,rgba(255,255,255,.18));--tp-accent:var(--dsw-alias-brand-primary,#7aa2f0);--tp-hover:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));--tp-tint:color-mix(in srgb,var(--dsw-alias-label-primary,#e8eaed) 5%,transparent);--tp-tint2:color-mix(in srgb,var(--dsw-alias-label-primary,#e8eaed) 9%,transparent);--tp-accent-tint:color-mix(in srgb,var(--tp-accent) 15%,transparent);--tp-ok:var(--dsw-alias-state-success-primary,#3fa564);--tp-warn:var(--dsw-alias-state-warn-primary,#c98a00);--tp-err:var(--dsw-alias-state-error-primary,#c93a30);}",
			".dsh-tree-panel-overlay{position:fixed;top:64px;right:12px;width:420px;max-height:calc(100vh - 96px);z-index:9999;box-sizing:border-box;display:flex;flex-direction:column;font-size:13px;user-select:none;background:var(--tp-bg);color:var(--tp-fg);border:1px solid var(--tp-line);border-radius:16px;box-shadow:0 20px 56px rgba(0,0,0,.42);animation:dsh-tree-panel-in 150ms ease;overflow:hidden}",
			"@keyframes dsh-tree-panel-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}",
			".dsh-tree-panel-header{display:flex;align-items:center;gap:4px;padding:8px 8px 6px 12px;cursor:move;border:0;background:transparent}",
			".dsh-tree-panel-title{flex:1;min-width:0;display:flex;align-items:baseline;gap:8px;font-size:12.5px;font-weight:600;letter-spacing:.01em;overflow:hidden;white-space:nowrap}",
			".dsh-tree-panel-count{color:var(--tp-fg2);font-size:10.5px;font-weight:400;overflow:hidden;text-overflow:ellipsis;opacity:.9}",
			".dsh-tree-panel-close,.dsh-tree-panel-iconbtn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--tp-fg2);font-size:13px;line-height:1;cursor:pointer;transition:background 140ms ease,color 140ms ease}",
			".dsh-tree-panel-close{font-size:16px}",
			".dsh-tree-panel-close:hover,.dsh-tree-panel-iconbtn:hover{background:var(--tp-hover);color:var(--tp-fg)}",
			".dsh-tree-goal{display:flex;align-items:center;gap:6px;padding:0 12px 6px;border:0;font-size:10.5px;line-height:1.4;min-width:0;color:var(--tp-fg2)}",
			".dsh-tree-goal-label{flex:none;opacity:.75}",
			".dsh-tree-goal-phase{flex:none;padding:0 5px;height:15px;line-height:14px;font-size:9.5px;border:1px solid var(--tp-line);border-radius:999px;color:var(--tp-fg2)}",
			".dsh-tree-goal-phase.active{color:var(--tp-ok);border-color:color-mix(in srgb,var(--tp-ok) 45%,transparent)}",
			".dsh-tree-goal-phase.paused{color:var(--tp-warn);border-color:color-mix(in srgb,var(--tp-warn) 45%,transparent)}",
			".dsh-tree-goal-phase.blocked{color:var(--tp-err);border-color:color-mix(in srgb,var(--tp-err) 45%,transparent)}",
			".dsh-tree-goal-phase.complete{color:var(--tp-accent);border-color:color-mix(in srgb,var(--tp-accent) 45%,transparent)}",
			".dsh-tree-goal-text{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tp-fg);opacity:.7}",
			".dsh-tree-tabs{display:flex;gap:2px;align-items:center;margin:0 12px 6px;padding:2px;border-radius:8px;background:var(--tp-tint);border:0;font-size:11px}",
			".dsh-tree-tabs .spacer{flex:0 0 4px}",
			".dsh-tree-tab{flex:1;text-align:center;cursor:pointer;border:0;border-radius:6px;background:transparent;color:var(--tp-fg2);padding:5px 8px;font-size:11.5px;line-height:1.35;font-weight:500;white-space:nowrap;transition:background 130ms ease,color 130ms ease}",
			".dsh-tree-tab:hover{color:var(--tp-fg);background:var(--tp-tint2)}",
			".dsh-tree-tab.on{background:var(--tp-accent);color:#fff;font-weight:600}",
			".dsh-tree-tab.ghost{flex:none;padding:4px 6px;color:var(--tp-fg2)}",
			".dsh-tree-tab.ghost:hover{background:var(--tp-tint2);color:var(--tp-fg)}",
			".dsh-tree-toolbar{display:flex;gap:8px;align-items:center;padding:0 12px 8px;border:0}",
			".dsh-tree-toolbar input{flex:1;min-width:0;height:30px;box-sizing:border-box;border:1px solid transparent;border-radius:8px;background:var(--tp-tint);color:var(--tp-fg);padding:0 10px;font-size:12px;outline:none;transition:border-color 140ms ease,background 140ms ease,box-shadow 140ms ease}",
			".dsh-tree-toolbar input::placeholder{color:var(--tp-fg2);opacity:.85}",
			".dsh-tree-toolbar input:focus{border-color:var(--tp-accent);background:transparent;box-shadow:0 0 0 2px color-mix(in srgb,var(--tp-accent) 22%,transparent)}",
			".dsh-tree-panel-body{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}",
			".dsh-tree-graph{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;position:relative;scrollbar-width:thin;scrollbar-color:var(--tp-hover) transparent}",
			".dsh-tree-graph::-webkit-scrollbar{width:8px}",
			".dsh-tree-graph::-webkit-scrollbar-thumb{background:var(--tp-hover);border-radius:8px;border:2px solid transparent;background-clip:content-box}",
			".dsh-tree-graph::-webkit-scrollbar-track{background:transparent}",
			".dsh-tree-graph-inner{position:relative;width:100%;padding-bottom:10px}",
			".dsh-tree-canvas{overflow:hidden;background-image:radial-gradient(color-mix(in srgb,var(--tp-fg) 9%,transparent) 1px,transparent 1px);background-size:16px 16px;cursor:grab;touch-action:none}",
			".dsh-tree-canvas:active{cursor:grabbing}",
			".dsh-tree-canvas-inner{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}",
			".dsh-tree-canvas-svg{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}",
			".dsh-tree-cluster-tag{position:absolute;font-size:9.5px;letter-spacing:.06em;color:var(--tp-fg2);opacity:.7;white-space:nowrap;pointer-events:none}",
			".dsh-tree-canvas .dsh-tree-node{position:absolute;left:0;right:auto;padding:0}",
			".dsh-tree-canvas .dsh-tree-node-card{border:1px solid var(--tp-line);background:var(--tp-bg);box-shadow:0 6px 18px rgba(0,0,0,.18)}",
			".dsh-tree-canvas .dsh-tree-node-card:hover{border-color:var(--tp-line2);box-shadow:0 10px 24px rgba(0,0,0,.26)}",
			".dsh-tree-canvas .dsh-tree-node-card.head{border-top:0;border-radius:12px;border-left:2px solid color-mix(in srgb,var(--tp-accent) 55%,transparent)}",
			".dsh-tree-zoom{position:absolute;right:10px;bottom:10px;display:flex;align-items:center;gap:2px;padding:3px;border-radius:999px;background:var(--tp-bg);border:1px solid var(--tp-line);box-shadow:0 6px 16px rgba(0,0,0,.24)}",
			".dsh-tree-zoom button{width:24px;height:22px;border:0;border-radius:999px;background:transparent;color:var(--tp-fg2);font-size:12px;cursor:pointer}",
			".dsh-tree-zoom button:hover{background:var(--tp-hover);color:var(--tp-fg)}",
			".dsh-tree-zoom span{font-size:10px;color:var(--tp-fg2);padding:0 3px;min-width:34px;text-align:center}",
			".dsh-tree-graph-svg{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}",
			".dsh-tree-lane-line{fill:none;stroke-width:1.4;opacity:.38}",
			".dsh-tree-lane-line.fork{opacity:.55;stroke-width:1.4}",
			".dsh-tree-lane-line.active{opacity:.95;stroke-width:2.2;stroke:var(--tp-accent)}",
			".dsh-tree-dot{stroke:var(--tp-bg);stroke-width:1.4}",
			".dsh-tree-dot.active{stroke-width:2.2;stroke:var(--tp-accent)}",
			".dsh-tree-node{position:absolute;left:0;right:0;box-sizing:border-box;display:flex;align-items:center;padding:1px 0}",
			".dsh-tree-node-card{position:relative;box-sizing:border-box;min-width:0;flex:1;display:flex;flex-direction:column;gap:3px;border:1px solid transparent;border-radius:12px;background:var(--tp-tint);padding:10px 12px;cursor:pointer;overflow:hidden;line-height:1.45;color:var(--tp-fg);transition:background 130ms ease,border-color 130ms ease,box-shadow 130ms ease}",
			".dsh-tree-node-card:hover{background:var(--tp-tint2);border-color:var(--tp-line);box-shadow:0 4px 14px rgba(0,0,0,.18)}",
			".dsh-tree-node-card.active{background:var(--tp-accent-tint);box-shadow:inset 0 0 0 1.5px var(--tp-accent)}",
			".dsh-tree-node-card.dim{opacity:.55}",
			".dsh-tree-node-card.drag-over{background:color-mix(in srgb,var(--tp-ok) 10%,transparent);box-shadow:inset 0 0 0 1.5px var(--tp-ok)}",
			".dsh-tree-node-card.flash{animation:dsh-tree-flash 1.6s ease-out 1}",
			"@keyframes dsh-tree-flash{0%{box-shadow:0 0 0 0 rgba(240,190,110,.75)}100%{box-shadow:0 0 0 12px rgba(240,190,110,0)}}",
			".dsh-tree-node-card.ghost{border:1px dashed var(--tp-line);background:transparent;color:var(--tp-fg2)}",
			".dsh-tree-node-card.head{background:transparent;border:0;border-top:1px solid var(--tp-line);border-radius:0;padding:14px 12px 4px;box-shadow:none}",
			".dsh-tree-node-card.head:hover{background:var(--tp-tint);box-shadow:none}",
			".dsh-tree-node-card.head .dsh-tree-node-row1{font-size:13px;font-weight:600;color:var(--tp-fg);letter-spacing:.01em}",
			".dsh-tree-node-card.head.active .dsh-tree-node-row1{color:var(--tp-fg)}",
			".dsh-tree-node-row1{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:13px;line-height:1.45;color:var(--tp-fg);padding-right:44px}",
			".dsh-tree-node-reply{min-width:0;font-size:11.5px;line-height:1.5;color:var(--tp-fg2);opacity:.9;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:normal;overflow-wrap:anywhere;padding-right:6px}",
			".dsh-tree-node-card.head .dsh-tree-node-reply{display:none}",
			".dsh-tree-node-row2{display:flex;align-items:center;gap:6px;min-width:0;font-size:10px;line-height:1.4;color:var(--tp-fg2);white-space:nowrap;overflow:hidden;padding-right:6px;margin-top:auto}",
			".dsh-tree-node-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-tree-node-text.muted{font-style:italic;opacity:.6}",
			".dsh-tree-node-meta{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.9}",
			".dsh-tree-turn-chip{position:absolute;top:11px;right:12px;padding:0;border:0;background:transparent;font-size:9.5px;line-height:1.4;color:var(--tp-fg2);opacity:.65;letter-spacing:.03em;pointer-events:none}",
			".dsh-tree-gap-card{align-items:center;justify-content:center;font-size:10.5px;padding:2px 8px}",
			".dsh-tree-actions{position:absolute;right:6px;bottom:3px;display:none;align-items:center;gap:2px;height:20px;padding:0 2px;border-radius:999px;background:var(--tp-bg);box-shadow:0 2px 8px rgba(0,0,0,.16)}",
			".dsh-tree-node-card:hover .dsh-tree-actions,.dsh-tree-node-card:focus-within .dsh-tree-actions{display:inline-flex}",
			".dsh-tree-action,.dsh-tree-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;height:20px;min-width:20px;padding:0 5px;border:0;border-radius:6px;background:transparent;color:var(--tp-fg2);font-size:10.5px;line-height:1;cursor:pointer;transition:background 130ms ease,color 130ms ease}",
			".dsh-tree-action:hover,.dsh-tree-icon:hover{background:var(--tp-tint2);color:var(--tp-fg)}",
			".dsh-tree-icon{font-size:12px}",
			".dsh-tree-icon.star{color:var(--tp-warn)}",
			".dsh-tree-icon.arch{color:var(--tp-fg2)}",
			".dsh-tree-badge{display:inline-flex;align-items:center;min-width:0;overflow:hidden;padding:0;height:auto;line-height:1.45;font-size:9.5px;font-weight:500;border:0;background:transparent;color:var(--tp-fg2);white-space:nowrap}",
			".dsh-tree-badge.fork{color:var(--tp-accent)}",
			".dsh-tree-badge.sub{color:var(--tp-warn)}",
			".dsh-tree-badge.warn{color:var(--tp-err)}",
			".dsh-tree-badge.live{color:var(--tp-ok)}",
			".dsh-tree-empty{padding:32px 16px;text-align:center;font-size:12px;color:var(--tp-fg2);opacity:.85}",
			".dsh-tree-toast{margin:0 12px 10px;padding:7px 10px;border-radius:8px;font-size:11px;line-height:1.5;color:var(--tp-fg);background:var(--tp-accent-tint);border:0}",
			".dsh-tree-toast.warn{background:color-mix(in srgb,var(--tp-err) 12%,transparent)}",
			".dsh-tree-footer{display:flex;gap:8px;padding:10px 12px}",
			".dsh-tree-primary{flex:1;height:30px;border-radius:8px;border:1px solid var(--tp-line);background:var(--tp-tint);color:var(--tp-fg);font-size:12px;font-weight:500;cursor:pointer;transition:background 130ms ease,border-color 130ms ease}",
			".dsh-tree-primary:hover{background:var(--tp-accent-tint);border-color:color-mix(in srgb,var(--tp-accent) 45%,transparent)}",
			".dsh-tree-panel-resize{position:absolute;left:0;top:0;bottom:0;width:6px;cursor:ew-resize;z-index:3}",
			".dsh-tree-canvas-fail{display:flex;flex-direction:column;flex:1;min-height:0}",
			".dsh-tree-canvas-fail .msg{margin:8px 12px 4px;padding:7px 10px;border-radius:8px;font-size:10.5px;line-height:1.5;color:var(--tp-fg);background:color-mix(in srgb,var(--tp-err) 14%,transparent);border:1px solid color-mix(in srgb,var(--tp-err) 40%,transparent);user-select:text;word-break:break-word}",
			".dsh-tree-menu{position:fixed;z-index:10050;min-width:200px;padding:5px;border-radius:12px;background:var(--tp-pop);border:1px solid var(--tp-line);box-shadow:0 16px 40px rgba(0,0,0,.35);font-size:12px;color:var(--tp-fg)}",
			".dsh-tree-menu-item{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;cursor:pointer;white-space:nowrap;transition:background 120ms ease,color 120ms ease}",
			".dsh-tree-menu-item:hover{background:var(--tp-accent-tint)}",
			".dsh-tree-menu-item.warn{color:var(--tp-err)}",
			".dsh-tree-menu-sep{height:1px;margin:4px 6px;background:var(--tp-line)}",
			".dsh-tree-menu-head{padding:4px 10px 6px;font-size:10.5px;color:var(--tp-fg2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}",
			".dsh-tree-tip{position:fixed;z-index:10060;max-width:380px;padding:10px 12px;border-radius:12px;background:var(--tp-pop);color:var(--tp-fg);border:1px solid var(--tp-line);box-shadow:0 14px 36px rgba(0,0,0,.4);font-size:12px;line-height:1.55;pointer-events:auto;user-select:text;cursor:default;box-sizing:border-box;max-height:min(52vh,320px);overflow:auto;overscroll-behavior:contain}",
			".dsh-tree-tip .t1{font-weight:650;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsh-tree-tip .t2{color:var(--tp-fg2);font-size:11px;margin-top:3px}",
			".dsh-tree-tip .t3{color:var(--tp-fg);opacity:.86;margin-top:6px}",
			".dsh-tree-tip .t3 p{margin:0 0 6px;white-space:pre-wrap;word-break:break-word}",
			".dsh-tree-tip .t3 p:last-child{margin-bottom:0}",
			".dsh-tree-mini{position:fixed;z-index:10070;padding:5px 9px;border-radius:8px;background:var(--tp-pop);color:var(--tp-fg);border:1px solid var(--tp-line);box-shadow:0 8px 20px rgba(0,0,0,.3);font-size:11.5px;line-height:1.4;white-space:nowrap;pointer-events:none}",
			".dsh-tree-hit{animation:dsh-tree-hit-pulse 1.6s ease-out 1}",
			"@keyframes dsh-tree-hit-pulse{0%{box-shadow:0 0 0 0 rgba(120,160,255,.6)}100%{box-shadow:0 0 0 14px rgba(120,160,255,0)}}",
			".dsh-tree-btn{display:inline-flex;align-items:center;justify-content:center;flex:none;border:none;background:transparent;border-radius:50%;cursor:pointer;padding:0;color:var(--dsw-alias-label-secondary,#8a8f98);line-height:1}",
			".dsh-tree-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18))}",
			".dsh-tree-btn svg{display:block}",
			".dsh-tree-fail{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;box-sizing:border-box;max-width:min(720px,92vw);padding:10px 14px;border-radius:10px;background:var(--dsw-alias-bg-overlay,#23272e);color:var(--dsw-alias-label-primary,#e8eaed);border:1px solid var(--dsw-alias-state-error-primary,#c93a30);box-shadow:0 12px 32px rgba(0,0,0,.42);font-size:12px;line-height:1.55;white-space:pre-wrap;user-select:text}",
			".dsh-tree-note{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;box-sizing:border-box;max-width:min(720px,92vw);padding:9px 13px;border-radius:10px;background:var(--dsw-alias-bg-overlay,#23272e);color:var(--dsw-alias-label-primary,#e8eaed);border:1px solid var(--dsw-alias-state-success-primary,#3fa564);box-shadow:0 12px 32px rgba(0,0,0,.42);font-size:12px;line-height:1.55;white-space:pre-wrap;user-select:text}",
			/* ===== v2（?ui=v2）：只压密度 + 加缩略图，不改图结构与交互 ===== */
						".dsh-tree-v2 .dsh-tree-graph .dsh-tree-node{padding:2px 0}",
			".dsh-tree-v2 .dsh-tree-node-text{font-size:12px;font-weight:500;line-height:16px}",
			".dsh-tree-v2 .dsh-tree-node-meta{font-size:10.5px;line-height:14px}",
			".dsh-tree-v2 .dsh-tree-node-reply{font-size:11px;line-height:1.45;-webkit-line-clamp:2}",
			".dsh-tree-v2 .dsh-tree-turn-chip{font-size:9.5px;top:10px;right:10px;opacity:.55}",
			".dsh-tree-v2 .dsh-tree-actions{gap:4px}",
			".dsh-tree-v2 .dsh-tree-action{font-size:10.5px}",
			".dsh-tree-map{position:fixed;z-index:6;padding:4px;border:1px solid var(--tp-line);border-radius:8px;background:var(--tp-pop);opacity:.92;cursor:pointer}",
			".dsh-tree-map svg{display:block}",
			".dsh-tree-map .dsh-tree-map-view{fill:var(--dsw-alias-brand-primary,#6f9df0);fill-opacity:.14;stroke:var(--dsw-alias-brand-primary,#6f9df0);stroke-width:1}",
			".dsh-tree-map .bar{fill:var(--tp-fg2)}"
		].join("");
		function injectCss() {
			if (document.getElementById("dsh-tree-panel-css")) return;
			var style = document.createElement("style");
			style.id = "dsh-tree-panel-css";
			style.textContent = CSS;
			style.setAttribute("data-plugin", "dsh-tree-panel");
			style.setAttribute("data-plugin-css", "dsh-tree-panel");
			document.head.appendChild(style);
		}

		/**
		 * 采样页面实际背景亮度 → 面板套亮色 / 暗色两套显式配色。
		 * 从 document.body 往上最多走 8 层，取第一个 alpha > 0.5 的背景色算亮度
		 * （0.299R + 0.587G + 0.114B）/ 255，> 0.55 判为亮色页面。
		 * 目的：不依赖应用主题变量（变量缺失时会把文字弄成与背景同色隐形）。
		 */
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
			} catch {}
			return false;
		}

		/* ---------- 图标 ----------
		   单色内联 SVG 枝干/分叉字形，stroke=currentColor：
		   面板外的按钮直接继承 --dsw-alias-label-secondary 与悬停态，与备份 / 监视同款；
		   槽内（rail 模式）按钮用同一字形，只是尺寸换成 17px。
		   几何按「四颗一套」定标：viewBox 16×16、统一 stroke-width 1.35、圆头圆角，
		   墨迹外框恒定 9.95~10.35 × 12.05~12.15，重心精确落在 (8,8) —— 四颗摆一排
		   光学重心才对得齐（早先那版重心在 x=8.2，比旁边偏右 0.2px）。 */
		var TREE_ICON_SVG =
			'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" ' +
			'stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">' +
			'<path d="M5 3.3v9.4"/>' +
			'<path d="M5 7.9h3.2a2.8 2.8 0 0 1 2.8 2.8v1.3"/>' +
			'<circle cx="5" cy="4" r="1.4"/>' +
			'<circle cx="5" cy="12" r="1.4"/>' +
			'<circle cx="11" cy="12" r="1.4"/>' +
			"</svg>";

		/** 同一个字形的 React 版（槽内按钮用，避免 innerHTML）。 */
		function treeGlyph(size) {
			return react_jsx_runtime.jsx("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				stroke: "currentColor",
				strokeWidth: 1.35,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				children: [
					react_jsx_runtime.jsx("path", { d: "M5 3.3v9.4" }, "p1"),
					react_jsx_runtime.jsx("path", { d: "M5 7.9h3.2a2.8 2.8 0 0 1 2.8 2.8v1.3" }, "p2"),
					react_jsx_runtime.jsx("circle", { cx: 5, cy: 4, r: 1.4 }, "c1"),
					react_jsx_runtime.jsx("circle", { cx: 5, cy: 12, r: 1.4 }, "c2"),
					react_jsx_runtime.jsx("circle", { cx: 11, cy: 12, r: 1.4 }, "c3")
				]
			});
		}

		/* ---------- 数据：会话行 → 轮次图 ---------- */

		/** 父指针字段名按运行版本而异，两个已知名字都认。 */
		function parentOf(item) {
			var p = item.parentId !== void 0 ? item.parentId : item.parentSessionId;
			return typeof p === "string" && p !== "" ? p : null;
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

		/** 每会话的轮次表 [{ turn, seq, prompt, response }]；无投影数据返回 null。 */
		function outlineOf(row) {
			try {
				var pv = row.projectionValues;
				if (!pv || !Array.isArray(pv.turnOutline)) return null;
				return pv.turnOutline
					.filter(function (e) { return e && Number.isFinite(e.turn) && Number.isFinite(e.seq); })
					.map(function (e) {
						return {
							turn: e.turn,
							seq: e.seq,
							prompt: typeof e.prompt === "string" ? e.prompt : "",
							response: typeof e.response === "string" ? e.response : ""
						};
					})
					.sort(function (a, b) { return a.turn - b.turn; });
			} catch {
				return null;
			}
		}

		function seqText(seq) {
			return Number.isFinite(seq) ? "#" + seq : "#?";
		}

		/**
		 * 分支折叠时也要保留的轮次：最近 TAIL_TURNS 轮 + 分支首轮 + 分叉挂接轮。
		 * 中间被折叠的连续段合并成一个 gap 节点。
		 */
		function visibleTurnEntries(branch, indexOfTurn) {
			var own = branch.ownTurns;
			if (own.length === 0) return [];
			if (branch.expanded === true) {
				return own.map(function (entry) { return { kind: "turn", entry: entry }; });
			}
			var keep = new Set();
			keep.add(own[0].turn);
			for (var i = Math.max(0, own.length - TAIL_TURNS); i < own.length; i++) keep.add(own[i].turn);
			for (var t of branch.pinnedTurns) keep.add(t);
			var picked = own.filter(function (entry) { return keep.has(entry.turn); });
			var out = [];
			for (var j = 0; j < picked.length; j++) {
				if (j > 0) {
					var before = indexOfTurn.get(picked[j - 1].turn);
					var after = indexOfTurn.get(picked[j].turn);
					if (after - before > 1) {
						out.push({ kind: "gap", hidden: after - before - 1, fromTurn: picked[j - 1].turn, toTurn: picked[j].turn });
					}
				}
				out.push({ kind: "turn", entry: picked[j] });
			}
			return out;
		}

		/**
		 * 把扁平会话列表折成"轮次级枝干图"。
		 *
		 * 节点类型（kind）：
		 *   turn          一轮对话（多个分支可共享同一个节点对象 = 公共历史只画一次）
		 *   empty-branch  刚分叉出来、还没有自有轮次的分支（占位节点）
		 *   gap           被折叠的连续轮次（点开 = 展开该分支）
		 *   sub-summary   "+N 子任务"汇总节点（子代理默认不进图）
		 *   subagent      展开后的子任务节点（标题本地化为"子任务 #k"）
		 *   empty-group   "N 个空会话/无轮次数据"汇总节点
		 *   empty-session 展开后的空会话节点
		 */
		function buildGraph(spec) {
			var rows = Array.isArray(spec.rows) ? spec.rows : [];
			var allIds = spec.allIds instanceof Set ? spec.allIds : null;
			var forkTable = spec.forks || {};
			var order = Array.isArray(spec.order) ? spec.order : [];
			var expanded = spec.expanded instanceof Set ? spec.expanded : new Set();
			var expandedSubs = spec.expandedSubs instanceof Set ? spec.expandedSubs : new Set();
			var expandedEmpty = spec.expandedEmpty === true;

			var byId = new Map();
			for (var row of rows) if (!byId.has(row.id)) byId.set(row.id, row);

			/* ---- 1) 分流：子代理不进图，按父会话归组 ---- */
			var subGroups = new Map();
			var branchRows = [];
			for (var item of byId.values()) {
				if (item.isSubagent === true) {
					var key = item.parentId !== null ? item.parentId : "";
					var bucket = subGroups.get(key);
					if (bucket === void 0) subGroups.set(key, (bucket = []));
					bucket.push(item);
					continue;
				}
				branchRows.push(item);
			}
			for (var subList of subGroups.values()) {
				subList.sort(function (a, b) { return (a.updatedAt || 0) - (b.updatedAt || 0); });
			}

			/* ---- 2) 建分支骨架 ---- */
			var info = new Map();
			for (var branchRow of branchRows) {
				info.set(branchRow.id, {
					row: branchRow,
					// 会话行可能是"已规范化"的（带 outline 字段），也可能是原始快照行
					// （轮次表在 projectionValues.turnOutline 里）；两种都认。
					outline: Array.isArray(branchRow.outline) ? branchRow.outline : outlineOf(branchRow),
					lane: 0,
					parent: null,
					parentRef: null,
					children: [],
					map: new Map(),
					nodes: [],
					placeholder: null,
					summary: void 0,
					subNodes: void 0,
					pinnedTurns: new Set(),
					expanded: false,
					emitted: false,
					ownTurns: [],
					fork: null,
					attachNode: null,
					firstOwnNode: null
				});
			}
			// 子代理自己也可能有父链：跳过被折叠的子代理，找最近的可见祖先。
			function resolveParent(item) {
				var pid = item.parentId;
				var viaSubagent = false;
				var guard = 0;
				while (pid !== null && guard++ < 128) {
					var p = byId.get(pid);
					if (p === void 0) {
						return { id: pid, absent: true, filtered: allIds !== null && allIds.has(pid), viaSubagent: viaSubagent, info: null };
					}
					if (p.isSubagent !== true) {
						var target = info.get(p.id);
						if (target === void 0) return { id: p.id, absent: true, filtered: false, viaSubagent: viaSubagent, info: null };
						return { id: p.id, absent: false, filtered: false, viaSubagent: viaSubagent, info: target };
					}
					viaSubagent = true;
					pid = p.parentId;
					if (pid === p.id) break;
				}
				return null;
			}

			var roots = [];
			for (var node of info.values()) {
				var pref = resolveParent(node.row);
				node.parentRef = pref;
				if (pref === null || pref.info === null) {
					roots.push(node.row.id);
					continue;
				}
				node.parent = pref.info;
				pref.info.children.push(node.row.id);
			}

			/* 纯环防御：互相指向的分支既不是根也到不了 → 提回根层，不丢节点。 */
			var reachable = new Set();
			var stack = roots.slice();
			while (stack.length > 0) {
				var cur = stack.pop();
				if (reachable.has(cur)) continue;
				reachable.add(cur);
				var kids = info.get(cur).children;
				for (var kid of kids) stack.push(kid);
			}
			for (var oid of info.keys()) {
				if (reachable.has(oid)) continue;
				// 提回根层时必须同时把它从旧父的 children 里摘掉，否则 self-parent / A↔B
				// 仍会构成一条环，后面的 assignLanes/buildBranch 会无限递归。
				var oldParent = info.get(oid).parent;
				if (oldParent !== null && oldParent !== void 0) {
					var sibs = oldParent.children;
					var atSib = sibs.indexOf(oid);
					if (atSib >= 0) sibs.splice(atSib, 1);
				}
				info.get(oid).parent = null;
				info.get(oid).parentRef = null;
				roots.push(oid);
				var pending = [oid];
				while (pending.length > 0) {
					var s = pending.pop();
					if (reachable.has(s)) continue;
					reachable.add(s);
					var more = info.get(s).children;
					for (var m of more) pending.push(m);
				}
			}

			/* ---- 3) 分支排序：标星整组前置，组内 order → updatedAt 倒序 ---- */
			var rank = new Map();
			if (Array.isArray(order)) order.forEach(function (oid2, index) { if (!rank.has(oid2)) rank.set(oid2, index); });
			var NO_RANK = 1e9;
			function compare(aid, bid) {
				var a = info.get(aid).row;
				var b = info.get(bid).row;
				var sa = a.star === true ? 0 : 1;
				var sb = b.star === true ? 0 : 1;
				if (sa !== sb) return sa - sb;
				var ra = rank.has(aid) ? rank.get(aid) : NO_RANK;
				var rb = rank.has(bid) ? rank.get(bid) : NO_RANK;
				if (ra !== rb) return ra - rb;
				return (b.updatedAt || 0) - (a.updatedAt || 0);
			}
			roots.sort(compare);
			for (var br of info.values()) br.children.sort(compare);

			/* ---- 4) 共享前缀 / 分歧点检测 ---- */
			/**
			 * 父子两侧按轮号对齐后，前面连续多少轮是"同一轮"。
			 * 判定：轮号相同 且 seq 相同；两边都有提示词时文本也必须相同（双保险）。
			 */
			function sharedTurns(childOutline, parentOutline) {
				if (!Array.isArray(childOutline) || !Array.isArray(parentOutline)) return null;
				var n = 0;
				while (n < childOutline.length && n < parentOutline.length) {
					var c = childOutline[n];
					var p = parentOutline[n];
					if (c.turn !== p.turn || c.seq !== p.seq) break;
					if (c.prompt !== "" && p.prompt !== "" && c.prompt !== p.prompt) break;
					n++;
				}
				return n;
			}

			function forkInfoFor(branch) {
				var row = branch.row;
				var rec = forkTable[row.id];
				var anchorSeq = rec !== void 0 && Number.isFinite(rec.atSeq) ? rec.atSeq : null;
				var anchorSource = rec !== void 0 && typeof rec.source === "string" ? rec.source : null;
				var parent = branch.parent;
				var result = {
					shareCount: 0,
					firstOwnTurn: 1,
					source: "root",
					anchorSeq: anchorSeq,
					anchorSource: anchorSource,
					seqShare: null,
					note: "根分支（创建时没有父会话）"
				};

				if (parent === null) {
					if (row.parentId !== null) {
						var ref = branch.parentRef;
						var why;
						if (ref === null) why = "父指针指向自己";
						else if (ref.filtered) why = "父分支被页签/搜索过滤掉了";
						else if (ref.viaSubagent) why = "父是子任务（已折叠）· 短码 " + shortCode(ref.id);
						else why = "父会话已删除 · 短码 " + shortCode(ref.id);
						result.source = "parent-absent";
						result.note = "父不可寻址（" + why + "）→ 按子会话起点分列，分叉轮次未知";
					}
					return result;
				}

				var pOutline = parent.outline;
				var seqShare = sharedTurns(branch.outline, pOutline);
				var anchorShare = null;
				if (anchorSeq !== null && Array.isArray(pOutline)) {
					var k = 0;
					while (k < pOutline.length && pOutline[k].seq <= anchorSeq) k++;
					anchorShare = k;
					if (branch.outline !== null && anchorShare > branch.outline.length) anchorShare = branch.outline.length;
				}
				result.seqShare = seqShare;
				// 优先级：已记录的 call 锚点 > seq 对齐推算
				if (anchorSource === "call" && anchorShare !== null) {
					result.shareCount = anchorShare;
					result.source = "call";
					result.note =
						"已记录锚点 " + seqText(anchorSeq) + "（source=call · fork 调用方自己给的切点）" +
						(seqShare === null
							? " · 父分支无轮次数据可比对"
							: seqShare === anchorShare
								? " · 与 seq 对齐推算一致"
								: " · seq 对齐推算为 " + seqShare + " 轮共享（不一致，以锚点为准）");
				} else if (seqShare !== null) {
					result.shareCount = seqShare;
					result.source = "derived-seq";
					result.note =
						"seq 对齐推算（父子同轮号下 seq 首个不一致处即子会话第一轮自有轮次）" +
						(anchorSeq !== null ? " · 另有 " + anchorSource + " 锚点 " + seqText(anchorSeq) + "（非 call，不作准）" : " · 无锚点记录");
				} else if (anchorShare !== null) {
					result.shareCount = anchorShare;
					result.source = "anchor-" + anchorSource;
					result.note = "锚点 " + seqText(anchorSeq) + "（source=" + anchorSource + "）· 父分支无轮次数据可比对";
				} else {
					result.shareCount = 0;
					result.source = "unknown";
					result.note = "既无锚点、父分支也没有轮次数据可比对 → 按子会话起点分列（分叉轮次未知）";
				}
				result.firstOwnTurn = result.shareCount + 1;
				return result;
			}

			/* ---- 5) 建节点 + 继承共享轮次（父先子后） ---- */
			function makeTurnNode(branch, entry) {
				return {
					id: "t:" + branch.row.id + ":" + entry.turn,
					kind: "turn",
					sessionId: branch.row.id,
					sessionTitle: branch.row.title,
					workspace: branch.row.workspace,
					branchId: branch.row.id,
					branchTitle: branch.row.title,
					lane: branch.lane,
					turn: entry.turn,
					seq: entry.seq,
					prompt: entry.prompt,
					response: entry.response,
					sharedBy: [],
					row: -1
				};
			}

			var builtBranches = new Set();
			function buildBranch(id) {
				if (builtBranches.has(id)) return;
				builtBranches.add(id);
				var branch = info.get(id);
				if (branch.built === true) return;
				branch.built = true;
				var fi = forkInfoFor(branch);
				branch.fork = fi;
				branch.shareCount = fi.shareCount;
				branch.firstOwnTurn = fi.firstOwnTurn;
				branch.expanded = expanded.has(id);
				branch.ownTurns = branch.outline === null ? [] : branch.outline.filter(function (e) { return e.turn >= fi.firstOwnTurn; });

				if (branch.parent !== null) {
					// 共享轮次直接复用父分支的节点对象 —— 这就是"公共历史只画一次"。
					for (var entry of branch.outline || []) {
						if (entry.turn >= fi.firstOwnTurn) break;
						var inherited = branch.parent.map.get(entry.turn);
						if (inherited === void 0) continue;
						branch.map.set(entry.turn, inherited);
						if (inherited.sharedBy.indexOf(branch.row.title) < 0) inherited.sharedBy.push(branch.row.title);
					}
				}
				for (var own of branch.ownTurns) {
					var n = makeTurnNode(branch, own);
					branch.map.set(own.turn, n);
					branch.nodes.push(n);
				}
				for (var childId of branch.children) buildBranch(childId);
			}

			var lanes = [];
			var laned = new Set();
			function assignLanes(id, lane) {
				if (laned.has(id) || lane > 4096) return; // 环/超深链兜底，宁可少摆一行也不炸整个面板
				laned.add(id);
				var branch = info.get(id);
				branch.lane = lane;
				lanes.push(branch);
				for (var kid of branch.children) assignLanes(kid, lane + 1);
			}
			for (var rid of roots) assignLanes(rid, 0);
			for (var rid2 of roots) buildBranch(rid2);

			/* ---- 6) 挂接关系：子分支挂在"最后一个共享轮次"的节点上 ---- */
			var attachOf = new Map();
			var detached = [];
			for (var branch3 of info.values()) {
				var f = branch3.fork;
				var attachNode = null;
				if (branch3.parent !== null && f.shareCount >= 1 && Array.isArray(branch3.outline) && branch3.outline.length >= f.shareCount) {
					var attachTurn = branch3.outline[f.shareCount - 1].turn;
					attachNode = branch3.parent.map.get(attachTurn) || null;
				}
				branch3.attachNode = attachNode;
				if (attachNode !== null) {
					var arr = attachOf.get(attachNode.id);
					if (arr === void 0) attachOf.set(attachNode.id, (arr = []));
					arr.push(branch3.row.id);
					var owner = info.get(attachNode.branchId);
					if (owner !== void 0) owner.pinnedTurns.add(attachNode.turn);
					attachNode.forkChildren = attachNode.forkChildren || [];
					attachNode.forkChildren.push(branch3.row.title);
				} else if (branch3.parent !== null) {
					detached.push(branch3.row.id);
				}
			}

			/* ---- 7) 排布行：深度优先（父节点 → 挂在它上面的子分支 → 父的下一个节点） ---- */
			var nodes = [];
			function place(node) {
				if (node.row >= 0) return; // 同一个节点只能放一次（共享轮次）
				node.row = nodes.length;
				nodes.push(node);
			}
			function emitBranch(id) {
				var branch = info.get(id);
				if (branch.emitted === true) return;
				branch.emitted = true;
				var indexOfTurn = new Map();
				branch.ownTurns.forEach(function (e, i) { indexOfTurn.set(e.turn, i); });
				var entries = visibleTurnEntries(branch, indexOfTurn);
				for (var v of entries) {
					var node;
					if (v.kind === "gap") {
						node = {
							id: "g:" + branch.row.id + ":" + v.fromTurn,
							kind: "gap",
							sessionId: branch.row.id,
							sessionTitle: branch.row.title,
							branchId: branch.row.id,
							branchTitle: branch.row.title,
							lane: branch.lane,
							hiddenCount: v.hidden,
							fromTurn: v.fromTurn,
							toTurn: v.toTurn,
							row: -1
						};
						place(node);
						continue;
					}
					node = branch.map.get(v.entry.turn); // 轮次条目 → 真实节点对象（共享轮次也在这里统一）
					if (node === void 0) continue;
					if (branch.nodes.length > 0 && node === branch.nodes[0]) {
						node.isHead = true;
						branch.firstOwnNode = node;
					}
					place(node);
					var kids = attachOf.get(node.id);
					if (kids !== void 0) for (var kid of kids.slice()) emitBranch(kid);
				}
				if (branch.ownTurns.length === 0 && branch.attachNode !== null && branch.parent !== null) {
					// 刚分叉出来、还没有自有轮次的分支：给一个占位节点，别让它消失。
					branch.placeholder = {
						id: "e:" + branch.row.id,
						kind: "empty-branch",
						sessionId: branch.row.id,
						sessionTitle: branch.row.title,
						workspace: branch.row.workspace,
						branchId: branch.row.id,
						branchTitle: branch.row.title,
						lane: branch.lane,
						isHead: true,
						row: -1
					};
					place(branch.placeholder);
					branch.firstOwnNode = branch.placeholder;
					var pk = attachOf.get(branch.placeholder.id);
					if (pk !== void 0) for (var k2 of pk) emitBranch(k2);
				}
				// 子任务组：挂在分支最后一个节点下方（子代理默认不进图）。
				var subs = subGroups.get(branch.row.id);
				if (subs !== void 0 && subs.length > 0) {
					var anchorNode = branch.nodes.length > 0 ? branch.nodes[branch.nodes.length - 1] : branch.placeholder;
					var summary = {
						id: "s:" + branch.row.id,
						kind: "sub-summary",
						sessionId: branch.row.id,
						sessionTitle: branch.row.title,
						branchId: branch.row.id,
						branchTitle: branch.row.title,
						lane: branch.lane,
						subCount: subs.length,
						expanded: expandedSubs.has(branch.row.id),
						row: -1
					};
					if (anchorNode !== null && anchorNode !== void 0) anchorNode.hasSubSummary = true;
					place(summary);
					branch.summary = summary;
					if (summary.expanded) {
						branch.subNodes = [];
						subs.forEach(function (sub, idx) {
							var subNode = {
								id: "sa:" + sub.id,
								kind: "subagent",
								sessionId: sub.id,
								sessionTitle: sub.title,
								workspace: sub.workspace,
								branchId: branch.row.id,
								branchTitle: branch.row.title,
								lane: branch.lane,
								index: idx + 1,
								running: sub.running === true,
								turnCount: sub.outline === null ? null : sub.outline.length,
								rawTitle: sub.title,
								row: -1
							};
							place(subNode);
							branch.subNodes.push(subNode);
						});
					}
				}
			}

			for (var rid3 of roots) emitBranch(rid3);
			// 挂不上父节点的分支（父无轮次数据/父被过滤）跟在主图后面，不丢信息。
			for (var did of detached) emitBranch(did);

			/* ---- 8) 空会话 / 无轮次数据会话：合成一个折叠组 ---- */
			var emptyRows = [];
			for (var branch4 of info.values()) {
				if (branch4.nodes.length > 0 || branch4.placeholder !== null || branch4.summary !== void 0) continue;
				emptyRows.push(branch4.row);
			}
			emptyRows.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
			var emptyGroup = null;
			if (emptyRows.length > 0) {
				emptyGroup = {
					id: "x:group",
					kind: "empty-group",
					lane: 0,
					count: emptyRows.length,
					expanded: expandedEmpty,
					row: -1
				};
				place(emptyGroup);
				if (expandedEmpty) {
					emptyGroup.members = emptyRows.map(function (r2) {
						var n2 = { id: "x:" + r2.id, kind: "empty-session", sessionId: r2.id, sessionTitle: r2.title, workspace: r2.workspace, lane: 0, row: -1 };
						place(n2);
						return n2;
					});
				}
			}

			/* ---- 9) SVG 用的轨道脊线与分叉曲线 ---- */
			var spines = [];
			for (var branch5 of info.values()) {
				var chain = [];
				if (branch5.nodes.length > 0) chain = branch5.nodes.slice();
				else if (branch5.placeholder !== null) chain = [branch5.placeholder];
				if (branch5.summary !== void 0) chain = chain.concat([branch5.summary]);
				if (branch5.subNodes !== void 0) chain = chain.concat(branch5.subNodes);
				if (chain.length === 0) continue;
				spines.push({
					lane: branch5.lane,
					color: LANE_COLORS[branch5.lane % LANE_COLORS.length],
					fromRow: chain[0].row, toRow: chain[chain.length - 1].row,
					branchId: branch5.row.id,
					title: branch5.row.title
				});
			}
			var edges = [];
			for (var branch6 of info.values()) {
				if (branch6.attachNode === null) continue;
				var first = branch6.nodes.length > 0 ? branch6.nodes[0] : branch6.placeholder;
				if (first === null || first === void 0) continue;
				edges.push({
					branchId: branch6.row.id,
					fromNodeId: branch6.attachNode.id,
					toNodeId: first.id,
					fromRow: branch6.attachNode.row,
					toRow: first.row,
					fromLane: branch6.attachNode.lane,
					toLane: branch6.lane,
					color: LANE_COLORS[branch6.lane % LANE_COLORS.length],
					title: branch6.row.title
				});
			}

			var maxLane = 0;
			for (var gl of lanes) if (gl.lane > maxLane) maxLane = gl.lane;
			var gutter = (maxLane + 1) * LANE_W + LANE_PAD * 2;

			var visibleTurns = 0;
			var totalTurns = 0;
			for (var branch7 of info.values()) totalTurns += branch7.ownTurns.length;
			for (var n3 of nodes) if (n3.kind === "turn") visibleTurns++;

			return {
				nodes: nodes,
				spines: spines,
				edges: edges,
				lanes: lanes,
				rowCount: nodes.length,
				gutter: gutter,
				emptyGroup: emptyGroup,
				stats: {
					branches: info.size,
					subagentGroups: subGroups.size,
					totalTurns: totalTurns,
					visibleTurns: visibleTurns,
					hiddenTurns: Math.max(0, totalTurns - visibleTurns),
					emptySessions: emptyRows.length
				}
			};
		}

		/* ---------- 分叉锚点记录（包装 sessions.fork） ---------- */
		/**
		 * fork API 不存分叉点 seq，所以这里包一层：fork 成功时把
		 * (childId → atSeq) 记进 localStorage "dsh-tree-panel.forks.v1"。
		 *
		 * 锚点优先级：
		 *  1) fork 调用方自己给的 atSeq —— 权威锚点，source="call"（右键"从此轮分叉"走这条）；
		 *  2) uiAnchorHint —— 界面分叉前选中的轮次（60s 内有效，当前无公开接口可读）；
		 *  3) 父会话当前末位 seq（派生值，source="derived"，如实标注为推定）。
		 */
		function installForkRecorder(sessionsService, uiAnchorHint, deps) {
			var installed = "none";

			function titleById(id) {
				try {
					var snap = deps.listSnapshot();
					var row = snap && snap.byId ? snap.byId[id] : void 0;
					if (row !== void 0 && row !== null) return titleOf(row, id);
				} catch {}
				return "";
			}

			function anchorFor(sourceId, opts) {
				var requested = opts && opts.atSeq;
				if (Number.isFinite(requested)) return { atSeq: Math.floor(requested), source: "call" };
				var hint = uiAnchorHint();
				if (hint !== null && hint !== void 0 && hint.parentId === sourceId && Date.now() - hint.time <= FORK_CAPTURE_TTL_MS) {
					return { atSeq: hint.atSeq, source: "ui" };
				}
				var derived = deps.lastSeqOf(sourceId);
				if (Number.isFinite(derived)) return { atSeq: derived, source: "derived" };
				return { atSeq: null, source: "unknown" };
			}

			function wrap(original) {
				return function (opts) {
					var sourceId = opts && typeof opts.sessionId === "string" ? opts.sessionId : null;
					var anchor = anchorFor(sourceId, opts);
					var result = original.apply(this, arguments);
					try {
						if (result && typeof result.then === "function") {
							return result.then(function (childId) {
								recordFork(childId, {
									parentId: sourceId,
									atSeq: anchor.atSeq,
									parentTitle: titleById(sourceId),
									time: Date.now(),
									source: anchor.source
								});
								return childId;
							});
						}
						if (typeof result === "string") {
							recordFork(result, { parentId: sourceId, atSeq: anchor.atSeq, parentTitle: titleById(sourceId), time: Date.now(), source: anchor.source });
						}
						return result;
					} catch {
						return result;
					}
				};
			}

			var patchOriginal = null;
			var patchProto = null;
			try {
				if (sessionsService && typeof sessionsService.fork === "function") {
					if (sessionsService.fork.__treePanelRecorder === true) return "already";
					var original = sessionsService.fork;
					patchOriginal = original;
					try {
						sessionsService.fork = wrap(original);
						if (sessionsService.fork !== original) {
							sessionsService.fork.__treePanelRecorder = true;
							installed = "own";
						}
					} catch {
						/* 只读实例：走原型那条路 */
					}
					if (installed !== "own") {
						try {
							var proto = Object.getPrototypeOf(sessionsService);
							if (proto && typeof proto.fork === "function" && proto.fork.__treePanelRecorder !== true) {
								proto.fork = wrap(original);
								if (proto.fork !== original) {
									proto.fork.__treePanelRecorder = true;
									installed = "proto";
									patchProto = proto;
								}
							}
						} catch {}
					}
				}
			} catch {}
			try {
				if (sessionsService && patchOriginal && (installed === "own" || installed === "proto")) {
					sessionsService.__treePanelForkPatch = { kind: installed, original: patchOriginal, proto: patchProto };
				}
			} catch {}
			return installed;
		}

		/* ---------- 小工具 ---------- */
		function copyText(text) {
			try {
				if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
					navigator.clipboard.writeText(text);
					return true;
				}
			} catch {}
			try {
				var ta = document.createElement("textarea");
				ta.value = text;
				ta.setAttribute("readonly", "readonly");
				ta.style.position = "fixed";
				ta.style.opacity = "0";
				document.body.appendChild(ta);
				ta.select();
				var ok = document.execCommand("copy");
				document.body.removeChild(ta);
				return ok === true;
			} catch {
				return false;
			}
		}

		function truncate(text, max) {
			var t = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
			if (t === "") return "";
			return t.length > max ? t.slice(0, max) + "…" : t;
		}

		/* ---------- 组件 ---------- */
		function Badge(props) {
			return react_jsx_runtime.jsx("span", {
				className: "dsh-tree-badge" + (props.kind ? " " + props.kind : ""),
				title: props.title,
				onClick: props.onClick,
				style: props.title || props.onClick ? { cursor: "pointer" } : void 0,
				children: props.children
			});
		}

		/** 节点提示：把"这个节点是什么 / 分叉点从哪来"如实写全（含三种来源标注）。 */
		function nodeTooltip(node) {
			var lines = [];
			if (node.sessionId !== void 0) lines.push("会话：" + node.sessionTitle + "（" + node.sessionId + "）");
			if (node.workspace) lines.push("工作区：" + node.workspace);
			if (node.kind === "turn") {
				lines.push("轮次：第 " + node.turn + " 轮 · 起始 seq " + seqText(node.seq));
				lines.push("所属轨道：lane " + node.lane + " · " + node.branchTitle);
				if (node.sharedBy && node.sharedBy.length > 0) lines.push("共享轮次（同一节点被这些分支共用）：" + node.sharedBy.join("、"));
				if (node.forkChildren && node.forkChildren.length > 0) lines.push("从这里分叉出的分支：" + node.forkChildren.join("、"));
				if (node.sessionForkNote) lines.push("本分支分叉点来源：" + node.sessionForkNote);
				if (node.forkNote) lines.push("分叉点来源：" + node.forkNote);
				if (node.prompt) lines.push("用户输入：" + node.prompt);
				if (node.response) lines.push("回复摘要：" + node.response);
				if (node.hasSubSummary) lines.push("该会话有折叠的子任务组（见下方「+N 子任务」节点）");
				lines.push("");
				lines.push("左键：打开该会话并定位到这一轮　右键：分叉 / 打开 / 复制 id");
			} else if (node.kind === "empty-branch") {
				lines.push("该分支刚分叉出来，还没有自有轮次（占位节点）");
				lines.push("分叉点来源：" + (node.forkNote || "未知"));
				lines.push("");
				lines.push("左键：打开该会话　右键：分叉 / 打开 / 复制 id");
			} else if (node.kind === "gap") {
				lines.push("这里折叠了 " + node.hiddenCount + " 轮（第 " + node.fromTurn + " 轮之后、第 " + node.toTurn + " 轮之前）");
				lines.push("点击展开该分支的全部轮次");
			} else if (node.kind === "sub-summary") {
				lines.push("子任务（子代理会话）：" + node.subCount + " 个 · 默认不单独占轨道");
				lines.push("点击" + (node.expanded ? "折叠" : "展开") + "查看（标题本地化为「子任务 #k」，不显示英文内部标题）");
			} else if (node.kind === "subagent") {
				lines.push("子任务 #" + node.index + "（父会话：" + node.branchTitle + "）");
				lines.push("轮次数：" + (node.turnCount === null ? "无轮次数据" : node.turnCount));
				if (node.rawTitle) lines.push("内部标题（不直接显示在卡片上）：" + node.rawTitle);
				lines.push("");
				lines.push("左键：打开该子任务会话　右键：分叉 / 打开 / 复制 id");
			} else if (node.kind === "empty-group") {
				lines.push(node.count + " 个会话没有轮次数据（空会话，或投影尚未加载）");
				lines.push("点击" + (node.expanded ? "折叠" : "展开") + "成单个节点");
			} else if (node.kind === "empty-session") {
				lines.push("该会话没有轮次数据（空会话，或投影尚未加载）");
				lines.push("左键：打开该会话　右键：打开 / 复制 id");
			}
			return lines.join("\n");
		}

				/** 单个图节点（HTML 卡片）。 */
		var __tipTimer = null, __tipEl = null, __miniEl = null, __tipHideTimer = null;
		var __tipNodes = Object.create(null);

		function hideNodeTip() {
			if (__tipTimer) { clearTimeout(__tipTimer); __tipTimer = null; }
			if (__tipEl && __tipEl.parentNode) __tipEl.parentNode.removeChild(__tipEl);
			if (__miniEl && __miniEl.parentNode) __miniEl.parentNode.removeChild(__miniEl);
			__tipEl = null;
			__miniEl = null;
		}
		function scheduleHideNodeTip() {
			if (__tipHideTimer) clearTimeout(__tipHideTimer);
			__tipHideTimer = setTimeout(function () { hideNodeTip(); }, 260);
		}
		function cancelHideNodeTip() {
			if (__tipHideTimer) { clearTimeout(__tipHideTimer); __tipHideTimer = null; }
		}
		function tipIsLight(anchor) {
			var panel = anchor && anchor.closest ? anchor.closest(".dsh-tree-panel-overlay") : null;
			return !!(panel && panel.classList.contains("dsh-tp-light"));
		}
		function showNodeTip(node, anchor) {
			cancelHideNodeTip();
			hideNodeTip();
			__tipTimer = setTimeout(function () {
				__tipTimer = null;
				if (__tipEl) return;
				var el = document.createElement("div");
				el.className = "dsh-tree-tip" + (tipIsLight(anchor) ? " dsh-tip-light" : "");
				var t1 = document.createElement("div"); t1.className = "t1";
				t1.textContent = node.sessionTitle || node.prompt || "会话";
				el.appendChild(t1);
				var sub = node.kind === "turn"
					? ("第 " + node.turn + " 轮" + (node.branchTitle ? " · " + node.branchTitle : ""))
					: (node.kind === "sub-summary" ? ("子任务 " + node.subCount + " 个") : "");
				if (sub) { var t2 = document.createElement("div"); t2.className = "t2"; t2.textContent = sub; el.appendChild(t2); }
				var lines = [];
				if (node.prompt) lines.push("用户：" + node.prompt);
				if (node.response) lines.push("回复：" + node.response);
				if (lines.length === 0) lines.push(node.sessionTitle || "");
				var scroller = document.createElement("div"); scroller.className = "t3";
				lines.forEach(function (line) { var p = document.createElement("p"); p.textContent = line; scroller.appendChild(p); });
				el.appendChild(scroller);
				document.body.appendChild(el);
				var panel = anchor.closest ? anchor.closest(".dsh-tree-panel-overlay") : null;
				var ar = anchor.getBoundingClientRect();
				var pr = panel ? panel.getBoundingClientRect() : ar;
				var rect = el.getBoundingClientRect();
				var left = Math.max(8, pr.left - rect.width - 8);
				var top = Math.max(8, Math.min(window.innerHeight - rect.height - 8, ar.top));
				el.style.left = left + "px"; el.style.top = top + "px";
				el.addEventListener("mouseenter", cancelHideNodeTip);
				el.addEventListener("mouseleave", scheduleHideNodeTip);
				el.addEventListener("wheel", function (ev) { ev.stopPropagation(); }, { passive: true });
				__tipEl = el;
			}, 450);
		}
		function showMiniTip(text, anchor) {
			cancelHideNodeTip();
			if (__tipTimer) { clearTimeout(__tipTimer); __tipTimer = null; }
			if (__tipEl && __tipEl.parentNode) __tipEl.parentNode.removeChild(__tipEl);
			__tipEl = null;
			if (__miniEl && __miniEl.parentNode) __miniEl.parentNode.removeChild(__miniEl);
			var el = document.createElement("div");
			el.className = "dsh-tree-mini" + (tipIsLight(anchor) ? " dsh-tip-light" : "");
			el.textContent = text;
			document.body.appendChild(el);
			var ar = anchor.getBoundingClientRect();
			var rect = el.getBoundingClientRect();
			var left = Math.min(window.innerWidth - rect.width - 8, Math.max(8, ar.left + ar.width / 2 - rect.width / 2));
			var top = ar.bottom + 6;
			if (top + rect.height > window.innerHeight - 8) top = ar.top - rect.height - 6;
			el.style.left = left + "px"; el.style.top = top + "px";
			__miniEl = el;
		}
		/* 事件委托：卡片每 1.5s 重渲染，绑 document 才不会被 DOM 替换打断 */
		(function installTipDelegation() {
			if (typeof window === "undefined" || window.__treeTipDelegated) return;
			window.__treeTipDelegated = true;
			document.addEventListener("pointerover", function (e) {
				var t = e.target;
				if (!t || !t.closest || !t.closest(".dsh-tree-panel-overlay")) return;
				var btn = t.closest("[data-tip]");
				if (btn) { showMiniTip(btn.getAttribute("data-tip"), btn); return; }
				if (t.closest(".dsh-tree-actions")) return;
				var card = t.closest(".dsh-tree-node-card");
				if (!card) return;
				var node = __tipNodes[card.getAttribute("data-node-id")];
				if (node) showNodeTip(node, card);
			}, true);
			document.addEventListener("pointerout", function (e) {
				var t = e.target;
				if (!t || !t.closest || !t.closest(".dsh-tree-panel-overlay")) return;
				var to = e.relatedTarget;
				if (to && to.closest && to.closest(".dsh-tree-tip, .dsh-tree-mini")) return;
				var prevCard = t.closest(".dsh-tree-node-card");
				var nextCard = to && to.closest ? to.closest(".dsh-tree-node-card") : null;
				if (prevCard && nextCard && prevCard === nextCard) return;
				scheduleHideNodeTip();
			}, true);
		})();
		function GraphNodeCard(props) {
			__tipNodes[props.node.id] = props.node;
			var node = props.node;
			var graph = props.graph;
			var hasSession = node.sessionId !== void 0 && node.sessionId !== null;
			var active = hasSession && node.sessionId === props.activeSessionId;
			var cardClass = "dsh-tree-node-card";
			if (active) cardClass += " active";
			if (node.isHead === true || node.kind === "sub-summary" || node.kind === "empty-group") cardClass += " head";
			if (node.kind === "gap" || node.kind === "empty-branch" || node.kind === "empty-session") cardClass += " ghost";
			if (node.kind === "gap") cardClass += " dsh-tree-gap-card";
			if (props.flashNodeId === node.id) cardClass += " flash";
			if (node.kind === "empty-session") cardClass += " dim";
			if (props.dropTargetId === node.id) cardClass += " drag-over";

			function stop(e) {
				e.stopPropagation();
				e.preventDefault();
			}

			var row1 = [];
			var row2 = [];
			/* 「第 N 轮」不再占第一行的前缀，改成卡片右上角的绝对定位胶囊。 */
			var chip =
				node.kind === "turn"
					? react_jsx_runtime.jsx("span", { className: "dsh-tree-turn-chip", children: "第" + node.turn + "轮" }, "turn")
					: null;
			/* 悬停才出现的小动作条：快捷「分叉 / 定位」，头节点再加收藏 ★ / 归档 ▣。 */
			var actions = [];

			if (node.kind === "turn") {
				if (Number.isFinite(node.seq)) {
					actions.push(
						react_jsx_runtime.jsx("button", {
							className: "dsh-tree-action",
							"data-tip": "从此轮分叉",
							"aria-label": "分叉",
							onClick: function (e) {
								stop(e);
								if (props.onQuickFork) props.onQuickFork(node);
							},
							children: "分叉"
						}, "forkQuick")
					);
				}
				actions.push(
					react_jsx_runtime.jsx("button", {
						className: "dsh-tree-action",
						"data-tip": "定位到这一轮",
						"aria-label": "定位",
						onClick: function (e) {
							stop(e);
							if (props.onLocate) props.onLocate(node);
						},
						children: "定位"
					}, "locateQuick")
				);
				if (node.isHead === true) {
					row1.push(react_jsx_runtime.jsx("span", { className: "dsh-tree-node-text head", children: node.sessionTitle }, "title"));
				} else {
					row1.push(
						react_jsx_runtime.jsx("span", {
							className: "dsh-tree-node-text" + (node.prompt === "" ? " muted" : ""),
							children: truncate(node.prompt !== "" ? node.prompt : "（无用户输入）", 60)
						}, "text")
					);
				}
				if (node.isHead === true) {
					row2.push(
						react_jsx_runtime.jsx("span", {
							className: "dsh-tree-node-meta",
							children: node.prompt !== "" ? truncate(node.prompt, 42) : "（无用户输入）"
						}, "headtext")
					);
				}
				row2.push(react_jsx_runtime.jsx("span", { children: seqText(node.seq) }, "seq"));
				if (node.isHead === true && node.workspace) row2.push(react_jsx_runtime.jsx("span", { className: "dsh-tree-node-meta", children: node.workspace }, "ws"));
				if (node.forkChildren && node.forkChildren.length > 0) {
					row2.push(
						react_jsx_runtime.jsx(Badge, {
							kind: "fork",
							title: "从这里分叉出的分支：" + node.forkChildren.join("、") + "（点击跳到第一条子轨道）",
							onClick: function (e) {
								stop(e);
								if (props.onJumpToChild) props.onJumpToChild(node);
							},
							children: "⑂" + node.forkChildren.length
						}, "fork")
					);
				}
				if (node.hasSubSummary) row2.push(react_jsx_runtime.jsx(Badge, { kind: "sub", title: "该会话有折叠的子任务组（见下方汇总节点）", children: "子任务" }, "sub"));
				if (active) row2.push(react_jsx_runtime.jsx(Badge, { kind: "live", children: "当前会话" }, "active"));
				if (node.isHead === true) {
					actions.push(
						react_jsx_runtime.jsx("button", {
							className: "dsh-tree-icon star" + (props.star ? " on" : ""),
							title: props.star ? "取消收藏" : "收藏（标星，作用在这个会话轨道上）",
							"aria-label": props.star ? "取消收藏" : "收藏",
							onClick: function (e) {
								stop(e);
								if (props.onToggleMark) props.onToggleMark(node.sessionId, "star");
							},
							children: props.star ? "★" : "☆"
						}, "starBtn")
					);
					actions.push(
						react_jsx_runtime.jsx("button", {
							className: "dsh-tree-icon arch" + (props.archive ? " on" : ""),
							title: props.archive ? "取消归档" : "归档（默认折叠）",
							"aria-label": props.archive ? "取消归档" : "归档",
							onClick: function (e) {
								stop(e);
								if (props.onToggleMark) props.onToggleMark(node.sessionId, "archive");
							},
							children: "▣"
						}, "archBtn")
					);
				}
			} else if (node.kind === "empty-branch") {
				row1.push(react_jsx_runtime.jsx("span", { className: "dsh-tree-node-text head", children: node.sessionTitle }, "title"));
				row2.push(react_jsx_runtime.jsx("span", { children: "尚无新轮次（刚分叉）" }, "note"));
				row2.push(react_jsx_runtime.jsx("span", { children: shortCode(node.sessionId) }, "sid"));
			} else if (node.kind === "gap") {
				row1.push(react_jsx_runtime.jsx("span", { className: "dsh-tree-node-text", children: "⋯ 折叠 " + node.hiddenCount + " 轮 · 点击展开" }, "gap"));
			} else if (node.kind === "sub-summary") {
				row1.push(react_jsx_runtime.jsx("span", { className: "dsh-tree-node-text", children: (node.expanded ? "▾ " : "▸ ") + "+" + node.subCount + " 子任务" }, "sum"));
				row2.push(react_jsx_runtime.jsx("span", { className: "dsh-tree-node-meta", children: shortCode(node.sessionId) + " 的子代理会话" }, "sid"));
			} else if (node.kind === "subagent") {
				row1.push(react_jsx_runtime.jsx("span", { className: "dsh-tree-node-text", children: "子任务 #" + node.index }, "sub"));
				if (node.running) row1.push(react_jsx_runtime.jsx(Badge, { kind: "live", children: "运行中" }, "run"));
				row2.push(react_jsx_runtime.jsx("span", { className: "dsh-tree-node-meta", children: shortCode(node.sessionId) }, "sid"));
				row2.push(react_jsx_runtime.jsx("span", { children: node.turnCount === null ? "无轮次数据" : node.turnCount + " 轮" }, "cnt"));
			} else if (node.kind === "empty-group") {
				row1.push(react_jsx_runtime.jsx("span", { className: "dsh-tree-node-text", children: (node.expanded ? "▾ " : "▸ ") + node.count + " 个空会话 / 无轮次数据" }, "grp"));
			} else if (node.kind === "empty-session") {
				row1.push(react_jsx_runtime.jsx("span", { className: "dsh-tree-node-text", children: node.sessionTitle }, "title"));
				row2.push(react_jsx_runtime.jsx("span", { children: shortCode(node.sessionId) }, "sid"));
				row2.push(react_jsx_runtime.jsx("span", { children: "无轮次" }, "none"));
			}

			// 有悬停动作条的卡片：第一行留出「第 N 轮」胶囊、第二行留出动作条的位置，
			// 动作展开时只挤压（ellipsis）元信息，绝不压到文字上。
			if (actions.length > 0) cardClass += " has-actions";

			var draggable = node.kind === "turn" && node.isHead === true;

			return react_jsx_runtime.jsx("div", {
				className: "dsh-tree-node",
				style: props.pos ? { left: props.pos.left, top: props.pos.top, width: props.pos.width, height: props.pos.height } : { top: node.row * ROW_H, height: ROW_H },
				children: react_jsx_runtime.jsx("div", {
					className: cardClass,
					"data-lane": String(node.lane || 0),
					"data-node-id": node.id,
					style: props.pos ? { marginLeft: 0 } : { marginLeft: (node.lane * LANE_W + LANE_PAD * 2) + CARD_GAP + (cardClass.indexOf("head") >= 0 ? 0 : 8) },
					draggable: draggable,
					
					onDragStart: function (e) {
						try { e.dataTransfer.setData("text/tree-branch", node.sessionId); } catch {}
						if (props.onDragStart) props.onDragStart(node.sessionId);
					},
					onDragEnd: function () { if (props.onDragEnd) props.onDragEnd(); },
					onDragOver: function (e) {
						e.preventDefault();
						if (props.onDragOver) props.onDragOver(node);
					},
					onDrop: function (e) {
						e.preventDefault();
						var draggedId = "";
						try { draggedId = e.dataTransfer.getData("text/tree-branch"); } catch {}
						if (draggedId && props.onReorder) props.onReorder(draggedId, node.sessionId);
						if (props.onDragEnd) props.onDragEnd();
					},
					onClick: function (e) {
						if (props.draggedRef && props.draggedRef.current === true) return;
						if (props.onActivate) props.onActivate(node, e);
					},
					onContextMenu: function (e) {
						e.preventDefault();
						e.stopPropagation();
						if (props.onContextMenu) props.onContextMenu(node, e);
					},
					children: [
						chip,
							react_jsx_runtime.jsx("div", { className: "dsh-tree-node-row1", children: row1 }, "r1"),
						node.kind === "turn" && node.response ? react_jsx_runtime.jsx("div", { className: "dsh-tree-node-reply", children: truncate(node.response, 120) }, "rp") : null,
						row2.length > 0 ? react_jsx_runtime.jsx("div", { className: "dsh-tree-node-row2", children: row2 }, "r2") : null,
						actions.length > 0 ? react_jsx_runtime.jsx("div", { className: "dsh-tree-actions", children: actions }, "acts") : null
					]
				}, "card")
			});
		}

		/** SVG 图层：轨道脊线 + 分叉圆角曲线 + 节点圆点（只画视口内）。 */
		function GraphSvg(props) {
			var graph = props.graph;
			var winTop = props.winTop;
			var winBottom = props.winBottom;
			var children = [];
			function y(row) { return row * ROW_H + 19; }
			function x(lane) { return LANE_PAD + lane * LANE_W; }
			/** 这条脊线 / 分叉边是否属于当前会话所在的分支（与圆点的 isActive 同一判据）。 */
			function isActiveLane(branchId) {
				return branchId !== void 0 && branchId !== null && branchId === props.activeSessionId;
			}

			function vline(key, lane, y0, y1, cls, color, dash) {
				var a = Math.max(y0, winTop);
				var b = Math.min(y1, winBottom);
				if (b - a < 0.5) return null;
				return react_jsx_runtime.jsx(
					"line",
					{ x1: x(lane), y1: a, x2: x(lane), y2: b, className: "dsh-tree-lane-line " + cls, stroke: color, strokeDasharray: dash },
					key
				);
			}

			graph.spines.forEach(function (spine, i) {
				var cls = isActiveLane(spine.branchId) ? "active" : "";
				var line = vline("sp" + i, spine.lane, y(spine.fromRow), y(spine.toRow), cls, spine.color, spine.fromRow === spine.toRow ? "2 3" : void 0);
				if (line !== null) children.push(line);
			});

			graph.edges.forEach(function (edge, i) {
				var xa = x(edge.fromLane);
				var xb = x(edge.toLane);
				var ya = y(edge.fromRow);
				var yb = y(edge.toRow);
				var r = Math.min(9, Math.max(3, (yb - ya) / 2));
				var knee = yb - r;
				var edgeCls = isActiveLane(edge.branchId) ? "fork active" : "fork";
				if (xa === xb) {
					var sameLine = vline("eg" + i, edge.fromLane, ya, yb, edgeCls, edge.color);
					if (sameLine !== null) children.push(sameLine);
					return;
				}
				var v = vline("egv" + i, edge.fromLane, ya, knee, edgeCls, edge.color);
				if (v !== null) children.push(v);
				if (knee > winBottom + ROW_H || yb < winTop - ROW_H) return;
				children.push(
					react_jsx_runtime.jsx(
						"path",
						{
							d: "M " + xa + " " + knee + " Q " + xa + " " + yb + " " + (xa + r) + " " + yb + " L " + xb + " " + yb,
							className: "dsh-tree-lane-line " + edgeCls,
							stroke: edge.color
						},
						"egc" + i
					)
				);
			});

			var firstRow = Math.max(0, Math.floor(winTop / ROW_H) - 1);
			var lastRow = Math.min(graph.rowCount - 1, Math.ceil(winBottom / ROW_H) + 1);
			for (var row = firstRow; row <= lastRow; row++) {
				var node = graph.nodes[row];
				if (node === void 0 || node.kind === "gap") continue;
				var isActive = node.sessionId !== void 0 && node.sessionId === props.activeSessionId;
				var color = LANE_COLORS[node.lane % LANE_COLORS.length];
				var radius = isActive ? 5 : node.isHead === true || node.kind === "sub-summary" || node.kind === "empty-group" ? 4.5 : 3.5;
				children.push(
					react_jsx_runtime.jsx(
						"circle",
						{
							cx: x(node.lane),
							cy: y(node.row),
							r: radius,
							fill: node.kind === "turn" || node.kind === "empty-branch" ? color : "rgba(28,30,36,.95)",
							stroke: color,
							className: "dsh-tree-dot" + (isActive ? " active" : "")
						},
						"dot" + row
					)
				);
			}

			return react_jsx_runtime.jsx("svg", {
				className: "dsh-tree-graph-svg",
				width: graph.gutter,
				height: props.height,
				children: children
			});
		}

		/**
		 * 图视图：固定行高的虚拟化滚动容器。
		 * 性能方案 =「默认折叠（每分支最近 3 轮 + 分叉点）」+「视口外不渲染 DOM」：
		 * 容器高度按行数撑开（滚动条正确），但只有视口 ± OVERSCAN 行的
		 * 卡片与 SVG 元素真的进 DOM。
		 */
		/**
		 * 缩略图：把整张图的"行 → 车道"压成 52×44 的小图，叠一个视口框；点/拖它就把主视图滚过去。
		 * 只读 graph.nodes 的 row/lane，不改任何数据；行数大时按 step 下采样，最多画 ~90 条。
		 */
		function TreeMap(props) {
			var W = 52;
			var H = 44;
			var total = Math.max(1, props.total);
			var step = Math.max(1, Math.ceil(total / 90));
			var bars = [];
			for (var r = 0; r < total; r += step) {
				var n = props.nodes[r];
				if (n === void 0 || n === null) continue;
				var y = Math.round((r / total) * (H - 2));
				var x = Math.min(W - 6, 2 + (Number(n.lane) || 0) * 3);
				bars.push(react_jsx_runtime.jsx("rect", {
					className: "bar",
					x: x,
					y: y,
					width: 3,
					height: 1.2,
					rx: 0.6,
					opacity: n.isHead === true ? 0.85 : 0.45
				}, "m" + r));
			}
			var span = total * ROW_H;
			var vh = Math.max(4, Math.min(H, Math.round((props.viewportH / Math.max(1, span)) * H)));
			var vy = Math.max(0, Math.min(H - vh, Math.round((props.scrollTop / Math.max(1, span)) * H)));
			function seek(e) {
				var rect = e.currentTarget.getBoundingClientRect();
				var ratio = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0;
				ratio = Math.max(0, Math.min(1, ratio));
				if (typeof props.onSeek === "function") props.onSeek(ratio * span);
			}
			return react_jsx_runtime.jsx("div", {
				className: "dsh-tree-map",
				style: props.style || null,
				title: "缩略图：点这里跳转",
				role: "img",
				"aria-label": "缩略图，点击跳转",
				onClick: seek,
				children: react_jsx_runtime.jsx("svg", {
					width: W,
					height: H,
					viewBox: "0 0 " + W + " " + H,
					children: [
						react_jsx_runtime.jsx("rect", { className: "dsh-tree-map-view", x: 0, y: vy, width: W, height: vh, rx: 2 }, "view"),
						bars
					]
				}, "svg")
			}, "map");
		}

		function GraphView(props) {
			var graph = props.graph;
			var viewportRef = React.useRef(null);
			var scrollState = React.useState(0);
			var scrollTop = scrollState[0];
			var setScrollTop = scrollState[1];
			var sizeState = React.useState(420);
			var viewportH = sizeState[0];
			var setViewportH = sizeState[1];
			var overState = React.useState(null);
			var overId = overState[0];
			var setOverId = overState[1];
			var draggedRef = React.useRef(false);

			React.useEffect(function () {
				var el = viewportRef.current;
				if (el === null) return;
				function onScroll() { setScrollTop(el.scrollTop); }
				function measure() { setViewportH(el.clientHeight || 420); }
				el.addEventListener("scroll", onScroll, { passive: true });
				measure();
				var raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(measure) : null;
				window.addEventListener("resize", measure);
				return function () {
					el.removeEventListener("scroll", onScroll);
					window.removeEventListener("resize", measure);
					if (raf !== null) cancelAnimationFrame(raf);
				};
			}, []);

			// 打开面板 / 点了"定位"时把指定行滚进视野。
			React.useEffect(function () {
				if (props.focus === null || props.focus === void 0) return;
				var el = viewportRef.current;
				if (el === null) return;
				var top = props.focus.row * ROW_H - Math.max(0, el.clientHeight / 2 - ROW_H);
				if (typeof el.scrollTo === "function") el.scrollTo({ top: Math.max(0, top), behavior: "auto" });
				else el.scrollTop = Math.max(0, top);
			}, [props.focus]);

			var total = graph.rowCount;
			var winTop = Math.max(0, scrollTop - OVERSCAN * ROW_H);
			var winBottom = Math.min(total * ROW_H, scrollTop + viewportH + OVERSCAN * ROW_H);
			var firstRow = Math.max(0, Math.floor(winTop / ROW_H));
			var lastRow = Math.min(total - 1, Math.ceil(winBottom / ROW_H));
			var visible = [];
			for (var row = firstRow; row <= lastRow; row++) if (graph.nodes[row] !== void 0) visible.push(graph.nodes[row]);

			return react_jsx_runtime.jsx("div", {
				className: "dsh-tree-graph" + (UI2 ? " dsh-tree-graph-v2" : ""),
				ref: viewportRef,
				onContextMenu: function (e) { e.preventDefault(); },
				children: [react_jsx_runtime.jsx("div", {
					className: "dsh-tree-graph-inner",
					style: { height: Math.max(ROW_H, total * ROW_H) },
					children: [
						react_jsx_runtime.jsx(
							GraphSvg,
							{
								graph: graph,
								height: Math.max(ROW_H, total * ROW_H),
								winTop: winTop,
								winBottom: winBottom,
								activeSessionId: props.activeSessionId
							},
							"svg"
						),
						visible.map(function (node) {
							var mark = props.marksOf(node.sessionId);
							return react_jsx_runtime.jsx(
								GraphNodeCard,
								{
									node: node,
									graph: graph,
									activeSessionId: props.activeSessionId,
									flashNodeId: props.flashNodeId,
									dropTargetId: overId,
									draggedRef: draggedRef,
									star: mark.star,
									archive: mark.archive,
									onActivate: props.onActivateNode,
									onContextMenu: props.onNodeContextMenu,
									onToggleMark: props.onToggleMark,
									onJumpToChild: props.onJumpToChild,
									onQuickFork: props.onQuickFork,
									onLocate: props.onLocate,
									onDragStart: function () { draggedRef.current = true; },
									onDragOver: function (n) { if (n.kind === "turn" && n.isHead === true) setOverId(n.id); },
									onDragEnd: function () {
										setOverId(null);
										if (typeof setTimeout === "function") setTimeout(function () { draggedRef.current = false; }, 0);
									},
									onReorder: props.onReorder
								},
								node.id
							);
						})
					]
				}), UI2 ? react_jsx_runtime.jsx(TreeMap, {
					nodes: graph.nodes,
					total: total,
					scrollTop: scrollTop,
					viewportH: viewportH,
					onSeek: function (top) {
						var el = viewportRef.current;
						if (el !== null) el.scrollTop = top;
					},
					style: (function () {
						// 缩略图挂在滚动容器里会跟着内容滚走：改成 fixed，坐标由视口矩形算，
						// 滚动时每次 re-render 重算，所以它始终贴在面板右下角。
						var el = viewportRef.current;
						if (el === null || typeof el.getBoundingClientRect !== "function") return { display: "none" };
						var r = el.getBoundingClientRect();
						return {
							right: Math.max(8, (window.innerWidth || 0) - r.right + 8) + "px",
							bottom: Math.max(8, (window.innerHeight || 0) - r.bottom + 8) + "px"
						};
					})()
				}, "map") : null]
			});
		}

		/** 右键菜单（fixed 定位，点外面 / Esc 都关）。 */
		function NodeMenu(props) {
			var menu = props.menu;
			React.useEffect(function () {
				if (menu === null) return;
				function onDoc(e) {
					var el = document.querySelector(".dsh-tree-menu");
					if (el !== null && el.contains(e.target)) return;
					props.onClose();
				}
				function onKey(e) { if (e.key === "Escape") props.onClose(); }
				window.addEventListener("pointerdown", onDoc, true);
				window.addEventListener("keydown", onKey, true);
				return function () {
					window.removeEventListener("pointerdown", onDoc, true);
					window.removeEventListener("keydown", onKey, true);
				};
			}, [menu]);
			if (menu === null) return null;
			var items = menu.items.map(function (item, i) {
				if (item.separator === true) return react_jsx_runtime.jsx("div", { className: "dsh-tree-menu-sep" }, "sep" + i);
				return react_jsx_runtime.jsx(
					"div",
					{
						className: "dsh-tree-menu-item" + (item.warn === true ? " warn" : ""),
						onClick: function (e) {
							e.stopPropagation();
							props.onClose();
							item.run();
						},
						children: item.label
					},
					item.key
				);
			});
			var maxLeft = typeof window !== "undefined" ? Math.max(8, window.innerWidth - 240) : menu.x;
			var maxTop = typeof window !== "undefined" ? Math.max(8, window.innerHeight - 180) : menu.y;
			return react_jsx_runtime.jsx("div", {
				className: "dsh-tree-menu",
				style: { left: Math.min(menu.x, maxLeft), top: Math.min(menu.y, maxTop) },
				onContextMenu: function (e) { e.preventDefault(); },
				children: [react_jsx_runtime.jsx("div", { className: "dsh-tree-menu-head", title: menu.headTitle, children: menu.head }, "head")].concat(items)
			});
		}

		/* ---------- 画布模式（第 1 轮：几何 + 视口 + 平移缩放） ---------- */
		var COL_W = 300;        // 一条分支占的列宽
		var COL_GAP = 26;       // 列内卡片右侧留白
		var CLUSTER_GAP = 56;   // 簇（工作区）之间的间距
		var CLUSTER_HEAD = 30;  // 簇标题行高
		var CANVAS_PAD = 18;

		/**
		 * 把紧凑布局的结果（每节点已有 row / lane）映射到画布坐标：
		 * 按工作区分簇 → 簇内分支成列 → 簇间横向排布。
		 * 行在簇内归零（每簇从顶部开始），所以一簇的高 = 该簇自己的行数。
		 */
		function layoutCanvas(graph) {
			var nodes = graph.nodes || [];
			var groups = new Map();
			var order = [];
			for (var i = 0; i < nodes.length; i++) {
				var n = nodes[i];
				var key = n.workspace ? String(n.workspace) : "未分组";
				var g = groups.get(key);
				if (g === void 0) {
					g = { key: key, title: key, nodes: [], minRow: Infinity, maxRow: -Infinity, maxLane: 0 };
					groups.set(key, g);
					order.push(g);
				}
				g.nodes.push(n);
				if (n.row < g.minRow) g.minRow = n.row;
				if (n.row > g.maxRow) g.maxRow = n.row;
				if ((n.lane || 0) > g.maxLane) g.maxLane = n.lane || 0;
			}
			var x = CANVAS_PAD;
			var maxH = 0;
			for (var gi = 0; gi < order.length; gi++) {
				var cl = order[gi];
				var rows = cl.maxRow - cl.minRow + 1;
				cl.index = gi;
				cl.x = x;
				cl.width = (cl.maxLane + 1) * COL_W;
				cl.height = CLUSTER_HEAD + rows * ROW_H + 12;
				for (var k = 0; k < cl.nodes.length; k++) {
					var m = cl.nodes[k];
					m.cx = cl.x + (m.lane || 0) * COL_W + 28;
					m.cy = CLUSTER_HEAD + (m.row - cl.minRow) * ROW_H;
					m.cw = COL_W - COL_GAP;
				}
				if (cl.height > maxH) maxH = cl.height;
				x += cl.width + CLUSTER_GAP;
			}
			graph.mode = "canvas";
			graph.clusters = order;
			graph.canvasWidth = Math.max(x, 320);
			graph.canvasHeight = Math.max(maxH, 200);
			return graph;
		}

		/** 画布里的连线：每支一条竖脊 + 分叉处的 90° 圆角拐弯。 */
		function CanvasSvg(props) {
			var graph = props.graph;
			var byId = new Map();
			var anchor = new Map();
			var lastOf = new Map();
			for (var i = 0; i < graph.nodes.length; i++) {
				var n = graph.nodes[i];
				byId.set(n.id, n);
				var b = n.branchId || n.sessionId;
				if (b && !anchor.has(b)) anchor.set(b, n);
				if (b) lastOf.set(b, n);
			}
			var els = [];
			(graph.spines || []).forEach(function (sp, idx) {
				var a = anchor.get(sp.branchId);
				var z = lastOf.get(sp.branchId);
				if (!a || !z) return;
				var railX = a.cx - 16;
				els.push(react_jsx_runtime.jsx("line", {
					x1: railX, y1: a.cy + ROW_H / 2, x2: railX, y2: z.cy + ROW_H / 2,
					className: "dsh-tree-lane-line", stroke: sp.color, opacity: 0.32
				}, "sp" + idx));
			});
			(graph.edges || []).forEach(function (e, idx) {
				var from = byId.get(e.fromNodeId);
				var to = byId.get(e.toNodeId);
				if (!from || !to) return;
				var x1 = from.cx - 16, y1 = from.cy + ROW_H / 2;
				var x2 = to.cx - 16, y2 = to.cy + 20;
				var r = 16;
				var d = "M " + x1 + " " + y1 + " L " + x1 + " " + (y2 - r) + " Q " + x1 + " " + y2 + " " + (x1 + r) + " " + y2 + " L " + x2 + " " + y2;
				els.push(react_jsx_runtime.jsx("path", {
					d: d, className: "dsh-tree-lane-line fork", stroke: e.color, fill: "none", opacity: 0.55
				}, "eg" + idx));
			});
			return react_jsx_runtime.jsx("svg", {
				className: "dsh-tree-canvas-svg",
				width: graph.canvasWidth,
				height: graph.canvasHeight,
				children: els
			});
		}

		/** 画布视图：2D 视口裁剪 + 滚轮缩放（指针为锚）+ 拖空白平移。 */
		function CanvasView(props) {
			var graph = props.graph;
			var hostRef = React.useRef(null);
			var viewState = React.useState(null);
			var view = viewState[0];
			var setView = viewState[1];
			var sizeState = React.useState({ w: 640, h: 520 });
			var size = sizeState[0];
			var setSize = sizeState[1];

			function fitView() {
				var cw = graph.canvasWidth || 1;
				var ch = graph.canvasHeight || 1;
				var z = Math.min(1, Math.min((size.w - 24) / cw, (size.h - 24) / ch));
				return { x: 12, y: 10, z: Math.max(0.42, Math.min(1.6, z)) };
			}

			React.useEffect(function () {
				var el = hostRef.current;
				if (el === null) return;
				function measure() { setSize({ w: el.clientWidth || 640, h: el.clientHeight || 520 }); }
				measure();
				window.addEventListener("resize", measure);
				var ro = null;
				try { if (typeof ResizeObserver === "function") { ro = new ResizeObserver(measure); ro.observe(el); } } catch (err) {}
				return function () {
					window.removeEventListener("resize", measure);
					try { if (ro) ro.disconnect(); } catch (err) {}
				};
			}, []);

			React.useEffect(function () { setView(fitView()); }, [size.w, size.h, graph.canvasWidth, graph.canvasHeight]);

			React.useEffect(function () {
				var el = hostRef.current;
				if (el === null) return;
				function onWheel(e) {
					e.preventDefault();
					var rect = el.getBoundingClientRect();
					var px = e.clientX - rect.left;
					var py = e.clientY - rect.top;
					setView(function (v) {
						var base = v || fitView();
						var nz = Math.max(0.42, Math.min(1.6, base.z * (e.deltaY > 0 ? 0.92 : 1.08)));
						var k = nz / base.z;
						return { x: px - (px - base.x) * k, y: py - (py - base.y) * k, z: nz };
					});
				}
				el.addEventListener("wheel", onWheel, { passive: false });
				return function () { el.removeEventListener("wheel", onWheel); };
			}, []);

			var dragRef = React.useRef(null);
			function onPointerDown(e) {
				if (e.button !== 0) return;
				var el = hostRef.current;
				if (el === null) return;
				var t = e.target;
				var onEmpty = t === el || (t && t.classList && (t.classList.contains("dsh-tree-canvas-inner") || t.classList.contains("dsh-tree-canvas-svg")));
				if (!onEmpty) return;
				var base = view || fitView();
				dragRef.current = { x: e.clientX, y: e.clientY, vx: base.x, vy: base.y };
				try { el.setPointerCapture(e.pointerId); } catch (err) {}
			}
			function onPointerMove(e) {
				var d = dragRef.current;
				if (d === null) return;
				var dx = e.clientX - d.x;
				var dy = e.clientY - d.y;
				setView(function (v) {
					var b = v || fitView();
					return { x: d.vx + dx, y: d.vy + dy, z: b.z };
				});
			}
			function onPointerUp() { dragRef.current = null; }

			var v = view || fitView();
			var z = v.z;
			var vx0 = -v.x / z;
			var vy0 = -v.y / z;
			var vx1 = (-v.x + size.w) / z;
			var vy1 = (-v.y + size.h) / z;
			var visible = [];
			for (var i = 0; i < graph.nodes.length; i++) {
				var n = graph.nodes[i];
				if (n.cx === void 0) continue;
				if (n.cx + n.cw < vx0 - 60 || n.cx > vx1 + 60) continue;
				if (n.cy + ROW_H < vy0 - 60 || n.cy > vy1 + 60) continue;
				visible.push(n);
			}

			return react_jsx_runtime.jsx("div", {
				className: "dsh-tree-graph dsh-tree-canvas",
				ref: hostRef,
				onPointerDown: onPointerDown,
				onPointerMove: onPointerMove,
				onPointerUp: onPointerUp,
				onPointerCancel: onPointerUp,
				onContextMenu: function (e) { e.preventDefault(); },
				children: [
					react_jsx_runtime.jsx("div", {
						className: "dsh-tree-canvas-inner",
						style: { width: graph.canvasWidth, height: graph.canvasHeight, transform: "translate(" + v.x + "px," + v.y + "px) scale(" + z + ")" },
						children: [
							react_jsx_runtime.jsx(CanvasSvg, { graph: graph }, "svg"),
							graph.clusters.map(function (cl) {
								return react_jsx_runtime.jsx("div", {
									className: "dsh-tree-cluster-tag",
									style: { left: cl.x, top: 6 },
									children: cl.title + " · " + (cl.maxLane + 1) + " 支"
								}, "cl" + cl.index);
							}),
							visible.map(function (node) {
								var mark = props.marksOf(node.sessionId);
								return react_jsx_runtime.jsx(GraphNodeCard, {
									node: node,
									graph: graph,
									activeSessionId: props.activeSessionId,
									flashNodeId: props.flashNodeId,
									dropTargetId: null,
									draggedRef: null,
									star: mark.star,
									archive: mark.archive,
									onActivate: props.onActivateNode,
									onContextMenu: props.onNodeContextMenu,
									onToggleMark: props.onToggleMark,
									onJumpToChild: props.onJumpToChild,
									onQuickFork: props.onQuickFork,
									onLocate: props.onLocate,
									onReorder: props.onReorder,
									pos: { left: node.cx, top: node.cy, width: node.cw, height: ROW_H }
								}, node.id);
							})
						]
					}),
					react_jsx_runtime.jsx("div", {
						className: "dsh-tree-zoom",
						children: [
							react_jsx_runtime.jsx("button", {
								title: "缩小",
								onClick: function () { setView(function (vv) { var b = vv || fitView(); return { x: b.x, y: b.y, z: Math.max(0.42, b.z * 0.88) }; }); },
								children: "−"
							}),
							react_jsx_runtime.jsx("span", { children: Math.round(z * 100) + "%" }),
							react_jsx_runtime.jsx("button", {
								title: "放大",
								onClick: function () { setView(function (vv) { var b = vv || fitView(); return { x: b.x, y: b.y, z: Math.min(1.6, b.z * 1.14) }; }); },
								children: "+"
							}),
							react_jsx_runtime.jsx("button", { title: "适应窗口", onClick: function () { setView(fitView()); }, children: "⤢" })
						]
					}, "zoom")
				]
			});
		}

		/**
		 * 画布渲染的兜底。必须是真正的 ES class —— React.Component 是 class，
		 * 用 React.Component.call(this) 会直接抛 TypeError，而错误发生在边界自己身上，
		 * 边界捕不到自己，于是整块面板空白（v12 的 bug 就这么来的）。
		 */
		function CanvasBoundary(props) {
			return react_jsx_runtime.jsx(CanvasBoundaryImpl, props);
		}

		var CanvasBoundaryImpl = class extends React.Component {
			constructor(props) {
				super(props);
				this.state = { err: null };
			}
			static getDerivedStateFromError(err) {
				return { err: err };
			}
			componentDidCatch(err) {
				try { markCanvasBroken(err); } catch (e) {}
			}
			render() {
				if (this.state && this.state.err) {
					var msg = this.state.err && this.state.err.message ? this.state.err.message : String(this.state.err);
					return react_jsx_runtime.jsx("div", {
						className: "dsh-tree-canvas-fail",
						children: [
							react_jsx_runtime.jsx("div", { className: "msg", children: "画布渲染失败，已退回列表 · " + BUILD_TAG + " · " + msg }, "m"),
							react_jsx_runtime.jsx(GraphView, this.props, "list")
						]
					});
				}
				return react_jsx_runtime.jsx(CanvasView, this.props);
			}
		};


		/* ---------- 画布浮层（纯 DOM，已用假数据验证过渲染） ---------- */
		var TPC_NS = "http://www.w3.org/2000/svg";
		var TPC_W = 250, TPC_H = 66, TPC_COL = 46, TPC_ROW = 34, TPC_GAP = 70, TPC_HEAD = 34;

		function tpcSessions(ctx) {
			try {
				var snap = ctx.sessions.list.getSnapshot();
				var ids = snap.ids || [];
				var out = [];
				var seen = new Set();
				for (var i = 0; i < ids.length; i++) {
					var row = snap.byId ? snap.byId[ids[i]] : null;
					if (!row) continue;
					if (seen.has(row.id)) continue;
					seen.add(row.id);
					out.push({
						id: row.id,
						title: row.displayTitle || row.title || (row.cwd ? String(row.cwd).split(/[\\/]/).pop() : row.id.slice(-8)),
						parentId: row.parentId || null,
						turns: row.projectionValues && row.projectionValues.turnOutline ? row.projectionValues.turnOutline.length : 0,
						current: snap.current === row.id
					});
				}
				return out;
			} catch (err) { return []; }
		}

		function tpcLayout(sessions) {
			var byId = new Map();
			for (var i = 0; i < sessions.length; i++) byId.set(sessions[i].id, sessions[i]);
			var children = new Map();
			var roots = [];
			for (var j = 0; j < sessions.length; j++) {
				var x = sessions[j];
				var pid = x.parentId && byId.has(x.parentId) ? x.parentId : null;
				if (pid === null) { roots.push(x); continue; }
				if (!children.has(pid)) children.set(pid, []);
				children.get(pid).push(x);
			}
			var clusters = [], nodes = [], edges = [];
			for (var c = 0; c < roots.length; c++) {
				var rowState = { v: 0 };
				var list = [];
				var stack = [{ s: roots[c], lane: 0, parent: null }];
				while (stack.length) {
					var it = stack.pop();
					var n = { session: it.s, lane: it.lane, row: rowState.v++, parent: it.parent };
					list.push(n);
					if (it.parent) edges.push({ from: it.parent, to: n });
					var kids = children.get(it.s.id) || [];
					for (var k = kids.length - 1; k >= 0; k--) stack.push({ s: kids[k], lane: Math.min(3, it.lane + 1), parent: n });
				}
				var maxLane = 0, maxRow = 0;
				for (var m = 0; m < list.length; m++) { if (list[m].lane > maxLane) maxLane = list[m].lane; if (list[m].row > maxRow) maxRow = list[m].row; }
				clusters.push({ nodes: list, width: (maxLane + 1) * (TPC_W + TPC_COL) + 40, height: TPC_HEAD + (maxRow + 1) * (TPC_H + TPC_ROW) + 20 });
			}
			/* 簇纵向堆叠：一列排下去，绝不重叠 */
			var w = 0, y = 24;
			for (var q = 0; q < clusters.length; q++) {
				var cl = clusters[q];
				cl.x = 24;
				cl.y = y;
				for (var z = 0; z < cl.nodes.length; z++) {
					var nn = cl.nodes[z];
					nn.x = cl.x + 24 + nn.lane * (TPC_W + TPC_COL);
					nn.y = cl.y + TPC_HEAD + nn.row * (TPC_H + TPC_ROW);
					nodes.push(nn);
				}
				if (cl.x + cl.width > w) w = cl.x + cl.width;
				y += cl.height + TPC_GAP;
			}
			var h = y;
			return { nodes: nodes, edges: edges, width: Math.max(w, 400), height: Math.max(h, 300) };
		}

		function openTreeCanvas(ctx, rect, onClose) {
			var CSSID = "dshtp-canvas-css";
			if (!document.getElementById(CSSID)) {
				var st = document.createElement("style");
				st.id = CSSID;
				st.textContent = ""
					+ ".dshtp-layer{position:fixed;z-index:10050;user-select:none;-webkit-user-select:none;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#1f2329);"
					+ "color:var(--dsw-alias-label-primary,#e8eaed);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));border-radius:14px;overflow:hidden;"
					+ "box-shadow:0 20px 56px rgba(0,0,0,.45);font:13px/1.4 'Segoe UI','Microsoft YaHei',system-ui}"
					+ ".dshtp-bar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.08)}"
					+ ".dshtp-name{flex:1;font-weight:600;font-size:12.5px}"
					+ ".dshtp-name span{font-weight:400;font-size:10.5px;color:var(--dsw-alias-label-secondary,#98a0ab);margin-left:6px}"
					+ ".dshtp-b{border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#98a0ab);font-size:12px;padding:4px 8px;cursor:pointer}"
					+ ".dshtp-b:hover{background:rgba(128,128,128,.16);color:var(--dsw-alias-label-primary,#e8eaed)}"
					+ ".dshtp-cv{position:relative;flex:1;min-height:0;overflow:hidden;cursor:grab;"
					+ "background-image:radial-gradient(rgba(140,150,165,.22) 1px,transparent 1px);background-size:16px 16px;touch-action:none}"
					+ ".dshtp-cv:active{cursor:grabbing}"
					+ ".dshtp-in{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}"
					+ ".dshtp-c{position:absolute;box-sizing:border-box;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:rgba(255,255,255,.03);"
					+ "padding:8px 10px;overflow:hidden;cursor:pointer}"
					+ ".dshtp-c:hover{border-color:rgba(255,255,255,.22);background:rgba(255,255,255,.06)}"
					+ ".dshtp-c.on{box-shadow:0 0 0 1.5px var(--dsw-alias-brand-primary,#7aa2f0)}"
					+ ".dshtp-t{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
					+ ".dshtp-m{font-size:10px;color:var(--dsw-alias-label-secondary,#98a0ab);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
					+ ".dshtp-z{position:absolute;right:10px;bottom:10px;display:flex;align-items:center;gap:2px;padding:3px;border-radius:999px;"
					+ "background:rgba(30,34,41,.94);border:1px solid rgba(255,255,255,.1)}"
					+ ".dshtp-z button{width:24px;height:22px;border:0;border-radius:999px;background:transparent;color:#c7ccd4;font-size:12px;cursor:pointer}"
					+ ".dshtp-z span{font-size:10px;color:#98a0ab;min-width:34px;text-align:center}";
				document.head.appendChild(st);
			}

			var view = { x: 14, y: 12, z: 1 };
			var pan = null;
			var layer = document.createElement("div");
			layer.className = "dshtp-layer";
			layer.style.left = Math.round(rect.left) + "px";
			layer.style.top = Math.round(rect.top) + "px";
			layer.style.width = Math.round(rect.width) + "px";
			layer.style.height = Math.round(rect.height) + "px";

			var bar = document.createElement("div");
			bar.className = "dshtp-bar";
			var name = document.createElement("div");
			name.className = "dshtp-name";
			name.textContent = "会话树";
			var cnt = document.createElement("span");
			name.appendChild(cnt);
			var back = document.createElement("button");
			back.className = "dshtp-b";
			back.textContent = "☰ 列表";
			var fitBtn = document.createElement("button");
			fitBtn.className = "dshtp-b";
			fitBtn.textContent = "⤢";
			bar.appendChild(name); bar.appendChild(fitBtn); bar.appendChild(back);

			var cv = document.createElement("div");
			cv.className = "dshtp-cv";
			var inner = document.createElement("div");
			inner.className = "dshtp-in";
			cv.appendChild(inner);

			var zoom = document.createElement("div");
			zoom.className = "dshtp-z";
			var out = document.createElement("button"); out.textContent = "−";
			var lbl = document.createElement("span"); lbl.textContent = "100%";
			var inn = document.createElement("button"); inn.textContent = "+";
			var fit2 = document.createElement("button"); fit2.textContent = "⤢";
			zoom.appendChild(out); zoom.appendChild(lbl); zoom.appendChild(inn); zoom.appendChild(fit2);
			cv.appendChild(zoom);

			layer.appendChild(bar);
			layer.appendChild(cv);
			document.body.appendChild(layer);

			var sessions = tpcSessions(ctx);
			var graph = tpcLayout(sessions);
			cnt.textContent = sessions.length + " 会话 · " + graph.width + "×" + graph.height;
			inner.style.width = graph.width + "px";
			inner.style.height = graph.height + "px";

			var svg = document.createElementNS(TPC_NS, "svg");
			svg.setAttribute("style", "position:absolute;left:0;top:0;pointer-events:none;overflow:visible");
			svg.setAttribute("width", graph.width);
			svg.setAttribute("height", graph.height);
			inner.appendChild(svg);
			for (var i = 0; i < graph.edges.length; i++) {
				var e = graph.edges[i];
				var x1 = e.from.x + 20, y1 = e.from.y + TPC_H;
				var x2 = e.to.x + 20, y2 = e.to.y;
				var my = (y1 + y2) / 2;
				var pth = document.createElementNS(TPC_NS, "path");
				pth.setAttribute("d", "M " + x1 + " " + y1 + " L " + x1 + " " + my + " L " + x2 + " " + my + " L " + x2 + " " + y2);
				pth.setAttribute("fill", "none");
				pth.setAttribute("stroke", "rgba(126,196,255,.5)");
				pth.setAttribute("stroke-width", "1.5");
				svg.appendChild(pth);
			}
			for (var j = 0; j < graph.nodes.length; j++) {
				var n = graph.nodes[j];
				var card = document.createElement("div");
				card.className = "dshtp-c" + (n.session.current ? " on" : "");
				card.style.left = n.x + "px"; card.style.top = n.y + "px";
				card.style.width = TPC_W + "px"; card.style.height = TPC_H + "px";
				card.title = n.session.id;
				var t = document.createElement("div"); t.className = "dshtp-t"; t.textContent = n.session.title;
				var m = document.createElement("div"); m.className = "dshtp-m";
				m.textContent = (n.session.turns ? n.session.turns + " 轮 · " : "") + n.session.id.slice(-8);
				card.appendChild(t); card.appendChild(m);
				(function (id) {
					card.addEventListener("click", function (ev) {
						ev.stopPropagation();
						if (pan && pan.moved) return;
						try {
							var ui = ctx.get && ctx.get("uiWorkspace");
							if (ui && typeof ui.openSession === "function") ui.openSession(id);
						} catch (err) {}
					});
				})(n.session.id);
				inner.appendChild(card);
			}

			function apply() {
				inner.style.transform = "translate(" + view.x + "px," + view.y + "px) scale(" + view.z + ")";
				lbl.textContent = Math.round(view.z * 100) + "%";
			}
			function fit() {
				var w = cv.clientWidth || rect.width, h = cv.clientHeight || rect.height;
				var z = Math.min(1, Math.min((w - 20) / graph.width, (h - 20) / graph.height));
				view = { x: 10, y: 10, z: Math.max(0.5, Math.min(1.3, z)) };
				apply();
			}
			apply();

			out.addEventListener("click", function () { view.z = Math.max(0.4, view.z * 0.88); apply(); });
			inn.addEventListener("click", function () { view.z = Math.min(1.5, view.z * 1.14); apply(); });
			fitBtn.addEventListener("click", fit);
			fit2.addEventListener("click", fit);
			back.addEventListener("click", function () { destroy(); if (onClose) onClose(); });

			cv.addEventListener("wheel", function (ev) {
				ev.preventDefault();
				var r = cv.getBoundingClientRect();
				var px = ev.clientX - r.left, py = ev.clientY - r.top;
				var nz = Math.max(0.4, Math.min(1.5, view.z * (ev.deltaY > 0 ? 0.92 : 1.08)));
				var k = nz / view.z;
				view.x = px - (px - view.x) * k;
				view.y = py - (py - view.y) * k;
				view.z = nz;
				apply();
			}, { passive: false });

			function onMove(ev) {
				if (!pan) return;
				var dx = ev.clientX - pan.sx, dy = ev.clientY - pan.sy;
				if (Math.abs(dx) + Math.abs(dy) > 2) pan.moved = true;
				view.x = pan.vx + dx;
				view.y = pan.vy + dy;
				apply();
			}
			function onUp() {
				pan = null;
				window.removeEventListener("pointermove", onMove, true);
				window.removeEventListener("pointerup", onUp, true);
				window.removeEventListener("pointercancel", onUp, true);
			}
			cv.addEventListener("pointerdown", function (ev) {
				if (ev.button !== 0) return;
				if (ev.target && ev.target.closest && ev.target.closest(".dshtp-b")) return;
				ev.preventDefault();
				pan = { sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y, moved: false };
				window.addEventListener("pointermove", onMove, true);
				window.addEventListener("pointerup", onUp, true);
				window.addEventListener("pointercancel", onUp, true);
			});

			function destroy() { try { layer.remove(); } catch (e) {} }
			return { el: layer, destroy: destroy, count: sessions.length };
		}

		function TreePanel(props) {
			var layout = props.layout;
			var tabs = [
				{ key: "active", label: "活跃" },
				{ key: "starred", label: "收藏" },
				{ key: "archived", label: "归档" }
			];
			var tabButtons = tabs.map(function (tab) {
				return react_jsx_runtime.jsx("button", {
					className: "dsh-tree-tab" + (props.filterTab === tab.key ? " on" : ""),
					onClick: function () { if (props.onFilter) props.onFilter(tab.key); },
					children: tab.label
				}, tab.key);
			});
			

			return react_jsx_runtime.jsx("div", {
				className: "dsh-tree-panel-overlay" + (props.light ? " dsh-tp-light" : "") + (UI2 ? " dsh-tree-v2" : ""),
				style: { width: layout.width, right: layout.right, top: layout.top },
				children: [
					react_jsx_runtime.jsx("div", {
						className: "dsh-tree-panel-header",
						onPointerDown: props.onDragHeader,
						children: [
							react_jsx_runtime.jsx("div", {
								className: "dsh-tree-panel-title",
								children: ["会话树 ", react_jsx_runtime.jsx("span", { className: "dsh-tree-panel-count", children: props.tally })]
							}),
							react_jsx_runtime.jsx("button", {
								className: "dsh-tree-panel-iconbtn",
								title: props.allExpanded ? "收回所有分支" : "展开所有分支",
								"aria-label": "展开或收回",
								onPointerDown: function (e) { e.stopPropagation(); },
								onClick: function () { if (props.onToggleExpandAll) props.onToggleExpandAll(); },
								children: props.allExpanded ? "⤡" : "⤢"
							}),
							react_jsx_runtime.jsx("button", {
								className: "dsh-tree-panel-iconbtn",
								title: "在当前会话上分叉",
								"aria-label": "分叉",
								onPointerDown: function (e) { e.stopPropagation(); },
								onClick: function () { if (props.onForkActive) props.onForkActive(); },
								children: "⑂"
							}),
							react_jsx_runtime.jsx("button", {
								className: "dsh-tree-panel-iconbtn dsh-tree-panel-modebtn",
								style: { width: "auto", minWidth: "52px", padding: "0 8px", fontSize: "11px" },
								title: props.canvasMode ? "切回列表" : "切到画布（也可以双击标题）",
								"aria-label": props.canvasMode ? "切回列表" : "画布模式",
								onPointerDown: function (e) { e.stopPropagation(); },
								onClick: props.onToggleCanvas,
								children: props.canvasMode ? "☰ 列表" : "⛶ 画布"
							}),
							react_jsx_runtime.jsx("button", { className: "dsh-tree-panel-close", onClick: props.onClose, children: "×" })
						]
					}),
					props.goal
						? react_jsx_runtime.jsx("div", {
								className: "dsh-tree-goal",
								title: props.goal.full,
								children: [
									react_jsx_runtime.jsx("span", { className: "dsh-tree-goal-label", children: "目标" }),
									props.goal.phase
										? react_jsx_runtime.jsx("span", { className: "dsh-tree-goal-phase " + props.goal.phase, children: props.goal.phaseLabel })
										: null,
									react_jsx_runtime.jsx("span", { className: "dsh-tree-goal-text", children: props.goal.text })
								]
							}, "goal")
						: null,
					react_jsx_runtime.jsx("div", {
						className: "dsh-tree-tabs",
						onPointerDown: function (e) { e.stopPropagation(); },
						children: tabButtons
					}),
					react_jsx_runtime.jsx("div", {
						className: "dsh-tree-toolbar",
						onPointerDown: function (e) { e.stopPropagation(); },
						children: react_jsx_runtime.jsx("input", {
							type: "search",
							placeholder: "搜索会话 / 轮次",
							defaultValue: props.query,
							onChange: function (e) { props.onQuery(e.target.value); }
						})
					}),
					react_jsx_runtime.jsx("div", {
						className: "dsh-tree-panel-body",
						onPointerDown: function (e) { e.stopPropagation(); },
						children:
							props.graph.rowCount > 0
								? react_jsx_runtime.jsx(
										props.graph.mode === "canvas" ? CanvasBoundary : GraphView,
										{
											graph: props.graph,
											activeSessionId: props.activeSessionId,
											flashNodeId: props.flashNodeId,
											focus: props.focus,
											marksOf: props.marksOf,
											onActivateNode: props.onActivateNode,
											onNodeContextMenu: props.onNodeContextMenu,
											onToggleMark: props.onToggleMark,
											onJumpToChild: props.onJumpToChild,
											onQuickFork: props.onQuickFork,
											onLocate: props.onLocate,
											onReorder: props.onReorder
										},
										"graph"
									)
								: react_jsx_runtime.jsx("div", {
										className: "dsh-tree-empty",
										children: props.query ? "没有匹配的会话 / 轮次" : "没有可显示的会话"
									})
					}),
					props.toast
						? react_jsx_runtime.jsx("div", {
								className: "dsh-tree-toast" + (props.toast.warn ? " warn" : ""),
								children: props.toast.text
							})
						: null,
					react_jsx_runtime.jsx(NodeMenu, { menu: props.menu, onClose: props.onMenuClose }),
										react_jsx_runtime.jsx("div", { className: "dsh-tree-panel-resize", onPointerDown: props.onResize })
				]
			});
		}

		/* ---------- 插件入口 ---------- */
		var inject = ["slots", "sessions"];

		function apply(ctx) {
			try {
				if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") {
					console.warn("[dsh-tree-panel] 当前版本无 slots API，面板未注入（安全降级）");
					return;
				}
				injectCss();

				var layout = loadLayout();
				// 用户要求：宽度/位置只在本次运行内保持，重启 DSH 后回到默认值。
				layout.width = DEFAULT_LAYOUT.width;
				layout.right = DEFAULT_LAYOUT.right;
				layout.top = DEFAULT_LAYOUT.top;
				var open = false; // 启动时不自动打开（需要时手动开）
				var container = null;
				var root = null;
				var sessionsService = ctx.sessions || (typeof ctx.get === "function" ? ctx.get("sessions") : void 0);
				var activeSessionId = null;
				var query = "";
			var queryDraft = "";
			var searchTimer = null;
				var toast = null;
				var toastTimer = null;
				var uiAnchor = null;
				var lastLocate = null;
				var toastLog = [];
				var timers = [];
				var disposed = false;
				var filterTab = "active";
				var flashNodeId = null;
				var flashTimer = null;
				var menu = null;
				var focus = null;
				var focusNonce = 0;
				var graphState = loadGraphState();
				var expandedBranches = new Set(graphState.branches);
				var expandedSubs = new Set(graphState.subs);
				var expandedEmpty = graphState.empty === true;
				var lastGraph = null;
				var lastForkFromNode = null;
				var lastCopy = null;
				var lastOpen = null;
				var lastToggle = null;
				var canvasBroken = false;
				function markCanvasBroken(err) {
					canvasBroken = true;
					try { console.warn("[dsh-tree-panel] 画布渲染失败，本次会话改用列表：", err); } catch (e) {}
				}
				/** 画布总开关：false = 永远走紧凑列表（已验证可用的形态）。 */
				var CANVAS_ENABLED = true;
				/** 画布模式：由标题栏按钮切换，默认列表。 */
				var canvasMode = false;
				var canvasError = null;
				/** 面板配色：每次创建 / 打开面板时按页面实际底色采样一次（亮 → .dsh-tp-light）。 */
				var panelLight = false;

				function persistGraphState() {
					saveGraphState({ expandedBranches: expandedBranches, expandedSubs: expandedSubs, expandedEmpty: expandedEmpty });
				}

				function trackTimer(id) {
					timers.push(id);
					return id;
				}

				/* ---- 列表快照读取（字段名按运行版本容错） ---- */
				function listSnapshot() {
					try {
						if (!sessionsService || !sessionsService.list) return null;
						var list = sessionsService.list;
						if (typeof list.getSnapshot === "function") return list.getSnapshot();
						if (typeof list.getListSnapshot === "function") return list.getListSnapshot();
						return list;
					} catch {
						return null;
					}
				}

				/** 推算某会话当前的末位 seq（分叉锚点的派生兜底）。 */
				function lastSeqOf(sessionId) {
					try {
						if (typeof sessionId !== "string" || sessionId === "") return null;
						if (typeof sessionsService.binding !== "function") return null;
						var binding = sessionsService.binding(sessionId);
						var source = binding && binding.eventSource;
						if (!source || typeof source.getSnapshot !== "function") return null;
						var view = source.getSnapshot();
						var entries = view && view.entries ? view.entries : [];
						var max = -1;
						for (var entry of entries) {
							var event = entry && entry.event ? entry.event : entry;
							if (event && Number.isFinite(event.seq) && event.seq > max) max = event.seq;
						}
						return max >= 0 ? max : null;
					} catch {
						return null;
					}
				}

				/** 把列表快照规范化成会话行（图的输入）。 */
				function sessionItems() {
					try {
						var snap = listSnapshot();
						if (snap === null || snap === void 0) return [];
						var raw = null;
						if (Array.isArray(snap.ids) && snap.byId && typeof snap.byId === "object") {
							raw = snap.ids
								.map(function (id) { return snap.byId[id]; })
								.filter(function (row) { return row !== void 0 && row !== null; });
						} else if (Array.isArray(snap.items)) {
							raw = snap.items;
						} else if (Array.isArray(snap)) {
							raw = snap;
						} else {
							return [];
						}
						return raw
							.map(function (item) {
								var id = item.id || item.sessionId;
								if (typeof id !== "string" || id === "") return null;
								var parentId = parentOf(item);
								var record = forks[id];
								if (parentId === null && record !== void 0 && typeof record.parentId === "string") parentId = record.parentId;
								var marked = marksOf(id);
								var depthVal = item.delegationDepth !== void 0 ? item.delegationDepth : item.delegation_depth;
								var delegationDepth = Number.isFinite(depthVal) ? depthVal : null;
								return {
									id: id,
									title: titleOf(item, id),
									cwd: typeof item.cwd === "string" ? item.cwd : "",
									workspace: basename(item.cwd),
									parentId: parentId,
									origin: typeof item.origin === "string" ? item.origin : "",
									delegationDepth: delegationDepth,
									isSubagent: typeof item.origin === "string" && item.origin === "subagent",
									running: item.running === true,
									blank: item.blank === true,
									updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
									outline: outlineOf(item),
									atSeq: record !== void 0 && Number.isFinite(record.atSeq) ? record.atSeq : null,
									atSeqSource: record !== void 0 && typeof record.source === "string" ? record.source : "unknown",
									parentTitle: record !== void 0 && record.parentTitle ? record.parentTitle : "",
									star: marked.star,
									archive: marked.archive
								};
							})
							.filter(function (row) { return row !== null; });
					} catch {
						return [];
					}
				}

				/** 页签过滤（沿用 MARK-6 规则）+ 搜索裁剪，返回参与建图的会话行。 */
				function displayRows() {
					var items = sessionItems();
					var byId = new Map();
					for (var it of items) byId.set(it.id, it);
					for (var row of items) {
						if (row.parentId === null) continue;
						var parent = byId.get(row.parentId);
						if (parent !== void 0 && parent.title) row.parentTitle = parent.title;
					}
					// 当前会话的祖先链（"当前会话的祖先"标注）。
					var ancestors = new Set();
					var walk = activeSessionId !== null ? byId.get(activeSessionId) : void 0;
					var guard = 0;
					while (walk !== void 0 && walk.parentId !== null && guard++ < 64) {
						if (ancestors.has(walk.parentId)) break;
						ancestors.add(walk.parentId);
						walk = byId.get(walk.parentId);
					}
					for (var node of items) node.ancestor = ancestors.has(node.id);

					// 页签：收藏 = 标星；归档 = 归档；活跃 = 未归档（标星不排除）。
					var matched = items.filter(function (item) {
						if (filterTab === "starred") return item.star;
						if (filterTab === "archived") return item.archive;
						return !item.archive;
					});
					// 命中项的后代也带上（否则归档一个父会话会把整枝藏掉）。
					var allowed = new Set();
					if (filterTab === "active") {
						for (var it2 of items) if (!it2.archive) allowed.add(it2.id);
					} else {
						for (var it3 of items) allowed.add(it3.id);
					}
					var keep = new Set(matched.map(function (m) { return m.id; }));
					var grew = true;
					var guard2 = 0;
					while (grew && guard2++ < 64) {
						grew = false;
						for (var cand of items) {
							if (keep.has(cand.id) || !allowed.has(cand.id)) continue;
							if (cand.parentId !== null && keep.has(cand.parentId)) {
								keep.add(cand.id);
								grew = true;
							}
						}
					}
					var rows = items.filter(function (item4) { return keep.has(item4.id); });

					// 搜索：命中"会话标题 / id / 工作区 / 轮次文本 / seq"的分支，连带祖先一起保留，
					// 这样图结构不会因为过滤而断裂（节点本身不再单独裁剪）。
					var needle = query.trim().toLowerCase();
					var matchedCount = rows.length;
					if (needle !== "") {
						var hit = new Set();
						for (var r2 of rows) {
							var texts = [r2.title, r2.id, r2.workspace, r2.parentTitle, r2.atSeq !== null ? "#" + r2.atSeq : ""];
							if (Array.isArray(r2.outline)) {
								for (var e of r2.outline) texts.push(e.prompt, e.response, String(e.seq), "第" + e.turn + "轮", "#" + e.seq);
							}
							for (var t of texts) {
								if (typeof t === "string" && t !== "" && t.toLowerCase().indexOf(needle) >= 0) { hit.add(r2.id); break; }
							}
						}
						var added = true;
						var guard3 = 0;
						while (added && guard3++ < 64) {
							added = false;
							for (var r3 of rows) {
								if (hit.has(r3.id) || r3.parentId === null || !hit.has(r3.parentId)) continue;
								hit.add(r3.id);
								added = true;
							}
						}
						matchedCount = hit.size;
						rows = rows.filter(function (r4) { return hit.has(r4.id); });
					}

					var suffix = filterTab === "starred" ? "收藏" : filterTab === "archived" ? "归档" : "会话";
					var branchRows = rows.filter(function (r5) { return !r5.isSubagent; });
					var tally = needle !== "" ? branchRows.length + "/" + matchedCount + " 个" + suffix : branchRows.length + " 个" + suffix;
					return { rows: rows, tally: tally, allItems: items };
				}

				/** 组装一次图（渲染与调试共用同一条代码路径）。 */
				function composeGraph() {
					var composed = displayRows();
					var graph = buildGraph({
						rows: composed.rows,
						allIds: new Set(composed.allItems.map(function (r) { return r.id; })),
						forks: forks,
						order: layout.order,
						expanded: expandedBranches,
						expandedSubs: expandedSubs,
						expandedEmpty: expandedEmpty
					});
					// 把"分叉点来源"标注挂到分支首节点上（tooltip 里如实展示三种来源）。
					for (var lane of graph.lanes) {
						if (lane.fork === null) continue;
						if (lane.placeholder !== null) lane.placeholder.forkNote = lane.fork.note;
						var head = lane.firstOwnNode;
						if (head !== null && head !== void 0) head.sessionForkNote = lane.fork.note;
					}
					if (CANVAS_ENABLED && canvasMode && !canvasBroken && graph.stats.branches > 0) {
						try { graph = layoutCanvas(graph); } catch (err) { canvasError = String(err && err.message ? err.message : err); console.warn("[dsh-tree-panel] 画布布局失败，退回紧凑列表：", err); }
					}
					lastGraph = graph;
					return { graph: graph, tally: composed.tally, rows: composed.rows };
				}

				function showToast(text, warn) {
					if (disposed) return;
					toast = { text: text, warn: warn === true };
					toastLog.push({ text: text, warn: warn === true, time: Date.now() });
					if (toastLog.length > 16) toastLog.shift();
					if (toastTimer !== null) clearTimeout(toastTimer);
					toastTimer = trackTimer(setTimeout(function () {
						toast = null;
						toastTimer = null;
						render();
					}, 4600));
					render();
				}

				/* ---- 定位：打开会话 + 滚到指定轮次 ---- */
				function findScroller() {
					try {
						var explicit = document.querySelector("[data-conversation-scroll]");
						if (explicit !== null) return explicit;
						var pane = document.querySelector('[data-pane="conversation"]');
						var scope = pane !== null ? pane : document;
						var candidates = scope.querySelectorAll("div");
						for (var i = 0; i < candidates.length; i++) {
							var el = candidates[i];
							var style = getComputedStyle(el);
							if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 24) return el;
						}
						return null;
					} catch {
						return null;
					}
				}

				function turnOutlineOf(sessionId) {
					try {
						var snap = listSnapshot();
						var row = snap && snap.byId ? snap.byId[sessionId] : void 0;
						var values = row && row.projectionValues ? row.projectionValues.turnOutline : void 0;
						if (!Array.isArray(values)) return [];
						return values
							.filter(function (entry) { return entry && Number.isFinite(entry.turn) && Number.isFinite(entry.seq); })
							.map(function (entry) { return { turn: entry.turn, seq: entry.seq }; });
					} catch {
						return [];
					}
				}

				/**
				 * 锚点 seq → 轮次号（定位分叉轮次的备用尺子）。
				 *  a) 父会话的 turnOutline（父子共用同一套事件 seq，最准）；
				 *  b) 父会话已删时退到子会话自己的 turnOutline —— 子会话继承了分叉点
				 *     之前的全部轮次，所以"第一个 seq 超过锚点的轮次"再往前一轮即分叉轮次。
				 */
				function resolveAnchorTurn(atSeq, parentId, childId) {
					var outline = parentId !== null ? turnOutlineOf(parentId) : [];
					var source = "parent";
					if (outline.length === 0 && childId !== void 0) {
						outline = turnOutlineOf(childId);
						source = "child";
					}
					if (outline.length === 0) return null;
					var sorted = outline.slice().sort(function (a, b) { return a.turn - b.turn; });
					var last = sorted[sorted.length - 1];
					if (source === "child") {
						var firstAfter = sorted.find(function (entry) { return entry.seq > atSeq; });
						var forkTurn = firstAfter === void 0 ? last.turn : firstAfter.turn - 1;
						if (forkTurn < sorted[0].turn) forkTurn = sorted[0].turn;
						return { turn: forkTurn, source: source };
					}
					var found = null;
					for (var entry of sorted) {
						if (entry.seq <= atSeq) found = entry.turn;
						else break;
					}
					if (found === null) found = sorted[0].turn;
					return { turn: found, source: source };
				}

				function turnEl(scope, turn) {
					var rows = scope.querySelectorAll('[data-chat-turn="' + turn + '"]:not([hidden])');
					if (rows.length > 0) return rows[0];
					return null;
				}

				/**
				 * 官方对话视图只在 DOM 里保留**当前渲染的那一轮**（flow 虚拟化），
				 * 历史轮次要靠它自己的「加载并跳转到第 N 轮」按钮才会加载并定位。
				 * 这里找那个按钮，并加两道守卫，避免点到别的会话的轮次轨：
				 *   1) 会话守卫：当前 activeSessionId 必须是目标会话；
				 *   2) 形状守卫：按钮数量 == 目标会话轮次数，且当前渲染出的轮次都属于该会话。
				 */
				function turnJumpButton(turn, sessionId) {
					try {
						var outline = turnOutlineOf(sessionId);
						var all = document.querySelectorAll("button[aria-label]");
						var buttons = [];
						for (var i = 0; i < all.length; i++) {
							var label = all[i].getAttribute("aria-label") || "";
							var m = /跳转到第\s*(\d+)\s*轮/.exec(label);
							if (m !== null) buttons.push({ el: all[i], turn: Number(m[1]) });
						}
						if (buttons.length === 0) return null;
						if (outline.length > 0 && buttons.length !== outline.length) return null;
						if (outline.length > 0) {
							var rendered = document.querySelectorAll("[data-chat-turn]");
							for (var j = 0; j < rendered.length; j++) {
								var t = Number(rendered[j].getAttribute("data-chat-turn"));
								var known = false;
								for (var k = 0; k < outline.length; k++) if (outline[k].turn === t) { known = true; break; }
								if (!known) return null;
							}
						}
						for (var b of buttons) if (b.turn === turn) return b.el;
						return null;
					} catch {
						return null;
					}
				}

				/**
				 * 把对话视图滚到指定轮次并高亮。
				 * 步骤：① 目标轮已在 DOM 里 → 直接滚过去；
				 *      ② 不在（历史未加载）→ 点一次官方「加载并跳转到第 N 轮」，然后继续重试；
				 *      ③ 重试期间用户切了会话 → 立刻放弃，避免滚错会话；
				 *      ④ 超时仍拿不到 → 如实回 "unknown"（绝不假装成功）。
				 */
				function locateTurnInView(sessionId, turn, attempt, onResult, triedJump) {
					var tries = attempt === void 0 ? 60 : attempt;
					if (disposed || activeSessionId !== sessionId) return;
					var scroller = findScroller();
					var scope = scroller !== null ? scroller : document;
					var target = Number.isFinite(turn) ? turnEl(scope, turn) : null;
					var usedJump = triedJump === true;
					if (target !== null) {
						try {
							var offset = target.getBoundingClientRect().top - (scroller !== null ? scroller.getBoundingClientRect().top - scroller.scrollTop : 0) - 96;
							if (scroller !== null && typeof scroller.scrollTo === "function") {
								scroller.scrollTo({ top: Math.max(0, offset), behavior: "smooth" });
							} else {
								target.scrollIntoView({ block: "center", behavior: "smooth" });
							}
							target.classList.add("dsh-tree-hit");
							var pulse = setTimeout(function () {
								try { target.classList.remove("dsh-tree-hit"); } catch {}
							}, 2200);
							timers.push(pulse);
						} catch {}
						onResult("located", turn, usedJump ? "ui-jump" : "direct");
						return;
					}
					if (!usedJump && Number.isFinite(turn) && tries > 0) {
						var btn = turnJumpButton(turn, sessionId);
						if (btn !== null) {
							try { btn.click(); } catch {}
							usedJump = true;
						}
					}
					if (tries <= 0 || !Number.isFinite(turn)) {
						onResult("unknown", null);
						return;
					}
					var retry = setTimeout(function () { locateTurnInView(sessionId, turn, tries - 1, onResult, usedJump); }, 200);
					timers.push(retry);
				}

				/** 旧路径：按锚点 seq 定位（保留给"在此会话上分叉"与调试钩子）。 */
				function scrollToTurn(atSeq, attempt, onResult) {
					var myId = activeSessionId;
					var item = sessionItems().find(function (row) { return row.id === myId; });
					var resolved = resolveAnchorTurn(atSeq, item !== void 0 ? item.parentId : null, myId);
					if (resolved === null) {
						onResult("unknown", null, null);
						return;
					}
					locateTurnInView(myId, resolved.turn, attempt, function (result, turn) {
						onResult(result, turn, resolved.source);
					});
				}

				/** 打开会话（不定位）。 */
								/** 可选服务：拿不到就返回 undefined（不写进 inject，避免某个装配里整插件挂起）。 */
				function optionalService(key) {
					try {
						return typeof ctx.get === "function" ? ctx.get(key) : void 0;
					} catch (err) {
						return void 0;
					}
				}
				function uiWorkspaceService() {
					return optionalService("uiWorkspace");
				}

				/**
				 * 打开会话（不定位）。
				 * 导航归"视图所有者"：0.2.0 起 ctx.sessions 只剩 list/retain/fork/binding/search/scope/using，
				 * 原来的 sessions.open 已经不存在；正规入口是 uiWorkspace.openSession(target)。
				 * 老版本回落到 sessions.open，两代都能跑。
				 */
				function openSession(id) {
					var ui = uiWorkspaceService();
					if (ui && typeof ui.openSession === "function") {
						try {
							ui.openSession(id);
							activeSessionId = id;
							return true;
						} catch (err) {
							console.warn("[dsh-tree-panel] uiWorkspace.openSession 失败，回落到 sessions.open：", err);
						}
					}
					try {
						if (sessionsService && typeof sessionsService.open === "function") {
							sessionsService.open(id);
							activeSessionId = id;
							return true;
						}
					} catch (err) {
						console.warn("[dsh-tree-panel] 打开会话失败：", err);
					}
					return false;
				}

				/**
				 * 点节点卡片 = 打开该会话并定位到该轮。
				 * 第四轮的精确路径：节点自己就带着轮次号，不需要再用 atSeq 反推。
				 */
				function activateNode(node) {
					if (node === null || node === void 0) return;
					if (node.kind === "gap") {
						expandBranch(node.sessionId);
						showToast("已展开 " + shortCode(node.sessionId) + " 折叠的 " + node.hiddenCount + " 轮");
						return;
					}
					if (node.kind === "sub-summary") {
						toggleSubGroup(node.sessionId);
						return;
					}
					if (node.kind === "empty-group") {
						expandedEmpty = !expandedEmpty;
						persistGraphState();
						render();
						return;
					}
					if (node.sessionId === void 0 || node.sessionId === null) return;
					var opened = openSession(node.sessionId);
					lastOpen = { nodeId: node.id, sessionId: node.sessionId, turn: Number.isFinite(node.turn) ? node.turn : null, ok: opened, time: Date.now() };
					if (!opened) {
						showToast("打开会话失败：sessions.open 不可用", true);
						return;
					}
					setFocusOnSession(node.sessionId);
					render();
					if (!Number.isFinite(node.turn)) {
						showToast("已打开会话 " + shortCode(node.sessionId));
						return;
					}
					var label = node.kind === "subagent" ? "子任务 #" + node.index : "第 " + node.turn + " 轮";
					showToast("已打开 " + shortCode(node.sessionId) + " · 正在定位到" + label);
					locateTurnInView(node.sessionId, node.turn, 60, function (result, turn, mechanism) {
						lastLocate = {
							sessionId: node.sessionId,
							atSeq: Number.isFinite(node.seq) ? node.seq : null,
							nodeId: node.id,
							result: result,
							turn: Number.isFinite(turn) ? turn : null,
							turnSource: "node",
							mechanism: mechanism,
							time: Date.now()
						};
						if (result === "unknown") {
							showToast("已打开会话 · 对话视图里没等到第 " + node.turn + " 轮的节点（历史可能未加载），定位失败", true);
							return;
						}
						showToast(
							"已定位到第 " + turn + " 轮 · " + shortCode(node.sessionId) + "（seq " + seqText(node.seq) + "）" +
								(mechanism === "ui-jump" ? " · 走官方「加载并跳转」" : "")
						);
					});
				}

				/** 跳到某节点的第一条子轨道（点卡片上的 ⑂N 徽标）。 */
				function jumpToChildNode(node) {
					var graph = lastGraph;
					if (graph === null) return;
					var edge = null;
					for (var e of graph.edges) if (e.fromNodeId === node.id) { edge = e; break; }
					if (edge === null) {
						showToast("这条分支没有可跳转的子轨道", true);
						return;
					}
					var target = null;
					for (var n of graph.nodes) if (n.id === edge.toNodeId) { target = n; break; }
					if (target === null) {
						showToast("子轨道节点不在当前视图（可能被折叠）", true);
						return;
					}
					focus = { row: target.row, nonce: ++focusNonce };
					flashNodeId = target.id;
					if (flashTimer !== null) clearTimeout(flashTimer);
					flashTimer = trackTimer(setTimeout(function () {
						flashNodeId = null;
						flashTimer = null;
						render();
					}, 1700));
					showToast("已跳到子轨道 " + shortCode(target.sessionId) + " · lane " + target.lane);
					render();
				}

				function setFocusOnSession(sessionId) {
					var graph = lastGraph;
					if (graph === null || typeof sessionId !== "string") return;
					var row = null;
					for (var n of graph.nodes) if (n.sessionId === sessionId && n.kind === "turn") row = n.row;
					if (row !== null) focus = { row: row, nonce: ++focusNonce };
				}

				function expandBranch(id) {
					expandedBranches.add(id);
					persistGraphState();
					render();
				}

				function toggleSubGroup(id) {
					if (expandedSubs.has(id)) expandedSubs.delete(id);
					else expandedSubs.add(id);
					persistGraphState();
					render();
				}

				/** 右键菜单内容。 */
				function openNodeMenu(node, event) {
					var x = Number.isFinite(event.clientX) ? event.clientX : 220;
					var y = Number.isFinite(event.clientY) ? event.clientY : 220;
					var items = [];
					var hasSession = node.sessionId !== void 0 && node.sessionId !== null;
					if (node.kind === "gap") {
						items.push({
							key: "expand",
							label: "⇕ 展开这 " + node.hiddenCount + " 轮",
							run: function () { expandBranch(node.sessionId); }
						});
					}
					if (node.kind === "sub-summary") {
						items.push({
							key: "toggle",
							label: (node.expanded ? "▾ 折叠" : "▸ 展开") + " " + node.subCount + " 个子任务",
							run: function () { toggleSubGroup(node.sessionId); }
						});
					}
					if (node.kind === "empty-group") {
						items.push({
							key: "toggle",
							label: (node.expanded ? "▾ 折叠" : "▸ 展开") + " " + node.count + " 个空会话",
							run: function () {
								expandedEmpty = !expandedEmpty;
								persistGraphState();
								render();
							}
						});
					}
					if (hasSession && (node.kind === "turn" || node.kind === "empty-branch" || node.kind === "subagent" || node.kind === "empty-session")) {
						items.push({
							key: "open",
							label: node.kind === "subagent" ? "↗ 打开此子任务会话" : "↗ 打开此会话" + (Number.isFinite(node.turn) ? "并定位到第 " + node.turn + " 轮" : ""),
							run: function () { activateNode(node); }
						});
					}
					if (hasSession) {
						items.push({
							key: "copy",
							label: "⧉ 复制会话 id",
							run: function () {
								var ok = copyText(node.sessionId);
								lastCopy = { id: node.sessionId, ok: ok, time: Date.now(), via: "menu" };
								showToast(ok ? "已复制会话 id · " + node.sessionId : "复制失败（浏览器拒绝了剪贴板）", !ok);
							}
						});
					}
					if (hasSession && Number.isFinite(node.seq)) {
						items.push({ key: "sep1", separator: true });
						items.push({
							key: "fork",
							label: "⑂ 从此轮分叉新对话",
							run: function () { forkFromNode(node); }
						});
					}
					menu = {
						x: x,
						y: y,
						head: node.kind === "turn" ? "第 " + node.turn + " 轮 · " + shortCode(node.sessionId) : node.sessionTitle !== void 0 ? node.sessionTitle : "节点",
						headTitle: node.id + (node.forkNote ? "\n" + node.forkNote : ""),
						items: items
					};
					render();
				}

				/**
				 * 右键"从此轮分叉新对话"：带 atSeq = 该轮 seq 调 sessions.fork，
				 * 锚点由 fork 包装记成 source="call"（调用方自己给的切点，权威）。
				 */
				function forkFromNode(node) {
					if (node === null || node === void 0 || node.sessionId === void 0 || node.sessionId === null) {
						showToast("这个节点不能分叉", true);
						return;
					}
					if (!Number.isFinite(node.seq)) {
						showToast("这个节点没有可用的 seq，无法精确分叉", true);
						return;
					}
					if (!sessionsService || typeof sessionsService.fork !== "function") {
						showToast("当前版本 sessions.fork 不可用", true);
						return;
					}
					var payload = { sessionId: node.sessionId, atSeq: node.seq, increaseTitle: true };
					lastForkFromNode = { nodeId: node.id, sessionId: node.sessionId, turn: node.turn, seq: node.seq, time: Date.now() };
					showToast("正在从 " + shortCode(node.sessionId) + " 第 " + node.turn + " 轮（seq " + seqText(node.seq) + "）分叉…");
					try {
						Promise.resolve(sessionsService.fork(payload)).then(
							function (childId) {
								if (disposed) return;
								var record = forks[childId];
								var note = record !== void 0 && Number.isFinite(record.atSeq) ? "锚点 " + seqText(record.atSeq) + " · source=" + record.source : "锚点未记录";
								showToast("已分叉出 " + shortCode(childId) + "（" + note + "）");
								if (typeof childId === "string" && childId !== "") {
									if (openSession(childId)) {
										setFocusOnSession(childId);
										render();
									}
								}
								render();
							},
							function (err) {
								if (disposed) return;
								showToast("分叉失败：" + String(err && err.message ? err.message : err).slice(0, 120), true);
							}
						);
					} catch (err) {
						showToast("分叉失败：" + String(err && err.message ? err.message : err).slice(0, 120), true);
					}
				}

				/**
				 * 卡片快捷动作「定位」：把面板视口滚到该节点所在行并闪一下。
				 * 只动视图焦点（focus / flashNodeId），不碰任何数据、不发任何请求。
				 */
				function locateNode(node) {
					if (node === null || node === void 0) return;
					if (Number.isFinite(node.row) && node.row >= 0) focus = { row: node.row, nonce: ++focusNonce };
					else setFocusOnSession(node.sessionId);
					flashNodeId = node.id;
					if (flashTimer !== null) clearTimeout(flashTimer);
					flashTimer = trackTimer(setTimeout(function () {
						flashNodeId = null;
						flashTimer = null;
						render();
					}, 1700));
					showToast(
						"已定位到 " +
							(node.kind === "turn" ? "第 " + node.turn + " 轮 · " : "") +
							shortCode(node.sessionId) +
							"（面板内第 " + (node.row + 1) + " 行）"
					);
				}

				/** 拖动排序：只改同父兄弟分支的相对次序。 */
				function reorderCards(draggedId, targetId) {
					if (typeof draggedId !== "string" || typeof targetId !== "string" || draggedId === targetId) return;
					var items = sessionItems();
					function parentIdOf(id) {
						var row = items.find(function (x) { return x.id === id; });
						return row === void 0 ? null : row.parentId;
					}
					if (parentIdOf(draggedId) !== parentIdOf(targetId)) return;
					var ids = items.filter(function (r) { return !r.isSubagent; }).map(function (r) { return r.id; });
					var orderIds = layout.order && layout.order.length ? layout.order.slice() : ids.slice();
					for (var id of ids) if (orderIds.indexOf(id) < 0) orderIds.push(id);
					orderIds = orderIds.filter(function (entry) { return ids.indexOf(entry) >= 0; });
					var from = orderIds.indexOf(draggedId);
					if (from < 0) return;
					orderIds.splice(from, 1);
					var to = orderIds.indexOf(targetId);
					if (to < 0) to = 0;
					orderIds.splice(to, 0, draggedId);
					layout.order = orderIds;
					saveLayout(layout);
					render();
				}

				/** 当前会话的"任务目标"（只读，沿用第三轮实现）。 */
				function currentGoal() {
					try {
						if (activeSessionId === null) return null;
						var snap = listSnapshot();
						var row = snap && snap.byId ? snap.byId[activeSessionId] : void 0;
						var projection = row && row.projectionValues ? row.projectionValues.goal : void 0;
						var goal = projection && projection.goal ? projection.goal : null;
						var objective = goal && typeof goal.objective === "string" ? goal.objective.trim() : "";
						if (objective === "") return null;
						var phase = typeof goal.phase === "string" ? goal.phase : "";
						var labels = { active: "进行中", paused: "已暂停", blocked: "已阻塞", complete: "已完成", completed: "已完成" };
						return {
							full: objective,
							text: objective,
							phase: labels[phase] !== void 0 ? phase : "",
							phaseLabel: labels[phase] !== void 0 ? labels[phase] : phase
						};
					} catch {
						return null;
					}
				}

				function setFilterTab(tab) {
					if (tab !== "active" && tab !== "starred" && tab !== "archived") return;
					filterTab = tab;
					render();
				}

				function onToggleMark(id, field) {
					if (typeof id !== "string" || id === "") return;
					var next = toggleMark(id, field);
					render();
					if (field === "archive") showToast(next ? "已归档（默认折叠，可在「▣ 归档」页签查看）" : "已取消归档");
					else showToast(next ? "已收藏（在「★ 收藏」页签查看）" : "已取消收藏");
				}

				function toggleExpandAll() {
					var allExpanded = expandedBranches.size > 0;
					if (allExpanded) {
						expandedBranches.clear();
						expandedSubs.clear();
					} else {
						for (var row of sessionItems()) if (!row.isSubagent) expandedBranches.add(row.id);
					}
					persistGraphState();
					render();
					showToast(allExpanded ? "已把所有分支收回「最近 " + TAIL_TURNS + " 轮 + 分叉点」" : "已展开所有分支的全部轮次");
				}

				/** 面板头部"在此会话上分叉"：对当前选中会话调 sessions.fork（锚点 derived）。 */
				function forkActiveSession() {
					var id = activeSessionId;
					if (typeof id !== "string" || id === "") {
						showToast("没有选中的会话", true);
						return;
					}
					if (!sessionsService || typeof sessionsService.fork !== "function") {
						showToast("当前版本 sessions.fork 不可用", true);
						return;
					}
					showToast("正在对 " + shortCode(id) + " 分叉…");
					try {
						Promise.resolve(sessionsService.fork({ sessionId: id, increaseTitle: true })).then(
							function (childId) {
								if (disposed) return;
								var record = forks[childId];
								showToast(
									"已分叉出 " + shortCode(childId) + (record !== void 0 && Number.isFinite(record.atSeq) ? "（锚点 " + seqText(record.atSeq) + " · " + record.source + "）" : "（锚点未知）")
								);
								if (typeof childId === "string" && childId !== "") {
									if (openSession(childId)) setFocusOnSession(childId);
								}
								render();
							},
							function (err) {
								if (disposed) return;
								showToast("分叉失败：" + String(err && err.message ? err.message : err).slice(0, 120), true);
							}
						);
					} catch (err) {
						showToast("分叉失败：" + String(err && err.message ? err.message : err).slice(0, 120), true);
					}
				}

				/* ---- 渲染 ---- */
				function render() {
					if (disposed || !root) return;
					var composed = composeGraph();
					var graph = composed.graph;
					var shown = graph.stats.visibleTurns;
					var totalTurns = graph.stats.totalTurns;
					root.render(
						react_jsx_runtime.jsx(TreePanel, {
							layout: layout,
							graph: graph,
							light: panelLight,
							tally:
								composed.tally +
								" · " +
								graph.stats.branches +
								" 轨道 · " +
								shown +
								(totalTurns > shown ? "/" + totalTurns : "") +
								" 轮",
							query: query,
							toast: toast,
							goal: currentGoal(),
							activeSessionId: activeSessionId,
							filterTab: filterTab,
							flashNodeId: flashNodeId,
							focus: focus,
							menu: menu,
							allExpanded: expandedBranches.size > 0,
							canvasMode: canvasMode,
							onToggleCanvas: function () {
								toggleCanvasLayer();
							},
							marksOf: function (id) {
								if (typeof id !== "string") return { star: false, archive: false };
								return marksOf(id);
							},
							onFilter: setFilterTab,
							onToggleMark: onToggleMark,
							onToggleExpandAll: toggleExpandAll,
							onForkActive: forkActiveSession,
							onQuery: function (value) {
								// 输入框自己即时回显（不受控），真正昂贵的 composeGraph 延后 150ms 再跑。
								queryDraft = typeof value === "string" ? value : "";
								if (searchTimer !== null) clearTimeout(searchTimer);
								searchTimer = setTimeout(function () {
									searchTimer = null;
									query = queryDraft;
									render();
								}, 150);
							},
							onClose: function () {
								open = false;
								layout.open = false;
								saveLayout(layout);
								if (container) container.style.display = "none";
								render();
							},
							onDragHeader: function (e) {
								var startX = e.clientX, startY = e.clientY;
								var startRight = layout.right, startTop = layout.top;
								function move(ev) {
									layout.right = Math.max(0, startRight - (ev.clientX - startX));
									layout.top = Math.max(0, startTop + (ev.clientY - startY));
									// 面板是 position:fixed 的，改容器没用——直接改面板自己的内联样式才跟手。
									var el = overlayEl();
									if (el !== null) {
										el.style.right = layout.right + "px";
										el.style.top = layout.top + "px";
									}
								}
								function up() {
									document.removeEventListener("pointermove", move);
									document.removeEventListener("pointerup", up);
									saveLayout(layout);
									render(); // 让 React 的内联样式与拖动结果对齐
								}
								document.addEventListener("pointermove", move);
								document.addEventListener("pointerup", up);
							},
							onResize: function (e) {
								e.stopPropagation();
								var startX = e.clientX;
								var startWidth = layout.width;
								function move(ev) {
									layout.width = Math.min(720, Math.max(260, startWidth + (startX - ev.clientX)));
									var el = overlayEl();
									if (el !== null) el.style.width = layout.width + "px";
								}
								function up() {
									document.removeEventListener("pointermove", move);
									document.removeEventListener("pointerup", up);
									saveLayout(layout);
									render();
								}
								document.addEventListener("pointermove", move);
								document.addEventListener("pointerup", up);
							},
							onActivateNode: activateNode,
							onNodeContextMenu: openNodeMenu,
							onJumpToChild: jumpToChildNode,
							onQuickFork: forkFromNode,
							onLocate: locateNode,
							onReorder: reorderCards,
							onMenuClose: function () {
								menu = null;
								render();
							}
						})
					);
				}

								/**
				 * 位置/宽度兜底：历史拖动可能把面板存到窗口外
				 * （top 超过窗口高度、right 超过窗口宽度），那样点开就是"看不见"。
				 */
				function clampLayout() {
					if (!Number.isFinite(layout.width)) layout.width = 420;
					layout.width = Math.min(720, Math.max(260, layout.width));
					var maxRight = Math.max(0, (window.innerWidth || 1280) - 180);
					var maxTop = Math.max(0, (window.innerHeight || 800) - 140);
					if (!Number.isFinite(layout.right) || layout.right < 0 || layout.right > maxRight) layout.right = 12;
					if (!Number.isFinite(layout.top) || layout.top < 0 || layout.top > maxTop) layout.top = 64;
				}

				function ensurePanel() {
					injectCss();
					clampLayout();
					panelLight = pageIsLight();
					if (container === null) {
						container = document.createElement("div");
						container.dataset.dshPlugin = "dsh-tree-panel";
						document.body.appendChild(container);
						root = react_dom_client.createRoot(container);
					}
					container.style.display = open ? "" : "none";
					render();
				}

				/** 面板根元素（拖动/缩放时直接改它的内联样式，保证跟手）。 */
				function overlayEl() {
					try {
						return container !== null ? container.querySelector(".dsh-tree-panel-overlay") : null;
					} catch {
						return null;
					}
				}

				/* ---- 当前会话：快照优先，其次读宿主的 dsh.sessions.current ---- */
				function currentSessionIdFromStore() {
					try {
						var raw = localStorage.getItem("dsh.sessions.current");
						if (!raw) return null;
						var parsed = JSON.parse(raw);
						return parsed && typeof parsed.sessionId === "string" && parsed.sessionId ? parsed.sessionId : null;
					} catch (e) { return null; }
				}
				function resolveCurrentSessionId() {
					try {
						var snap = listSnapshot();
						if (snap && typeof snap.current === "string" && snap.current) return snap.current;
					} catch (e) {}
					return currentSessionIdFromStore();
				}
				var __activeTimer = null;
				function startActiveWatch() {
					if (__activeTimer !== null) return;
					__activeTimer = setInterval(function () {
						try {
							if (!open) return;
							var id = resolveCurrentSessionId();
							if (id !== null && id !== activeSessionId) { activeSessionId = id; render(); }
						} catch (e) {}
					}, 1500);
				}
				/* ---- MARK-4：高亮随主界面当前会话联动 ---- */
				var initial = listSnapshot();
				var initialCurrent = resolveCurrentSessionId();
				if (initialCurrent !== null) activeSessionId = initialCurrent;
				try {
					var listFace = sessionsService && sessionsService.list;
					if (listFace && typeof listFace.subscribe === "function") {
						var renderPending = false;
            var unsubscribe = listFace.subscribe(function () {
              try {
                var snap = listSnapshot();
                var current = resolveCurrentSessionId();
                if (current !== null) activeSessionId = current;
                // 节流到一帧：流式输出期间列表事件很密，每个事件都 composeGraph 会卡。
                if (!open || renderPending) return;
                renderPending = true;
                var flush = function () { renderPending = false; try { render(); } catch (e) {} };
                if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
                else setTimeout(flush, 60);
              } catch {}
            });
						if (typeof ctx.on === "function") {
							ctx.on("dispose", function () {
								try { unsubscribe(); } catch {}
							});
						}
					}
				} catch (err) {
					console.warn("[dsh-tree-panel] 订阅会话列表失败（高亮只在点击/打开面板时更新）：", err);
				}

				startActiveWatch();
				try { startHitLayer(); } catch (err) { console.warn("[dsh-tree-panel] 命中层未启动：", err); }
				/* ---- 分叉锚点记录 ---- */
				try {
					void installForkRecorder(sessionsService, function () { return uiAnchor; }, {
						listSnapshot: listSnapshot,
						lastSeqOf: lastSeqOf
					});
				} catch (err) {
					console.warn("[dsh-tree-panel] 分叉锚点记录未安装：", err);
				}

				/* ---- 面板开合：wide 模式的 DOM 按钮与 rail 模式的槽内按钮共用这一条路径 ---- */
				try {
					// 捕获阶段：外壳的行如果再挂自己的 handler，也轮不到它先动手
					document.addEventListener("pointerdown", onDocumentPointerDown, true);
					document.addEventListener("click", onDocumentPointerDown, true);
					if (typeof ctx.on === "function") {
						ctx.on("dispose", function () {
							try { document.removeEventListener("pointerdown", onDocumentPointerDown, true); } catch (e) {}
							try { document.removeEventListener("click", onDocumentPointerDown, true); } catch (e) {}
						});
					}
				} catch (e) {}
				/*
				 * 这里原来监听 dsh-panel-open：收到"别的面板打开了"就把自己关掉。
				 * 但同批插件（成本卡 / 备份 / 知识库）里存在"首次交互才出现的一次性引导"，
				 * 它们也会广播这个事件；任何一次广播都会把刚刚打开的面板立刻关掉，
				 * 表现就是"第一次点击什么都没发生，第二次才出来"。
				 * 互斥的收益远小于"打不开"的代价，整条去掉；本插件仍然照旧广播自己的打开事件。
				 */
								/** 面板此刻在屏幕上是否真的可见：只认 DOM，不信内存里的 open。 */
				function overlayVisibleNow() {
					try {
						if (container === null || container.isConnected === false) return false;
						if (container.style.display === "none") return false;
						var el = container.querySelector(".dsh-tree-panel-overlay");
						if (el === null) return false;
						var rect = el.getBoundingClientRect();
						return rect.width > 0 && rect.height > 0;
					} catch (err) {
						return false;
					}
				}

				/** 打不开时把原因摆到屏幕上：挂在 body 上，面板自己没渲染出来也看得见。 */
				function revealFailure(text) {
					try {
						var el = document.createElement("div");
						el.className = "dsh-tree-fail";
						el.textContent = "会话树：" + text;
						document.body.appendChild(el);
						setTimeout(function () {
							try { el.remove(); } catch (e) {}
						}, 9000);
					} catch (e) {}
				}

				/** 中性回执（诊断用）：证明"点击已经送到本插件"，并报出构建号与面板可见性。 */
				function revealNote(text) {
					try {
						var el = document.createElement("div");
						el.className = "dsh-tree-note";
						el.textContent = "会话树：" + text;
						document.body.appendChild(el);
						setTimeout(function () {
							try { el.remove(); } catch (e) {}
						}, 6000);
					} catch (e) {}
				}

				/**
				 * 提交之后再连查几帧：没落到 DOM 上就再提交一次，最后一帧还不行就把
				 * 位置/宽度一起报出来（十有八九是位置被存到窗口外）。
				 */
				function verifyOverlayPaint() {
					var tries = 0;
					var tick = function () {
						if (!open) return;
						if (overlayVisibleNow()) return;
						if (tries >= 4) {
							revealFailure("面板已提交但没出现在屏幕上 · " + BUILD_TAG + " · 右距 " + layout.right + "px / 上距 " + layout.top + "px / 宽 " + layout.width + "px / 窗口 " + window.innerWidth + "×" + window.innerHeight);
							return;
						}
						tries++;
						try { render(); } catch (err) {}
						setTimeout(tick, 40);
					};
					setTimeout(tick, 0);
				}

				function openPanel() {
					open = true;
					layout.open = true;
					saveLayout(layout);
					var cur = resolveCurrentSessionId();
					if (cur !== null) activeSessionId = cur;
					ensurePanel();
					replayPanelIn();
					setFocusOnSession(activeSessionId);
					render();
					verifyOverlayPaint();
				}

				function closePanel() {
					open = false;
					layout.open = false;
					saveLayout(layout);
					if (container !== null) container.style.display = "none";
					render();
				}

				/**
				 * 开合入口。
				 * 旧实现按内存里的 open 取反；open 与"屏幕上有没有面板"一旦不一致
				 * （容器被别的路径隐藏、上一帧没落地），就会出现"第一次点没反应、第二次才出来"。
				 * 现在先看屏幕：看得见就关，看不见就开；出错就把原因摆出来。
				 */
				/* ---- 入口命中：只认我们图标所在的"那一条横向带" ----
				 * 外壳把 footer 动作画成整行，行会吃掉事件，组件自己的 handler 收不到；
				 * 但按"行 DOM"判会误伤同排的其它插件（实测：点存档匣 / 监视台 / 知识阁
				 * 也会打开分支树 —— 因为向上找"像行"的祖先时退化成了一个装下四颗按钮的容器）。
				 * 改用两条纯几何 + 归属判据，不再依赖 DOM 结构：
				 *   1) 指针纵向必须落在我们图标上下 ±14px、横向在图标左侧 -24 ~ +260px 内；
				 *   2) 落点若在某颗 <button> 里，这颗按钮必须是我们的图标本身、它的祖先或后代。 */
				var entryGlyphEl = null;
				var lastToggleAt = 0;

				function bindEntryRef(el) {
					entryGlyphEl = el;
				}

				function onDocumentPointerDown(e) {
					try {
						if (disposed) return;
						var glyph = entryGlyphEl;
						if (!glyph || glyph.isConnected === false) return;
						var r = glyph.getBoundingClientRect();
						if (r.width < 1 || r.height < 1) return; // 隐藏态：交给组件自己的 handler
						if (typeof e.clientY === "number" && (e.clientY < r.top - 14 || e.clientY > r.bottom + 14)) return;
						if (typeof e.clientX === "number" && (e.clientX < r.left - 16 || e.clientX > r.right + 160)) return;
						var t = e.target;
						if (!t || typeof t.nodeType !== "number") return;
						var btn = typeof t.closest === "function" ? t.closest("button") : null;
						if (btn && btn !== glyph && !btn.contains(glyph) && !glyph.contains(btn)) return;
						e.stopPropagation();
						togglePanel();
					} catch (err) {}
				}

				/* ---- 命中层（见上方说明） ---- */
				var hitLayer = null;
				var hitTimer = null;

				function findShellRow() {
					try {
						var all = document.querySelectorAll("div,button,li,a");
						for (var i = 0; i < all.length; i++) {
							var el = all[i];
							if (el.childElementCount > 3) continue;
							var text = (el.textContent || "").trim();
							if (text !== "会话树") continue;
							var r0 = el.getBoundingClientRect();
							if (r0.width < 40 || r0.height < 16) continue;
							if (r0.left > 460 || r0.top < window.innerHeight * 0.35) continue;
							var row = el;
							for (var d = 0; d < 3 && row.parentElement; d++) {
								if (row.tagName === "BUTTON") break;
								row = row.parentElement;
							}
							return row;
						}
					} catch (err) {}
					return null;
				}

				function syncHitLayer() {
					if (true) return; // 命中层停用：入口回到 v10 的捕获判定
					var row = findShellRow();
					if (row === null) {
						if (hitLayer !== null) { try { hitLayer.remove(); } catch (e) {} hitLayer = null; }
						return;
					}
					var r = row.getBoundingClientRect();
					if (hitLayer === null || hitLayer.isConnected !== true) {
						hitLayer = document.createElement("button");
						hitLayer.type = "button";
						hitLayer.className = "dsh-tree-hitlayer";
						hitLayer.setAttribute("aria-label", "会话树");
						hitLayer.title = "会话树面板";
						hitLayer.addEventListener("pointerdown", function (e) {
							e.preventDefault();
							e.stopPropagation();
							togglePanel();
						});
						document.body.appendChild(hitLayer);
					}
					hitLayer.style.cssText =
						"position:fixed;left:" + Math.round(r.left) + "px;top:" + Math.round(r.top) + "px;" +
						"width:" + Math.round(r.width) + "px;height:" + Math.round(r.height) + "px;" +
						"z-index:9998;margin:0;padding:0;border:0;background:transparent;cursor:pointer;";
				}

				function startHitLayer() {
  // 命中层已停用（syncHitLayer 第一行就 return）：这里原来还会起 800ms 定时器
  // + resize/scroll 两条捕获监听，等于开机即空转。stopHitLayer 保留用于清理旧状态。
}

				function stopHitLayer() {
					if (hitTimer !== null) { clearInterval(hitTimer); hitTimer = null; }
					try { window.removeEventListener("resize", syncHitLayer); } catch (e) {}
					try { window.removeEventListener("scroll", syncHitLayer, true); } catch (e) {}
					if (hitLayer !== null) { try { hitLayer.remove(); } catch (e) {} hitLayer = null; }
				}

				var canvasLayer = null;
				function clearAllLayers() {
					try {
						var ls = document.querySelectorAll(".dshtp-layer");
						for (var i = 0; i < ls.length; i++) { try { ls[i].remove(); } catch (e) {} }
					} catch (e) {}
				}

				function toggleCanvasLayer() {
					try {
						if (canvasLayer !== null) { try { canvasLayer.destroy(); } catch (e) {} canvasLayer = null; clearAllLayers(); return; }
						clearAllLayers(); // 上一次若中途抛错，先清掉残留，绝不再叠一层
						var host = overlayEl();
						var rect = host ? host.getBoundingClientRect() : { left: 200, top: 80, width: 520, height: 700 };
						canvasLayer = openTreeCanvas(ctx, rect, null);
					} catch (err) {
						canvasLayer = null;
						clearAllLayers();
						revealNote("画布打开失败 · " + (err && err.message ? err.message : String(err)));
					}
				}

				function togglePanel() {
					void 0;
					var nowMs = Date.now();
					// 捕获监听与组件自己的 handler 可能对同一次点击各触发一回，400ms 内只认一次。
					if (nowMs - lastToggleAt < 400) return open;
					lastToggleAt = nowMs;
					try {
						var visibleBefore = overlayVisibleNow();
						if (visibleBefore) {
							closePanel();
							lastToggle = { time: Date.now(), visibleBefore: visibleBefore, visibleAfter: false, action: "close" };
							return false;
						}
						if (!open) {
							try { window.dispatchEvent(new CustomEvent("dsh-panel-open", { detail: "tree" })); } catch (ev) {}
						}
						openPanel();
						lastToggle = { time: Date.now(), visibleBefore: visibleBefore, visibleAfter: overlayVisibleNow(), action: "open" };
						return true;
					} catch (err) {
						open = false;
						try { layout.open = false; saveLayout(layout); } catch (e) {}
						try { if (container !== null) container.style.display = "none"; } catch (e) {}
						revealFailure("打开时出错 · " + BUILD_TAG + " · " + (err && err.message ? err.message : String(err)));
						return false;
					}
				}

				/** 重播一次面板淡入（打开这一侧调用；元素尚未挂上或失败都静默跳过）。 */
				function replayPanelIn() {
					var el = overlayEl();
					if (el === null) return;
					try {
						el.style.animation = "none";
						void el.offsetWidth; // 强制一次重排，否则浏览器会把这次动画重启合并掉
						el.style.animation = "";
					} catch {}
				}

				/* ============================================================
				 * wide（侧边栏展开）模式：按钮放「设置」行内 —— 备份右侧、监视左侧一格。
				 *
				 * DOM 结构（ui-sidebar 的 footArea，竖排两行）：
				 *   div.footArea
				 *     ├─ div.footerActions   ← sidebar.footer.action 槽（本插件的锚点在此）
				 *     └─ div.settingsArea    ← sidebar.settings 槽（设置触发器 button[aria-haspopup="dialog"]）
				 *
				 * 做法：从锚点向上爬到 footArea → 在 footArea 的兄弟行里找设置触发器按钮 →
				 * 把独立创建的 DOM 按钮挂进 settingsArea（绝对定位、垂直居中）。
				 * right 值 = 设置按钮左边缘距侧边栏左框的距离（左右对称），再按 DOM_BUTTON_OFFSET
				 * 往左让位给备份与监视。该按钮不归 React 管理（React 只渲染一个隐藏锚点），
				 * 避免两侧抢同一块 DOM。
				 * ============================================================ */
				var domButton = null;
				var domTimer = null;
				var placementRef = null; // { settingsArea, trigger, footArea, rootEl }

				function findPlacement(anchorEl) {
					try {
						// 锚点：槽内渲染的隐藏占位 span。真实 shell 中 renderSlot 会在每行外面
						// 再包一层 <div data-slot="..." style="display:contents">，所以锚点的直接父元素
						// 不是 footerActions 行本身。这里从锚点向上爬，找到 class 含 "footArea" 的容器
						// （侧边栏底部两行：footerActions + settingsArea）。
						var el = anchorEl ? anchorEl.parentElement : null;
						var footArea = null;
						while (el) {
							var p = el.parentElement;
							if (p && typeof p.className === "string" && p.className.indexOf("footArea") !== -1) { footArea = p; break; }
							el = p;
						}
						if (!footArea) return null;
						// 在 footArea 的兄弟行里找设置触发器（跳过锚点所在的那一行）
						var trigger = null;
						var settingsArea = null;
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
						// 备份按钮占位 = inset - rightGap；本按钮再往左 DOM_BUTTON_OFFSET 一格，
						// 与备份（偏移 0）、监视（偏移 +30）、知识库（偏移 +90）各留 2px，互不重叠。
						// DOM_ROW_BASE 见常量处注释：把四颗一起挪上同一根 30px 栅格。
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
						domButton.className = "dsh-tree-btn dsh-tree-btn-anchor";
						domButton.title = "会话树面板（轮次级枝干图）";
						domButton.setAttribute("aria-label", "会话树");
						domButton.innerHTML = TREE_ICON_SVG;
						domButton.addEventListener("pointerdown", function (e) { e.preventDefault(); togglePanel(); });
						domButton.addEventListener("click", function () { togglePanel(); });
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

				/* ---------- 槽内组件（wide：只渲染隐藏锚点；rail：渲染真按钮） ---------- */
				function TreePanelToggle(props) {
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
						// 侧边栏尚未就绪：有限重试（500ms × 10；期间一旦发现宽条设置就切内联）
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
														var placedNow = ensureDomButton(anchorNow);
							if (placedNow || tries > 10) {
								clearInterval(domTimer);
								domTimer = null;
								// 探测一直失败也必须有按钮可点：退回槽内内联渲染，绝不让组件停在隐藏 span 上
								setMode(placedNow ? "dom" : "inline");
							}
						}, 500);
						return function () {
							if (domTimer) { clearInterval(domTimer); domTimer = null; }
							removeDomButton();
						};
					}, [wide, mode]);

					// 旧版 wide：真实按钮由 DOM 挂到「设置」行，这里只留一个隐藏锚点（不占槽位、不挤余额卡）
					if (wide && mode !== "inline") return React.createElement("span", { ref: function (el) { anchorRef.current = el; bindEntryRef(el); }, style: { display: "none" } });

					return React.createElement("button", {
						className: "dsh-tree-btn dsh-tree-btn-anchor",
						"data-dsh-part": "entry",
						ref: function (el) { bindEntryRef(el); },
						onPointerDown: function (e) { e.preventDefault(); togglePanel(); },
						onClick: function () { togglePanel(); },
						title: "会话树面板（轮次级枝干图）",
						"aria-label": "会话树",
						style: { width: 36, height: 36, fontSize: 17 }
					}, treeGlyph(17));
				}

				ctx.slots.inject("sidebar.footer.action", function () {
					return ctx.slots.register(
						{ name: "sidebar.footer.action", id: "tree-panel", order: 40, label: "会话树" },
						TreePanelToggle
					);
				});

				/* 启动时不自动展开面板（layout.open 仅用于记忆宽度/位置） */

				/* ---- 卸载：HMR 重载/插件卸载时把自管 DOM 与定时器全部收拾干净 ---- */
				try {
					if (typeof ctx.on === "function") {
						ctx.on("dispose", function () {
disposed = true;
// 这个 1.5s 轮询原来没人清：dev HMR / 插件停用后仍持有整个闭包每 1.5s 读一次 localStorage。
try { if (__activeTimer !== null) { clearInterval(__activeTimer); __activeTimer = null; } } catch (e) {}
try { if (searchTimer !== null) { clearTimeout(searchTimer); searchTimer = null; } } catch (e) {}
// fork 猴补丁：卸载时还原，否则宿主此后一直走插件包装（上了原型那条路尤其回不去）。
try {
  var __forkSvc = typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
  var __forkPatch = __forkSvc && __forkSvc.__treePanelForkPatch;
  if (__forkPatch && __forkPatch.original) {
    if (__forkPatch.kind === "own" && __forkSvc.fork && __forkSvc.fork.__treePanelForkRecorder === true) __forkSvc.fork = __forkPatch.original;
    else if (__forkPatch.kind === "proto" && __forkPatch.proto && __forkPatch.proto.fork && __forkPatch.proto.fork.__treePanelForkRecorder === true) __forkPatch.proto.fork = __forkPatch.original;
    try { delete __forkSvc.__treePanelForkPatch; } catch (e) {}
  }
} catch (e) {}
							try { stopHitLayer(); } catch (e) {}
							removeDomButton();
							for (var t of timers) {
								try { clearTimeout(t); } catch {}
							}
							timers.length = 0;
							try { if (root) root.unmount(); } catch {}
							try { if (container && container.parentNode) container.parentNode.removeChild(container); } catch {}
							root = null;
							container = null;
							try { delete window.__treePanelDebug; } catch {}
							try { delete window.__treePanelBench; } catch {}
							try { delete window.__tpCaptured; } catch {}
						});
					}
				} catch {}

				/* ---- 调试辅助 ---- */
				function findNode(nodeId) {
					var graph = lastGraph;
					if (graph === null) return null;
					for (var n of graph.nodes) if (n.id === nodeId) return n;
					return null;
				}

				function stressRows(sessionCount, turnsPerSession, withSubagents) {
					var n = Math.max(1, Math.min(400, sessionCount | 0 || 100));
					var turns = Math.max(1, Math.min(2000, turnsPerSession | 0 || 30));
					var synthRows = [];
					for (var i = 0; i < n; i++) {
						var outline = [];
						var base = i * 7;
						var isSub = withSubagents === true && i % 13 === 12;
						for (var t = 0; t < turns; t++) {
							outline.push({
								turn: t + 1,
								seq: base + t * 3,
								prompt: "合成轮次 " + (t + 1) + " · 会话 " + i + " 的提示词文本用于测量布局与渲染",
								response: "合成回复"
							});
						}
						var parentId = null;
						if (i % 5 === 4) parentId = "session-syn-" + (i - 1);
						else if (i % 11 === 10) parentId = "session-syn-" + (i - 2);
						if (parentId !== null) outline = outline.slice(0, Math.max(1, Math.floor(turns / 2)));
						synthRows.push({
							id: "session-syn-" + i,
							title: "合成会话 " + i,
							workspace: "synth",
							parentId: isSub ? "session-syn-" + (i - 1) : parentId,
							origin: isSub ? "subagent" : "",
							isSubagent: isSub,
							running: false,
							blank: false,
							updatedAt: 1790000000000 + i,
							outline: outline,
							star: i % 17 === 0,
							archive: false
						});
					}
					return synthRows;
				}

				try {
					window.__treePanelDebug = function () {
						var snap = listSnapshot();
						composeGraph();
						var graph = lastGraph;
						return {
							snapshotShape: snap && typeof snap === "object" ? Object.keys(snap) : typeof snap,
							snapshot: snap,
							cards: sessionItems(),
							graph: {
								rowCount: graph.rowCount,
								gutter: graph.gutter,
								stats: graph.stats,
								spines: graph.spines,
								edges: graph.edges,
								nodes: graph.nodes.map(function (n) {
									return {
										id: n.id,
										kind: n.kind,
										row: n.row,
										lane: n.lane,
										sessionId: n.sessionId,
										sessionTitle: n.sessionTitle,
										turn: Number.isFinite(n.turn) ? n.turn : null,
										seq: Number.isFinite(n.seq) ? n.seq : null,
										isHead: n.isHead === true,
										prompt: n.prompt ? String(n.prompt).slice(0, 40) : null,
										sharedBy: n.sharedBy || [],
										forkChildren: n.forkChildren || null,
										hiddenCount: n.hiddenCount,
										subCount: n.subCount,
										count: n.count,
										expanded: n.expanded === true,
										index: n.index,
										turnCount: n.turnCount
									};
								}),
								lanes: graph.lanes.map(function (l) {
									return {
										sessionId: l.row.id,
										title: l.row.title,
										lane: l.lane,
										parentId: l.parent !== null ? l.parent.row.id : null,
										forkSource: l.fork !== null ? l.fork.source : null,
										forkNote: l.fork !== null ? l.fork.note : null,
										shareCount: l.shareCount,
										firstOwnTurn: l.firstOwnTurn,
										ownTurns: l.ownTurns.map(function (e) { return e.turn; }),
										attachNodeId: l.attachNode !== null ? l.attachNode.id : null,
										expanded: l.expanded === true,
										hasTurns: l.nodes.length,
										hasPlaceholder: l.placeholder !== null,
										subCount: l.summary !== void 0 ? l.summary.subCount : 0
									};
								})
							},
							renderedNodeCards: container !== null ? container.querySelectorAll(".dsh-tree-node").length : 0,
							renderedSvgElements: container !== null ? container.querySelectorAll(".dsh-tree-graph-svg *").length : 0,
							forks: loadForks(),
							marks: loadMarks(),
							layout: layout,
							graphState: { branches: [...expandedBranches], subs: [...expandedSubs], empty: expandedEmpty },
							goal: currentGoal(),
							activeSessionId: activeSessionId,
							filterTab: filterTab,
							flashNodeId: flashNodeId,
							panel: { open: open, visible: overlayVisibleNow(), lastToggle: lastToggle, build: BUILD_TAG, canvasBroken: canvasBroken },
							menuOpen: menu !== null,
							menuItems: menu !== null ? menu.items.map(function (i) { return i.label || "---"; }) : null,
							lastLocate: lastLocate,
							lastOpen: lastOpen,
							lastForkFromNode: lastForkFromNode,
							lastCopy: lastCopy,
							toast: toast,
							toastLog: toastLog,
							ui: {
								setFilterTab: setFilterTab,
								toggleMark: onToggleMark,
								toggleExpandAll: toggleExpandAll,
								expandBranch: expandBranch,
								toggleSubGroup: toggleSubGroup,
								forkActive: forkActiveSession
							},
							lastSeqOf: lastSeqOf,
							turnOutlineOf: turnOutlineOf,
							resolveAnchorTurn: resolveAnchorTurn,
							sessions: sessionsService,
							actions: {
								activateNode: function (nodeId) {
									var node = findNode(nodeId);
									if (node === null) return { error: "no such node " + nodeId };
									activateNode(node);
									return { ok: true, nodeId: nodeId, kind: node.kind, sessionId: node.sessionId, turn: Number.isFinite(node.turn) ? node.turn : null };
								},
								openTurn: function (sessionId, turn) {
									var graph = lastGraph;
									var node = null;
									for (var n of graph.nodes) if (n.sessionId === sessionId && n.kind === "turn" && n.turn === turn) { node = n; break; }
									if (node === null) return { error: "no node for " + sessionId + " turn " + turn };
									activateNode(node);
									return { ok: true, nodeId: node.id };
								},
								forkFromNode: function (nodeId) {
									var node = findNode(nodeId);
									if (node === null) return { error: "no such node " + nodeId };
									forkFromNode(node);
									return { ok: true, nodeId: nodeId, sessionId: node.sessionId, seq: node.seq };
								},
								openMenu: function (nodeId) {
									var node = findNode(nodeId);
									if (node === null) return { error: "no such node " + nodeId };
									openNodeMenu(node, { clientX: 220, clientY: 220 });
									var el = document.querySelector(".dsh-tree-menu");
									return {
										ok: true,
										nodeId: nodeId,
										items: el !== null ? [...el.querySelectorAll(".dsh-tree-menu-item")].map(function (x) { return x.textContent; }) : null
									};
								},
								closeMenu: function () {
									menu = null;
									render();
								},
								clickMenuItem: function (label) {
									var el = [...document.querySelectorAll(".dsh-tree-menu-item")];
									var target = null;
									for (var i = 0; i < el.length; i++) if (el[i].textContent === label) { target = el[i]; break; }
									if (target === null) target = el[Number(label)] || null;
									if (target === null) return { error: "no menu item " + label };
									target.click();
									return { ok: true, label: target.textContent };
								},
								reorder: function (dragged, target) { return reorderCards(dragged, target); },
								snapshot: function () { return listSnapshot(); },
								/** 性能：用合成数据集跑一次真实建图（不动真实会话）。 */
								stress: function (sessionCount, turnsPerSession) {
									var synthRows = stressRows(sessionCount, turnsPerSession, true);
									var t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
									var g = buildGraph({
										rows: synthRows,
										allIds: new Set(synthRows.map(function (r) { return r.id; })),
										forks: {},
										order: [],
										expanded: new Set(),
										expandedSubs: new Set(),
										expandedEmpty: false
									});
									var t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
									var g2 = buildGraph({
										rows: synthRows,
										allIds: new Set(synthRows.map(function (r) { return r.id; })),
										forks: {},
										order: [],
										expanded: new Set(synthRows.map(function (r) { return r.id; })),
										expandedSubs: new Set(),
										expandedEmpty: true
									});
									var t2 = typeof performance !== "undefined" ? performance.now() : Date.now();
									return {
										sessions: synthRows.length,
										turnsPerSession: turnsPerSession,
										defaultView: { rows: g.rowCount, branches: g.stats.branches, totalTurns: g.stats.totalTurns, visibleTurns: g.stats.visibleTurns, hiddenTurns: g.stats.hiddenTurns, buildMs: Math.round((t1 - t0) * 100) / 100 },
										allExpanded: { rows: g2.rowCount, visibleTurns: g2.stats.visibleTurns, buildMs: Math.round((t2 - t1) * 100) / 100 },
										lanes: g.lanes.length,
										edges: g.edges.length
									};
								},
								/** 性能：把合成图真的渲染进离屏容器，数 DOM 节点 + 量渲染耗时。 */
								stressRender: function (sessionCount, turnsPerSession, height, expandedAll) {
									var synthRows = stressRows(sessionCount, turnsPerSession, true);
									var t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
									var g = buildGraph({
										rows: synthRows,
										allIds: new Set(synthRows.map(function (r) { return r.id; })),
										forks: {},
										order: [],
										expanded: expandedAll === true ? new Set(synthRows.map(function (r) { return r.id; })) : new Set(),
										expandedSubs: expandedAll === true ? new Set(synthRows.map(function (r) { return r.id; })) : new Set(),
										expandedEmpty: expandedAll === true
									});
									var t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
									var host = document.createElement("div");
									// 必须给一个"有确定高度的 flex 容器"，否则 .dsh-tree-graph 会被内容撑开，
									// clientHeight = 全部内容高度，视口虚拟化就永远不生效（基准值会骗人）。
									host.style.cssText = "position:fixed;left:-10000px;top:0;width:380px;";
									document.body.appendChild(host);
									var benchRoot = react_dom_client.createRoot(host);
									var t2 = typeof performance !== "undefined" ? performance.now() : Date.now();
									benchRoot.render(
										react_jsx_runtime.jsx("div", {
											className: "dsh-tree-panel-body",
											style: { height: (height || 600) + "px", width: "380px" },
											children: react_jsx_runtime.jsx(GraphView, {
												graph: g,
												activeSessionId: null,
												flashNodeId: null,
												focus: null,
												marksOf: function () { return { star: false, archive: false }; },
												onActivateNode: function () {},
												onNodeContextMenu: function () {},
												onToggleMark: function () {},
												onJumpToChild: function () {},
												onQuickFork: function () {},
												onLocate: function () {},
												onReorder: function () {}
											})
										})
									);
									// React 18 的 root.render 是异步的：必须等它提交完再数 DOM，
									// 否则数到的永远是空容器（这条基线值没有意义）。
									return new Promise(function (resolve) {
										var settle = function () {
											var t3 = typeof performance !== "undefined" ? performance.now() : Date.now();
											var domNodes = host.querySelectorAll(".dsh-tree-node").length;
											var svgKids = host.querySelectorAll(".dsh-tree-graph-svg *").length;
											var canvas = host.querySelector(".dsh-tree-graph-inner");
											var firstCard = host.querySelector(".dsh-tree-node");
											var viewportEl = host.querySelector(".dsh-tree-graph");
											var result = {
												sessions: synthRows.length,
												turnsPerSession: turnsPerSession,
												expandedAll: expandedAll === true,
												rows: g.rowCount,
												totalTurns: g.stats.totalTurns,
												buildMs: Math.round((t1 - t0) * 100) / 100,
												paintMs: Math.round((t3 - t2) * 100) / 100,
												domNodeCards: domNodes,
												svgElements: svgKids,
												canvasHeight: canvas !== null ? canvas.style.height : null,
												viewportHeight: viewportEl !== null ? viewportEl.clientHeight : null,
												firstCardTop: firstCard !== null ? firstCard.style.top : null
											};
											try { benchRoot.unmount(); } catch {}
											try { host.parentNode.removeChild(host); } catch {}
											resolve(result);
										};
										if (typeof requestAnimationFrame === "function") requestAnimationFrame(function () { requestAnimationFrame(settle); });
										else setTimeout(settle, 120);
									});
								}
							}
						};
					};
				} catch (err) {
					console.warn("[dsh-tree-panel] 调试钩子安装失败：", err);
				}
			} catch (err) {
				console.warn("[dsh-tree-panel] 注入失败，已安全降级：", err);
			}
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
