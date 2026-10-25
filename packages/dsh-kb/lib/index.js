import { readdir, readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import {
	createMemory,
	libraryForCwd,
	resolveSession,
	sessionDisplayTitle,
	MEMORY_FILE,
	WINDOW_DIR,
	projectMemoryPath,
} from "./memory.js";

/**
 * dsh-kb 的 host 半（Node 侧）。
 *
 * 职责：
 * 1. 扫描知识库源目录  <dshHome>/kb/<库名>/*.md|*.txt
 * 2. 分块（markdown 按标题切 + 长度兜底）→ DashScope text-embedding-v4 向量化
 *    → 存 <dshHome>/storages/dsh-kb/<库名>.json（含向量、原文、来源定位）
 * 3. 注册 kb_search agent 工具（对话中按需检索，本地暴力余弦，零额外成本）
 * 4. 注册 /kb/api 前缀路由（status / search / rebuild）供客户端面板使用
 *
 * 安全底线：
 * - 只读 ~/.dsh/kb/ 源目录，只写 ~/.dsh/storages/dsh-kb/；
 * - 凭据只经 credentials 服务解析（env 兜底），不落盘、不写日志；
 * - 所有对外行为（路由/工具）失败即返回结构化错误，绝不抛穿 cordis。
 */

export const name = "kb";
// webServer / commands 都是可选服务：有就注册面板路由 / /kb 命令，没有（headless/CLI）
// 就只提供 kb_search 工具。写进 inject 会让整个插件在缺它们的构成里永远 pending。
export const inject = ["credentials", "tools"];

/** 默认配置（cordis.patch.yml 的 config 块可覆盖）。 */
const DEFAULTS = {
	embedding: {
		provider: "dashscope", // dashscope | openai（OpenAI 兼容）| ollama（原生 /api/embed）
		model: "text-embedding-v4",
		dimensions: 1024, // 本地模型按它的输出维度改（bge-m3=1024、nomic-embed-text=768、Qwen3-Embedding-0.6B=1024）
		baseUrl: "", // openai 默认 http://127.0.0.1:11434/v1；ollama 默认 http://127.0.0.1:11434
		apiKeyEnv: "", // 可选：从哪个环境变量读 key（本地服务通常不需要）
	},
	chunking: { targetChars: 1200, overlapChars: 150 },
	batchSize: 10,
	topK: 5,
	/**
	 * 检索分数的两档阈值（实测：无关查询 0.17~0.20，弱相关 0.35~0.39，真命中 0.56~0.79）：
	 * - minScore：硬底线。最高分都低于它 → 当作"没有找到相关内容"（A 策略）；
	 * - lowScore：软阈值。介于两者之间的命中**保留**但标 `confidence: "low"`（B 策略），
	 *   让模型/面板自己判断要不要用。
	 */
	search: { minScore: 0.25, lowScore: 0.5 },
};
const EMBED_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding";
const DOC_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const INDEX_VERSION = 1;

/** 模块级索引缓存：<存储文件绝对路径 → 解析后的索引对象>。 */
const indexCache = new Map();
/** 索引缓存上限：每库都是"1024 维向量 + 全量原文"，库一多就是内存黑洞。按插入顺序淘汰最旧的。 */
const INDEX_CACHE_LIMIT = 4;
function cacheIndex(path, record) {
	while (indexCache.size >= INDEX_CACHE_LIMIT && !indexCache.has(path)) {
		const oldest = indexCache.keys().next().value;
		if (oldest === void 0) break;
		indexCache.delete(oldest);
	}
	indexCache.set(path, record);
}

/**
 * 进程内的重建进度：<库名 → { name, done, total, phase, startedAt }>。
 * 只存计数、不落盘；/kb/api/status 读它给面板画进度条。
 */
const rebuildProgress = new Map();
/** 运行时路径覆盖（apply 时从 config.paths 读取；空值回落默认）。 */
const pathOverrides = { source: "", index: "" };
function resolveOverride(raw, fallback) {
	if (typeof raw !== "string" || raw.trim() === "") return fallback;
	const v = raw.trim();
	if (isAbsolute(v)) return v;
	const parts = v.split(/[\\/]+/).filter(Boolean);
	return parts.length > 0 ? dshHomePath(...parts) : fallback;
}

function log(...args) {
	console.warn("[dsh-kb]", ...args);
}

/** 知识库源目录（<dshHome>/kb）。 */
function kbRoot() {
	return resolveOverride(pathOverrides.source, dshHomePath("kb"));
}
/** 索引存储目录（<dshHome>/storages/dsh-kb）。 */
function storeRoot() {
	return resolveOverride(pathOverrides.index, dshHomePath("storages", "dsh-kb"));
}
/** 路径设置文件（面板里可改，重启后仍生效）。 */
function pathsFile() {
	return dshHomePath("storages", "dsh-kb", "paths.json");
}
/** 给面板的路径状态（配置值 + 实际生效值 + 默认值）。 */
function pathsState() {
	return {
		ok: true,
		source: { configured: pathOverrides.source, effective: kbRoot() },
		index: { configured: pathOverrides.index, effective: storeRoot() },
		defaults: { source: dshHomePath("kb"), index: dshHomePath("storages", "dsh-kb") },
	};
}

/* ------------------------------------------------------------------ */
/* 库元数据：每个库对应哪个工作区（面板要回答"当前会话 → 哪个库"）       */
/* ------------------------------------------------------------------ */

/**
 * <索引存储>/libraries.json —— 只记"库 ↔ 工作区"的对应关系与类型。
 * 用途：面板把库分成「工作区」（有 cwd 绑定）与「文档」（纯文档库），
 * 并标出当前会话正在用的那一个。不存任何文档内容。
 */
const LIBRARY_META_FILE = "libraries.json";
let libraryMeta = null;
/** 进程内已登记过的 <库\0cwd>，避免每次装配都重写文件。 */
const librarySeen = new Set();

/** /kb/api/status 的短 TTL 缓存：面板 800ms 轮询，全量扫盘（每库 readdir+逐文件 stat+loadIndex）太贵。 */
let statusCache = { at: 0, key: "", value: null };
const STATUS_CACHE_MS = 1500;

async function loadLibraryMeta() {
	if (libraryMeta) return libraryMeta;
	let parsed;
	try {
		parsed = JSON.parse(await readFile(join(storeRoot(), LIBRARY_META_FILE), "utf8"));
	} catch (error) {
		// 只有"文件不存在"才降级成空表；文件坏了/被占用不能装作没有——
		// 否则下一次 saveLibraryMeta 会把所有"库↔工作区"绑定清零。
		if (error?.code !== "ENOENT") {
			log("库元数据读取失败（保留内存里的旧值）：", error?.message ?? String(error));
			// 冷启动时 libraryMeta 还是 null：此时如果把空表放进去，下一次 saveLibraryMeta
			// 会用空表覆盖掉"库↔工作区"绑定。先把坏文件改名留证，再重建空表。
			if (!libraryMeta) {
				try {
					const bad = join(storeRoot(), LIBRARY_META_FILE);
					await rename(bad, bad + ".corrupt-" + Date.now());
					log("库元数据已损坏，已备份并重建空表");
				} catch (e2) {
					log("库元数据损坏且备份失败（只读启动）：", e2?.message ?? String(e2));
				}
				libraryMeta = { version: 1, items: {} };
			}
			return libraryMeta;
		}
		parsed = void 0;
	}
	libraryMeta = { version: 1, items: parsed?.items && typeof parsed.items === "object" ? parsed.items : {} };
	return libraryMeta;
}

/** 元数据写盘串行化 + 原子替换（避免并发 noteLibrary 后写覆盖先写、半截文件）。 */
let libraryMetaSaveChain = Promise.resolve();
async function saveLibraryMeta() {
	const meta = libraryMeta ?? (await loadLibraryMeta());
	libraryMetaSaveChain = libraryMetaSaveChain.then(async () => {
		try {
			await mkdir(storeRoot(), { recursive: true });
			const target = join(storeRoot(), LIBRARY_META_FILE);
			const tmp = `${target}.tmp`;
			await writeFile(tmp, JSON.stringify(meta, null, 2), "utf8");
			await rename(tmp, target);
		} catch (error) {
			log("库元数据写入失败（不影响检索）：", error.message);
		}
	});
	return libraryMetaSaveChain;
}

/** 记住"库 ← 工作区"的绑定（首次命中即登记，之后只更新 lastSeenAt）。 */
function noteLibrary(library, cwd) {
	if (!library || typeof cwd !== "string" || !cwd.trim()) return;
	const key = `${library}\u0000${cwd}`;
	if (librarySeen.has(key)) return;
	librarySeen.add(key);
	void (async () => {
		try {
			const meta = await loadLibraryMeta();
			const prev = meta.items[library] ?? {};
			const stamp = new Date().toISOString();
			meta.items[library] = {
				...prev,
				kind: "workspace",
				cwd,
				firstSeenAt: prev.firstSeenAt ?? stamp,
				lastSeenAt: stamp,
			};
			await saveLibraryMeta();
		} catch (error) {
			log("库元数据记录失败（忽略）：", error.message);
		}
	})();
}

/** 库名规则：不静默清洗（否则 `../x` 会变成另一个合法名并被真的改名），一律拒绝。 */
const LIBRARY_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
function validateLibraryName(raw) {
	const name = String(raw ?? "").trim();
	if (!name) return { ok: false, error: "库名不能为空" };
	if (name.length > 64) return { ok: false, error: "库名最多 64 个字符" };
	if (/[<>:"/\\|?*\u0000-\u001f]/u.test(name)) return { ok: false, error: "库名不能包含 / \\ : * ? \" < > | 这些字符" };
	if (name.startsWith(".") || name.endsWith(".")) return { ok: false, error: "库名不能以点开头或结尾" };
	if (LIBRARY_RESERVED.test(name)) return { ok: false, error: "这是 Windows 保留名，不能用作库名" };
	return { ok: true, value: name };
}

/** 正在重建的库（防并发重建：同一库两次重建会重复花 embedding 钱，还可能互相覆盖索引）。 */
const rebuilding = new Set();

/**
 * 库改名：目录、索引文件、libraries.json 记录一起改（memory.json 的项目记录由 memory 模块搬）。
 * 目标目录已存在时拒绝，避免覆盖别的库。
 */
async function renameLibrary(from, to) {
	// 工作区记忆库的库名由 cwd 推导（libraryForCwd），改名后这个工作区就再也找不到自己的库了。
	const guardMeta = await loadLibraryMeta();
	if (guardMeta.items[from]?.cwd) {
		return { ok: false, error: `「${from}」是工作区记忆库（绑定 ${guardMeta.items[from].cwd}），改名会让该工作区找不到自己的库；确需改名请先解除绑定` };
	}
	const root = kbRoot();
	const fromDir = join(root, from);
	const toDir = join(root, to);
	if (!existsSync(fromDir)) return { ok: false, error: `库不存在：${from}` };
	if (existsSync(toDir)) return { ok: false, error: `名字已被占用：${to}` };
	try {
		await rename(fromDir, toDir);
	} catch (error) {
		return { ok: false, error: `重命名目录失败：${error.message}` };
	}
	const indexFrom = join(storeRoot(), `${from}.json`);
	const indexTo = join(storeRoot(), `${to}.json`);
	try {
		if (existsSync(indexFrom)) await rename(indexFrom, indexTo);
	} catch (error) {
		log(`索引文件改名失败（不影响记忆）：${error.message}`);
	}
	indexCache.delete(indexFrom);
	indexCache.delete(indexTo);
	const meta = await loadLibraryMeta();
	if (meta.items[from]) {
		meta.items[to] = { ...meta.items[from] };
		delete meta.items[from];
		await saveLibraryMeta();
		log(`库已改名：${from} → ${to}`);
	}
	return { ok: true, from, to };
}

/**
 * 删除库：整目录移入 <kb>/.trash/（可从磁盘找回），索引与状态记录一并清掉。
 * @param currentLibrary 当前窗口所在工作区的库（不给删，否则本窗口记忆失去落点）
 *
 * 注意：只看 currentLibrary 不够——会话没挂载（比如在 dev 预览里点删除）时它是 undefined，
 * 一次误点就会把工作区库搬走。所以**任何登记过 cwd 的工作区库都拒绝删除**。
 */
async function trashLibrary(name, currentLibrary) {
	if (currentLibrary && name === currentLibrary) {
		return { ok: false, error: "当前窗口所在工作区的库不能删除，请先切到别的工作区" };
	}
	const meta = await loadLibraryMeta();
	if (meta.items?.[name]?.cwd) {
		return { ok: false, error: `「${name}」是工作区记忆库（绑定 ${meta.items[name].cwd}），删除会让该工作区的记忆失去落点；确需移除请直接处理 ${join(kbRoot(), name)} 目录` };
	}
	// 兜底：只给工作区库建的 窗口/ 目录存在 → 它正在被某个窗口写记忆，不能从面板删
	if (existsSync(join(kbRoot(), name, WINDOW_DIR))) {
		return { ok: false, error: `「${name}」里有窗口记忆（${WINDOW_DIR}/），它正被某个工作区使用；确需移除请直接处理 ${join(kbRoot(), name)} 目录` };
	}
	const root = kbRoot();
	const dir = join(root, name);
	if (!existsSync(dir)) return { ok: false, error: `库不存在：${name}` };
	const trash = join(root, ".trash");
	await mkdir(trash, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
	const target = join(trash, `${name}-${stamp}`);
	try {
		await rename(dir, target);
	} catch (error) {
		return { ok: false, error: `移入回收站失败：${error.message}` };
	}
	const index = join(storeRoot(), `${name}.json`);
	try {
		if (existsSync(index)) await rm(index, { force: true });
	} catch (error) {
		log(`索引删除失败（不影响其它库）：${error.message}`);
	}
	indexCache.delete(index);
	const afterMeta = await loadLibraryMeta();
	if (afterMeta.items[name]) {
		delete afterMeta.items[name];
		await saveLibraryMeta();
	}
	log(`库已移入回收站：${name} → ${target}`);
	return { ok: true, name, trashPath: target };
}

/** 源目录是否可以作为知识库源：必须是已存在的目录、不能是盘根、不能是系统目录。 */
function checkSourcePath(raw) {
	if (!raw) return { ok: true, value: "" };
	if (!isAbsolute(raw)) return { ok: false, error: "请填绝对路径（如 D:\\DSH-KB），或留空用默认目录" };
	let info;
	try {
		info = statSync(raw);
	} catch {
		return { ok: false, error: "目录不存在：" + raw };
	}
	if (!info.isDirectory()) return { ok: false, error: "不是目录：" + raw };
	const parts = raw.replace(/[\\/]+$/u, "").split(/[\\/]+/u).filter(Boolean);
	if (parts.length <= 1) return { ok: false, error: "不能把盘符根目录当知识库源" };
	const head = parts.map((p) => p.toLowerCase());
	if (head[0] === "c:" && ["windows", "program files", "program files (x86)", "programdata", "users"].includes(head[1])) {
		return { ok: false, error: "系统目录不适合当知识库源（重建时会把该目录的 .md/.txt 上传去向量化）" };
	}
	return { ok: true, value: raw };
}

/** 索引目录：可不存在（会被创建），但必须是绝对路径、非盘根、非系统目录。 */
function checkIndexPath(raw) {
	if (!raw) return { ok: true, value: "" };
	if (!isAbsolute(raw)) return { ok: false, error: "索引目录请填绝对路径，或留空用默认目录" };
	const parts = raw.replace(/[\\/]+$/u, "").split(/[\\/]+/u).filter(Boolean);
	if (parts.length <= 1) return { ok: false, error: "不能把盘符根目录当索引目录" };
	const head = parts.map((p) => p.toLowerCase());
	const cDrive = ["c:", "d:"].includes(head[0]);
	if (!cDrive) return { ok: true, value: raw };
	if (["windows", "program files", "program files (x86)", "programdata", "users"].includes(head[1])) {
		return { ok: false, error: "系统目录不适合当索引目录" };
	}
	return { ok: true, value: raw };
}

/**
 * 库名必须是 kb 根下**真实存在的一个单层目录**。
 * 关键：`join(kbRoot, name)` 会把 `..` 归一化掉，未校验的 name 能指向宿主机任意目录
 * （rename/delete/rebuild/file-open 都吃过这个亏），这里统一收口。
 */
async function resolveLibraryName(raw) {
	const name = String(raw ?? "").trim();
	if (!name || name !== basename(name) || name.includes("..")) return { ok: false, error: "库名不合法" };
	const known = await listLibraries();
	if (!known.includes(name)) return { ok: false, error: `库不存在：${name}` };
	return { ok: true, value: name };
}

/* ------------------------------------------------------------------ */
/* 凭据链：DASHSCOPE_API_KEY → DASHSCOPE_VISION（既有 ref）→ 环境变量   */
/* ------------------------------------------------------------------ */

async function resolveEmbeddingKey(ctx, config = {}) {
	const provider = String(config.embedding?.provider || "dashscope").toLowerCase();
	const credentials = ctx.get("credentials");
	const candidates = provider === "dashscope"
		? ["DASHSCOPE_API_KEY", "DASHSCOPE_VISION"]
		: [config.embedding?.apiKeyEnv, "OPENAI_API_KEY"].filter((name) => typeof name === "string" && name.trim());
	for (const refName of candidates) {
		try {
			const hit = await credentials?.resolve(credentialRef(refName));
			if (hit?.value) return { key: hit.value, source: `credentials:${refName}` };
		} catch {
			/* 该 ref 不存在或不可读 → 尝试下一个 */
		}
	}
	const envKey = candidates.map((name) => process.env[name]).find(Boolean);
	if (envKey) return { key: envKey, source: "env" };
	// 本地服务通常不需要 key：dashscope 之外允许空 key
	return { key: void 0, source: "unconfigured", optional: provider !== "dashscope" };
}

/* ------------------------------------------------------------------ */
/* 文档扫描与分块                                                      */
/* ------------------------------------------------------------------ */

async function listLibraries() {
	const root = kbRoot();
	if (!existsSync(root)) return [];
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
}

async function listDocuments(libName) {
	const dir = join(kbRoot(), libName);
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((e) => e.isFile() && DOC_EXTENSIONS.has(e.name.slice(e.name.lastIndexOf(".")).toLowerCase()) && !e.name.startsWith("."))
		.map((e) => e.name)
		.sort();
}

/** markdown 标题行（含 Setext 风格的下一行下划线标题不处理，保持简单）。 */
function isHeadingLine(line) {
	return /^#{1,6}\s+\S/.test(line);
}

/** 单块硬上限：超过则按 targetChars 切片（防止单个超长行产生巨型块）。 */
const HARD_CHUNK_CAP = 4000;

function pushChunk(chunks, text, heading, line, { targetChars, overlapChars }) {
	const trimmed = text.trim();
	if (!trimmed) return;
	if (trimmed.length <= HARD_CHUNK_CAP) {
		chunks.push({ text: trimmed, heading, line });
		return;
	}
	// 步长至少 1：overlapChars >= targetChars 时步长为 0 会死循环直到宿主 OOM
	const step = Math.max(1, targetChars - overlapChars);
	for (let pos = 0; pos < trimmed.length; pos += step) {
		const piece = trimmed.slice(pos, pos + targetChars);
		if (piece.trim()) chunks.push({ text: piece.trim(), heading, line });
		if (pos + targetChars >= trimmed.length) break;
	}
}

/**
 * 把一篇文档切成带来源定位的块。
 * 策略：按标题分段；段内行聚合到 targetChars 出块，块间带 overlapChars 重叠；
 * 单块超硬上限时切片。行号近似（重叠尾部沿用块尾行号），满足"定位到文件大致位置"。
 * @returns [{ text, heading, line }]  line 为 1 起始行号
 */
export function chunkDocument(content, { targetChars = 1200, overlapChars = 150 } = {}) {
	const lines = content.split(/\r?\n/);
	const chunks = [];
	let heading = "";
	let buf = [];
	let startLine = 1;
	/** 上一块留下的重叠尾巴；只在"还有后续内容"时才拼进下一块，避免多出一个纯尾巴的重复块。 */
	let pendingOverlap = "";

	const flush = (endLine) => {
		if (buf.length === 0) return;
		const text = buf.join("\n");
		pushChunk(chunks, text, heading, startLine, { targetChars, overlapChars });
		pendingOverlap = overlapChars > 0 ? text.slice(Math.max(0, text.length - overlapChars)) : "";
		buf = [];
		startLine = Math.max(1, endLine);
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNo = i + 1;
		if (isHeadingLine(line)) {
			flush(lineNo - 1);
			pendingOverlap = ""; // 跨标题不重叠：标题本身已经是边界
			heading = line.replace(/^#+\s+/, "").trim();
			startLine = lineNo;
			buf = [line];
			continue;
		}
		if (buf.length === 0 && pendingOverlap) {
			buf.push(pendingOverlap);
			startLine = Math.max(1, lineNo - pendingOverlap.split("\n").length);
			pendingOverlap = "";
		}
		buf.push(line);
		if (buf.join("\n").length >= targetChars) flush(lineNo);
	}
	buf.length > 0 && chunks.push({ text: buf.join("\n").trim(), heading, line: Math.max(1, startLine) });
	// 上面那次 push 只用于"最后一段没有被 flush"的情况，空文本要滤掉
	const last = chunks[chunks.length - 1];
	if (last && !last.text) chunks.pop();
	const deduped = [];
	for (const chunk of chunks) {
		if (!chunk.text) continue;
		if (deduped.length && chunk.text === deduped[deduped.length - 1].text) continue;
		deduped.push(chunk);
	}
	return deduped;
}

/* ------------------------------------------------------------------ */
/* Embedding：DashScope / OpenAI 兼容 / Ollama（10 条/批）            */
/* ------------------------------------------------------------------ */

/**
 * 三种 provider：
 * - dashscope（默认）：原生端点，text_type 区分文档/查询（非对称检索）；
 * - openai：任意 OpenAI 兼容服务（LM Studio / vLLM / Ollama 的 /v1），POST <base>/embeddings；
 * - ollama：原生 /api/embed，返回 embeddings 数组。
 * 本地服务不需要 key；dashscope 需要 DASHSCOPE_API_KEY（凭据或环境变量）。
 */
function embedEndpointBase(config, fallback) {
	const raw = String(config.embedding?.baseUrl || "").trim();
	return (raw || fallback).replace(/\/+$/, "");
}

/** 维度校验：expected > 0 严格比对；expected = 0 只保证同批一致，返回实际维度。 */
function ensureVectors(vectors, expected, texts, label) {
	if (!Array.isArray(vectors) || vectors.length !== texts.length) {
		throw new Error(`${label} 返回条数不符：期望 ${texts.length}，实际 ${Array.isArray(vectors) ? vectors.length : "非数组"}`);
	}
	const dims = expected > 0 ? expected : vectors[0]?.length;
	if (!Number.isFinite(dims) || dims <= 0) throw new Error(`${label} 没有返回有效向量`);
	vectors.forEach((vector, i) => {
		if (!Array.isArray(vector) || vector.length !== dims) {
			throw new Error(`${label} 维度不符：期望 ${dims}，第 ${i} 条实际 ${Array.isArray(vector) ? vector.length : "非数组"}（本地模型请把 embedding.dimensions 设成它的输出维度）`);
		}
	});
	return dims;
}

async function embedDashscope(texts, key, config, textType) {
	const res = await fetch(EMBED_ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
		body: JSON.stringify({
			model: config.embedding.model,
			input: { texts },
			parameters: { dimension: config.embedding.dimensions, text_type: textType, output_type: "dense" },
		}),
		signal: AbortSignal.timeout(60000),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`dashscope ${res.status}: ${body.slice(0, 300)}`);
	}
	const data = await res.json();
	const rows = data?.output?.embeddings ?? [];
	if (!Array.isArray(rows) || rows.length !== texts.length) {
		throw new Error(`dashscope 返回条数不符：期望 ${texts.length}，实际 ${Array.isArray(rows) ? rows.length : "非数组"}`);
	}
	const ordered = rows.map((entry, i) => ({ at: Number.isInteger(entry?.text_index) ? entry.text_index : i, vector: entry?.embedding }));
	ensureVectors(ordered.map((entry) => entry.vector), config.embedding.dimensions, texts, "dashscope");
	const seen = new Set();
	for (const entry of ordered) {
		if (entry.at < 0 || entry.at >= texts.length || seen.has(entry.at)) throw new Error("dashscope 的 text_index 非法或重复");
		seen.add(entry.at);
	}
	return ordered.sort((a, b) => a.at - b.at).map((entry) => entry.vector);
}

async function embedOpenAICompatible(texts, key, config) {
	const base = embedEndpointBase(config, "http://127.0.0.1:11434/v1");
	const res = await fetch(`${base}/embeddings`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
		body: JSON.stringify({ model: config.embedding.model, input: texts }),
		signal: AbortSignal.timeout(60000),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`embedding ${res.status}（${base}）：${body.slice(0, 300)}`);
	}
	const data = await res.json();
	const rows = Array.isArray(data?.data) ? data.data : [];
	const ordered = rows.map((entry, i) => ({ at: Number.isInteger(entry?.index) ? entry.index : i, vector: entry?.embedding }));
	ensureVectors(ordered.map((entry) => entry.vector), config.embedding.dimensions, texts, "embedding");
	return ordered.sort((a, b) => a.at - b.at).map((entry) => entry.vector);
}

async function embedOllama(texts, key, config) {
	const base = embedEndpointBase(config, "http://127.0.0.1:11434");
	const res = await fetch(`${base}/api/embed`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
		body: JSON.stringify({ model: config.embedding.model, input: texts }),
		signal: AbortSignal.timeout(60000),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`ollama ${res.status}（${base}）：${body.slice(0, 300)}`);
	}
	const data = await res.json();
	const vectors = data?.embeddings ?? [];
	ensureVectors(vectors, config.embedding.dimensions, texts, "ollama");
	return vectors;
}

/** 按 provider 分发；导出给测试（用假 fetch 验证三种响应形状）。 */
export async function embedBatch(texts, key, config, textType = "document") {
	const provider = String(config.embedding?.provider || "dashscope").toLowerCase();
	if (provider === "openai") return embedOpenAICompatible(texts, key, config);
	if (provider === "ollama") return embedOllama(texts, key, config);
	return embedDashscope(texts, key, config, textType);
}

async function embedAll(texts, key, config, onProgress) {
	const vectors = [];
	for (let i = 0; i < texts.length; i += config.batchSize) {
		const batch = texts.slice(i, i + config.batchSize);
		let lastError;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				vectors.push(...(await embedBatch(batch, key, config)));
				lastError = void 0;
				break;
			} catch (error) {
				lastError = error;
				if (attempt < 2) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
			}
		}
		if (lastError) throw lastError;
		onProgress?.(Math.min(i + batch.length, texts.length), texts.length);
	}
	return vectors;
}

/* ------------------------------------------------------------------ */
/* 索引构建与读取                                                       */
/* ------------------------------------------------------------------ */

function cosine(a, b) {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom === 0 ? 0 : dot / denom;
}

/**
 * 词面命中加成：query 的相邻二元组在原文中的命中率（对中英文都有效）。
 * 实测 text-embedding-v4 的 text_type 参数对向量无影响（2026-09-23 验证），
 * 纯余弦对"精确词"类查询排序偏弱，用词面分补偿：综合分 = 0.75*余弦 + 0.25*词面。
 */
function keywordBoost(query, text) {
	const q = query.replace(/\s+/g, "");
	if (q.length < 2) return 0;
	let hits = 0;
	let total = 0;
	for (let i = 0; i + 2 <= q.length; i++) {
		total++;
		if (text.includes(q.slice(i, i + 2))) hits++;
	}
	return total === 0 ? 0 : hits / total;
}

/** 索引存储文件路径。 */
function storePath(libName) {
	return join(storeRoot(), `${libName}.json`);
}

/**
 * 读取某库的索引（带内存缓存）。
 * 缓存项带 mtime/size：索引文件被别的进程换掉时不会一直读旧副本。
 * 结构不合法（版本不符 / files 不是对象）按"损坏 → 需要重建"处理，而不是让上层 500。
 */
async function loadIndex(libName) {
	const path = storePath(libName);
	let info;
	try {
		info = statSync(path);
	} catch {
		indexCache.delete(path);
		return void 0;
	}
	const cached = indexCache.get(path);
	if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.index;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || !parsed.files || typeof parsed.files !== "object") {
			throw new Error("结构不完整");
		}
		if (parsed.version !== void 0 && parsed.version !== INDEX_VERSION) {
			throw new Error(`版本不符（${parsed.version} != ${INDEX_VERSION}）`);
		}
		cacheIndex(path, { index: parsed, mtimeMs: info.mtimeMs, size: info.size });
		return parsed;
	} catch (error) {
		log(`索引文件损坏，忽略：${libName} (${error.message})`);
		indexCache.delete(path);
		return void 0;
	}
}

/** 原子写索引：先写 .tmp 再 rename（写到一半被打断也不会留下半截 JSON）。 */
async function saveIndex(libName, index) {
	await mkdir(storeRoot(), { recursive: true });
	const path = storePath(libName);
	const tmp = `${path}.tmp`;
	await writeFile(tmp, JSON.stringify(index));
	await rename(tmp, path);
	let info;
	try {
		info = statSync(path);
	} catch {
		info = void 0;
	}
	cacheIndex(path, { index, mtimeMs: info?.mtimeMs ?? 0, size: info?.size ?? 0 });
}

/**  embedding / 分块配置指纹：配置变了就必须整库重建，否则新旧向量混在一个索引里会互相丢分。 */
function indexFingerprint(config) {
	return {
		provider: String(config.embedding.provider || "dashscope").toLowerCase(),
		baseUrl: String(config.embedding.baseUrl || ""),
		model: config.embedding.model,
		dimensions: config.embedding.dimensions,
		targetChars: config.chunking.targetChars,
		overlapChars: config.chunking.overlapChars,
	};
}

/**
 * 重建一个库的索引：全量扫描 → 与旧索引按文件 hash 比对 → 只 embedding 变化文件。
 * @returns {ok, library, files, chunks, embedded, skipped, error?}
 */
async function rebuildLibrary(ctx, libName, config) {
	const docs = await listDocuments(libName);
	if (docs.length === 0) {
		return { ok: false, library: libName, error: `库 "${libName}" 不存在或没有 .md/.txt 文档（源目录：${join(kbRoot(), libName)}）` };
	}
	const keyInfo = await resolveEmbeddingKey(ctx, config);
	if (!keyInfo.key && !keyInfo.optional) {
		return { ok: false, library: libName, error: "未配置 DashScope 凭据：请在 DSH 凭据里配置 DASHSCOPE_API_KEY（或已有的 DASHSCOPE_VISION）；也可以把 embedding.provider 改成 openai / ollama 指向本地服务" };
	}
	const previousIndex = await loadIndex(libName);
	const fingerprint = indexFingerprint(config);
	// 配置（模型/维度/分块）变了就不能复用旧块的向量：那会让新旧向量混在一个索引里互相丢分。
	const usablePrevious = previousIndex && JSON.stringify(previousIndex.fingerprint ?? null) === JSON.stringify(fingerprint)
		? previousIndex.files ?? {}
		: {};
	const previous = usablePrevious;
	const files = {};
	const embedTexts = [];
	const embedSlots = [];
	let skipped = 0;
	const startedAt = Date.now();
	rebuildProgress.set(libName, { name: libName, done: 0, total: 0, phase: "scanning", startedAt });

	try {

	for (const doc of docs) {
		const abs = join(kbRoot(), libName, doc);
		let content;
		try {
			// 库里误放几百 MB 的 .md 时，整篇读进内存会 OOM：先看大小再读。
			const size = statSync(abs).size;
			if (size > 8 * 1024 * 1024) {
				log(`跳过超大文档（>8MB）：${libName}/${doc}（${(size / 1048576).toFixed(1)} MB）`);
				continue;
			}
			content = await readFile(abs, "utf8");
		} catch (error) {
			log(`读取失败，跳过：${libName}/${doc} (${error.message})`);
			continue;
		}
		const hash = createHash("sha1").update(content).digest("hex");
		if (previous[doc]?.hash === hash && Array.isArray(previous[doc]?.chunks)) {
			files[doc] = previous[doc];
			skipped++;
			continue;
		}
		const chunks = chunkDocument(content, config.chunking).map((c) => ({ ...c, text: c.text, vector: [] }));
		files[doc] = { hash, chunks };
		for (const chunk of chunks) {
			embedTexts.push(chunk.text);
			embedSlots.push({ doc, chunk });
		}
	}

		let embedded = 0;
		try {
			if (embedTexts.length > 0) {
				const vectors = await embedAll(embedTexts, keyInfo.key, config, (done, total) => {
					log(`索引中：${libName} ${done}/${total} 块`);
					// 进程内进度：只存计数，供 /kb/api/status 读取（面板轮询用）。
					// 不落盘、不含文档内容，进程重启即丢——索引本身才是权威。
					rebuildProgress.set(libName, { name: libName, done, total, phase: "embedding", startedAt });
				});
				for (let i = 0; i < embedSlots.length; i++) {
					embedSlots[i].chunk.vector = vectors[i];
				}
				embedded = vectors.length;
			}

			// 本地模型没写 dimensions 时，取实际输出维度（0 = 自动）
			if (!(Number(config.embedding.dimensions) > 0) && embedTexts.length > 0) {
				const firstVector = embedSlots[0]?.chunk?.vector;
				if (Array.isArray(firstVector) && firstVector.length > 0) config.embedding.dimensions = firstVector.length;
			}
			const chunkCount = Object.values(files).reduce((n, f) => n + f.chunks.length, 0);
			const index = {
				version: INDEX_VERSION,
				model: config.embedding.model,
				dimensions: config.embedding.dimensions,
				fingerprint,
				keySource: keyInfo.source,
				updatedAt: new Date().toISOString(),
				files,
				stats: { documents: Object.keys(files).length, chunks: chunkCount },
			};
			await saveIndex(libName, index);
			return { ok: true, library: libName, files: index.stats.documents, chunks: chunkCount, embedded, skipped };
		} finally {
			// 无论成功/失败/被抛，都要把进度清掉，否则面板会一直显示"索引中"。
			rebuildProgress.delete(libName);
		}
	} catch (error) {
		// 扫描阶段抛错时进度条目还没被上面的 finally 覆盖，这里兜一次
		rebuildProgress.delete(libName);
		throw error;
	}
}

/** 在一个库（或全部库）中检索。 */
async function search(ctx, query, { library, topK = DEFAULTS.topK, searchConfig = DEFAULTS.search, embeddingConfig } = {}) {
	const libs = library ? [library] : await listLibraries();
	const results = [];
	let keyInfo;
	// 同一 query 只向量化一次（按模型/维度分组）：以前每库各请求一次，多库时是 N 倍延迟与费用
	const queryVectors = new Map();
	for (const libName of libs) {
		const index = await loadIndex(libName);
		if (!index?.stats?.chunks) continue;
		if (!keyInfo) {
			keyInfo = await resolveEmbeddingKey(ctx, { embedding: embeddingConfig });
			if (!keyInfo.key && !keyInfo.optional) return { ok: false, error: "未配置 DashScope 凭据，无法向量化查询（本地服务：把 embedding.provider 设为 openai / ollama）" };
		}
		const vectorKey = `${index.model}|${index.dimensions}`;
		let queryVector = queryVectors.get(vectorKey);
		if (!queryVector) {
			try {
				// 复用建索引时记录的 model/dimensions，保证查询向量与库内向量同空间
				const emb = { ...(embeddingConfig || {}), model: index.model, dimensions: index.dimensions };
				const [vector] = await embedBatch([query], keyInfo.key, { embedding: emb }, "query");
				queryVector = vector;
				queryVectors.set(vectorKey, vector);
			} catch (error) {
				return { ok: false, error: `查询向量化失败：${error.message}` };
			}
		}
		const flat = [];
		for (const [doc, info] of Object.entries(index.files)) {
			for (const chunk of info.chunks ?? []) {
				if (Array.isArray(chunk.vector) && chunk.vector.length === index.dimensions) {
					flat.push({ library: libName, file: doc, heading: chunk.heading, line: chunk.line, text: chunk.text, vector: chunk.vector });
				}
			}
		}
		flat.forEach((entry) => {
			const vectorScore = cosine(queryVector, entry.vector);
			entry.score = Number((0.75 * vectorScore + 0.25 * keywordBoost(query, entry.text)).toFixed(4));
		});
		results.push(...flat);
	}
	results.sort((a, b) => b.score - a.score);
	const classified = classifySearchHits(results, searchConfig);
	return {
		ok: true,
		query,
		results: classified.results.slice(0, topK).map(({ vector, ...rest }) => rest),
		maxScore: classified.maxScore,
		matched: classified.matched,
		lowConfidence: classified.lowConfidence,
		dropped: classified.dropped,
		thresholds: { minScore: searchConfig.minScore, lowScore: searchConfig.lowScore },
		note: classified.matched ? void 0 : "知识库里没有找到相关内容（相关度低于阈值）",
	};
}

/**
 * 分数分类（A+B 结合）：
 * - 最高分 < minScore → 视为没有命中（返回空 results + matched:false）；
 * - 其余保留，低于 lowScore 的标 `confidence: "low"`，让调用方决定是否采用。
 * 纯函数，便于单测。
 */
export function classifySearchHits(hits, options = {}) {
	const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : DEFAULTS.search.minScore;
	const lowScore = Number.isFinite(Number(options.lowScore)) ? Number(options.lowScore) : DEFAULTS.search.lowScore;
	const sorted = [...(hits ?? [])].sort((a, b) => b.score - a.score);
	const maxScore = sorted.length ? Number(sorted[0].score) : 0;
	if (!sorted.length || maxScore < minScore) {
		return { results: [], maxScore, matched: false, lowConfidence: false, dropped: sorted.length };
	}
	const kept = sorted.filter((hit) => Number(hit.score) >= minScore);
	const results = kept.map((hit) => ({ ...hit, confidence: Number(hit.score) >= lowScore ? "high" : "low" }));
	return {
		results,
		maxScore,
		matched: results.length > 0,
		lowConfidence: results.length > 0 && results.every((hit) => hit.confidence === "low"),
		dropped: sorted.length - kept.length,
	};
}

/**
 * 全库状态汇总（面板用）。
 * - 回答"当前会话用哪个库"：按 sessionId → cwd → 库名，未建库时 library 为 null；
 * - 把「记忆.md」从用户文档里摘出来（它是插件维持的，不是知识文档）；
 * - needsRebuild 不再只数文件个数：任一源文件比索引新也算落后（改内容能看见）。
 */
async function status(ctx, { sessionId } = {}, config = DEFAULTS) {
	const session = resolveSession(ctx, sessionId);
	const cwd = typeof session?.header?.cwd === "string" ? session.header.cwd : void 0;
	const currentLibrary = libraryForCwd(cwd);
	if (currentLibrary) noteLibrary(currentLibrary, cwd);
	const meta = await loadLibraryMeta();
	const libs = [];
	for (const libName of await listLibraries()) {
		const docs = await listDocuments(libName);
		const index = await loadIndex(libName);
		const hasMemory = docs.includes(MEMORY_FILE);
		const contentDocs = docs.filter((doc) => doc !== MEMORY_FILE);
		let memoryUpdatedAt;
		if (hasMemory) {
			try {
				memoryUpdatedAt = new Date(statSync(projectMemoryPath(kbRoot(), libName)).mtimeMs).toISOString();
			} catch {
				memoryUpdatedAt = void 0;
			}
		}
		let chunks = 0;
		let indexedDocuments = 0;
		for (const [doc, info] of Object.entries(index?.files ?? {})) {
			if (doc === MEMORY_FILE) continue;
			const n = info?.chunks?.length ?? 0;
			if (n > 0) indexedDocuments++;
			chunks += n;
		}
		// 落后判定：没索引 / 文档增减 / 任一源文件比索引新（含改内容不改名字）
		// 双向比对：索引里多出的文档（已删/改名）+ 磁盘上多出的文档都算落后
		const indexedDocs = Object.keys(index?.files ?? {});
		let dirty = index === void 0
			|| indexedDocs.length !== docs.length
			|| indexedDocs.some((doc) => !docs.includes(doc));
		// 配置指纹变了（换模型/维度/分块）也必须整库重建
		if (!dirty && JSON.stringify(index.fingerprint ?? null) !== JSON.stringify(indexFingerprint(config))) dirty = true;
		if (!dirty) {
			const indexedAt = Date.parse(index.updatedAt ?? "") || 0;
			for (const doc of docs) {
				try {
					if (statSync(join(kbRoot(), libName, doc)).mtimeMs > indexedAt + 1500) {
						dirty = true;
						break;
					}
				} catch {
					/* 文件刚被删：下一轮 status 会自然发现 */
				}
			}
		}
		const record = meta.items[libName];
		const kind = record?.cwd ? "workspace" : contentDocs.length + (hasMemory ? 1 : 0) > 0 ? "docs" : "empty";
		const live = rebuildProgress.get(libName);
		// 文件清单：面板展开库行时按名字列出来（内容一多，光看"5 篇"会一脸懵）
		const files = [];
		for (const doc of docs) {
			const abs = join(kbRoot(), libName, doc);
			let size;
			let updatedAt;
			try {
				const info = statSync(abs);
				size = info.size;
				updatedAt = new Date(info.mtimeMs).toISOString();
			} catch {
				/* 刚被删就跳过 */
			}
			files.push({ name: doc, kind: doc === MEMORY_FILE ? "project-memory" : "doc", size, updatedAt });
		}
		try {
			const windowDir = join(kbRoot(), libName, WINDOW_DIR);
			if (existsSync(windowDir)) {
				for (const entry of await readdir(windowDir, { withFileTypes: true })) {
					if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
					let size;
					let updatedAt;
					try {
						const info = statSync(join(windowDir, entry.name));
						size = info.size;
						updatedAt = new Date(info.mtimeMs).toISOString();
					} catch {
						/* 同上 */
					}
					files.push({ name: entry.name, kind: "window-memory", size, updatedAt });
				}
			}
		} catch {
			/* 没有窗口目录就跳过 */
		}
		files.sort((a, b) => {
			const rank = (x) => (x.kind === "project-memory" ? 0 : x.kind === "window-memory" ? 1 : 2);
			const d = rank(a) - rank(b);
			return d !== 0 ? d : String(a.name).localeCompare(String(b.name), "zh");
		});
		// 大库别把整个文件清单塞进每次 status：只回前 200 条，另给总数
		const filesTotal = files.length;
		const filesShown = files.slice(0, 200);
		libs.push({
			name: libName,
			kind,
			cwd: record?.cwd ?? void 0,
			documents: contentDocs.length,
			indexedDocuments,
			chunks,
			hasMemory,
			memoryUpdatedAt,
			updatedAt: index?.updatedAt ?? void 0,
			model: index?.model ?? void 0,
			needsRebuild: dirty,
			isCurrent: libName === currentLibrary,
			files: filesShown,
			filesTotal,
			// 面板轮询这个字段画进度条；重建结束即消失
			...(live ? { progress: { done: live.done, total: live.total, phase: live.phase } } : {}),
		});
	}
	// 工作区还没有库时如实回告（不凭空造目录），面板据此显示"尚未建立"
	return {
		ok: true,
		root: kbRoot(),
		store: storeRoot(),
		current: cwd
			? {
					cwd,
					library: currentLibrary ?? null,
					exists: libs.some((l) => l.name === currentLibrary),
					// 面板要把"哪个窗口"写清楚：窗口标题 + 会话 id
					sessionId: session?.id ? String(session.id) : void 0,
					title: sessionDisplayTitle(session) || void 0,
					// 没传 sessionId 时是"最近活动的会话"兜底，面板文案要区分，别装作是当前会话
					source: sessionId ? "session" : "recent",
				}
			: null,
		libraries: libs,
	};
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

export function apply(ctx, config = {}) {
	try {
		const paths = config && config.paths;
		pathOverrides.source = paths && typeof paths.source === "string" ? paths.source : "";
		pathOverrides.index = paths && typeof paths.index === "string" ? paths.index : "";
		if (pathOverrides.source || pathOverrides.index) {
			log("路径覆盖生效：source=" + (pathOverrides.source || "(默认)") + " · index=" + (pathOverrides.index || "(默认)"));
		}
	} catch (e) { log("路径配置读取失败：", e && e.message ? e.message : e); }
	try {
		const raw = readFileSync(pathsFile(), "utf8");
		const saved = JSON.parse(raw);
		if (saved && typeof saved.source === "string") pathOverrides.source = saved.source;
		if (saved && typeof saved.index === "string") pathOverrides.index = saved.index;
		if (pathOverrides.source || pathOverrides.index) log("面板路径覆盖生效：source=" + (pathOverrides.source || "(默认)") + " · index=" + (pathOverrides.index || "(默认)"));
	} catch (e) { /* 首次运行没有该文件，正常 */ }
	const merged = {
		embedding: { ...DEFAULTS.embedding, ...config.embedding },
		chunking: { ...DEFAULTS.chunking, ...config.chunking },
		batchSize: DEFAULTS.batchSize,
		topK: DEFAULTS.topK,
		search: { ...DEFAULTS.search, ...config.search },
	};
	// 分块参数夹紧：overlap >= target 会让切片步长退化为 0，死循环到宿主 OOM
	if (!(Number(merged.chunking.targetChars) > 0)) merged.chunking.targetChars = DEFAULTS.chunking.targetChars;
	merged.chunking.targetChars = Math.floor(merged.chunking.targetChars);
	const overlap = Number(merged.chunking.overlapChars);
	merged.chunking.overlapChars = Number.isFinite(overlap) && overlap >= 0
		? Math.min(Math.floor(overlap), merged.chunking.targetChars - 1)
		: DEFAULTS.chunking.overlapChars;
	if ((Number(config.chunking?.overlapChars) || 0) >= merged.chunking.targetChars) {
		log(`分块参数不合法（overlapChars ≥ targetChars），已夹到 ${merged.chunking.overlapChars}`);
	}

	// 记忆子系统：窗口记忆（每个窗口一篇，只注入给它自己）+ 项目记忆（跨窗口，需用户允许才注入）。
	// 任何一步失败都只降级记忆功能，绝不影响 kb_search / 面板路由。
	let memory;
	try {
		memory = createMemory({
			ctx,
			kbRoot,
			storeRoot,
			log,
			indexConfig: merged,
			rawConfig: config.memory,
			// 记忆自动重建也走同一把锁：路由层的 rebuilding 只管手动重建，
		// 两路并发会给同一个库重复 embedding（双倍费用 + 后写覆盖先写）。
		rebuildLibrary: (lib) => {
			if (rebuilding.has(lib)) return Promise.resolve({ ok: false, library: lib, error: "该库正在重建，请稍候" });
			rebuilding.add(lib);
			return Promise.resolve(rebuildLibrary(ctx, lib, merged)).finally(() => rebuilding.delete(lib));
		},
		});
	} catch (error) {
		log("记忆子系统未启用（降级）：", error?.message ?? String(error));
	}
	/** 生效的记忆参数（供日志与路由读取；运行时缺席时给默认值，行为一致）。 */
	const memoryConfig = memory ? memory.settings() : { turns: 6, minIntervalMs: 120000 };

	try {
		// 1) agent 工具：kb_search
		ctx.tools.register(
			defineTool({
				name: "kb_search",
				description:
					"在用户本地知识库（~/.dsh/kb/<库名>/ 下的 markdown/文本文档，已向量化索引）中做语义检索，返回最相关的原文块及其来源（库/文件/标题/行号）。用户提问涉及参考资料、手册、笔记、规范等文档内容时调用。",
				parameters: {
					query: { type: "string", description: "检索查询（自然语言，可中文）" },
					library: { type: "string", description: "限定库名（~/.dsh/kb 下的子目录名）。省略则搜索全部库", default: "" },
					topK: { type: "number", description: "返回的最大结果数，默认 5", default: DEFAULTS.topK },
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: true,
						properties: {
							ok: { type: "boolean", description: "是否成功" },
							results: {
								type: "array",
								description: "相关块列表（按相关度降序）",
								items: {
									type: "object",
									additionalProperties: true,
									properties: {
										library: { type: "string" },
										file: { type: "string" },
										heading: { type: "string" },
										line: { type: "number" },
										score: { type: "number" },
										confidence: { type: "string", enum: ["high", "low"], description: "高置信为真命中；low 表示相关度偏低，仅供参考" },
										text: { type: "string" },
									},
								},
							},
							maxScore: { type: "number", description: "本次最高相关度（0~1）" },
							matched: { type: "boolean", description: "false = 最高分低于阈值，视为没有相关内容" },
							lowConfidence: { type: "boolean", description: "true = 全部命中都是低置信" },
							dropped: { type: "number", description: "低于硬阈值被丢弃的条数" },
							note: { type: "string", description: "没有命中时的说明" },
							error: { type: "string", description: "失败原因" },
						},
					},
					// render 是**必填**的：dsh-tools 在 createSuccessResult 里无条件调
					// output.render(args, value)（dsh-tools/lib/index.js:3422），
					// 缺了它每次调用都会变成 projectionError("render", TypeError)，
					// 模型只会收到一条错误 tool-result，永远拿不到命中内容。
					render(_args, value) {
						if (!value || value.ok !== true) {
							return [{ type: "text", text: `知识库检索失败：${value?.error ?? "未知原因"}` }];
						}
						const hits = Array.isArray(value.results) ? value.results : [];
						if (hits.length === 0) {
							// 硬底线以下：明确告诉模型"没找到"，别让它拿无关内容硬编
							const max = Number.isFinite(value.maxScore) ? `（最高相关度 ${value.maxScore.toFixed(3)}）` : "";
							return [{ type: "text", text: `知识库中没有找到相关内容${max}。` }];
						}
						const low = value.lowConfidence === true;
						const lead = low ? "以下命中相关度偏低，仅供参考，不要当作确定事实：\n\n" : "";
						const body = hits
							.map((hit, index) => {
								const where = `${hit.library ?? "?"}/${hit.file ?? "?"}${hit.heading ? ` · ${hit.heading}` : ""} · L${hit.line ?? "?"}`;
								const score = Number.isFinite(hit.score) ? ` · 相似度 ${hit.score.toFixed(3)}` : "";
								const flag = hit.confidence === "low" ? "（低置信）" : "";
								return `【${index + 1}】${where}${score}${flag}\n${hit.text ?? ""}`;
							})
							.join("\n\n");
						return [{ type: "text", text: `${lead}知识库命中 ${hits.length} 条：\n\n${body}` }];
					},
				},
				isConcurrencySafe: true,
				timeoutMs: 60000,
				async execute(args, exec) {
					const query = String(args?.query ?? "").trim();
					if (!query) return { ok: false, results: [], error: "query 不能为空" };
					try {
						const topK = Number.isFinite(args?.topK) ? Math.min(Math.max(1, Math.floor(args.topK)), 20) : DEFAULTS.topK;
						let library;
						if (args?.library) {
							const check = await resolveLibraryName(args.library);
							if (!check.ok) return { ok: false, results: [], error: check.error };
							library = check.value;
						}
						const result = await search(ctx, query, { library, topK, searchConfig: merged.search, embeddingConfig: merged.embedding });
						// 记"查过什么、命中哪里"：上下文被压缩后，这行回执会随窗口记忆继续出现在系统提示里
						if (result.ok && result.results.length > 0) {
							void memory?.noteSearch({
								sessionId: exec?.agent?.sessionId ? String(exec.agent.sessionId) : void 0,
								query,
								results: result.results,
								by: "ai",
							}).catch(() => {});
						}
						return result;
					} catch (error) {
						log("kb_search 失败：", error.message);
						return { ok: false, results: [], error: error.message };
					}
				},
			}),
		);
	} catch (error) {
		log("kb_search 工具注册失败（降级为仅 HTTP 路由）：", error.message);
	}

	try {
		// 2) agent 工具：memory_read —— 项目记忆不自动注入，由模型自己按 query 取需要的小节。
		ctx.tools.register(
			defineTool({
				name: "memory_read",
				description:
					"按需读取记忆（两级）：窗口记忆＝本对话窗口自动维护的那份，通常已在系统提示里，一般不用读；项目记忆＝工作区级、跨窗口，**不会自动注入**，需要项目约定/决策/目录/坑时用这个工具按 query 取最相关的小节。",
				parameters: {
					query: { type: "string", description: "想找什么（自然语言关键词）；留空则按顺序取全文（受 maxChars 限制）", default: "" },
					scope: { type: "string", description: "window | project | auto（默认 auto：先本窗口，再项目）", default: "auto" },
					maxChars: { type: "number", description: "返回字符上限，默认 4000", default: 4000 },
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: true,
						properties: {
							ok: { type: "boolean" },
							library: { type: "string" },
							chars: { type: "number" },
							results: {
								type: "array",
								items: {
									type: "object",
									additionalProperties: true,
									properties: {
										scope: { type: "string" },
										label: { type: "string" },
										file: { type: "string" },
										heading: { type: "string" },
										text: { type: "string" },
									},
								},
							},
							error: { type: "string" },
						},
					},
					render(_args, value) {
						if (!value || value.ok !== true) return [{ type: "text", text: `读取记忆失败：${value?.error ?? "未知原因"}` }];
						const rows = Array.isArray(value.results) ? value.results : [];
						if (rows.length === 0) return [{ type: "text", text: "没有匹配的记忆内容。" }];
						const body = rows.map((r) => `【${r.label}${r.heading ? " · " + r.heading : ""}】\n${r.text}`).join("\n\n");
						return [{ type: "text", text: body }];
					},
				},
				isConcurrencySafe: true,
				timeoutMs: 20000,
				async execute(args, exec) {
					if (!memory) return { ok: false, results: [], error: "记忆子系统未启用" };
					try {
						const sessionId = exec?.agent?.sessionId ? String(exec.agent.sessionId) : void 0;
						return await memory.recall({
							sessionId,
							query: String(args?.query ?? ""),
							scope: args?.scope,
							maxChars: args?.maxChars,
						});
					} catch (error) {
						log("memory_read 失败：", error.message);
						return { ok: false, results: [], error: error.message };
					}
				},
			}),
		);
	} catch (error) {
		log("memory_read 工具注册失败（记忆仍可在面板查看）：", error.message);
	}

	try {
		// 2) 面板路由：/kb/api/status | /kb/api/search | /kb/api/rebuild
		// webServer 只在 host 构成里有（headless/CLI 没有）：缺它就只提供 kb_search 工具，
		// 不因为一个可选服务缺席而让整个插件起不来。
		// 注意用 ctx.get("webServer") 读——属性式 ctx.webServer 需要写进 inject。
		const webServer = typeof ctx.get === "function" ? ctx.get("webServer") : void 0;
		if (!webServer) {
			log("当前构成没有 webServer，面板路由未注册（kb_search 工具不受影响）");
		} else
		ctx.effect(
			() =>
				webServer.register({
					kind: "prefix",
					path: "/kb/api",
					handler: async (req, res) => {
						const writeJson = (code, body) => {
							res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
							res.end(JSON.stringify(body));
						};
						try {
							const url = new URL(req.url ?? "/", "http://x");
							const pathname = url.pathname;
							const params = url.searchParams;
							// 写接口同源闸门：浏览器跨站 POST（表单/no-cors fetch）一律拒绝。
							if (req.method !== "GET") {
								const secFetch = String(req.headers?.["sec-fetch-site"] ?? "");
								const origin = String(req.headers?.origin ?? "");
								const host = String(req.headers?.host ?? "");
								let crossSite = secFetch === "cross-site";
								if (!crossSite && origin) {
									try {
										crossSite = new URL(origin).host !== host;
									} catch {
										crossSite = true;
									}
								}
								if (crossSite) {
									writeJson(403, { ok: false, error: "拒绝跨站写入" });
									return;
								}
							}
							// JSON 体解析失败不能降级成 {}（那会让 /rebuild 变成"全库重建"、/paths 变成"清空配置"）。
							let body = {};
							if (req.method !== "GET") {
								try {
									body = await readJsonBody(req);
								} catch {
									writeJson(400, { ok: false, error: "请求体不是合法 JSON" });
									return;
								}
							}
							if (pathname === "/kb/api/paths") {
								if (req.method === "GET") { writeJson(200, pathsState()); return; }
								if (req.method === "POST") {
									const norm = (v) => (typeof v === "string" ? v.trim() : "");
									const hasSource = Object.hasOwn(body, "source");
									const hasIndex = Object.hasOwn(body, "index");
									if (!hasSource && !hasIndex) {
										writeJson(400, { ok: false, error: "请求体缺少 source / index" });
										return;
									}
									const nextSource = hasSource ? norm(body.source) : pathOverrides.source;
									const nextIndex = hasIndex ? norm(body.index) : pathOverrides.index;
									const sourceCheck = checkSourcePath(nextSource);
									if (!sourceCheck.ok) { writeJson(200, { ok: false, error: sourceCheck.error }); return; }
									if (nextIndex && !isAbsolute(nextIndex)) {
										writeJson(200, { ok: false, error: "索引目录请填绝对路径，或留空用默认目录" });
										return;
									}
									const indexCheck = checkIndexPath(nextIndex);
									if (nextIndex && !indexCheck.ok) { writeJson(200, { ok: false, error: indexCheck.error }); return; }
									pathOverrides.source = sourceCheck.value;
									pathOverrides.index = nextIndex;
									try {
										await mkdir(dshHomePath("storages", "dsh-kb"), { recursive: true });
										const tmp = `${pathsFile()}.tmp`;
										await writeFile(tmp, JSON.stringify({ source: pathOverrides.source, index: pathOverrides.index }, null, 2), "utf8");
										await rename(tmp, pathsFile());
									} catch (err) { log("保存路径失败：", err && err.message ? err.message : err); }
									// 换目录后进程内的索引缓存与库元数据都失效，必须一起清
									indexCache.clear();
									libraryMeta = null;
									librarySeen.clear();
									writeJson(200, pathsState());
									return;
								}
							}
							if (req.method === "GET" && pathname === "/kb/api/status") {
								const sid = params.get("sessionId") ?? "";
								// 重建进行中必须给实时进度，不能吃缓存。
								const fresh = rebuildProgress.size === 0
									&& statusCache.value !== null
									&& statusCache.key === sid
									&& Date.now() - statusCache.at < STATUS_CACHE_MS;
								if (fresh) {
									writeJson(200, statusCache.value);
									return;
								}
								const value = await status(ctx, { sessionId: sid || void 0 }, merged);
								statusCache = { at: Date.now(), key: sid, value };
								writeJson(200, value);
								return;
							}
							// ---- 记忆：窗口记忆（默认）+ 项目记忆（需用户允许注入） ----
							if (pathname.startsWith("/kb/api/memory")) {
								// 每条记忆路由各自兜底：任何内部异常都返回结构化错误，绝不抛穿。
								try {
									if (!memory) {
										writeJson(200, { ok: false, error: "记忆子系统未启用（见宿主日志 [dsh-kb] 前缀）" });
										return;
									}
									const sid = params.get("sessionId") ?? void 0;
									const scopeOf = (raw) => (raw === "project" ? "project" : "session");
									if (req.method === "GET" && pathname === "/kb/api/memory") {
										writeJson(200, await memory.view({ sessionId: sid, library: params.get("library") ?? void 0 }));
										return;
									}
									const scope = scopeOf(body?.scope);
									const wantedSession = body?.sessionId ? String(body.sessionId) : sid;
									// 面板的"打开目录"是按库发的（没有会话），所以这里必须把 library 透传下去
									const bodyLibrary = body?.library ? String(body.library) : params.get("library") ?? void 0;
									if (req.method === "POST" && pathname === "/kb/api/memory/update") {
										writeJson(200, await memory.update({ sessionId: wantedSession, scope, library: bodyLibrary, trigger: "manual" }));
										return;
									}
									if (req.method === "POST" && pathname === "/kb/api/memory/settings") {
										writeJson(200, await memory.setSettings(body ?? {}));
										return;
									}
									if (req.method === "POST" && pathname === "/kb/api/memory/rollback") {
										writeJson(200, await memory.rollback({ sessionId: wantedSession, scope, library: bodyLibrary, slot: body?.slot }));
										return;
									}
									if (req.method === "POST" && pathname === "/kb/api/memory/reveal") {
										try {
											writeJson(200, await memory.reveal({ sessionId: wantedSession, scope, library: bodyLibrary }));
										} catch (error) {
											// 打不开文件管理器也不算失败：把错误如实回给面板
											writeJson(200, { ok: false, error: `打开文件夹失败：${error?.message ?? String(error)}` });
										}
										return;
									}
									writeJson(404, { ok: false, error: "未知端点" });
								} catch (error) {
									log("记忆路由处理失败：", error?.message ?? String(error));
									writeJson(200, { ok: false, error: error?.message ?? String(error) });
								}
								return;
							}
							if (req.method === "POST" && pathname === "/kb/api/search") {
								const query = String(body?.query ?? "").trim();
								// 空 query 过去会退化成"纯关键词打分的任意命中"，这里直接拒绝。
								if (!query) {
									writeJson(200, { ok: false, results: [], error: "query 不能为空" });
									return;
								}
								// topK 必须夹紧：负数会让 slice(0,-1) 静默丢命中，超大值会灌爆响应。
								const rawTopK = Number(body?.topK);
								const routeTopK = Number.isFinite(rawTopK) ? Math.min(Math.max(1, Math.floor(rawTopK)), 20) : DEFAULTS.topK;
								let searchLibrary;
								if (body?.library) {
									const check = await resolveLibraryName(body.library);
									if (!check.ok) {
										writeJson(200, { ok: false, results: [], error: check.error });
										return;
									}
									searchLibrary = check.value;
								}
								const routeResult = await search(ctx, query, { library: searchLibrary, topK: routeTopK, searchConfig: merged.search, embeddingConfig: merged.embedding });
								// 面板里的检索也算"这个窗口查过什么"，同样进回执
								if (routeResult.ok && routeResult.results.length > 0) {
									const sid = body?.sessionId ? String(body.sessionId) : params.get("sessionId") ?? void 0;
									void memory?.noteSearch({ sessionId: sid, query, results: routeResult.results, by: "panel" }).catch(() => {});
								}
								writeJson(200, routeResult);
								return;
							}
							// 打开某个文件（面板文件清单点击）：只允许库目录内的单层文件
							if (req.method === "POST" && pathname === "/kb/api/file/open") {
								const libraryCheck = await resolveLibraryName(body?.library);
								if (!libraryCheck.ok) {
									writeJson(200, libraryCheck);
									return;
								}
								const library = libraryCheck.value;
								const name = String(body?.name ?? "").trim();
								const kind = body?.kind === "window-memory" ? "window" : "project";
								if (!name) {
									writeJson(200, { ok: false, error: "缺少文件名" });
									return;
								}
								if (name !== basename(name) || name.includes("..")) {
									writeJson(200, { ok: false, error: "文件名不合法" });
									return;
								}
								const dir = kind === "window" ? join(kbRoot(), library, WINDOW_DIR) : join(kbRoot(), library);
								const target = join(dir, name);
								if (!existsSync(target)) {
									writeJson(200, { ok: false, error: `文件不存在：${target}` });
									return;
								}
								try {
									const mod = await import("@deepseek-ai/dsh-native-command");
									const opener = mod?.openNativePath ?? mod?.revealNativePath;
									if (typeof opener !== "function") throw new Error("dsh-native-command 未导出 openNativePath");
									await opener(target, AbortSignal.timeout(10000));
									writeJson(200, { ok: true, path: target });
								} catch (error) {
									writeJson(200, { ok: false, path: target, error: `打开失败：${error?.message ?? String(error)}` });
								}
								return;
							}
							if (req.method === "POST" && pathname === "/kb/api/rebuild") {
								let targetLibraries;
								if (body?.library) {
									// 库名必须来自真实存在的库：否则 join(kb, "..\\..\\x") 会把任意目录的 .md 上传去向量化
									const check = await resolveLibraryName(body.library);
									if (!check.ok) {
										writeJson(200, { ok: false, outcomes: [], error: check.error });
										return;
									}
									targetLibraries = [check.value];
								} else {
									targetLibraries = await listLibraries();
								}
								if (targetLibraries.length === 0) {
									writeJson(200, { ok: false, error: `没有可索引的库。请先创建源目录 ${kbRoot()}\\<库名>\\ 并放入 .md/.txt 文档` });
									return;
								}
								const outcomes = [];
								for (const libName of targetLibraries) {
									if (rebuilding.has(libName)) {
										outcomes.push({ ok: false, library: libName, error: "该库正在重建，请稍候" });
										continue;
									}
									rebuilding.add(libName);
									try {
										outcomes.push(await rebuildLibrary(ctx, libName, merged));
									} catch (error) {
										log(`重建失败：${libName}`, error.message);
										outcomes.push({ ok: false, library: libName, error: error.message });
									} finally {
										rebuilding.delete(libName);
									}
								}
								writeJson(200, { ok: outcomes.every((o) => o.ok), outcomes });
								return;
							}
							// ---- 库的重命名 / 删除（删除 = 移入 <kb>/.trash，可恢复） ----
							if (req.method === "POST" && pathname === "/kb/api/library/rename") {
								const fromCheck = await resolveLibraryName(body?.from);
								if (!fromCheck.ok) {
									writeJson(200, fromCheck);
									return;
								}
								const from = fromCheck.value;
								const check = validateLibraryName(body?.to);
								if (!check.ok) {
									writeJson(200, check);
									return;
								}
								const to = check.value;
								if (to === from) {
									writeJson(200, { ok: true, from, to, unchanged: true });
									return;
								}
								const result = await renameLibrary(from, to);
								if (result.ok && memory) await memory.renameLibrary(from, to);
								writeJson(200, result);
								return;
							}
							if (req.method === "POST" && pathname === "/kb/api/library/delete") {
								const check = await resolveLibraryName(body?.name);
								if (!check.ok) {
									writeJson(200, check);
									return;
								}
								const name = check.value;
								// 当前窗口所在工作区的库不给删：删了本窗口记忆就没落点了
								const currentLib = libraryForCwd(resolveSession(ctx, body?.sessionId)?.header?.cwd);
								const result = await trashLibrary(name, currentLib);
								if (result.ok && memory) await memory.forgetLibrary(name);
								writeJson(200, result);
								return;
							}
							writeJson(404, { ok: false, error: "未知端点" });
						} catch (error) {
							log("路由处理失败：", error.message);
							writeJson(500, { ok: false, error: error.message });
						}
					},
				}),
			"kb: /kb/api 路由",
		);
	} catch (error) {
		log("webServer 路由注册失败（面板不可用，kb_search 工具不受影响）：", error.message);
	}

	try {
		// 3) 斜杠命令 /kb <问题>：host 侧注册，客户端 / 菜单会自动列出（remote.commands.list）。
		// 命令在 host 侧跑检索，返回值作为 command/done 结果进入会话——因此它不可能
		// 往输入框里塞文本（那需要客户端侧的输入框通道），这里只如实给检索结果。
		const commands = typeof ctx.get === "function" ? ctx.get("commands") : void 0;
		if (!commands || typeof commands.register !== "function") {
			log("当前构成没有 commands 服务，/kb 命令未注册（kb_search 工具不受影响）");
		} else {
			commands.register({
				name: "kb",
				description: "在本地知识库中检索：/kb <问题>",
				input: { hint: "要检索的问题" },
				handler: async ({ rawInput }) => {
					const query = String(rawInput ?? "").trim();
					if (!query) return { kind: "error", text: "用法：/kb <问题>（可加 --lib=<库名> 限定库，--topk=<1-20> 控制条数）" };
					let library;
					let topK = DEFAULTS.topK;
					for (const token of query.split(/\s+/)) {
						const libMatch = /^--lib=(.+)$/u.exec(token);
						if (libMatch) library = libMatch[1];
						const topMatch = /^--topk=(\d+)$/u.exec(token);
						if (topMatch) topK = Math.min(Math.max(1, Number(topMatch[1])), 20);
					}
					if (library !== void 0) {
						// 和 kb_search 一样必须过库名校验：未校验的 `..` 会被 join 归一化到 storeRoot 之外。
						const checked = await resolveLibraryName(library);
						if (!checked.ok) return { kind: "error", text: checked.error };
						library = checked.value;
					}
					const cleanQuery = query.replace(/--(?:lib|topk)=\S+/gu, "").trim();
					if (!cleanQuery) return { kind: "error", text: "用法：/kb <问题>（问题不能为空）" };
					try {
						const result = await search(ctx, cleanQuery, { library, topK, searchConfig: merged.search, embeddingConfig: merged.embedding });
						if (!result.ok) return { kind: "error", text: result.error };
						if (result.results.length === 0) return { kind: "success", text: "知识库里没有找到相关内容。" };
						const lead = result.lowConfidence ? "相关度偏低，仅供参考：\n" : "";
						const lines = result.results.map((hit, index) => {
							const where = `${hit.library}/${hit.file}${hit.heading ? ` · ${hit.heading}` : ""} · L${hit.line}`;
							const body = String(hit.text ?? "").replace(/\s+/gu, " ").slice(0, 240);
							return `【${index + 1}】${where}${hit.confidence === "low" ? "（低置信）" : ""}\n${body}`;
						});
						return { kind: "success", text: `${lead}知识库命中 ${result.results.length} 条（来源已附）：\n\n${lines.join("\n\n")}` };
					} catch (error) {
						log("/kb 检索失败：", error.message);
						return { kind: "error", text: `检索失败：${error.message}` };
					}
				},
			});
		}
	} catch (error) {
		log("/kb 命令注册失败（kb_search 工具不受影响）：", error.message);
	}

	log(
		"已加载：源目录",
		kbRoot(),
		"· 索引存储",
		storeRoot(),
		`· 记忆：窗口记忆（自动，每窗口一篇，只注入自己）${memory && memory.injectEnabled() ? "已注入系统提示层" : "未注入（降级）"} · 项目记忆（主动型：默认关闭，面板开启后自动维护；正文不注入，AI 用 memory_read 取） · 每 ${memoryConfig.turns} 轮自动更新，间隔下限 ${Math.round(memoryConfig.minIntervalMs / 1000)}s`,
	);
}

/** 读取并解析 JSON 请求体（空体返回 {}）。 */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		// 本机程序也可能 POST 一个超大 JSON：上限 1MB，超了直接拒绝，别把宿主内存打满。
		if (size > 1024 * 1024) throw new Error("请求体超过 1MB");
		chunks.push(chunk);
	}
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	return raw ? JSON.parse(raw) : {};
}
