// test/render.test.mjs — 自检客户端组件：伪造极简 React，把元素树真的走一遍
//
// DSH 的 Client 模块表在浏览器里提供 react，Node 侧没有；为一个自检查去装依赖不值。
// 这里用 h() 造同样的元素树再自己序列化，足以证明「不抛异常、结构完整、文案都在、顺序对」。
//
// 用法： node test/render.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.resolve(here, '..')

const FRAGMENT = Symbol('Fragment')
const React = {
  Fragment: FRAGMENT,
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
}

function render(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(render).join('')
  if (node.type === FRAGMENT) return node.children.map(render).join('')
  if (typeof node.type === 'function') return render(node.type(node.props))
  const attrs = Object.entries(node.props)
    .filter(([k]) => k !== 'children' && k !== 'key')
    .map(([k, v]) => (typeof v === 'string' ? ` ${k}="${v}"` : v === true ? ` ${k}` : ''))
    .join('')
  return `<${node.type}${attrs}>${node.children.map(render).join('')}</${node.type}>`
}

let mod = null
new Function('window', fs.readFileSync(path.join(dir, 'client.js'), 'utf8'))({
  __ModuleLoader__: { load: (m) => { mod = m } },
})

const failures = []
const check = (name, cond, extra = '') => {
  if (cond) console.log('  PASS  ' + name)
  else { failures.push(name); console.log('  FAIL  ' + name + '  ' + extra) }
}

check('模块 id 正确', mod && mod.id === '@local/dsh-workspace-map', mod && mod.id)

const api = mod.factory(() => React)
check('factory 返回 inject/apply', Array.isArray(api.inject) && typeof api.apply === 'function')

const regs = []
api.apply({
  slots: {
    inject: (name, fn) => fn(),
    register: (opts, component) => { regs.push({ opts, component }) },
  },
})

check('注册了两个槽位', regs.length === 2, regs.length + ' 个')
const pane = regs.find((r) => r.opts.name === 'sidebar.panellist')
const main = regs.find((r) => r.opts.name === 'main')

check('侧边栏用 sidebar.panellist', !!pane)
check('侧边栏 id 与 main 的 key 一致', pane && main && pane.opts.id === main.opts.key, pane && pane.opts.id)
check('侧边栏排在最前（order -1）', pane && pane.opts.order === -1)
check('侧边栏 label 正确', pane && pane.opts.label() === '工作区地图')
check('不再往设置页注册', !regs.some((r) => r.opts.name === 'settings.section'))

const glyph = render(React.createElement(pane.component, { size: 18, active: false }))
check('字形是自绘 SVG', glyph.includes('<svg') && glyph.includes('viewBox="0 0 24 24"'))
check('字形跟随主题色 currentColor', glyph.includes('currentColor'))
check('字形没有写死颜色', !/#[0-9a-fA-F]{6}/.test(glyph))

const html = render(React.createElement(main.component, {}))
check('面板渲染不抛异常', true)
check('含标题', html.includes('工作区地图'))
check('含工程坞与成品舱', html.includes('工程坞') && html.includes('成品舱'))
check('含文件数标注', /\d+\s?文件/.test(html))
check('含顶部统计条', html.includes('wm-stats') && html.includes('wm-stat-v'))
check('统计条有目录/文件/体积', html.includes('>目录<') && html.includes('>文件<') && html.includes('>体积<'))
check('目录是卡片网格', html.includes('wm-grid') && html.includes('wm-card'))
check('卡片有名字与说明', html.includes('wm-name') && html.includes('wm-note'))
check('分组目录用整行卡片 + 虚线子行', html.includes('wm-card-wide') && html.includes('wm-sub-row'))
check('样式走主题 token', html.includes('var(--dsw-alias-') && !html.includes('style="color:'))
check('无 [object Object]', !html.includes('[object Object]'))
check('无 undefined 漏串', !html.includes('undefined') && !html.includes('NaN'))
check('用了新名字 竣工/封存', html.includes('竣工') && html.includes('封存'))
check('没有旧名字 完工坞/封存坞', !html.includes('完工坞') && !html.includes('封存坞'))

// 顺序检查按"生成出来的数据"走，不写死目录名——目录会搬家，规则不该跟着改
// 文本节点两侧都是标签，所以把标签换成 \u0001 后，\u0001名字\u0001 就是一个独立的文本节点
const text = html.replace(/<[^>]+>/g, '\u0001')
const idx = (s) => text.indexOf('\u0001' + s + '\u0001')

const raw = fs.readFileSync(path.join(dir, 'client.js'), 'utf8')
const dataMatch = raw.match(/const DATA = (\{[\s\S]*?\n\});/)
let DATA = null
try { DATA = dataMatch ? JSON.parse(dataMatch[1]) : null } catch { DATA = null }
check('能读出生成的数据', DATA !== null && Array.isArray(DATA.zones))

if (DATA) {
  const items = DATA.zones.flatMap((z) => z.items)
  const rank = { live: 0, done: 1, sealed: 2 }
  // 每个舱位内部按"在用 → 竣工 → 封存"排；跨舱位不做比较
  const sorted = DATA.zones.every((z) => z.items.every((it, i) => i === 0 || rank[z.items[i - 1].state] <= rank[it.state]))
  check('排序：每个舱位内 在用 → 竣工 → 封存', sorted, DATA.zones.map((z) => z.items.map((i) => i.name + ':' + i.state).join(' ')).join(' | '))
  const done = items.find((i) => i.state === 'done')
  const sealed = items.find((i) => i.state === 'sealed')
  const live = items.find((i) => i.state === 'live')
  check('有在办/竣工/封存三类目录', !!live && !!done && !!sealed, [live && live.name, done && done.name, sealed && sealed.name].join('/'))
  if (live && done && sealed) {
    check('渲染顺序：在办在竣工之前', idx(live.name) < idx(done.name), idx(live.name) + ' vs ' + idx(done.name))
    check('渲染顺序：竣工在封存之前', idx(done.name) < idx(sealed.name), idx(done.name) + ' vs ' + idx(sealed.name))
  }
  // 统计里的目录数把 竣工/封存 的子目录也算进去
  const dirs = DATA.zones.reduce((n, z) => n + z.items.reduce((m, i) => m + 1 + (i.children ? i.children.length : 0), 0), 0) + DATA.others.length
  check('顶部统计与数据一致', String(DATA.summary.dirs) === String(dirs), DATA.summary.dirs + ' vs ' + dirs)
}

console.log('\n渲染结果（去标签，前 360 字）：')
console.log(text.replace(/\u0001/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 360))

if (failures.length) { console.log('\n失败 ' + failures.length + ' 项'); process.exit(1) }
console.log('\n渲染自检全部通过')
