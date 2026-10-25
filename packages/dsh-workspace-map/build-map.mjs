// build-map.mjs — 扫描工作区目录，生成 client.js（侧边栏字形 + 主面板内容）
//
// 两种用法：
//   1) 命令行手动跑：node build-map.mjs
//   2) 被 index.js 在 DSH 启动时调用 —— 每次重启自动同步一张新图
//
// 分工：
//   · 这个文件只负责"扫 + 算 + 拼"：目录、说明、文件数、体积、状态。
//   · 界面在 ui.template.js 里，被整段拼进 client.js；改长相只改那一个文件。
//   · client.js 仍是单文件（Client 模块只能整块注册），但已经是生成的产物，别手改。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 默认根目录；发布版不要写死个人路径——优先 config.root，其次环境变量，最后才是这个默认值。 */
const DEFAULT_ROOT = process.cwd()
let ROOT = process.env.DSH_WORKSPACE_MAP_ROOT || DEFAULT_ROOT

/** Host 侧 apply 时用 patch 里的 config.root 覆盖（发布用）。 */
export function setRoot(root) {
  if (typeof root === 'string' && root.trim()) ROOT = root.trim()
}
const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, 'client.js')
const UI = path.join(HERE, 'ui.template.js')

/** 一句话说明：目录名 → 它是干什么的。加新目录时补一行，不补就留空。 */
const NOTES = {
  '01-DSH插件': '插件工程：dsh-rea、dsh-auto-restart、dsh-ar、plugins、tp-p0 + 部署脚本 + 插件档案 + 三个自研插件',
  '02-逆向调查': '逆向与调查工程：scriptcat-re（知行脚本）、calib（审查流水线校准夹具）',
  '03-前端与游戏': '前端应用：xinggui（星轨，含 node_modules）、grok-game（星轨的源工作区）',
  '04-本机运维': '本机维护：工具集（D 盘整理、DiskKeeper）、回滚清单（豆包输入法、手机远程还原步骤）',
  '05-远程修机': '荣耀本那次：11 个诊断/修复脚本 + 状态交接单 + 图标素材（未验收）',
  '竣工': '活干完了、工具留着备查（产物已进成品舱）',
  '封存': '被取代/过期/放弃，只留证据',
  '02-pcl-invest': 'PCL「MC 下载封印」调查报告 + 解锁补丁（已交付离线版）',
  '03-pcl-theme-switch': 'PCL 主题切换的 4 个脚本（星空蓝 / 玄素黑）',
  '06-供应链核查': '10-21 供应链自查的扫描脚本 + 修 Node 的一键脚本',
  '01-旧镜像': '7 个过期插件副本 + codemate + synapse-src，勿反向部署',
  '02-rea-web-case': 'REA 网页测试输入数据（旧 README 标"可弃"）',
  '01-信息检索实验报告': '《信息检索》实验报告：docx + 11 张截图 + 数据',
  '02-外联部招新': '公众号招新推文（秀米版 v3）',
  '03-供应链核查报告': '10-21 深夜四份：泄露核查 / 漏洞逐条 / 修复记录 / net-guard 诊断',
  '04-OneStep诊断报告': 'OneStep 工具流诊断 + 审查方案',
  '05-DSH方案报告': '手机远程控制的 分析与建议 + 最终方案',
  '06-远程修机报告': '那 11 个脚本跑出来的体检报告',
  '收件箱': '唯一允许"暂时不知道放哪"的地方',
  '_归档': '被取代的旧版本、旧产物（6 个批次）',
  '_维护': '规矩、体检脚本、整理记录、搬移台账与回滚脚本'
}

/** 状态层：目录名 → 状态。只有终态才有状态，在用的编号目录默认 live */
const STATE_DIRS = { '竣工': 'done', '封存': 'sealed' }
const STATE_ORDER = { live: 0, done: 1, sealed: 2 }

const ZONES = [
  { key: '工程坞', label: '工程坞', hint: '手段：脚本、工具、工程' },
  { key: '成品舱', label: '成品舱', hint: '产出：报告、文档、成品包' }
]
const OTHER = ['收件箱', '_归档', '_维护']
const OTHERS_META = { label: '其它', hint: '收件箱、归档、维护台账' }

function sortKey(name, state) {
  const m = /^(\d+)/.exec(name)
  return [STATE_ORDER[state] ?? 0, m ? Number(m[1]) : 999, name]
}
const cmp = (a, b) => {
  const ka = sortKey(a.name, a.state)
  const kb = sortKey(b.name, b.state)
  return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2], 'zh')
}

function measure(dir) {
  let files = 0
  let bytes = 0
  const walk = (d) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else { files++; try { bytes += fs.statSync(p).size } catch {} }
    }
  }
  walk(dir)
  return { files, mb: Math.round((bytes / 1048576) * 10) / 10 }
}

function makeNode(name, abs, state) {
  const item = { name, note: NOTES[name] || '', state: state || 'live' }
  const st = measure(abs)
  item.files = st.files
  item.mb = st.mb
  if (STATE_DIRS[name]) {
    // 竣工/封存是"分组目录"：自己的数字清零，改列子目录
    item.children = listDirs(abs).sort(cmp)
    item.files = 0
    item.mb = 0
  }
  return item
}

function listDirs(dir) {
  let subs = []
  try { subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return [] }
  return subs.map((n) => makeNode(n, path.join(dir, n), STATE_DIRS[n] || 'live'))
}

/** 顶部三个数字：目录数、文件数、总体积（子目录算进去，父分组不重复计数）。 */
function summarize(zones, others) {
  let dirs = 0
  let files = 0
  let mb = 0
  const walk = (items) => {
    for (const item of items) {
      dirs++
      const children = item.children || []
      if (children.length > 0) walk(children)
      else {
        files += Number(item.files) || 0
        mb += Number(item.mb) || 0
      }
    }
  }
  for (const zone of zones) walk(zone.items)
  walk(others)
  return { dirs, files, mb: Math.round(mb * 10) / 10 }
}

const pad = (n) => String(n).padStart(2, '0')

const HEADER = (model) => [
  '// client.js — 由 build-map.mjs 生成，别手改。',
  '// 改界面：改 ui.template.js；改一句话说明：改 build-map.mjs 里的 NOTES；然后重跑 node build-map.mjs。',
  'window.__ModuleLoader__.load({',
  "  id: '@local/dsh-workspace-map',",
  '  factory(require) {',
  "    const React = require('react');",
  '    const h = React.createElement;',
  '    const DATA = ' + JSON.stringify(model, null, 2) + ';',
  '',
].join('\n')

const FOOTER = [
  '',
  '    return {',
  "      inject: ['slots'],",
  '      apply(ctx) {',
  '        // 侧边栏那一格：字形由本组件自己画，order -1 排在最前',
  "        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({",
  "          name: 'sidebar.panellist',",
  "          id: 'workspace-map',",
  '          order: -1,',
  "          label: () => '工作区地图',",
  '        }, Glyph));',
  '        // 点开后占满主区域',
  "        ctx.slots.inject('main', () => ctx.slots.register({",
  "          name: 'main',",
  "          key: 'workspace-map',",
  '        }, WorkspaceMap));',
  '      },',
  '    };',
  '  },',
  '});',
  '',
].join('\n')

/** 扫一遍目录，重写 client.js，返回统计。开机时也会调一次。 */
export function buildMap() {
  // 根目录不在 / 扫出来是空的，就宁可报错让 index.js 保留上一张好图：
  // 以前这里会无条件写盘，一次权限问题就把地图换成空图，还不报错。
  if (!fs.existsSync(ROOT)) throw new Error('工作区根不存在：' + ROOT)
  const now = new Date()
  const generatedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`

  const zones = ZONES.map((z) => ({ ...z, items: listDirs(path.join(ROOT, z.key)).sort(cmp) }))
  const others = OTHER.map((n) => makeNode(n, path.join(ROOT, n), 'live'))
  const ui = fs.readFileSync(UI, 'utf8')
  const model = {
    generatedAt,
    root: ROOT,
    summary: summarize(zones, others),
    zones,
    others
  }

  const total = zones.reduce((n, z) => n + z.items.length, 0) + others.length
  if (total === 0) throw new Error('扫到 0 个目录，拒绝用空图覆盖上一张')
  // 原子写：不让"写一半被杀"的半截 bundle 被下一次启动读到
  const tmpOut = OUT + '.tmp'
  fs.writeFileSync(tmpOut, HEADER(model) + ui.trim() + '\n' + FOOTER, 'utf8')
  fs.renameSync(tmpOut, OUT)
  const count = zones.reduce((n, z) => n + z.items.length + z.items.reduce((m, i) => m + (i.children ? i.children.length : 0), 0), 0) + others.length
  return { count, generatedAt, order: zones[0].items.map((i) => i.name) }
}

// 命令行直接跑时输出摘要；被 index.js import 时只导出函数
if (process.argv[1] && path.basename(process.argv[1]) === 'build-map.mjs') {
  const r = buildMap()
  console.log('已写 client.js：' + OUT)
  console.log('条目 ' + r.count + ' 条，生成于 ' + r.generatedAt)
  console.log('工程坞顺序：' + r.order.join(' → '))
}
