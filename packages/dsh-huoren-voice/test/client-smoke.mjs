/**
 * client 冒烟：把 lib/client.js 装进一个极简的"假浏览器"，验证
 * 1) ModuleLoader 协议（id / factory / exports）
 * 2) 注册的 settings.section 名称、id、order、label 正确
 * 3) 组件先渲染 loading，再在假 fetch 返回后渲染出完整开关面板
 *    （能抓「h() 吞掉 children」这类回归）
 *
 * 不依赖 react：用最小 shim 只覆盖组件用到的 Hook。
 * 真实浏览器里的完整交互（点击保存）靠装好后手点。
 *
 * 跑法：node test/client-smoke.mjs
 */
import assert from "node:assert/strict";

/* ---------------- 假浏览器 + 假 fetch ---------------- */
let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(options) {
      captured = options;
    },
  },
};
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: "" }),
  head: { appendChild: () => {} },
};

const CONFIG = {
  enabled: true,
  warm: true,
  rigor: true,
  wild: true,
  humor: true,
  rhythm: true,
  concrete: true,
  forbidTable: true,
  emoji: false,
  tailEcho: true,
  examples: true,
  samples: "",
  append: "",
  maxChars: 4000,
};
const SNAPSHOT = {
  ok: true,
  config: CONFIG,
  text: "## 你是谁\n热情：…",
  tail: "记住你是个有口味的人：…",
  storeFile: "C:\\Users\\x\\.dsh\\storages\\dsh-huoren-voice\\config.json",
};
globalThis.fetch = () =>
  Promise.resolve({ ok: true, json: async () => SNAPSHOT, text: async () => "" });

await import("../lib/client.js");
assert.ok(captured, "client.js 应该调用 window.__ModuleLoader__.load");
assert.equal(captured.id, "dsh-huoren-voice", "loader id 必须等于包名");

/* ---------------- 最小 React / jsx-runtime（带状态重渲染） ---------------- */
const hooks = [];
let cursor = 0;
let pendingEffects = [];
let ranEffects = false;
let dirty = false;

const React = {
  useState(initial) {
    const index = cursor++;
    if (!(index in hooks)) hooks[index] = initial;
    return [
      hooks[index],
      (value) => {
        hooks[index] = typeof value === "function" ? value(hooks[index]) : value;
        dirty = true;
      },
    ];
  },
  useRef(initial) {
    const index = cursor++;
    if (!(index in hooks)) hooks[index] = { current: initial };
    return hooks[index];
  },
  useEffect(fn) {
    if (!ranEffects) pendingEffects.push(fn);
  },
  createElement: (type, props) => ({ type, props: props ?? {} }),
};
const jsxRuntime = { jsx: (type, props) => ({ type, props: props ?? {} }) };
const require = (name) => {
  if (name === "react") return React;
  if (name === "react/jsx-runtime") return jsxRuntime;
  throw new Error(`unexpected require: ${name}`);
};

const mod = captured.factory(require);
assert.equal(mod.inject?.[0], "slots");

/* ---------------- 注册 ---------------- */
let registered = null;
const fakeCtx = {
  slots: {
    inject(name, factory) {
      assert.equal(name, "settings.section");
      registered = { name, ...factory() };
    },
    register(options, component) {
      return { options, component };
    },
  },
};
mod.apply(fakeCtx);
assert.ok(registered, "应该注册 settings.section");
assert.equal(registered.name, "settings.section");
assert.equal(registered.options.id, "huoren-voice");
assert.equal(registered.options.order, 65); // 与 lib/client.js 的注册值一致（此前写 60，长期红着也没人发现）
assert.equal(registered.options.label, "声线");
assert.equal(typeof registered.component, "function");

/* ---------------- 渲染 ---------------- */
function textOf(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node.type === "function") return textOf(node.type(node.props));
  return textOf(node.props?.children);
}

function renderOnce() {
  cursor = 0;
  dirty = false;
  const tree = React.createElement(registered.component, {});
  const text = textOf(tree);
  ranEffects = true;
  const effects = pendingEffects.splice(0);
  for (const fn of effects) fn();
  return text;
}

const loading = renderOnce();
assert.ok(loading.includes("声线设置正在加载"), `loading 态不对：${loading.slice(0, 120)}`);

// 让 effect 里的 fetch().then(setState) 走完，再渲染一次
await new Promise((resolve) => setTimeout(resolve, 0));
assert.ok(dirty, "假 fetch 返回后组件应该触发重渲染");

const loaded = renderOnce();
for (const needle of [
  "总开关",
  "热情",
  "严谨",
  "天马行空",
  "幽默",
  "节奏",
  "替换表",
  "末尾回声",
  "例句",
  "追加你自己的话",
  "你喜欢的句子",
  "恢复基线",
  "config.json",
]) {
  assert.ok(loaded.includes(needle), `渲染结果缺少「${needle}」，实际：${loaded.slice(0, 240)}`);
}
assert.ok(loaded.includes("看模型实际读到的正文"), "预览区没渲染");
assert.ok(!loaded.includes("[object Object]"), "children 没被正确展开");

console.log("client 冒烟通过：协议 / 注册 / loading→loaded 渲染 都正常");
