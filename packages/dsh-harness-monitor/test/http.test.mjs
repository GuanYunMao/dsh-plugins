// dsh-harness-monitor 的 HTTP 守卫测试：跨源必须被拒、预检不回 *、body 有上限
// 跑法： node test/http.test.mjs
// 只测"守卫"分支（403/413）——它们在任何 IO 之前就返回；真正 kill 要 PowerShell，沙箱里不测。
import assert from 'node:assert/strict'
import host from '../lib/index.js'
import { makeCtx, callRoute, run } from '../../_testkit/testkit.mjs'

const makeRoute = () => {
  const { ctx, captures } = makeCtx()
  host.apply(ctx, {})
  const route = captures.routes[0]
  assert.ok(route && typeof route.handler === 'function', '应注册一个前缀路由')
  return route
}

await run('dsh-harness-monitor HTTP 守卫', [
  ['跨源 OPTIONS 被拒（403）', async () => {
    const route = makeRoute()
    const res = await callRoute(route, {
      method: 'OPTIONS',
      url: '/harness-monitor/api/kill',
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
    })
    assert.equal(res.status, 403)
    assert.equal(res.json.ok, false)
  }],

  ['同站 OPTIONS 通过，且回的是具体 origin 而不是 *', async () => {
    const route = makeRoute()
    const origin = 'http://127.0.0.1:3081'
    const res = await callRoute(route, {
      method: 'OPTIONS',
      url: '/harness-monitor/api/kill',
      headers: { 'sec-fetch-site': 'same-site', origin },
    })
    assert.equal(res.status, 204)
    assert.equal(res.headers['access-control-allow-origin'], origin)
    assert.notEqual(res.headers['access-control-allow-origin'], '*')
  }],

  ['跨源 POST /kill 被拒，且在读 body 之前就返回', async () => {
    const route = makeRoute()
    const res = await callRoute(route, {
      method: 'POST',
      url: '/harness-monitor/api/kill',
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{"pids":[123],"kind":"background","confirm":true}',
    })
    assert.equal(res.status, 403)
  }],

  ['同源 POST /kill 的请求体有 64KB 上限', async () => {
    const route = makeRoute()
    const big = '{"pids":[123],"padding":"' + 'x'.repeat(70 * 1024) + '"}'
    const res = await callRoute(route, {
      method: 'POST',
      url: '/harness-monitor/api/kill',
      headers: { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', 'content-type': 'application/json' },
      body: big,
    })
    assert.equal(res.status, 413)
  }],

  ['whoami 对跨源不给 CORS 头', async () => {
    const route = makeRoute()
    const res = await callRoute(route, {
      method: 'GET',
      url: '/harness-monitor/api/whoami',
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers['access-control-allow-origin'], undefined)
  }],
])
