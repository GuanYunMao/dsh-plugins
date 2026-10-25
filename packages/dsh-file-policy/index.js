// index.js — DSH Host 插件入口
// 拦截 write/edit 类工具，把落在工作区根的散件挡回去，并说明该放哪儿。
// 设计取舍（参照 dcg 的失败策略）：
//   · 给了 deny 就 deny
//   · 判定过程出任何异常 → 放行 + 记日志（误杀比漏放更贵）
//   · 有环境变量逃生舱
import { decide } from './policy.js'

export const inject = ['tools']

const DEFAULTS = {
  /** 工作区根目录绝对路径；空 = 不启用 */
  root: '',
  /** 根目录允许出现的文件名（大小写不敏感） */
  allow: ['README.md'],
  /** deny | ask | log —— log 只记录不拦 */
  onViolation: 'deny',
  /** 设为 1 时整条策略跳过 */
  bypassEnv: 'DSH_FILE_POLICY_BYPASS',
  /** 是否把每次判定打到 stderr */
  log: false,
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  if (!cfg.root) {
    console.warn('[file-policy] 未配置 root，插件不生效')
    return
  }
  if (cfg.log) console.warn(`[file-policy] 已启用，根目录=${cfg.root}，模式=${cfg.onViolation}`)

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const bypass = process.env[cfg.bypassEnv] === '1'
      const verdict = decide({
        tool: exec && exec.name,
        args: exec && exec.arguments,
        root: cfg.root,
        allow: cfg.allow,
        bypass,
      })

      if (verdict.deny) {
        if (cfg.log) console.warn(`[file-policy] 拦截 ${exec.name} -> ${verdict.path}`)
        if (cfg.onViolation === 'log') return next()
        if (cfg.onViolation === 'ask') {
          return {
            kind: 'ask',
            reason: verdict.reason,
            displayReason: {
              en: `Root-level file: ${verdict.path}. File it under 工程坞 / 成品舱 / 收件箱?`,
              zh: `根目录散件：${verdict.path}。要放进 工程坞 / 成品舱 / 收件箱 吗？`,
            },
          }
        }
        return { kind: 'deny', reason: verdict.reason }
      }
    } catch (err) {
      // 失败即放行
      console.warn('[file-policy] 判定异常，本次放行：' + (err && err.message ? err.message : String(err)))
    }
    return next()
  })
}
