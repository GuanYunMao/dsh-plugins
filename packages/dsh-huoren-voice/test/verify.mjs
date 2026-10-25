/**
 * 自检：不依赖 DSH 运行时。
 * 1) 纯文本组装与配置收敛；2) 配置持久化；3) 假 ctx 验段落注册；
 * 4) 假 req/res 走一遍 /api/huoren-voice/* 路由（含跨站与回环闸门）。
 *
 * 跑法：node test/verify.mjs
 */
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME = mkdtempSync(join(tmpdir(), "huoren-voice-test-"));
process.env.DSH_HOME = HOME;

const {
  DEFAULT_CONFIG,
  SECTION_MAIN,
  SECTION_SAMPLES,
  SECTION_TAIL,
  apply,
  buildSections,
  buildSamplesText,
  buildTailEcho,
  buildVoicePrompt,
  normalizeConfig,
  readStoredConfig,
  writeStoredConfig,
  clearStoredConfig,
  effectiveConfig,
} = await import("../lib/index.js");

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    console.error(`FAIL  ${label}`);
    throw error;
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    console.error(`FAIL  ${label}`);
    throw error;
  }
}

/* ---------------- 1. 文本组装 ---------------- */

check("默认主段包含身份、四条方向、替换表与正反例句", () => {
  const text = buildVoicePrompt(DEFAULT_CONFIG);
  for (const needle of ["## 你是谁", "热情：", "严谨：", "天马行空：", "幽默：", "展开说清：", "具体：", "替换表：", "## 你会这样说", "## 你不会这样说"]) {
    assert.ok(text.includes(needle), `缺少 ${needle}`);
  }
});

check("例句开关：关掉后正反例句都不出现", () => {
  const text = buildVoicePrompt({ examples: false });
  assert.ok(!text.includes("你会这样说"));
  assert.ok(text.includes("替换表："));
});

check("samples 单独成段，放在末尾附近（order 10200），最多 6 条", () => {
  const text = buildSamplesText({ samples: "这版先别发。\n我赌三分钟。" });
  assert.ok(text.includes("## 用户喜欢的句子（只学语气，不搬内容）"));
  assert.ok(text.includes("「这版先别发。」"));
  assert.ok(text.includes("「我赌三分钟。」"));
  assert.ok(!buildVoicePrompt({ samples: "不该进主段" }).includes("不该进主段"), "样例不应该塞进主段");

  const many = buildSamplesText({ samples: Array.from({ length: 9 }, (_, i) => `句${i}`).join("\n") });
  assert.ok(many.includes("「句5」"));
  assert.ok(!many.includes("「句6」"));

  const sections = buildSections({ samples: "这版先别发。" });
  assert.equal(sections.length, 3);
  const sampleSection = sections.find((section) => section.name === SECTION_SAMPLES);
  assert.ok(sampleSection, "应该注册 huoren:samples");
  assert.equal(sampleSection.order, 10200);
  assert.ok(buildSections({}).every((section) => section.name !== SECTION_SAMPLES));
});

check("关闭 humor 后对应块消失、其它块仍在", () => {
  const text = buildVoicePrompt({ humor: false });
  assert.ok(!text.includes("幽默："));
  assert.ok(text.includes("严谨："));
});

check("总开关关掉后主段与回声都为空串", () => {
  assert.equal(buildVoicePrompt({ enabled: false }), "");
  assert.equal(buildTailEcho({ enabled: false }), "");
});

check("emoji 默认开，关掉后表情块消失", () => {
  assert.ok(buildVoicePrompt(DEFAULT_CONFIG).includes("表情："));
  assert.ok(!buildVoicePrompt({ emoji: false }).includes("表情："));
  assert.ok(buildVoicePrompt(DEFAULT_CONFIG).includes("3 到 8 个"));
});

check("append 原样注入到主段末尾", () => {
  const text = buildVoicePrompt({ append: "可以偶尔用上海话。" });
  assert.ok(text.endsWith("可以偶尔用上海话。"));
});

check("maxChars 截断时保头保尾", () => {
  const long = buildVoicePrompt({ append: "尾巴".repeat(500), maxChars: 300 });
  assert.ok(long.length <= 302, `实际 ${long.length}`);
  assert.ok(long.includes("## 你是谁"));
  assert.ok(long.endsWith("尾巴"));
});

check("append 超长与 maxChars 越界都被收敛", () => {
  const cfg = normalizeConfig({ append: "x".repeat(5000), maxChars: 999999 });
  assert.equal(cfg.append.length, 2000);
  assert.equal(cfg.maxChars, 20000);
});

check("未知键与错类型被忽略，默认值兜底", () => {
  const cfg = normalizeConfig({ warm: "yes", maxChars: -1, nope: 1 });
  assert.equal(cfg.warm, DEFAULT_CONFIG.warm);
  assert.equal(cfg.maxChars, DEFAULT_CONFIG.maxChars);
  assert.ok(!("nope" in cfg));
});

check("两条段落总是注册：名称、顺序、interpolate 都正确", () => {
  const sections = buildSections(DEFAULT_CONFIG);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].name, SECTION_MAIN);
  assert.equal(sections[0].order, 20);
  assert.equal(sections[0].interpolate, false);
  assert.equal(sections[1].name, SECTION_TAIL);
  assert.equal(sections[1].order, 10201);
  assert.equal(sections[1].interpolate, false);
  assert.ok(sections[0].text().startsWith("## 你是谁"));
  assert.ok(sections[0].text().includes("展开说清"));
  assert.ok(!sections[0].text().includes("能一句说完就一句"), "旧的惜字如金规则应该已经移除");
  assert.ok(sections[1].text().includes("第一句给判断")); // 末尾回声 2026-10-24 换成抗漂移锚
});

check("text 是函数：改配置后同一个 section 立刻给出新文本（免重启的关键）", () => {
  const cfg = { humor: true };
  const [main] = buildSections(cfg);
  cfg.humor = false;
  assert.ok(main.text().includes("幽默："), "闭包应看到最新配置");
  const fresh = buildSections({ humor: false })[0];
  assert.ok(!fresh.text().includes("幽默："));
});

check("默认主段带反 AI 腔硬性清单", () => {
  const text = buildVoicePrompt(DEFAULT_CONFIG);
  assert.ok(text.includes("反 AI 腔"), "缺少反 AI 腔段");
  assert.ok(text.includes("在这个……的时代"), "缺少禁句示例");
  assert.ok(text.includes("三连排比"), "缺少结构禁令");
  assert.ok(!buildVoicePrompt({ antiSlop: false }).includes("反 AI 腔"), "开关关掉应移除");
});

check("末尾回声针对长上下文抗漂移", () => {
  const echo = buildTailEcho(DEFAULT_CONFIG);
  assert.ok(echo.includes("上下文越长"), "回声要针对长上下文");
  assert.ok(echo.includes("第一句给判断"), "回声保留正向指令");
});

check("回声是正向陈述，不含「不要/禁止」式否定", () => {
  const echo = buildTailEcho(DEFAULT_CONFIG);
  assert.ok(!/不要|禁止|严禁/.test(echo));
});

/* ---------------- 2. 持久化 ---------------- */

check("写覆盖 → 读回来 → 和基线合并，字段级生效", () => {
  writeStoredConfig({ warm: false, append: "叫我老周" });
  const stored = readStoredConfig();
  assert.equal(stored.warm, false);
  assert.equal(stored.append, "叫我老周");
  const effective = effectiveConfig({ rigor: true }, stored);
  assert.equal(effective.warm, false);
  assert.equal(effective.rigor, true);
  assert.ok(buildVoicePrompt(effective).includes("叫我老周"));
  clearStoredConfig();
  assert.deepEqual(readStoredConfig(), {});
});

/* ---------------- 3. 假 ctx 注册 ---------------- */

let routeHandler = null;
const appliedSections = [];
{
  const fakeWebServer = {
    register(options) {
      routeHandler = options.handler;
      return () => {};
    },
  };
  const ctx = {
    systemPrompt: { section: (section) => appliedSections.push(section) },
    get: (key) => (key === "webServer" ? fakeWebServer : undefined),
    effect: (fn) => fn(),
  };
  apply(ctx, { enabled: true });
  check("apply 注册三条段落（主段/样例/回声，空样例自动降级）并挂上 /huoren-voice/api 路由", () => {
    assert.equal(appliedSections.length, 3);
    assert.deepEqual(
      appliedSections.map((section) => section.name),
      [SECTION_MAIN, SECTION_SAMPLES, SECTION_TAIL]
    );
    assert.ok(typeof routeHandler === "function");
  });
}

check("webServer 未就绪时走 ctx.inject 等待，服务出现后再注册", () => {
  let injected = null;
  const ctx = {
    systemPrompt: { section: () => {} },
    get: () => undefined,
    inject: (deps, callback) => {
      injected = { deps, callback };
    },
  };
  apply(ctx, {});
  assert.deepEqual(injected.deps, ["webServer"], "应该声明等待 webServer");
  let registered = null;
  const fakeWebServer = { register: (options) => { registered = options; return () => {}; } };
  injected.callback({ webServer: fakeWebServer, effect: (fn) => fn() });
  assert.ok(registered, "服务出现后应该注册路由");
  assert.equal(registered.path, "/huoren-voice/api");
  assert.equal(registered.kind, "prefix");
});

check("apply 注册的 text 会读磁盘覆盖（设置页改完立刻生效）", () => {
  writeStoredConfig({ warm: false });
  const text = appliedSections[0].text();
  assert.ok(!text.includes("热情："), "磁盘覆盖里的 warm:false 应生效");
  assert.ok(text.includes("严谨："));
  clearStoredConfig();
  assert.ok(appliedSections[0].text().includes("热情："));
});

/* ---------------- 4. 路由 ---------------- */

function makeReq(opts = {}) {
  const body = opts.body;
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  req.method = opts.method ?? "GET";
  req.url = opts.url ?? "/huoren-voice/api/state";
  req.headers = opts.headers ?? {};
  req.socket = { remoteAddress: opts.remote ?? "127.0.0.1" };
  return req;
}

function makeRes() {
  const res = {
    code: 0,
    headers: null,
    body: "",
    writeHead(code, headers) {
      res.code = code;
      res.headers = headers;
    },
    end(chunk) {
      res.body = String(chunk ?? "");
    },
  };
  return res;
}

async function call(opts) {
  const res = makeRes();
  await routeHandler(makeReq(opts), res);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* 非 JSON 就不用 */
  }
  return { status: res.code, json };
}

await checkAsync("GET state 返回生效配置与正文", async () => {
  const out = await call({ method: "GET" });
  assert.equal(out.status, 200);
  assert.equal(out.json.ok, true);
  assert.ok(out.json.text.includes("## 你是谁"));
  assert.ok(out.json.storeFile.includes("config.json"));
});

await checkAsync("POST config 写盘后 state 立刻反映（不用重启）", async () => {
  const out = await call({ method: "POST", url: "/huoren-voice/api/config", body: JSON.stringify({ warmth: true }) });
  assert.equal(out.status, 200);
  const warm = await call({ method: "POST", url: "/huoren-voice/api/config", body: JSON.stringify({ warm: false }) });
  assert.equal(warm.status, 200);
  assert.equal(warm.json.config.warm, false);
  assert.ok(!warm.json.text.includes("热情："));
  const bad = await call({ method: "POST", url: "/huoren-voice/api/config", body: JSON.stringify({ warm: "yes", nope: 1 }) });
  assert.equal(bad.json.config.warm, false, "错类型不该写进去");
});

await checkAsync("POST reset 回到基线", async () => {
  const out = await call({ method: "POST", url: "/huoren-voice/api/reset", body: "{}" });
  assert.equal(out.status, 200);
  assert.deepEqual(readStoredConfig(), {});
  assert.equal(out.json.config.warm, true);
});

await checkAsync("跨站请求被拒 403", async () => {
  const out = await call({ method: "POST", url: "/huoren-voice/api/config", body: "{}", headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(out.status, 403);
});

await checkAsync("非回环来源被拒 403", async () => {
  const out = await call({ method: "GET", remote: "192.168.1.9" });
  assert.equal(out.status, 403);
});

await checkAsync("坏 JSON 400、未知路径 404", async () => {
  const bad = await call({ method: "POST", url: "/huoren-voice/api/config", body: "{not json" });
  assert.equal(bad.status, 400);
  const missing = await call({ method: "GET", url: "/huoren-voice/api/nope" });
  assert.equal(missing.status, 404);
});

rmSync(HOME, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 项`);
