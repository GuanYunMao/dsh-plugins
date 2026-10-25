/**
 * dsh-kb 的记忆子系统（宿主侧）：窗口记忆 + 项目记忆。
 *
 * 为什么要分两级（用户反馈）：
 * - 原来按"工作区目录名"存 `<kb>/<库>/记忆.md`，同一工作区里所有窗口共用一份，
 *   于是新窗口会看到别的窗口写下的记忆，面板却标成"当前"——身份就是错的。
 * - 现在：**一个窗口一篇** `<kb>/<库>/窗口/<会话短 id>.md`，只注入给它自己；
 *   项目级 `<kb>/<库>/记忆.md` 保留，但**默认不注入**，要用户在面板上明确"允许注入"。
 *
 * 注入：两条 systemPrompt.section（窗口记忆 949 / 项目记忆 950），文本函数是同步的，
 * 按 mtime+size 缓存；压缩只重写会话历史，从不碰系统提示，所以结构上免疫压缩。
 *
 * 存储：
 * - 记忆正文：普通 Markdown 文件，人类可随时手改（手改区由 `<!-- 手改区开始 -->` 保护）。
 * - 运行状态：`<storages>/dsh-kb/memory.json`（settings / sessions / projects），不含任何凭据。
 */
import { readFile, writeFile, mkdir, copyFile, rename, rm, stat } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/** 项目记忆文件名（同时也是"这个库有没有项目记忆"的判据）。 */
export const MEMORY_FILE = "记忆.md";
/** 窗口记忆目录名（放在库目录下，天然不进知识库索引：listDocuments 只扫一层文件）。 */
export const WINDOW_DIR = "窗口";
/** 记忆备份槽位数（.bak.1~3）。 */
const MEMORY_BAK_SLOTS = 3;
/** 同一窗口两次更新的最小间隔硬下限（红线）。 */
const MEMORY_MIN_INTERVAL_FLOOR_MS = 120000;
/** 注入段名与位置：FILE_REFERENCE(900) 之后、TOOL_*(1000+) 之前。 */
const SESSION_SECTION = "kb:session-memory";
const PROJECT_SECTION = "kb:project-memory";
const SESSION_SECTION_ORDER = 949;
const PROJECT_SECTION_ORDER = 950;

/** 记忆默认参数（cordis.patch.yml 的 config.memory 覆盖）。 */
export const DEFAULTS = {
	enabled: true,
	/** 同一窗口累计多少轮触发一次自动重写。 */
	turns: 6,
	minIntervalMs: MEMORY_MIN_INTERVAL_FLOOR_MS,
	recentTurns: 8,
	maxMessageChars: 2000,
	maxInputChars: 12000,
	maxInjectChars: 6000,
	maxTokens: 2600,
	timeoutMs: 60000,
	/** 项目记忆总开关：**默认关闭，由用户手动开启**；开启后按同样的轮次节奏自动维护。
	 *  它不会自动注入正文，AI 需要时用 memory_read 按 query 取。 */
	projectEnabled: false,
	autoReindex: true,
	/**
	 * 检索回执：AI 每次用 kb_search / 面板每次检索，都把「查了什么 → 命中哪个文件哪一节」记下来，
	 * 并跟着窗口记忆一起进入系统提示（每轮都在，压缩也不丢）。
	 * 目的：上下文被压缩后，AI 还知道自己查过什么、要不要再取全文。
	 */
	receipts: true,
	maxReceipts: 5,
	maxReceiptChars: 700,
};

/** 手改区标记：两段注释之间的内容由用户手写，滚动重写原样保留。 */
const PIN_START = "<!-- 手改区开始";
const PIN_END = "<!-- 手改区结束";
const PIN_SCAFFOLD = [
	"<!-- 手改区开始（此区块由 dsh-kb 在自动重写时原样保留：把手写约定放这里，模型改不动） -->",
	"<!-- 手改区结束 -->",
].join("\n");

/** 把工作区目录名压成安全的库名（也是 <kb>/ 下的文件夹名）。 */
export function sanitizeLibraryName(raw) {
	const cleaned = String(raw ?? "")
		.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
		.replace(/^[.\s]+|[.\s]+$/gu, "")
		.slice(0, 64)
		.trim();
	return cleaned || "未命名工作区";
}

/** 工作区目录 → 库名（目录名，不含盘符与父路径）。 */
export function libraryForCwd(cwd) {
	if (typeof cwd !== "string" || !cwd.trim()) return void 0;
	const trimmed = cwd.trim().replace(/[\\/]+$/u, "");
	return sanitizeLibraryName(basename(trimmed) || trimmed);
}

/** 会话 id → 短 id（文件名用；去掉 session- 前缀，只留 8 位字母数字）。 */
export function sessionShortId(sessionId) {
	const s = String(sessionId ?? "").replace(/^session-/u, "").replace(/[^0-9a-zA-Z]/gu, "").toLowerCase();
	return s.slice(0, 8) || "unknown";
}

/** 从会话事件里折出最新标题（`session/title` 事件，官方 session-title 插件写入）。 */
export function foldSessionTitle(session) {
	try {
		const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
		for (let i = events.length - 1; i >= 0; i--) {
			const event = events[i];
			if (event?.type === "session/title" && typeof event.data?.title === "string" && event.data.title.trim()) {
				return event.data.title.trim();
			}
		}
	} catch {
		/* 没有事件就退回空串 */
	}
	return "";
}

function logOf(logger) {
	return typeof logger === "function" ? logger : () => {};
}

/** 文件名清洗：去掉路径非法字符，压掉多余空格，限长（Windows 文件名上限很宽，但太长不好看）。 */
function cleanFilePart(raw, limit = 40) {
	return String(raw ?? "")
		.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, limit)
		.trim();
}

/**
 * 窗口记忆文件名：`<窗口标题>-<短id>.md`。
 * 以前只有 `<短id>.md`（486dda5d.md 这种），内容一多就没人知道哪个文件是哪个窗口的。
 * 短 id 保留是为了两条不同标题的会话不会撞名。
 */
export function windowFileName(title, sessionId) {
	const short = sessionShortId(sessionId);
	const cleaned = cleanFilePart(title);
	return cleaned && cleaned !== short ? `${cleaned}-${short}.md` : `${short}.md`;
}

/** 项目记忆文件路径（库根下的 记忆.md）。 */
export function projectMemoryPath(kbRoot, library) {
	return join(kbRoot, library, MEMORY_FILE);
}

/**
 * 解析**指定的**会话 —— 不做"最近活动的会话"兜底。
 * 以前这里的兜底会让面板把别的工作区的窗口（比如 REA）当成本窗口，把别人的记忆标成
 * "当前 + 已注入"。拿不到就是拿不到，面板显示"未识别窗口"更诚实。
 */
export function resolveSession(ctx, sessionId) {
	try {
		const wanted = sessionId ? String(sessionId) : "";
		if (!wanted) return void 0;
		const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : void 0;
		if (!sessions) return void 0;
		if (typeof sessions.get === "function") {
			const hit = sessions.get(wanted);
			if (hit) return hit;
		}
		// 某些装配下 get() 只认"已挂载"的会话，列表里可能还有同一 id 的实例
		const all = typeof sessions.list === "function" ? sessions.list() : [];
		if (Array.isArray(all)) {
			for (const session of all) {
				if (session && String(session.id) === wanted) return session;
			}
		}
		return void 0;
	} catch {
		return void 0;
	}
}

/** 会话 id → 面板可读标题（标题事件优先，否则短 id）。 */
export function sessionDisplayTitle(session) {
	if (!session) return "";
	return foldSessionTitle(session) || String(session.id).replace(/^session-/u, "").slice(0, 8);
}

/**
 * 建立记忆运行时。
 * @param deps.kbRoot 知识库根目录（可能被 paths 覆盖，调用时求值）
 * @param deps.storeRoot 索引/状态存储目录
 * @param deps.rebuildLibrary 重建某个库索引的函数（项目记忆写入后顺手刷新）
 */
export function createMemory({ ctx, kbRoot, storeRoot, log, indexConfig, rawConfig, rebuildLibrary }) {
	const warn = logOf(log);
	const kbRootOf = typeof kbRoot === "function" ? kbRoot : () => kbRoot;
	const storeRootOf = typeof storeRoot === "function" ? storeRoot : () => storeRoot;

	const config = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === "object" ? rawConfig : {}) };
	config.minIntervalMs = Math.max(MEMORY_MIN_INTERVAL_FLOOR_MS, Number(config.minIntervalMs) || MEMORY_MIN_INTERVAL_FLOOR_MS);
	config.turns = Math.min(Math.max(1, Math.floor(Number(config.turns) || DEFAULTS.turns)), 200);
	config.maxReceipts = Math.min(Math.max(1, Math.floor(Number(config.maxReceipts) || DEFAULTS.maxReceipts)), 20);
	config.maxReceiptChars = Math.min(Math.max(120, Math.floor(Number(config.maxReceiptChars) || DEFAULTS.maxReceiptChars)), 4000);

	let state = null;
	/** 进程内：<会话 id → 已累计轮次>。 */
	const turnCounts = new Map();
	/** 进程内：<key → 正在跑的 promise>，key = `s:<会话>` / `p:<库>`。 */
	const inFlight = new Map();
	/** 进程内：<记忆文件绝对路径 → { mtimeMs, size, rendered }>，给同步注入用。 */
	const injectCache = new Map();
	/** dsh-llm 模块缓存（动态 import，缺席时只影响重写）。 */
	let llmModule;
	let injectEnabled = false;

	/* ---------- 路径 ---------- */
	const windowDirOf = (library) => join(kbRootOf(), library, WINDOW_DIR);
	/** 窗口记忆文件的相对路径（`窗口/<标题>-<短id>.md`）。 */
	const windowRelOf = (sessionId, title) => `${WINDOW_DIR}/${windowFileName(title, sessionId)}`;
	const sessionPathOf = (library, sessionId, title) => join(windowDirOf(library), windowFileName(title, sessionId));
	/**
	 * 读窗口记忆时优先用"标题命名"的文件；老数据可能还是 `<短id>.md`，
	 * 两个候选里挑实际存在的那个，命名与兼容都不丢。
	 */
	const existingWindowPathOf = (library, sessionId, title, record) => {
		const named = sessionPathOf(library, sessionId, title);
		const legacyRel = record && typeof record.file === "string" ? record.file : "";
		if (!legacyRel) return named;
		const legacy = join(kbRootOf(), library, legacyRel);
		if (legacy === named) return named;
		if (existsSync(named)) return named;
		return existsSync(legacy) ? legacy : named;
	};
	const projectPathOf = (library) => projectMemoryPath(kbRootOf(), library);
	const bakPathOf = (path, slot) => `${path}.bak.${slot}`;
	const statePath = () => join(storeRootOf(), "memory.json");

	/* ---------- 状态文件 ---------- */
	/**
	 * 状态文件加载（**promise 级记忆**）。
	 * 启动时的 `void load()` 会和面板第一次请求并发；若只缓存结果对象，
	 * 两个并发的 load 会各自 new 一份 state，后写入的那份把先前的改动静默覆盖
	 * （单测里 turns=9 被冲回 6 就是这个）。缓存 promise 才是幂等的。
	 */
	let loading = null;
	async function load() {
		if (state) return state;
		if (loading) return loading;
		loading = (async () => {
			let parsed;
			try {
				parsed = JSON.parse(await readFile(statePath(), "utf8"));
			} catch (error) {
				// 只有"文件不存在"才是真的空状态。文件坏了/读不了时先隔离再重建，
				// 否则下一次 save() 会把空状态写回，sessions/projects 元数据全丢。
				if (error?.code !== "ENOENT") {
					const corrupt = `${statePath()}.corrupt-${Date.now()}`;
					try {
						await rename(statePath(), corrupt);
						warn(`记忆状态文件不可读，已隔离为 ${basename(corrupt)}，将重建（旧统计会丢，记忆正文不受影响）`);
					} catch (renameError) {
						warn("记忆状态文件损坏且无法隔离：", renameError?.message ?? String(renameError));
					}
				}
				parsed = void 0;
			}
			// v1 → v2：原来的 libraries 就是"项目记忆"，sessions 继续保留
			const projects = parsed?.projects && typeof parsed.projects === "object" ? parsed.projects : parsed?.libraries && typeof parsed.libraries === "object" ? parsed.libraries : {};
			const sessions = {};
			for (const [sid, record] of Object.entries(parsed?.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {})) {
				if (record && typeof record === "object") sessions[sid] = record;
			}
			// 自愈：库目录暂时不存在（换盘、未挂载、路径改错）不代表用户删了库，
			// 所以只"标记缺失"、不删记录——删元数据是不可逆的，交给 forgetLibrary 显式做。
			const aliveProjects = {};
			let missing = 0;
			for (const [library, record] of Object.entries(projects)) {
				if (existsSync(join(kbRootOf(), library))) {
					aliveProjects[library] = record.missing ? { ...record, missing: void 0 } : record;
				} else {
					missing++;
					aliveProjects[library] = { ...record, missing: true };
				}
			}
			state = {
				version: 2,
				settings: parsed?.settings && typeof parsed.settings === "object" ? parsed.settings : {},
				sessions,
				projects: aliveProjects,
				// 库改名别名：旧名 → 新名。工作区 cwd 目录名不会跟着变，靠它把读写接回新库。
				aliases: parsed?.aliases && typeof parsed.aliases === "object" ? parsed.aliases : {},
			};
			// v1 迁移：v1 只有"按工作区一份"的记忆，记录里带着当时的会话 id。
			// 那份内容属于产生它的那个窗口，所以复制到该窗口的记忆文件（只补空缺，不覆盖）。
			let migrated = 0;
			try {
				for (const [sid, record] of Object.entries(sessions)) {
					if (record.file) continue;
					const library = record.library;
					if (!library) continue;
					const projectPath = projectMemoryPath(kbRootOf(), library);
					const windowPath = sessionPathOf(library, sid);
					if (existsSync(windowPath) || !existsSync(projectPath)) continue;
					await mkdir(windowDirOf(library), { recursive: true });
					await copyFile(projectPath, windowPath);
					record.file = `${WINDOW_DIR}/${sessionShortId(sid)}.md`;
					record.migratedFromV1 = true;
					migrated++;
					warn(`v1 记忆已归位到窗口文件：${library}/${sessionShortId(sid)}.md`);
				}
			} catch (error) {
				warn("v1 记忆归位失败（忽略）：", error.message);
			}
			if (migrated > 0) {
				warn(`记忆状态迁移：${migrated} 条记录已归位`);
				void save();
			}
			if (missing > 0) warn(`有 ${missing} 个库目录当前不存在（记录保留，只标缺失）`);
			loading = null;
			return state;
		})();
		return loading;
	}

	/** 状态写盘：串行 + 原子替换（tmp → rename），避免半截 JSON 与并发覆盖。 */
	let saveChain = Promise.resolve();
	async function save() {
		const current = state ?? (await load());
		saveChain = saveChain.then(async () => {
			try {
				await mkdir(storeRootOf(), { recursive: true });
				const target = statePath();
				const tmp = `${target}.tmp`;
				await writeFile(tmp, JSON.stringify(current, null, 2), "utf8");
				await rename(tmp, target);
			} catch (error) {
				warn("记忆状态写入失败（不影响记忆文件）：", error.message);
			}
		});
		return saveChain;
	}

	/** 生效设置 = 状态文件里的覆盖值 + 配置默认值。 */
	function settings() {
		const stored = state?.settings ?? {};
		return {
			enabled: typeof stored.enabled === "boolean" ? stored.enabled : config.enabled === true,
			turns: Number.isFinite(Number(stored.turns)) ? Math.min(Math.max(1, Math.floor(Number(stored.turns))), 200) : config.turns,
			minIntervalMs: config.minIntervalMs,
			// 项目记忆总开关：默认关，用户手动开；开了之后自动维护（但仍不自动注入正文）
			projectEnabled: typeof stored.projectEnabled === "boolean" ? stored.projectEnabled : config.projectEnabled === true,
			recentTurns: config.recentTurns,
			maxInputChars: config.maxInputChars,
			maxInjectChars: config.maxInjectChars,
			maxTokens: config.maxTokens,
			// 检索回执（默认开）：把最近查过什么随窗口记忆一起注入，压缩后仍可回忆
			receipts: typeof stored.receipts === "boolean" ? stored.receipts : config.receipts !== false,
			maxReceipts: config.maxReceipts,
			maxReceiptChars: config.maxReceiptChars,
		};
	}

	async function setSettings(patch = {}) {
		const current = await load();
		if (typeof patch.enabled === "boolean") current.settings.enabled = patch.enabled;
		if (patch.projectEnabled !== void 0) {
			if (typeof patch.projectEnabled !== "boolean") return { ok: false, error: "projectEnabled 必须是布尔值" };
			current.settings.projectEnabled = patch.projectEnabled;
		}
		// 兼容旧字段（0.3~0.6 的 injectProject）：只做校验，不再影响任何注入行为
		if (patch.injectProject !== void 0 && typeof patch.injectProject !== "boolean") {
			return { ok: false, error: "injectProject 必须是布尔值" };
		}
		if (patch.receipts !== void 0) {
			if (typeof patch.receipts !== "boolean") return { ok: false, error: "receipts 必须是布尔值" };
			current.settings.receipts = patch.receipts;
		}
		if (patch.turns !== void 0) {
			const turns = Number(patch.turns);
			if (!Number.isInteger(turns) || turns < 1 || turns > 200) return { ok: false, error: "turns 必须是 1~200 的整数" };
			current.settings.turns = turns;
		}
		await save();
		return { ok: true, settings: settings() };
	}

	/* ---------- 会话解析 ---------- */
	function describeSession(session, explicitId) {
		if (!session) return void 0;
		const cwd = typeof session.header?.cwd === "string" ? session.header.cwd : void 0;
		const sid = String(session.id);
		// 库改名后 cwd 目录名还是旧的：优先认记录里的 library（及其改名别名），cwd 只作回退
		const remembered = state?.sessions?.[sid]?.library;
		const aliasHit = remembered ? (state?.aliases?.[remembered] ?? remembered) : void 0;
		const library = aliasHit || libraryForCwd(cwd);
		return {
			id: sid,
			title: sessionDisplayTitle(session),
			cwd,
			library,
			session,
			source: explicitId ? "session" : "recent",
		};
	}

	/** 会话当前模型路由：请求头优先，其次部署默认模型。 */
	function resolveRoute(session) {
		try {
			const header = typeof session?.requestHeader === "function" ? session.requestHeader() : void 0;
			const cfg = header?.config;
			if (cfg?.provider && cfg?.model) return { provider: String(cfg.provider), model: String(cfg.model), source: "session" };
		} catch {
			/* 落到默认模型 */
		}
		try {
			const fallback = typeof ctx.get === "function" ? ctx.get("agentDefaultModel")?.currentSelection?.() : void 0;
			if (fallback?.provider && fallback?.model) return { provider: String(fallback.provider), model: String(fallback.model), source: "default" };
		} catch {
			/* 没有可用路由 */
		}
		return void 0;
	}

	/* ---------- 文件读写 ---------- */
	async function readText(path) {
		try {
			return { path, exists: true, text: await readFile(path, "utf8") };
		} catch (error) {
			// 只有"文件不存在"能当成空内容。读不了（EACCES/共享冲突）必须让调用方知道，
			// 否则 update 会以为没有旧内容、跳过备份直接覆盖。
			if (error?.code === "ENOENT") return { path, exists: false, text: "" };
			return { path, exists: false, text: "", error: error?.message ?? String(error) };
		}
	}

	/** 原子写：先写 .tmp 再改名，避免面板/注入读到半截内容。 */
	async function writeText(path, text) {
		await mkdir(join(path, ".."), { recursive: true });
		const tmp = `${path}.tmp`;
		await writeFile(tmp, text);
		await rename(tmp, path);
		injectCache.delete(path);
	}

	async function rotateBackups(path, previousText) {
		await mkdir(join(path, ".."), { recursive: true });
		for (let slot = MEMORY_BAK_SLOTS - 1; slot >= 1; slot--) {
			try {
				await copyFile(bakPathOf(path, slot), bakPathOf(path, slot + 1));
			} catch {
				/* 该槽位还不存在 */
			}
		}
		if (previousText) {
			try {
				await writeFile(bakPathOf(path, 1), previousText);
			} catch (error) {
				warn(`记忆备份写入失败（不影响正文）：${error.message}`);
			}
		}
	}

	async function listVersions(path) {
		const out = [];
		for (let slot = 1; slot <= MEMORY_BAK_SLOTS; slot++) {
			const bak = bakPathOf(path, slot);
			try {
				const info = await stat(bak);
				const text = await readFile(bak, "utf8");
				const firstLine = text.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? "";
				out.push({
					slot,
					path: bak,
					savedAt: new Date(info.mtimeMs).toISOString(),
					bytes: info.size,
					lines: text.split(/\r?\n/u).length,
					preview: clip(firstLine, 60),
				});
			} catch {
				out.push({ slot, path: bak, exists: false });
			}
		}
		return out;
	}

	/* ---------- 文本工具 ---------- */
	function clip(text, limit) {
		const value = String(text ?? "");
		return value.length > limit ? `${value.slice(0, limit)}…（已截断）` : value;
	}

	/** 逐行 diff：返回新增/删除行数（LCS），行数过多时退化为计数比较。 */
	function lineDiff(before, after) {
		const a = String(before ?? "").split(/\r?\n/u);
		const b = String(after ?? "").split(/\r?\n/u);
		if (a.length * b.length > 400000) {
			const setA = new Set(a);
			const added = b.filter((line) => !setA.has(line)).length;
			const setB = new Set(b);
			const removed = a.filter((line) => !setB.has(line)).length;
			return { added, removed, before: a.length, after: b.length };
		}
		const dp = new Array(b.length + 1).fill(0);
		for (let i = 1; i <= a.length; i++) {
			let prev = 0;
			for (let j = 1; j <= b.length; j++) {
				const keep = dp[j];
				dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
				prev = keep;
			}
		}
		const lcs = dp[b.length];
		return { added: b.length - lcs, removed: a.length - lcs, before: a.length, after: b.length };
	}

	function diffSummary(diff) {
		return `+${diff.added}/-${diff.removed} 行（${diff.before} → ${diff.after} 行）`;
	}

	function normalizeText(text) {
		return String(text ?? "")
			.replace(/\r\n/gu, "\n")
			.split("\n")
			.map((line) => line.replace(/\s+$/u, ""))
			.join("\n")
			.replace(/^\n+|\n+$/gu, "");
	}

	/** 拆出「手改区」：标记之间的内容不进模型、不被覆盖。 */
	function splitPinned(text) {
		const raw = String(text ?? "");
		const start = raw.indexOf(PIN_START);
		if (start < 0) return { pinned: "", body: raw };
		const end = raw.indexOf(PIN_END, start);
		let pinnedEnd;
		if (end < 0) pinnedEnd = raw.length;
		else {
			const endLine = raw.indexOf("\n", end);
			pinnedEnd = endLine < 0 ? raw.length : endLine + 1;
		}
		return { pinned: raw.slice(start, pinnedEnd).trim(), body: `${raw.slice(0, start)}${raw.slice(pinnedEnd)}`.trim() };
	}

	function contentBrief(content) {
		if (!Array.isArray(content)) return "";
		const parts = [];
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
			else if (block.type === "tool-call") parts.push(`〔调用工具 ${block.name ?? "?"}〕`);
			else if (block.type === "tool-result") parts.push("〔工具执行结果〕");
		}
		return parts.join("\n").trim();
	}

	/** 收集该会话最近若干轮（默认只取上次更新之后）的对话要点。 */
	function collectTurns(session, sinceSeq) {
		const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
		const rounds = [];
		let current = null;
		for (const event of events) {
			if (event?.type === "turn/start") {
				current = { turn: Number(event.data?.turn ?? rounds.length + 1), lines: [] };
				continue;
			}
			if (event?.type === "turn/end") {
				if (current) {
					current.endSeq = event.seq;
					rounds.push(current);
					current = null;
				}
				continue;
			}
			if (!current) continue;
			if (event.type === "user/message") {
				// 只取真实用户输入：runtime context / 工作区指令等插件注入消息会污染记忆。
				if (event.data?.source?.kind !== "user") continue;
				const text = contentBrief(event.data?.content);
				if (text) current.lines.push(`用户：${clip(text, config.maxMessageChars)}`);
			} else if (event.type === "assistant/message") {
				const text = contentBrief(event.data?.message?.content);
				if (text) current.lines.push(`助手：${clip(text, config.maxMessageChars)}`);
			}
		}
		if (current) {
			current.endSeq = session?.seq;
			rounds.push(current);
		}
		const since = Number.isFinite(Number(sinceSeq)) ? Number(sinceSeq) : 0;
		let picked = rounds.filter((round) => Number(round.endSeq ?? 0) > since);
		if (picked.length === 0) picked = rounds.slice(-1);
		picked = picked.slice(-config.recentTurns);
		const chunks = [];
		let used = 0;
		for (let i = picked.length - 1; i >= 0; i--) {
			const body = `— 第 ${picked[i].turn} 轮 —\n${picked[i].lines.join("\n")}`;
			if (used + body.length > config.maxInputChars && chunks.length > 0) break;
			chunks.push(body);
			used += body.length;
		}
		chunks.reverse();
		const lastSeq = picked.length > 0 ? Number(picked[picked.length - 1].endSeq ?? since) : since;
		return { text: chunks.join("\n\n"), turns: picked.length, lastSeq, chars: used };
	}

	/* ---------- 注入 ---------- */
	/**
	 * 记忆正文是自由文本（模型写 + 人类可手改），拼进提示前必须拆掉"闭合标签"序列：
	 * 否则正文里一句 `</session-memory>` 就能提前闭合区块，形成长期驻留的提示注入面。
	 */
	function defuseTag(text, tagName) {
		return String(text).replace(new RegExp(`<\\s*/?\\s*${tagName}`, "giu"), (match) => match.replace(/</gu, "‹"));
	}

	/** 同步渲染一段记忆区块（按 mtime/size 缓存）。 */
	function renderBlock(path, openTag, framing, limit) {
		try {
			const info = statSync(path);
			if (!info.isFile() || info.size === 0) return "";
			const cached = injectCache.get(path);
			if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.rendered;
			const raw = readFileSync(path, "utf8").trim();
			if (!raw) return "";
			const tagName = openTag.split(" ")[0];
			const clipped = raw.length > limit ? `${raw.slice(0, limit)}\n…（记忆较长已截断，完整内容见该文件）` : raw;
			const body = defuseTag(clipped, tagName);
			const rendered = [`<${openTag} file="${path}" updated="${new Date(info.mtimeMs).toISOString()}">`, framing, body, `</${tagName}>`].join("\n");
			injectCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, rendered });
			return rendered;
		} catch {
			return "";
		}
	}

	/** 窗口记忆注入文本：只属于当前窗口。 */
	function sessionSectionText(assembly) {
		if (!injectEnabled) return "";
		const session = assembly?.agent?.session;
		const cwd = session?.header?.cwd;
		const sid = session?.id;
		const library = libraryForCwd(cwd);
		if (!library || !sid) return "";
		const title = foldSessionTitle(session) || String(sid).replace(/^session-/u, "").slice(0, 8);
		const limit = settings().maxInjectChars;
		const memoryBlock = renderBlock(
			existingWindowPathOf(library, sid, foldSessionTitle(session), state?.sessions?.[sid]),
			`session-memory window="${title.replace(/"/gu, "'")}"`,
			"以下内容由 dsh-kb 从本窗口的对话自动维护（只属于这个窗口，不来自其它窗口；用户可直接编辑该文件，冲突时以用户当前指令为准）。",
			limit,
		);
		const receipts = receiptsText(sid);
		return [memoryBlock, receipts].filter(Boolean).join("\n");
	}

	/**
	 * 检索回执：把本窗口最近的检索（query → 命中的文件/小节）渲染成一小段注入文本。
	 * 系统提示的 section 每轮都会重新装配，所以即使对话被压缩，这段也还在。
	 */
	function receiptsText(sid) {
		if (!settings().receipts) return "";
		const list = state?.sessions?.[sid]?.receipts;
		if (!Array.isArray(list) || list.length === 0) return "";
		const maxChars = Number(config.maxReceiptChars) || DEFAULTS.maxReceiptChars;
		const lines = [];
		let used = 0;
		for (let i = list.length - 1; i >= 0; i--) {
			const item = list[i];
			const hits = (item.hits ?? []).slice(0, 3).map((hit) => {
				const where = `${hit.file ?? "?"}${hit.heading ? " · " + hit.heading : ""}`;
				const score = Number.isFinite(hit.score) ? `（${Number(hit.score).toFixed(2)}）` : "";
				return `${where}${score}`;
			});
			if (hits.length === 0) continue;
			const line = `- 「${item.q}」→ ${hits.join("；")}`;
			// 回执里的 query 是自由文本，同样不能让它闭合注入区块
			const safe = defuseTag(defuseTag(line, "session-memory"), "recent-searches");
			if (used + safe.length > maxChars && lines.length > 0) break;
			lines.unshift(safe);
			used += safe.length;
		}
		if (lines.length === 0) return "";
		return [
			"<recent-searches note=\"本窗口最近查过的知识库内容，供上下文被压缩后回忆；需要原文再调 kb_search\">",
			...lines,
			"</recent-searches>",
		].join("\n");
	}

	/**
	 * 记录一次检索（工具/面板/命令共用）。只留最近 maxReceipts 条，每条最多 3 个命中，
	 * 不存正文——只存"查过什么、命中哪里"，避免把索引内容复制进状态文件。
	 */
	async function noteSearch({ sessionId, query, results, by } = {}) {
		const sid = String(sessionId ?? "");
		const q = String(query ?? "").trim();
		if (!sid || !q) return { ok: false, error: "缺少会话或查询" };
		if (!settings().receipts) return { ok: true, skipped: true };
		const current = await load();
		const record = current.sessions[sid] ?? (current.sessions[sid] = {});
		const hits = (Array.isArray(results) ? results : []).slice(0, 3).map((hit) => ({
			file: hit?.file,
			heading: hit?.heading,
			score: Number.isFinite(hit?.score) ? Number(Number(hit.score).toFixed(3)) : void 0,
		}));
		const receipts = Array.isArray(record.receipts) ? record.receipts.slice() : [];
		receipts.push({ q: q.slice(0, 120), at: new Date().toISOString(), by: by ?? "ai", hits });
		while (receipts.length > (Number(config.maxReceipts) || DEFAULTS.maxReceipts)) receipts.shift();
		record.receipts = receipts;
		record.receiptsAt = Date.now();
		await save();
		return { ok: true, stored: receipts.length };
	}

	/**
	 * 项目记忆**不再自动注入**（用户明确：项目记忆是"主动型"，由人打开、由 AI 自己决定取什么）。
	 * 保留这个函数只为兼容旧调用；它现在永远返回空串，真正的取用走 `recall()`。
	 */
	function projectSectionText() {
		return "";
	}

	/**
	 * 只在系统提示里放一行"有项目记忆、需要时自己取"，不然模型不知道有这个东西。
	 * 不塞正文——正文由模型用 memory_read 按 query 选。
	 */
	function projectHintText(assembly) {
		if (!injectEnabled) return "";
		const cwd = assembly?.agent?.session?.header?.cwd;
		const library = libraryForCwd(cwd);
		if (!library) return "";
		try {
			const info = statSync(projectPathOf(library));
			if (!info.isFile() || info.size === 0) return "";
			return `<project-memory-available library="${library.replace(/"/gu, "'")}" file="${projectPathOf(library)}">\n这个项目有跨窗口的项目记忆（未自动加载）。需要项目约定/决策/路径/踩坑时，用 memory_read 工具按 query 取相关小节。\n</project-memory-available>`;
		} catch {
			return "";
		}
	}

	/**
	 * 按需读取记忆（给 agent 的 `memory_read` 工具用）。
	 * - window：本窗口记忆（自动维护，通常已在系统提示里，一般不用读）；
	 * - project：工作区项目记忆（不自动注入，AI 需要时自己取）；
	 * - auto：先窗口后项目。
	 * 有 query 时按 `## ` 小节切块并用二字组命中率排序，只回最相关的若干块（AI 自己选内容）。
	 */
	async function recall({ sessionId, query, scope = "auto", maxChars = 4000 } = {}) {
		const current = await load();
		const session = resolveSession(ctx, sessionId);
		const info = describeSession(session, sessionId);
		const library = info?.library;
		const q = String(query ?? "").trim();
		const limit = Math.min(Math.max(400, Number(maxChars) || 4000), 12000);
		const scopes = scope === "window" || scope === "project" ? [scope] : ["window", "project"];
		const packs = [];
		for (const which of scopes) {
			if (which === "window") {
				if (!info) continue;
				const record = current.sessions[info.id] ?? {};
				const path = existingWindowPathOf(library, info.id, info.title, record);
				const file = await readText(path);
				if (file.exists && file.text.trim()) packs.push({ scope: "window", label: "本窗口记忆", path, text: file.text });
			} else {
				if (!library) continue;
				const path = projectPathOf(library);
				const file = await readText(path);
				if (file.exists && file.text.trim()) packs.push({ scope: "project", label: `项目记忆（${library}）`, path, text: file.text });
			}
		}
		if (packs.length === 0) {
			return { ok: false, error: "没有可读的记忆：本窗口还没有生成记忆，项目记忆也还是空的" };
		}
		const results = [];
		let used = 0;
		for (const pack of packs) {
			const picked = pickSections(pack.text, q, Math.max(400, limit - used));
			for (const item of picked) {
				if (used + item.text.length > limit) break;
				results.push({ scope: pack.scope, label: pack.label, file: pack.path, heading: item.heading, text: item.text });
				used += item.text.length;
			}
			if (used >= limit) break;
		}
		return { ok: true, query: q, scope, library, chars: used, results, matched: results.length > 0 };
	}

	/** 把记忆文本按 `## ` 小节切块，按 query 二字组命中率排序；没有 query 就按原顺序全要。 */
	function pickSections(text, query, budget) {
		const raw = String(text ?? "").trim();
		if (!raw) return [];
		const parts = [];
		let heading = "";
		let buf = [];
		for (const line of raw.split(/\r?\n/)) {
			const m = /^##\s+(.+)$/u.exec(line);
			if (m) {
				if (buf.join("\n").trim()) parts.push({ heading, text: buf.join("\n").trim() });
				heading = m[1].trim();
				buf = [line];
				continue;
			}
			buf.push(line);
		}
		if (buf.join("\n").trim()) parts.push({ heading, text: buf.join("\n").trim() });
		if (!query) {
			const out = [];
			let used = 0;
			for (const part of parts) {
				if (used + part.text.length > budget) break;
				out.push(part);
				used += part.text.length;
			}
			return out.length ? out : [{ heading: "", text: raw.slice(0, budget) }];
		}
		const q = query.replace(/\s+/gu, "");
		const grams = [];
		for (let i = 0; i + 2 <= q.length; i++) grams.push(q.slice(i, i + 2));
		const scored = parts.map((part, index) => {
			let hits = 0;
			for (const gram of grams) if (part.text.includes(gram)) hits++;
			return { ...part, score: grams.length ? hits / grams.length : 0, index };
		});
		scored.sort((a, b) => b.score - a.score || a.index - b.index);
		const picked = scored.filter((s) => s.score > 0);
		// 无命中就如实返回空：以前会退回"按顺序取前几节"，等于把不相关的内容当命中塞给 AI。
		const list = scored.filter((s) => s.score > 0);
		const out = [];
		let used = 0;
		for (const item of list) {
			if (used + item.text.length > budget) break;
			out.push({ heading: item.heading, text: item.text });
			used += item.text.length;
		}
		return out;
	}

	/* ---------- 重写 ---------- */
	function systemPrompt(scope, maxChars) {
		const shared = [
			`2. 总长度控制在 ${maxChars} 字以内；合并现有记忆与新近况，滚动重写，删掉过时内容，绝不无限追加。`,
			"3. 用这些二级标题分节，没有内容的节直接省略（不要写「无」）：",
			"## 目标与约束",
			"## 已完成",
			"## 关键决策",
			"## 踩过的坑",
			"## 下一步",
			"4. 保留可执行的具体事实：文件名、路径、端口、命令、参数、约定、结论、未完成项。",
			"5. 用中文书写，术语与代码标识符保持原文。",
			"6. 绝不写入任何密钥、令牌、密码、凭据；如遇相关内容，只写「见用户凭据配置」。",
			"7. 不要输出任何 HTML 注释或「手改区」标记：用户手写区块由程序在外部另行保留。",
		];
		const head =
			scope === "project"
				? "你是「项目记忆」维护器：把当前工作区跨窗口累积的项目级事实，压缩成一份可持续维护的 Markdown 项目记忆。只保留项目级、跨窗口仍然成立的内容（约定、路径、架构决定、已知坑），不要写某个窗口的临时过程。"
				: "你是「窗口记忆」维护器：把**这一个对话窗口**的近况压缩成一份可持续维护的 Markdown 记忆，只服务这个窗口，不要写别的窗口的事。";
		return [head, "输出规则：", "1. 只输出 Markdown 正文本身：不要解释、不要前后缀、不要代码围栏。", ...shared].join("\n");
	}

	function normalizeOutput(raw) {
		let text = String(raw ?? "").trim();
		const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/u.exec(text);
		if (fence) text = fence[1].trim();
		return normalizeText(text);
	}

	function combinedSignal(timeoutMs, outer) {
		const controller = new AbortController();
		const timer = setTimeout(() => {
			try {
				controller.abort(new Error(`记忆重写超时（${timeoutMs}ms）`));
			} catch {
				controller.abort();
			}
		}, timeoutMs);
		if (typeof timer?.unref === "function") timer.unref();
		const onAbort = () => controller.abort(outer?.reason);
		if (outer) {
			if (outer.aborted) controller.abort(outer.reason);
			else outer.addEventListener("abort", onAbort, { once: true });
		}
		return {
			signal: controller.signal,
			dispose() {
				clearTimeout(timer);
				if (outer) outer.removeEventListener("abort", onAbort);
			},
		};
	}

	async function rewrite({ route, scope, currentText, recentText }) {
		const llm = typeof ctx.get === "function" ? ctx.get("llm") : void 0;
		if (!llm || typeof llm.stream !== "function") throw new Error("当前构成没有 llm 服务，记忆重写不可用");
		if (llmModule === void 0) llmModule = await import("@deepseek-ai/dsh-llm");
		const { BlockAssembler, createUserMessage } = llmModule;
		const payload = [
			scope === "project" ? "【现有项目记忆】" : "【现有窗口记忆】",
			currentText.trim() ? currentText.trim() : "（暂无：这是第一次生成）",
			"",
			"【最近会话近况】",
			recentText.trim() ? recentText.trim() : "（没有可用的对话内容）",
			"",
			scope === "project" ? "请输出重写后的完整项目记忆。" : "请输出重写后的完整窗口记忆。",
		].join("\n");
		const deadline = combinedSignal(config.timeoutMs, void 0);
		try {
			const assembler = new BlockAssembler();
			for await (const chunk of llm.stream({
				provider: route.provider,
				model: route.model,
				system: systemPrompt(scope, Math.max(200, Math.floor(settings().maxInjectChars * 0.8))),
				messages: [createUserMessage({ content: [{ type: "text", text: payload }], source: { kind: "plugin", plugin: "dsh-kb" } })],
				maxTokens: config.maxTokens,
				signal: deadline.signal,
			})) {
				assembler.push(chunk);
			}
			const finish = assembler.finish;
			if (finish?.kind === "error" || finish?.kind === "aborted") {
				throw new Error(finish.failure?.message ? String(finish.failure.message).slice(0, 200) : "模型调用失败");
			}
			const text = normalizeOutput(
				assembler.blocks()
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n"),
			);
			if (!text) throw new Error("模型没有返回可用的记忆内容");
			return {
				text,
				usage: assembler.usage ? { inputTokens: assembler.usage.inputTokens, outputTokens: assembler.usage.outputTokens } : void 0,
				truncated: finish?.kind === "max-tokens",
				model: `${route.provider}/${route.model}`,
			};
		} finally {
			deadline.dispose();
		}
	}

	/**
	 * 执行一次记忆更新。scope=session（窗口记忆，默认）或 project（项目记忆，仅手动）。
	 */
	async function update({ sessionId, scope = "session", trigger = "manual", library: explicitLibrary } = {}) {
		const current = await load();
		const live = settings();
		if (trigger === "auto" && !live.enabled) return { ok: false, skipped: true, error: "自动更新已关闭" };

		const session = resolveSession(ctx, sessionId);
		const info = describeSession(session, sessionId);
		const library = explicitLibrary ? sanitizeLibraryName(explicitLibrary) : info?.library;
		if (!library) return { ok: false, error: "无法确定工作区：该会话没有 cwd，也没有可用的会话" };

		const sid = info?.id ?? "";
		const key = scope === "project" ? `p:${library}` : `s:${sid}`;
		if (inFlight.has(key)) return { ok: false, error: scope === "project" ? "该项目记忆正在更新中，请稍候" : "该窗口记忆正在更新中，请稍候" };
		const title = info?.title;
		const record = scope === "project" ? current.projects[library] ?? {} : current.sessions[sid] ?? {};
		// 窗口记忆写"有名字的文件"（<标题>-<短id>.md）；老数据是 <短id>.md，写完顺手把旧名删掉
		const path = scope === "project" ? projectPathOf(library) : existingWindowPathOf(library, sid, title, record);
		const namedPath = scope === "project" ? path : sessionPathOf(library, sid, title);
		const now = Date.now();
		// 冷却同时参考"上次成功"和"上次失败"：模型路由坏掉时不能让每个 turn/end 都重试一次 60 秒的调用
		const blockedUntil = Math.max(Number(record.lastRunAt ?? 0), Number(record.lastFailedAt ?? 0)) + live.minIntervalMs;
		if (now < blockedUntil) {
			const cooldownMs = blockedUntil - now;
			return { ok: false, cooldownMs, error: `距上次更新不足 ${Math.round(live.minIntervalMs / 1000)} 秒，还需等待 ${Math.ceil(cooldownMs / 1000)} 秒` };
		}

		const task = (async () => {
			const route = resolveRoute(session);
			if (!route) throw new Error("拿不到会话当前模型：该会话还没有模型请求头，配置里也没有默认模型");
			if (scope === "session" && !session) throw new Error("没有可用的会话：先在左侧打开一个窗口");
			const existing = await readText(path);
			// 旧记忆读不了（被占用/权限）就中止：否则会当作"没有旧内容"，既不备份也直接覆盖
			if (existing.error) throw new Error(`现有记忆读取失败，本次不写入：${existing.error}`);
			const recent = scope === "project" ? collectTurns(session, 0) : collectTurns(session, record.sinceSeq);
			if (!recent.text.trim() && !existing.exists) throw new Error("没有可更新的内容：这个窗口还没有对话记录");
			const pinned = splitPinned(existing.text);
			const startedAt = Date.now();
			const result = await rewrite({
				route,
				scope,
				currentText: pinned.body,
				recentText: recent.text,
			});
			const elapsedMs = Date.now() - startedAt;
			// 输出被 token 上限截断时**不**覆盖正文：半截记忆比旧记忆更危险（尾部章节整段丢失）
			if (result.truncated === true) throw new Error("模型输出被截断（maxTokens 不够），本次不写入，保留旧记忆");
			const next = `${result.text}\n\n${pinned.pinned || PIN_SCAFFOLD}`;
			const changed = normalizeText(next) !== normalizeText(existing.text);
			const diff = lineDiff(existing.text, next);
			const stamp = new Date().toISOString();
			// 备份轮换跟着真正写入的路径走，否则改名那一刻的旧内容进的是旧路径的 .bak
			if (changed && existing.exists) await rotateBackups(namedPath, existing.text);
			if (changed) await writeText(namedPath, `${next}\n`);
			// 老的无名文件（<短id>.md）在改名后删掉，避免同一窗口留两份
			if (namedPath !== existing.path && existing.exists) {
				try {
					await rm(existing.path, { force: true });
				} catch {
					/* 删不掉就留着，不影响读数 */
				}
			}

			const patch = {
				lastRunAt: now,
				elapsedMs,
				diff,
				diffText: diffSummary(diff),
				trigger,
				model: result.model,
				usage: result.usage,
				truncated: result.truncated === true,
				turns: recent.turns,
				inputChars: recent.chars,
				pinnedChars: pinned.pinned.length,
				versions: await listVersions(namedPath),
				...(changed ? { updatedAt: stamp } : { skippedAt: stamp }),
			};
			if (scope === "project") {
				current.projects[library] = { ...(current.projects[library] ?? {}), ...patch };
			} else {
				current.sessions[sid] = {
					...(current.sessions[sid] ?? {}),
					...patch,
					library,
					file: windowRelOf(sid, info?.title),
					title: info?.title ?? current.sessions[sid]?.title,
					sinceSeq: recent.lastSeq,
				};
				turnCounts.set(sid, 0);
			}
			await save();

			// 项目记忆是库根下的 记忆.md（会被索引），写完顺手刷新；窗口记忆在子目录里，不进索引。
			if (scope === "project" && changed && config.autoReindex && typeof rebuildLibrary === "function") {
				void (async () => {
					try {
						const outcome = await rebuildLibrary(library);
						warn(`项目记忆索引已刷新：${library}（${outcome.ok ? `${outcome.chunks} 块` : outcome.error}）`);
					} catch (error) {
						warn(`项目记忆索引刷新失败（记忆已写入）：${library} (${error.message})`);
					}
				})();
			}
			return { ok: true, scope, library, changed, diff, diffText: diffSummary(diff), elapsedMs, usage: result.usage, model: result.model, turns: recent.turns, inputChars: recent.chars, path: namedPath };
		})();

		inFlight.set(key, task);
		try {
			return await task;
		} catch (error) {
			const message = error?.message ?? String(error);
			warn(`记忆更新失败（${scope}/${library}）：${message}`);
			// 记下失败时间：路由坏了也不能每轮都重试（冷却同样约束失败路径）
			try {
				if (scope === "project") current.projects[library] = { ...(current.projects[library] ?? {}), lastFailedAt: Date.now(), lastError: message };
				else if (sid) current.sessions[sid] = { ...(current.sessions[sid] ?? {}), lastFailedAt: Date.now(), lastError: message, library };
				await save();
			} catch {
				/* 状态记录失败不影响返回 */
			}
			return { ok: false, scope, library, error: message };
		} finally {
			inFlight.delete(key);
		}
	}

	/** 版本回退：把 bak.N 恢复成当前记忆（当前内容照常轮换进 bak.1）。 */
	async function rollback({ sessionId, scope = "session", slot, library: explicitLibrary } = {}) {
		const current = await load();
		const wanted = Number(slot);
		if (!Number.isInteger(wanted) || wanted < 1 || wanted > MEMORY_BAK_SLOTS) return { ok: false, error: `版本号无效（可选 1~${MEMORY_BAK_SLOTS}）` };
		const session = resolveSession(ctx, sessionId);
		const info = describeSession(session, sessionId);
		const library = explicitLibrary ? sanitizeLibraryName(explicitLibrary) : info?.library;
		if (!library) return { ok: false, error: "无法确定工作区" };
		const sid = info?.id ?? "";
		// 与 update 共用同一把锁：自动重写（最长 60s）进行中回退会被覆盖，反之亦然
		const key = scope === "project" ? `p:${library}` : `s:${sid}`;
		if (inFlight.has(key)) return { ok: false, error: "这次更新还在进行，稍后再回退" };
		const path = scope === "project" ? projectPathOf(library) : existingWindowPathOf(library, sid, info?.title, current.sessions[sid]);
		const bak = bakPathOf(path, wanted);
		let restored;
		try {
			restored = await readFile(bak, "utf8");
		} catch {
			return { ok: false, error: `版本 ${wanted} 不存在：${bak}` };
		}
		const nowText = await readText(path);
		if (normalizeText(restored) === normalizeText(nowText.text)) return { ok: false, error: `版本 ${wanted} 与当前内容相同，无需回退` };
		if (nowText.exists) await rotateBackups(path, nowText.text);
		await writeText(path, restored);
		const diff = lineDiff(nowText.text, restored);
		const record = { diff, diffText: `回退到版本 ${wanted}：${diffSummary(diff)}`, trigger: `rollback:${wanted}`, rollbackAt: new Date().toISOString(), versions: await listVersions(path) };
		if (scope === "project") current.projects[library] = { ...(current.projects[library] ?? {}), ...record };
		else current.sessions[sid] = { ...(current.sessions[sid] ?? {}), ...record, library, file: windowRelOf(sid, info?.title), title: info?.title };
		await save();
		return { ok: true, scope, library, restored: wanted, diff, diffText: record.diffText };
	}

	/** 面板视图：窗口记忆 + 项目记忆 + 生效设置。没有活动会话时仍可看项目记忆。 */
	async function view({ sessionId, library: explicitLibrary } = {}) {
		const current = await load();
		const live = settings();
		const session = resolveSession(ctx, sessionId);
		const info = describeSession(session, sessionId);
		const library = info?.library || (explicitLibrary ? sanitizeLibraryName(explicitLibrary) : void 0);
		if (!library) return { ok: false, error: "无法确定工作区：先打开一个窗口，或在设置里指定库名" };
		// 只在"显式指定库名"时校验存在性（防止幽灵库卡片）；由会话 cwd 推导出的库目录
		// 可能还没建（首次打开该工作区的记忆页），那是 update() 会自己创建的正常情况。
		if (!info && !existsSync(join(kbRootOf(), library))) return { ok: false, error: `库不存在：${library}` };

		const projectPath = projectPathOf(library);
		const projectFile = await readText(projectPath);
		const projectRecord = current.projects[library] ?? {};
		const project = {
			library,
			dir: join(kbRootOf(), library),
			path: projectPath,
			exists: projectFile.exists,
			text: projectFile.text,
			updatedAt: projectRecord.updatedAt,
			truncated: projectRecord.truncated === true,
			diffText: projectRecord.diffText,
			versions: await listVersions(projectPath),
			// 主动型：用户手动开启总开关；开启后自动维护，但正文永不自动注入（AI 用 memory_read 取）
			enabled: live.projectEnabled,
			autoInject: false,
			onDemand: true,
			chars: 0,
		};

		// 没有活动会话对象：window 为 null，面板显示"先开一个窗口"，项目记忆照常显示。
		// 但如果客户端仍知道会话 id + 库名，就按 <库>/窗口/<短id>.md 把那份记忆读出来（只读展示），
		// 这样"没挂载"和"没这个窗口"不会混为一谈。
		if (!info) {
			if (!sessionId) return { ok: true, cwd: void 0, window: null, project, settings: live, sessionTurns: 0, source: "none", libraryHint: library };
			const sid = String(sessionId);
			const detachedRecord = current.sessions[sid] ?? {};
			const detachedPath = existingWindowPathOf(library, sid, detachedRecord.title, detachedRecord);
			const detachedFile = await readText(detachedPath);
			// 既不认识这个会话（状态里没有记录）也没有对应文件 → 不凭空造一个"幽灵窗口"
			if (!detachedFile.exists && !detachedRecord.file) {
				return { ok: true, cwd: void 0, window: null, project, settings: live, sessionTurns: 0, source: "unknown", libraryHint: library };
			}
			return {
				ok: true,
				cwd: void 0,
				window: {
					id: sid,
					// 会话没挂载时也要给人看的标题：优先用记录里存的标题，再退回短 id
					title: detachedRecord.title || sessionShortId(sid),
					library,
					dir: windowDirOf(library),
					path: detachedPath,
					exists: detachedFile.exists,
					text: detachedFile.text,
					updatedAt: detachedRecord.updatedAt,
					truncated: detachedRecord.truncated === true,
					diffText: detachedRecord.diffText,
					model: detachedRecord.model,
					usage: detachedRecord.usage,
					elapsedMs: detachedRecord.elapsedMs,
					turns: detachedRecord.turns,
					inputChars: detachedRecord.inputChars,
					cooldownMs: 0,
					busy: false,
					versions: await listVersions(detachedPath),
					injection: { enabled: injectEnabled, section: SESSION_SECTION, chars: 0 },
					receipts: Array.isArray(current.sessions[sid]?.receipts) ? current.sessions[sid].receipts.slice(-5) : [],
					pinned: { present: false, chars: 0, scaffold: PIN_SCAFFOLD },
					detached: true,
				},
				project,
				settings: live,
				sessionTurns: turnCounts.get(sid) ?? 0,
				source: "detached",
			};
		}

		const sid = info.id;
		const sessionRecord = current.sessions[sid] ?? {};
		const sessionPath = existingWindowPathOf(info.library, sid, info.title, sessionRecord);
		const sessionFile = await readText(sessionPath);
		const cooldownMs = Math.max(0, Number(sessionRecord.lastRunAt ?? 0) + live.minIntervalMs - Date.now());

		return {
			ok: true,
			cwd: info.cwd,
			window: {
				id: sid,
				title: info.title,
				library: info.library,
				dir: windowDirOf(info.library),
				path: sessionPath,
				exists: sessionFile.exists,
				text: sessionFile.text,
				updatedAt: sessionRecord.updatedAt,
				skippedAt: sessionRecord.skippedAt,
				truncated: sessionRecord.truncated === true,
				diffText: sessionRecord.diffText,
				model: sessionRecord.model,
				usage: sessionRecord.usage,
				elapsedMs: sessionRecord.elapsedMs,
				turns: sessionRecord.turns,
				inputChars: sessionRecord.inputChars,
				cooldownMs,
				busy: inFlight.has(`s:${sid}`),
				versions: await listVersions(sessionPath),
				injection: {
					enabled: injectEnabled,
					section: SESSION_SECTION,
					chars: injectEnabled ? sessionSectionText({ agent: { session } }).length : 0,
				},
				// 最近检索回执（面板"更多"里能看到 AI 手上有哪几条，方便判断它是否还在"记得"）
				receipts: Array.isArray(current.sessions[sid]?.receipts) ? current.sessions[sid].receipts.slice(-5) : [],
				pinned: (() => {
					const split = splitPinned(sessionFile.text);
					return { present: split.pinned.length > 0, chars: split.pinned.length, scaffold: PIN_SCAFFOLD };
				})(),
			},
			project,
			settings: live,
			sessionTurns: turnCounts.get(sid) ?? 0,
			source: info.source,
		};
	}

	/** 在系统文件管理器里打开某个记忆目录。 */
	async function reveal({ sessionId, scope = "session", library: explicitLibrary } = {}) {
		const session = resolveSession(ctx, sessionId);
		const info = describeSession(session, sessionId);
		const library = explicitLibrary ? sanitizeLibraryName(explicitLibrary) : info?.library;
		if (!library) return { ok: false, error: "无法确定工作区" };
		const dir = scope === "project" ? join(kbRootOf(), library) : windowDirOf(library);
		await mkdir(dir, { recursive: true });
		const mod = await import("@deepseek-ai/dsh-native-command");
		// 这里是"打开文件夹"，用 revealNativePath（openNativePath 会按默认关联打开）
		const opener = mod?.revealNativePath ?? mod?.openNativePath;
		if (typeof opener !== "function") throw new Error("dsh-native-command 未导出 revealNativePath/openNativePath");
		await opener(dir, AbortSignal.timeout(10000));
		return { ok: true, dir };
	}

	/** 库改名：项目记录、会话记录的 library、别名一起搬到新库名下（cwd 目录名不会变）。 */
	async function renameLibrary(from, to) {
		const current = await load();
		let touched = false;
		if (current.projects[from]) {
			current.projects[to] = { ...current.projects[from] };
			delete current.projects[from];
			touched = true;
		}
		// 会话记录里的 library 是"写记忆时用的库名"，不改的话改名后读写会退回旧名
		for (const record of Object.values(current.sessions)) {
			if (record?.library === from) {
				record.library = to;
				touched = true;
			}
		}
		// 旧名 → 新名：cwd 推导出来的旧名在下次写之前也能接回新库
		current.aliases = current.aliases ?? {};
		current.aliases[from] = to;
		if (current.aliases[from] === current.aliases[to]) delete current.aliases[from];
		await save();
		return { ok: true, touched };
	}

	/** 库被删除/移入回收站：丢掉它的项目记录与会话记录里的绑定。 */
	async function forgetLibrary(name) {
		const current = await load();
		let touched = false;
		if (current.projects[name]) {
			delete current.projects[name];
			touched = true;
		}
		for (const record of Object.values(current.sessions)) {
			if (record?.library === name) {
				record.library = void 0;
				touched = true;
			}
		}
		if (current.aliases) {
			for (const [oldName, newName] of Object.entries(current.aliases)) {
				if (oldName === name || newName === name) {
					delete current.aliases[oldName];
					touched = true;
				}
			}
		}
		if (touched) await save();
	}

	/* ---------- 启动：注入段 + 轮次订阅 ---------- */
	const systemPromptService = typeof ctx.get === "function" ? ctx.get("systemPrompt") : void 0;
	if (!systemPromptService || typeof systemPromptService.section !== "function") {
		warn("当前构成没有 systemPrompt 服务：记忆不注入系统提示（降级为面板可见）");
	} else {
		// 只注册**窗口记忆**一条注入段：自动型，只进它自己的窗口。
		// 项目记忆是主动型：不注册正文注入，只放一行"有项目记忆、需要时用 memory_read 取"的提示。
		// interpolate:false 必须给：记忆正文是自由文本，含 `{{...}}` 时模板引擎会抛错并让整轮对话失败。
		ctx.effect(() => systemPromptService.section({ name: SESSION_SECTION, order: SESSION_SECTION_ORDER, interpolate: false, text: (assembly) => sessionSectionText(assembly) }), "kb: 窗口记忆注入（自动，仅本窗口）");
		ctx.effect(() => systemPromptService.section({ name: PROJECT_SECTION, order: PROJECT_SECTION_ORDER, interpolate: false, text: (assembly) => projectHintText(assembly) }), "kb: 项目记忆提示（按需读取，不注入正文）");
		injectEnabled = true;
	}

	// 先把状态读进来（面板一打开就能看到已有记录，不必等第一次写）
	void load();

	try {
		ctx.on("session/event", (session, event) => {
			try {
				if (!session || event?.type !== "turn/end") return;
				// 子代理 / 分叉会话不单独维护窗口记忆
				if (session.header?.parentSession) return;
				if (!libraryForCwd(session.header?.cwd)) return;
				const sid = String(session.id);
				const count = (turnCounts.get(sid) ?? 0) + 1;
				turnCounts.set(sid, count);
				const live = settings();
				if (!live.enabled) return;
				if (count < live.turns) return;
				// 1) 窗口记忆：自动型，永远自动重写
				void update({ sessionId: sid, scope: "session", trigger: "auto" })
					.then((result) => {
						if (result?.ok && result.changed) warn(`窗口记忆已更新：${result.library}/${sessionShortId(sid)}（${result.diffText} · ${result.elapsedMs}ms · ${result.turns} 轮）`);
						else if (result?.ok) warn(`窗口记忆无实质变化，跳过写入：${result.library}/${sessionShortId(sid)}`);
						else if (result?.cooldownMs) warn(`窗口记忆自动更新暂缓：${result.error}`);
						// 2) 项目记忆：用户手动开启后才自动维护（不注入正文）
						if (!live.projectEnabled) return null;
						return update({ sessionId: sid, scope: "project", trigger: "auto" });
					})
					.then((result) => {
						if (!result) return;
						if (result.ok && result.changed) warn(`项目记忆已自动更新：${result.library}（${result.diffText} · ${result.elapsedMs}ms）`);
						else if (result.ok) warn(`项目记忆无实质变化，跳过写入：${result.library}`);
						else if (result.cooldownMs) warn(`项目记忆自动更新暂缓：${result.error}`);
						else warn(`项目记忆自动更新未执行：${result.error}`);
					})
					.catch((error) => warn("记忆自动更新异常：", error?.message ?? String(error)));
			} catch (error) {
				warn("记忆轮次统计失败（忽略）：", error?.message ?? String(error));
			}
		});
	} catch (error) {
		warn("会话事件订阅失败（自动记忆更新不可用）：", error?.message ?? String(error));
	}

	return {
		view,
		update,
		rollback,
		reveal,
		recall,
		noteSearch,
		settings,
		setSettings,
		renameLibrary,
		forgetLibrary,
		injectEnabled: () => injectEnabled,
		sessionPath: sessionPathOf,
		projectPath: projectPathOf,
		projectSectionText,
		sessionSectionText,
	};
}
