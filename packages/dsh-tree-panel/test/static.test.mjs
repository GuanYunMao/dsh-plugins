// dsh-tree-panel 静态回归：父子互指/自指必须被守卫，否则整块面板静默失效
// 这个插件是纯 Client 半，沙箱里没有 DOM/React，所以只能对"守卫代码"上锁；真机行为要手点。
import { assertSourceHas, run } from '../../_testkit/testkit.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const client = join(here, '..', 'lib', 'client.js')

await run('dsh-tree-panel 守卫', [
  ['环处理时把节点从旧父的 children 里摘掉', async () => {
    assertSourceHas(client, [['sibs.splice(atSib, 1)', '不摘边的话 self-parent / A↔B 仍成环']])
  }],
  ['assignLanes 有已访问守卫与深度上限', async () => {
    assertSourceHas(client, [['laned.has(id)', '没有守卫会 A→B→A 无限递归'], ['lane > 4096', '超深链兜底']])
  }],
  ['buildBranch 有已访问守卫', async () => {
    assertSourceHas(client, [['builtBranches.has(id)', 'buildBranch 也会沿 children 递归']])
  }],
])

// v2 外观（2026-10-24）：只压密度 + 缩略图，旧外观默认
await run('dsh-tree-panel v2 外观', [
  ['v2 开关只在 ?ui=v2 时生效', async () => {
    assertSourceHas(client, [['var UI2 = (function ()', '没有开关就没法对比/回退'], ['(?:ui|treeui)=v1', '默认 v2，v1 回退'], ['return true;', '默认必须是开']])
  }],
  ['缩略图组件与挂载点都在', async () => {
    assertSourceHas(client, [['function TreeMap(props)', '缩略图组件'], ['react_jsx_runtime.jsx(TreeMap, {', '没有被挂进 GraphView']])
  }],
  ['搜索防抖：输入不受控 + 150ms 后才重算', async () => {
    assertSourceHas(client, [['queryDraft', '草稿变量'], ['defaultValue: props.query', '输入框必须不受控，否则会抖'], ['searchTimer', '防抖计时器']])
  }],
  ['fork 猴补丁可还原', async () => {
    assertSourceHas(client, [['__treePanelForkPatch', '没记录补丁就还原不了'], ['clearInterval(__activeTimer)', 'dispose 已接管清理']])
  }],
  ['缩略图用 fixed 坐标，不跟着滚', async () => {
    assertSourceHas(client, [['.dsh-tree-map{position:fixed', '绝对定位会随内容滚走'], ['getBoundingClientRect()', '按视口算坐标']])
  }],
])