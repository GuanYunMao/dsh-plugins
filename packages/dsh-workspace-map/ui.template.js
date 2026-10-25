/**
 * 工作区地图的渲染层（模板，不是能单独跑的模块）。
 *
 * build-map.mjs 把它整段拼进生成的 client.js，外层提供 React / h / DATA。
 * 这里只放声明、不放顶层 return，所以 `node --check` 能单独验语法。
 *
 * 设计取向：一张只读的"目录快照"。数据是白给的，所以界面别抢戏——
 * 标题一行、三个数字、按舱位分区、每个目录一张卡；状态只在竣工/封存时说话。
 */

const CSS = [
  '.wm-root{box-sizing:border-box;height:100%;overflow-y:auto;padding:26px 30px 44px;color:var(--dsw-alias-label-primary);-webkit-font-smoothing:antialiased}',
  '.wm-inner{max-width:960px;margin:0 auto}',
  '.wm-head{display:flex;align-items:flex-start;gap:10px}',
  '.wm-glyph{margin-top:1px;flex:none;color:var(--dsw-alias-label-secondary)}',
  '.wm-head-text{min-width:0}',
  '.wm-title{font-size:16px;font-weight:600;line-height:22px;letter-spacing:.01em}',
  '.wm-sub{margin-top:3px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
  '.wm-stats{display:flex;margin:20px 0 4px;padding-bottom:16px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
  '.wm-stat{display:flex;flex-direction:column;gap:3px;min-width:86px}',
  '.wm-stat + .wm-stat{padding-left:22px;border-left:1px solid var(--dsw-alias-border-l1)}',
  '.wm-stat-v{font-size:19px;font-weight:600;line-height:24px;font-variant-numeric:tabular-nums;letter-spacing:-.01em}',
  '.wm-stat-k{font-size:10.5px;line-height:14px;letter-spacing:.1em;color:var(--dsw-alias-label-secondary)}',
  '.wm-zone{margin-top:28px}',
  '.wm-zone-head{display:flex;align-items:baseline;gap:10px;margin-bottom:11px}',
  '.wm-zone-name{font-size:13px;font-weight:600;letter-spacing:.02em}',
  '.wm-zone-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
  '.wm-zone-count{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}',
  '.wm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(272px,1fr));gap:10px}',
  '.wm-card{box-sizing:border-box;display:flex;flex-direction:column;gap:8px;padding:12px 14px 13px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;transition:background-color .15s ease,border-color .15s ease}',
  '.wm-card:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2)}',
  '.wm-card-wide{grid-column:1 / -1}',
  '.wm-card-top{display:flex;align-items:center;gap:8px;min-width:0}',
  '.wm-name{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.wm-badge{flex:none;padding:1px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary)}',
  '.wm-badge-sealed{border-style:dashed}',
  '.wm-note{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
  '.wm-meta{font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;letter-spacing:.02em}',
  '.wm-sub{display:flex;flex-direction:column}',
  '.wm-sub-row{display:flex;align-items:baseline;gap:12px;padding:7px 0;border-top:1px dashed var(--dsw-alias-border-l1)}',
  '.wm-sub-name{flex:none;max-width:46%;font-size:12px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.wm-sub-note{flex:1;min-width:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.wm-sub-meta{flex:none;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
  '.wm-foot{margin-top:30px;padding-top:14px;border-top:1px dashed var(--dsw-alias-border-l1);font-size:10.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
  '@media (max-width:640px){.wm-root{padding:18px 16px 32px}.wm-grid{grid-template-columns:1fr}.wm-stat{min-width:72px}.wm-stat + .wm-stat{padding-left:16px}}',
].join('\n')

/** 状态徽章文案：在用不占用视觉，竣工/封存才说话。 */
const STATE_LABEL = { done: '竣工', sealed: '封存' }

/** 侧边栏那一格与面板头部共用的自绘字形（一个根节点分叉成两个舱位）。 */
function Glyph({ size = 18 }) {
  return h('svg', {
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': true, style: { display: 'block' },
  },
    h('path', { d: 'M12 3.2V7.2' }),
    h('path', { d: 'M4.6 7.2h14.8' }),
    h('path', { d: 'M4.6 7.2v3.4' }),
    h('path', { d: 'M19.4 7.2v3.4' }),
    h('rect', { x: 2.1, y: 10.6, width: 5, height: 5, rx: 1.4 }),
    h('rect', { x: 16.9, y: 10.6, width: 5, height: 5, rx: 1.4 })
  )
}

function fmtMb(mb) {
  const n = Number(mb) || 0
  if (n >= 1024) return (n / 1024).toFixed(1) + ' GB'
  // 整数就别拖 ".0"；小数保留一位（0.2 / 2.6 / 292）
  return (Number.isInteger(n) ? String(n) : n.toFixed(1)) + ' MB'
}

/** 「403 文件 · 219.5 MB」；空目录只写文件数，0 MB 不占地方。 */
function metaOf(item) {
  const files = Number(item.files) || 0
  const mb = Number(item.mb) || 0
  if (files === 0) return mb > 0 ? fmtMb(mb) : ''
  return files.toLocaleString() + ' 文件' + (mb > 0 ? ' · ' + fmtMb(mb) : '')
}

function Stat({ value, label }) {
  return h('div', { className: 'wm-stat' },
    h('div', { className: 'wm-stat-v' }, String(value)),
    h('div', { className: 'wm-stat-k' }, label)
  )
}

function Card({ item }) {
  const children = item.children || []
  const wide = children.length > 0
  // 名字本身就是"竣工/封存"的分组卡不再重复挂徽章
  const badge = STATE_LABEL[item.state] && STATE_LABEL[item.state] !== item.name ? STATE_LABEL[item.state] : ''
  return h('div', { className: 'wm-card' + (wide ? ' wm-card-wide' : '') },
    h('div', { className: 'wm-card-top' },
      h('span', { className: 'wm-name', title: item.name }, item.name),
      badge ? h('span', {
        className: 'wm-badge' + (item.state === 'sealed' ? ' wm-badge-sealed' : ''),
      }, badge) : null
    ),
    item.note ? h('div', { className: 'wm-note', title: item.note }, item.note) : null,
    !wide && metaOf(item) ? h('div', { className: 'wm-meta' }, metaOf(item)) : null,
    wide ? h('div', { className: 'wm-sub' }, children.map((child) => h('div', {
      className: 'wm-sub-row', key: child.name,
    },
      h('span', { className: 'wm-sub-name', title: child.name }, child.name),
      h('span', { className: 'wm-sub-note', title: child.note || '' }, child.note || ''),
      h('span', { className: 'wm-sub-meta' }, metaOf(child))
    ))) : null
  )
}

function Zone({ zone }) {
  return h('section', { className: 'wm-zone' },
    h('div', { className: 'wm-zone-head' },
      h('span', { className: 'wm-zone-name' }, zone.label),
      zone.hint ? h('span', { className: 'wm-zone-hint' }, zone.hint) : null,
      h('span', { className: 'wm-zone-count' }, zone.items.length + ' 个目录')
    ),
    h('div', { className: 'wm-grid' },
      zone.items.map((item) => h(Card, { key: item.name, item }))
    )
  )
}

function WorkspaceMap() {
  const s = DATA.summary || { dirs: 0, files: 0, mb: 0 }
  return h('div', { className: 'wm-root' },
    h('style', null, CSS),
    h('div', { className: 'wm-inner' },
      h('div', { className: 'wm-head' },
        h('span', { className: 'wm-glyph' }, h(Glyph, { size: 18 })),
        h('div', { className: 'wm-head-text' },
          h('div', { className: 'wm-title' }, '工作区地图'),
          h('div', { className: 'wm-sub' }, '生成于 ' + DATA.generatedAt + ' · 每次重启自动重扫 · 只读快照')
        )
      ),
      h('div', { className: 'wm-stats' },
        h(Stat, { value: s.dirs, label: '目录' }),
        h(Stat, { value: s.files.toLocaleString(), label: '文件' }),
        h(Stat, { value: fmtMb(s.mb), label: '体积' })
      ),
      DATA.zones.map((zone) => h(Zone, { key: zone.key, zone })),
      h(Zone, {
        key: 'others',
        zone: { key: 'others', label: '其它', hint: '收件箱、归档、维护台账', items: DATA.others || [] },
      }),
      h('div', { className: 'wm-foot' },
        '根目录只允许 README.md 和这些目录。想立刻刷新：node build-map.mjs 后刷新页面。'
      )
    )
  )
}
