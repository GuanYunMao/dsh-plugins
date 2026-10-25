/**
 * Host half of the workspace-map bundle.
 *
 * 渲染全在 Client 模块（client.js）里；Host 只做一件事：**开机时重扫一遍工作区**，
 * 重新生成 client.js，于是“重启一次就同步”，不用记得手动跑 build-map.mjs。
 *
 * 生成失败不抛：沿用上一次的 client.js，把原因打到 stderr。
 */
import { buildMap, setRoot } from './build-map.mjs'

export function apply(ctx, config) {
  try { setRoot(config && config.root); } catch {}

  try {
    const r = buildMap()
    console.log(
      '[workspace-map] 开机重建地图：' + r.count + ' 条目，生成于 ' + r.generatedAt +
      '；工程坞顺序 ' + r.order.join(' → ')
    )
  } catch (err) {
    console.warn('[workspace-map] 重建失败，沿用上次生成的 client.js：' + (err && err.message ? err.message : String(err)))
  }
}
