// policy.js — 纯函数策略：判断一次文件写是否落在工作区根
// 不依赖任何 DSH API，可以单独跑测试（见 test/policy.test.mjs）
import path from 'node:path'

/** 会写文件的工具名（小写比较）。名单之外的一律放行。 */
export const FILE_TOOLS = new Set([
  'write',
  'edit',
  'multi_edit',
  'apply_patch',
  'create_file',
  'str_replace_editor',
])

const PATH_KEYS = ['file_path', 'filePath', 'path', 'target_file', 'filename'];

/**
 * 从各种工具参数里取出所有目标路径。
 * 只认平铺标量会漏掉 multi_edit（edits:[{file_path}]）和 files[]/paths[] 这类嵌套写法——
 * 实测旧版对 multi_edit 直接放行，等于给根目录开了一个后门。
 */
export function pickPaths(args) {
  const out = []
  if (!args || typeof args !== 'object') return out
  const push = (v) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim())
  }
  for (const key of PATH_KEYS) push(args[key])
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (!edit || typeof edit !== 'object') continue
      for (const key of PATH_KEYS) push(edit[key])
    }
  }
  for (const key of ['files', 'paths', 'targets']) {
    if (Array.isArray(args[key])) for (const v of args[key]) push(v)
  }
  return [...new Set(out)]
}

/** 兼容旧调用：取第一条。 */
export function pickPath(args) {
  return pickPaths(args)[0] || ''
}

/**
 * 去掉 Windows 扩展长度/设备前缀。
 * `\\?\D:\x` 与 `\\.\D:\x` 等价于 `D:\x`；`\\?\UNC\server\share\x` 等价于 `\\server\share\x`。
 * 不先剥掉的话 path.relative 会把 `\\?\...` 当成另一条绝对路径，判定直接漏过去。
 */
export function stripExtendedPrefix(raw) {
  const s = String(raw || '')
  if (/^\\\\\?\\UNC\\/i.test(s)) return '\\\\' + s.slice(8)
  if (/^\\\\[?.]\\/.test(s)) return s.slice(4)
  return s
}

export function buildReason(relPath) {
  return [
    `根目录不放散件：${relPath}`,
    '',
    '往哪放：',
    '  · 脚本/工程 → 工程坞\\NN-域\\工程名\\',
    '  · 报告/成品 → 成品舱\\NN-主题\\',
    '  · 拿不准   → 收件箱\\',
    '',
    '根目录只允许 README.md（以及工程坞/成品舱/收件箱/_归档/_维护 这几个目录）。',
    '确实要绕过：设置环境变量 DSH_FILE_POLICY_BYPASS=1 后重试。',
  ].join('\n')
}

/**
 * @returns {{deny: false} | {deny: true, path: string, reason: string}}
 */
export function decide({ tool, args, root, allow = [], bypass = false }) {
  // 失败即放行的第一层：没配置根目录就不管事
  if (bypass || !root) return { deny: false }
  if (!FILE_TOOLS.has(String(tool || '').toLowerCase())) return { deny: false }

  const raws = pickPaths(args).map(stripExtendedPrefix).filter(Boolean)
  if (raws.length === 0) return { deny: false }

  const allowList = Array.isArray(allow) ? allow : []
  for (const raw of raws) {
    const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw)
    const rel = path.relative(root, abs)

    // 工作区之外、或就是工作区根本身：不归本插件管
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue

    const parts = rel.split(/[\\/]+/).filter(Boolean)
    if (parts.length !== 1) continue // 落在子目录里，合规

    const name = parts[0]
    if (allowList.some((a) => String(a).toLowerCase() === name.toLowerCase())) continue

    return { deny: true, path: rel, reason: buildReason(rel) }
  }
  return { deny: false }
}
