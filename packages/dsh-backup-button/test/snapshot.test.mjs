// test/snapshot.test.mjs — 临时 DSH_HOME 真跑 host 半，不碰真实配置
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const plugin = (await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'index.js')).href)).default
const SNAP = (home) => join(home, 'backups', 'snapshots')
const RUNTIME_NAME = /^\d{8}-\d{6}-p\d+$/

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-backup-test-'))
  const files = {
    'profiles/web/cordis.patch.yml': 'web: 1\n',
    'profiles/web/package.json': '{"name":"web-profile"}',
    'profiles/web/pnpm-workspace.yaml': 'packages: []\n',
    'profiles/web/pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'profiles/dev/cordis.patch.yml': 'dev: 1\n',
    'profiles/dev/package.json': '{"name":"dev-profile"}',
    'cordis.patch.yml': 'root: 1\n',
    'settings.yaml': 'k: v\n',
    '.credentials.yaml': 'DEEPSEEK_API_KEY: test-value-not-a-key\n',
  }
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(home, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body)
  }
  return home
}

function makeCtx() {
  const sink = {}
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) { const d = fn(); return () => { try { d && d() } catch {} } },
    webServer: { register(route) { sink.route = route; return () => {} } },
  }
  return { ctx, sink }
}

async function call(route, pathname) {
  const res = {
    status: 0,
    body: null,
    writeHead(status) { this.status = status },
    end(chunk) { this.body = JSON.parse(String(chunk)) },
  }
  await route.handler({ method: 'GET', url: pathname }, res)
  return res
}

const stampDirs = (home) => readdirSync(SNAP(home)).filter((n) => RUNTIME_NAME.test(n)).sort()

// 1) 启动快照：不含凭据
{
  const home = makeHome()
  const { ctx } = makeCtx()
  plugin.apply(ctx, { home, profile: 'web' })
  const dirs = stampDirs(home)
  assert.equal(dirs.length, 1, 'boot 应产生一份快照')
  assert.ok(existsSync(join(SNAP(home), dirs[0], 'settings.yaml')), '配置应在快照里')
  assert.ok(!existsSync(join(SNAP(home), dirs[0], 'credentials.yaml')), 'boot 快照不得包含凭据')
  rmSync(home, { recursive: true, force: true })
}

// 2) 手动快照默认不含凭据；开关打开后才含
{
  const home = makeHome()
  const { ctx, sink } = makeCtx()
  plugin.apply(ctx, { home, profile: 'web' })
  const r = await call(sink.route, '/backup/api/backup')
  assert.equal(r.status, 200)
  assert.equal(typeof r.body.credentials, 'string')
  assert.ok(r.body.credentials.startsWith('excluded'), '默认响应应标注凭据被排除：' + r.body.credentials)
  assert.ok(!existsSync(join(SNAP(home), r.body.dir, 'credentials.yaml')), '手动快照默认不得包含凭据')
  rmSync(home, { recursive: true, force: true })
}
{
  const home = makeHome()
  const { ctx, sink } = makeCtx()
  plugin.apply(ctx, { home, profile: 'web', includeCredentials: true })
  const r = await call(sink.route, '/backup/api/backup')
  assert.equal(r.body.credentials, 'included')
  assert.ok(existsSync(join(SNAP(home), r.body.dir, 'credentials.yaml')), '开关打开后才可包含凭据')
  rmSync(home, { recursive: true, force: true })
}

// 3) 列表端点可达（v2 之前它挂在 /snapshot/api/list，前缀对不上，永远 404）
{
  const home = makeHome()
  const { ctx, sink } = makeCtx()
  plugin.apply(ctx, { home, profile: 'web' })
  const r = await call(sink.route, '/backup/api/snapshots')
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.body.snapshots) && r.body.snapshots.length >= 1)
  rmSync(home, { recursive: true, force: true })
}

// 4) 保留上限：塞 20 份旧快照后再拍一份，最新总数不超过 20
{
  const home = makeHome()
  const { ctx, sink } = makeCtx()
  const root = SNAP(home)
  mkdirSync(root, { recursive: true })
  for (let i = 0; i < 20; i += 1) {
    const name = '20200101-0000' + String(i).padStart(2, '0') + '-p1'
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, 'snapshot.json'), JSON.stringify({ ts: name, files: [] }))
  }
  plugin.apply(ctx, { home, profile: 'web' })
  await call(sink.route, '/backup/api/backup')
  const dirs = readdirSync(root).filter((n) => RUNTIME_NAME.test(n))
  assert.ok(dirs.length <= 20, '保留上限应为 20，实际 ' + dirs.length)
  assert.ok(!dirs.includes('20200101-000000-p1'), '最旧的那份应被回收')
  rmSync(home, { recursive: true, force: true })
}

console.log('snapshot.test.mjs 全部通过（凭据默认排除 / 开关生效 / 列表端点 / 保留上限）')
