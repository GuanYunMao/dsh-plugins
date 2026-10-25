// client.js — 由 build-map.mjs 生成，别手改。
// 改界面：改 ui.template.js；改一句话说明：改 build-map.mjs 里的 NOTES；然后重跑 node build-map.mjs。
window.__ModuleLoader__.load({
  id: '@local/dsh-workspace-map',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const DATA = {
  "generatedAt": "2026-10-25 15:31",
  "root": "D:\\DSH Desktop\\Harness work",
  "summary": {
    "dirs": 21,
    "files": 18333,
    "mb": 1212.2
  },
  "zones": [
    {
      "key": "工程坞",
      "label": "工程坞",
      "hint": "手段：脚本、工具、工程",
      "items": [
        {
          "name": "01-DSH插件",
          "note": "插件工程：dsh-rea、dsh-auto-restart、dsh-ar、plugins、tp-p0 + 部署脚本 + 插件档案 + 三个自研插件",
          "state": "live",
          "files": 421,
          "mb": 2.9
        },
        {
          "name": "02-逆向调查",
          "note": "逆向与调查工程：scriptcat-re（知行脚本）、calib（审查流水线校准夹具）",
          "state": "live",
          "files": 137,
          "mb": 13.4
        },
        {
          "name": "03-前端与游戏",
          "note": "前端应用：xinggui（星轨，含 node_modules）、grok-game（星轨的源工作区）",
          "state": "live",
          "files": 16412,
          "mb": 635.9
        },
        {
          "name": "04-本机运维",
          "note": "本机维护：工具集（D 盘整理、DiskKeeper）、回滚清单（豆包输入法、手机远程还原步骤）",
          "state": "live",
          "files": 45,
          "mb": 0.2
        },
        {
          "name": "竣工",
          "note": "活干完了、工具留着备查（产物已进成品舱）",
          "state": "done",
          "files": 0,
          "mb": 0,
          "children": [
            {
              "name": "02-pcl-invest",
              "note": "PCL「MC 下载封印」调查报告 + 解锁补丁（已交付离线版）",
              "state": "live",
              "files": 340,
              "mb": 248.8
            },
            {
              "name": "03-pcl-theme-switch",
              "note": "PCL 主题切换的 4 个脚本（星空蓝 / 玄素黑）",
              "state": "live",
              "files": 4,
              "mb": 0
            },
            {
              "name": "05-远程修机",
              "note": "荣耀本那次：11 个诊断/修复脚本 + 状态交接单 + 图标素材（未验收）",
              "state": "live",
              "files": 24,
              "mb": 0.1
            },
            {
              "name": "06-供应链核查",
              "note": "10-21 供应链自查的扫描脚本 + 修 Node 的一键脚本",
              "state": "live",
              "files": 5,
              "mb": 0.1
            }
          ]
        },
        {
          "name": "封存",
          "note": "被取代/过期/放弃，只留证据",
          "state": "sealed",
          "files": 0,
          "mb": 0,
          "children": [
            {
              "name": "01-旧镜像",
              "note": "7 个过期插件副本 + codemate + synapse-src，勿反向部署",
              "state": "live",
              "files": 62,
              "mb": 2.2
            },
            {
              "name": "02-rea-web-case",
              "note": "REA 网页测试输入数据（旧 README 标\"可弃\"）",
              "state": "live",
              "files": 4,
              "mb": 2.6
            }
          ]
        }
      ]
    },
    {
      "key": "成品舱",
      "label": "成品舱",
      "hint": "产出：报告、文档、成品包",
      "items": [
        {
          "name": "01-信息检索实验报告",
          "note": "《信息检索》实验报告：docx + 11 张截图 + 数据",
          "state": "live",
          "files": 403,
          "mb": 219.5
        },
        {
          "name": "02-外联部招新",
          "note": "公众号招新推文（秀米版 v3）",
          "state": "live",
          "files": 83,
          "mb": 6
        },
        {
          "name": "03-供应链核查报告",
          "note": "10-21 深夜四份：泄露核查 / 漏洞逐条 / 修复记录 / net-guard 诊断",
          "state": "live",
          "files": 4,
          "mb": 0
        },
        {
          "name": "04-OneStep诊断报告",
          "note": "OneStep 工具流诊断 + 审查方案",
          "state": "live",
          "files": 2,
          "mb": 0
        },
        {
          "name": "05-DSH方案报告",
          "note": "手机远程控制的 分析与建议 + 最终方案",
          "state": "live",
          "files": 2,
          "mb": 0
        },
        {
          "name": "06-远程修机报告",
          "note": "那 11 个脚本跑出来的体检报告",
          "state": "live",
          "files": 1,
          "mb": 0
        }
      ]
    }
  ],
  "others": [
    {
      "name": "收件箱",
      "note": "唯一允许\"暂时不知道放哪\"的地方",
      "state": "live",
      "files": 1,
      "mb": 0
    },
    {
      "name": "_归档",
      "note": "被取代的旧版本、旧产物（6 个批次）",
      "state": "live",
      "files": 365,
      "mb": 80.3
    },
    {
      "name": "_维护",
      "note": "规矩、体检脚本、整理记录、搬移台账与回滚脚本",
      "state": "live",
      "files": 18,
      "mb": 0.2
    }
  ]
};
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

    return {
      inject: ['slots'],
      apply(ctx) {
        // 侧边栏那一格：字形由本组件自己画，order -1 排在最前
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'workspace-map',
          order: -1,
          label: () => '工作区地图',
        }, Glyph));
        // 点开后占满主区域
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'workspace-map',
        }, WorkspaceMap));
      },
    };
  },
});
