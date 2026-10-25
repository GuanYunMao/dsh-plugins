/**
 * dsh-kb 记忆子系统的最小单测（node --test，零依赖）。
 *
 * 覆盖用户明确关心的模型：
 * 1. 一个窗口一篇：窗口记忆落在 <库>/窗口/<短 id>.md，和项目记忆 <库>/记忆.md 分开；
 * 2. 项目记忆默认不注入：settings.injectProject 为 false 时 projectSectionText 返回空串；
 * 3. 同意后注入：面板"允许注入"把 injectProject 打开，同一份项目记忆立刻能拼出注入文本；
 * 4. 会话标题从 session/title 事件折出（面板要显示"哪个窗口"）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemory, libraryForCwd, sessionShortId, foldSessionTitle, projectMemoryPath, windowFileName, MEMORY_FILE, WINDOW_DIR } from "../lib/memory.js";
import { chunkDocument, classifySearchHits } from "../lib/index.js";

/** 一个假 ctx：只提供 sessions / systemPrompt，llm 不参与本组用例。 */
function makeCtx(sessions) {
	const sections = [];
	const ctx = {
		get(name) {
			if (name === "sessions") return { get: (id) => sessions.find((s) => s.id === id), list: () => sessions };
			if (name === "systemPrompt") return { section: (cfg) => { sections.push(cfg); return () => {}; } };
			return void 0;
		},
		effect(fn) { fn(); },
		on() {},
	};
	return { ctx, sections };
}

function makeSession({ id, cwd, title, turns = 2 }) {
	const events = [
		{ type: "session/title", seq: 1, time: 1, data: { title, messageSeqs: [], source: { kind: "fallback" } } },
	];
	for (let i = 1; i <= turns; i++) {
		events.push({ type: "turn/start", seq: i * 10, time: i, data: { turn: i } });
		events.push({ type: "user/message", seq: i * 10 + 1, time: i, data: { source: { kind: "user" }, content: [{ type: "text", text: `第${i}轮问题` }] } });
		events.push({ type: "assistant/message", seq: i * 10 + 2, time: i, data: { message: { content: [{ type: "text", text: `第${i}轮回答` }] } } });
		events.push({ type: "turn/end", seq: i * 10 + 3, time: i, data: { reason: { kind: "completed" } } });
	}
	return {
		id,
		header: { cwd },
		seq: turns * 10 + 3,
		snapshotEvents: () => events,
		requestHeader: () => ({ config: { provider: "fake", model: "fake" } }),
	};
}

async function withRuntime(fn) {
	const root = await mkdtemp(join(tmpdir(), "dshkb-test-"));
	const kbRoot = join(root, "kb");
	const storeRoot = join(root, "storages");
	const cwd = join(root, "ws", "Harness work");
	await mkdir(join(kbRoot, "Harness work"), { recursive: true });
	await mkdir(storeRoot, { recursive: true });
	try {
		return await fn({ root, kbRoot, storeRoot, cwd });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("库名 / 短 id / 标题折叠 / 窗口文件名", () => {
	assert.equal(libraryForCwd("D:\\DSH Desktop\\Harness work\\"), "Harness work");
	assert.equal(libraryForCwd(""), void 0);
	assert.equal(sessionShortId("session-a364d6d8-7300-4e00"), "a364d6d8");
	assert.equal(sessionShortId(""), "unknown");
	const session = makeSession({ id: "session-deadbeef-0000", cwd: "D:\\x\\ws", title: "窗口甲" });
	assert.equal(foldSessionTitle(session), "窗口甲");
	assert.equal(windowFileName("窗口甲", "session-a364d6d8-7300"), "窗口甲-a364d6d8.md");
	assert.equal(windowFileName("", "session-a364d6d8-7300"), "a364d6d8.md");
	assert.equal(windowFileName("含/斜杠:与*号", "session-a364d6d8-7300"), "含斜杠与号-a364d6d8.md");
});

test("窗口记忆与项目记忆是两份文件，路径分开", async () => {
	await withRuntime(async ({ kbRoot, storeRoot, cwd }) => {
		const id = "session-a364d6d8-7300-4e00-acc2-d75fd70b780e";
		const session = makeSession({ id, cwd, title: "窗口甲" });
		const { ctx, sections } = makeCtx([session]);
		const memory = createMemory({ ctx, kbRoot, storeRoot, log: () => {}, indexConfig: {}, rawConfig: {} });

		assert.equal(sections.length, 2, "窗口记忆注入 + 项目记忆提示（不注入正文）");
		assert.deepEqual(sections.map((s) => s.name), ["kb:session-memory", "kb:project-memory"]);

		await writeFile(projectMemoryPath(kbRoot, "Harness work"), "# 项目\n\n跨窗口约定。\n", "utf8");
		const view = await memory.view({ sessionId: id });
		assert.equal(view.ok, true);
		assert.equal(view.window.id, id);
		assert.equal(view.window.title, "窗口甲");
		assert.ok(view.window.path.endsWith(join(WINDOW_DIR, "窗口甲-a364d6d8.md")), "窗口记忆在 窗口/<短id>.md");
		assert.equal(view.window.exists, false);
		assert.equal(view.project.exists, true);
		assert.equal(view.project.path, join(kbRoot, "Harness work", MEMORY_FILE));
		assert.equal(view.project.autoInject, false, "项目记忆不自动注入（主动型）");
	});
});

test("窗口记忆自动注入；项目记忆永不自动注入，只能 memory_read 取", async () => {
	await withRuntime(async ({ kbRoot, storeRoot, cwd }) => {
		const id = "session-11112222-0000";
		const session = makeSession({ id, cwd, title: "窗口乙" });
		const { ctx } = makeCtx([session]);
		const memory = createMemory({ ctx, kbRoot, storeRoot, log: () => {}, indexConfig: {}, rawConfig: {} });
		const assembly = { agent: { session } };

		// 没有记忆文件时两条注入都为空
		assert.equal(memory.sessionSectionText(assembly), "");
		assert.equal(memory.projectSectionText(assembly), "");

		// 写一份窗口记忆 → 自动注入（带 window 标题）
		const windowPath = join(kbRoot, "Harness work", WINDOW_DIR, windowFileName("窗口乙", id));
		await mkdir(join(kbRoot, "Harness work", WINDOW_DIR), { recursive: true });
		await writeFile(windowPath, "## 已完成\n\n- 窗口内的事。\n", "utf8");
		assert.match(memory.sessionSectionText(assembly), /<session-memory/);
		assert.match(memory.sessionSectionText(assembly), /窗口内的事/);

		// 项目记忆：即使把 injectProject 打开，也不再自动注入（主动型）
		await writeFile(projectMemoryPath(kbRoot, "Harness work"), "## 目标与约束\n\n- 只做真实的事。\n", "utf8");
		assert.equal(memory.projectSectionText(assembly), "", "项目记忆永不自动注入");
		await memory.setSettings({ injectProject: true });
		assert.equal(memory.projectSectionText(assembly), "", "开开关也不注入");

		// AI 侧：memory_read → recall 能取到项目记忆
		const recalled = await memory.recall({ sessionId: id, query: "真实", scope: "project" });
		assert.equal(recalled.ok, true);
		assert.equal(recalled.results.length, 1);
		assert.match(recalled.results[0].text, /只做真实的事/);

		// scope=window 只取窗口记忆
		const win = await memory.recall({ sessionId: id, scope: "window" });
		assert.equal(win.ok, true);
		assert.match(win.results.map((r) => r.text).join("\n"), /窗口内的事/);
	});
});

test("recall：按 query 只回相关小节", async () => {
	await withRuntime(async ({ kbRoot, storeRoot, cwd }) => {
		const id = "session-abcdef01-0000";
		const session = makeSession({ id, cwd, title: "窗口丙" });
		const { ctx } = makeCtx([session]);
		const memory = createMemory({ ctx, kbRoot, storeRoot, log: () => {}, indexConfig: {}, rawConfig: {} });
		await writeFile(
			projectMemoryPath(kbRoot, "Harness work"),
			"## 目标与约束\n\n- 端口是 3097。\n\n## 踩过的坑\n\n- 编码问题曾经毁过一次文件。\n",
			"utf8",
		);
		const hit = await memory.recall({ sessionId: id, query: "编码", scope: "project" });
		assert.equal(hit.ok, true);
		assert.equal(hit.results.length, 1, "只回命中的那一节");
		assert.match(hit.results[0].text, /编码问题/);
		assert.doesNotMatch(hit.results[0].text, /3097/);
	});
});

test("设置校验：turns 越界被拒，非法 injectProject 被拒", async () => {
	await withRuntime(async ({ kbRoot, storeRoot, cwd }) => {
		const session = makeSession({ id: "session-3333", cwd, title: "t" });
		const { ctx } = makeCtx([session]);
		const memory = createMemory({ ctx, kbRoot, storeRoot, log: () => {}, indexConfig: {}, rawConfig: {} });
		assert.equal((await memory.setSettings({ turns: 0 })).ok, false);
		assert.equal((await memory.setSettings({ turns: 201 })).ok, false);
		assert.equal((await memory.setSettings({ turns: 9 })).ok, true);
		assert.equal(memory.settings().turns, 9);
		assert.equal((await memory.setSettings({ injectProject: "yes" })).ok, false);
		assert.equal(memory.settings().projectEnabled, false, "项目记忆默认不开启");
		assert.equal((await memory.setSettings({ projectEnabled: "yes" })).ok, false);
		assert.equal((await memory.setSettings({ projectEnabled: true })).ok, true);
		assert.equal(memory.settings().projectEnabled, true, "手动开启后生效");
	});
});

test("没有活动会话时仍能看项目记忆（window 为 null）", async () => {
	await withRuntime(async ({ kbRoot, storeRoot }) => {
		const { ctx } = makeCtx([]);
		const memory = createMemory({ ctx, kbRoot, storeRoot, log: () => {}, indexConfig: {}, rawConfig: {} });
		await writeFile(projectMemoryPath(kbRoot, "Harness work"), "## 已完成\n\n- 某件事。\n", "utf8");
		const view = await memory.view({ library: "Harness work" });
		assert.equal(view.ok, true);
		assert.equal(view.window, null);
		assert.equal(view.project.exists, true);
		assert.match(view.project.text, /某件事/);
	});
});

test("v1 迁移：旧的工作区记忆归位到产生它的窗口", async () => {
	await withRuntime(async ({ kbRoot, storeRoot, cwd }) => {
		const id = "session-486dda5d-e550-4d8a-b703-0cefd3ab832b";
		const legacy = "## 目标与约束\n\n- D 盘整理的那批结论。\n";
		await writeFile(projectMemoryPath(kbRoot, "Harness work"), legacy, "utf8");
		// v1 状态文件：只有 libraries + sessions（sessions 记录带 library 字段）
		await writeFile(
			join(storeRoot, "memory.json"),
			JSON.stringify({
				version: 1,
				settings: {},
				libraries: { "Harness work": { lastRunAt: 1, truncated: true } },
				sessions: { [id]: { library: "Harness work", lastRunAt: 1, sinceSeq: 99 } },
			}),
			"utf8",
		);
		const session = makeSession({ id, cwd, title: "大学生D盘整理与输入法排查" });
		const { ctx } = makeCtx([session]);
		const memory = createMemory({ ctx, kbRoot, storeRoot, log: () => {}, indexConfig: {}, rawConfig: {} });
		const view = await memory.view({ sessionId: id });
		assert.equal(view.ok, true);
		assert.equal(view.window.exists, true, "窗口记忆文件应被迁移出来");
		assert.match(view.window.text, /D 盘整理的那批结论/, "内容来自 v1 的工作区记忆");
		assert.equal(view.project.exists, true, "项目记忆仍保留一份");
		assert.equal(view.project.autoInject, false);
		assert.equal(view.project.onDemand, true);
		assert.equal(view.window.truncated, false, "截断标记属于项目记录，不再冒充窗口状态");
	});
});

test("recall：完全没有命中时返回空结果，不拿无关小节凑数", async () => {
	await withRuntime(async ({ kbRoot, storeRoot, cwd }) => {
		const id = "session-99999999-0000";
		const session = makeSession({ id, cwd, title: "窗口丁" });
		const { ctx } = makeCtx([session]);
		const memory = createMemory({ ctx, kbRoot, storeRoot, log: () => {}, indexConfig: {}, rawConfig: {} });
		await writeFile(projectMemoryPath(kbRoot, "Harness work"), "## 目标与约束\n\n- 只做真实的事。\n", "utf8");
		const miss = await memory.recall({ sessionId: id, query: "量子力学薛定谔方程", scope: "project" });
		assert.equal(miss.ok, true);
		assert.deepEqual(miss.results, []);
		assert.equal(miss.matched, false);
	});
});

test("分块：不产生“纯尾巴”重复块，overlap ≥ target 时不死循环", () => {
	// 旧实现会为长行多推一个"只有重叠尾巴"的块（第二块是第一块的后缀）
	const single = chunkDocument("a".repeat(1500), { targetChars: 1200, overlapChars: 150 });
	assert.equal(single.length, 1);

	const varied = Array.from({ length: 300 }, (_, i) => `line-${i}-` + "a".repeat(60)).join("\n");
	const chunks = chunkDocument(varied, { targetChars: 400, overlapChars: 100 });
	assert.ok(chunks.length > 10, "正常文档应切出多块");
	for (let i = 1; i < chunks.length; i++) {
		assert.ok(!chunks[i - 1].text.endsWith(chunks[i].text), "后一块不应是前一块的后缀");
	}

	// overlapChars == targetChars 会让步长退化为 0：必须还能返回而不是挂死
	const bad = chunkDocument(varied, { targetChars: 400, overlapChars: 400 });
	assert.ok(bad.length > 0 && bad.length < 2000, "非法分块参数应被兜住");
});

test("检索回执：查过什么随窗口记忆一起注入，压缩后仍可见", async () => {
	await withRuntime(async ({ kbRoot, storeRoot, cwd }) => {
		const id = "session-receipt-01";
		const session = makeSession({ id, cwd, title: "窗口戊" });
		const { ctx } = makeCtx([session]);
		const memory = createMemory({ ctx, kbRoot, storeRoot, log: () => {}, indexConfig: {}, rawConfig: {} });

		// 还没有回执时，注入里没有这一块
		assert.doesNotMatch(memory.sessionSectionText({ agent: { session } }), /recent-searches/);

		await memory.noteSearch({
			sessionId: id,
			query: "分叉 锚点",
			results: [{ file: "分叉语义与锚点.md", heading: "会话分叉（fork）语义与锚点记录", score: 0.675 }],
		});
		const injected = memory.sessionSectionText({ agent: { session } });
		assert.match(injected, /<recent-searches/);
		assert.match(injected, /分叉 锚点/);
		assert.match(injected, /分叉语义与锚点\.md/);

		// 只留最近 maxReceipts 条（默认 5）
		for (let i = 0; i < 8; i++) {
			await memory.noteSearch({ sessionId: id, query: `查询 ${i}`, results: [{ file: `f${i}.md`, score: 0.6 }] });
		}
		const section = memory.sessionSectionText({ agent: { session } });
		assert.doesNotMatch(section, /分叉 锚点/, "最旧的回执应被挤掉");
		assert.match(section, /查询 7/);

		// 关掉就不注入
		await memory.setSettings({ receipts: false });
		assert.doesNotMatch(memory.sessionSectionText({ agent: { session } }), /recent-searches/);
	});
});

test("检索分数分级：低于硬底线视为没命中，中间档标低置信", () => {
	const options = { minScore: 0.25, lowScore: 0.5 };
	// 无关查询（实测 0.17~0.20）→ 认为没找到
	const noise = classifySearchHits([{ score: 0.198 }, { score: 0.182 }], options);
	assert.equal(noise.matched, false);
	assert.deepEqual(noise.results, []);
	assert.equal(noise.dropped, 2);

	// 弱相关（实测 0.35~0.39）→ 保留但标 low
	const weak = classifySearchHits([{ score: 0.386 }, { score: 0.373 }], options);
	assert.equal(weak.matched, true);
	assert.equal(weak.lowConfidence, true);
	assert.deepEqual(weak.results.map((r) => r.confidence), ["low", "low"]);

	// 真命中（实测 0.56~0.79）→ high
	const good = classifySearchHits([{ score: 0.675 }, { score: 0.562 }], options);
	assert.equal(good.lowConfidence, false);
	assert.deepEqual(good.results.map((r) => r.confidence), ["high", "high"]);

	// 混合：高的保留、低的丢弃、中间标 low
	const mixed = classifySearchHits([{ score: 0.62 }, { score: 0.4 }, { score: 0.19 }], options);
	assert.equal(mixed.results.length, 2);
	assert.deepEqual(mixed.results.map((r) => r.confidence), ["high", "low"]);
	assert.equal(mixed.dropped, 1);
});
