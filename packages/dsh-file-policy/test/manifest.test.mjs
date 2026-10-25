// manifest.test.mjs — 装机前检查：manifest、patch YAML、模块加载、模拟一次调用
// 用法： node test/manifest.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.resolve(here, '..')
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8')
let failed = 0
const ok = (name) => console.log(`  PASS  ${name}`)
const bad = (name, detail) => {
  failed++
  console.log(`  FAIL  ${name}  ${detail ?? ''}`)
}
const t = (name, fn) => {
  try {
    fn()
    ok(name)
  } catch (e) {
    bad(name, e.message)
  }
}

console.log('manifest')

const pkg = JSON.parse(read('package.json'))
t('package.json 可解析', () => assert.equal(pkg.type, 'module'))
t('声明了 dsh.bundle.patch', () => assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml'))
t('main 指向 index.js', () => assert.equal(pkg.main, 'index.js'))
t('files 列出的文件都存在', () => {
  for (const f of pkg.files) assert.ok(fs.existsSync(path.join(dir, f)), '缺文件: ' + f)
})

console.log('cordis.patch.yml')

const YAML_PATH = 'D:/DSH Desktop/DeepSeek Harness/runtime/node_modules/js-yaml/dist/js-yaml.mjs'
const yamlMod = await import(pathToFileURL(YAML_PATH).href)
const patch = yamlMod.default.load(read('cordis.patch.yml'))

t('能解析成数组', () => assert.ok(Array.isArray(patch)))
t('第一项是 insert', () => assert.ok(patch[0].insert, '没有 insert'))
t('行 id 与包名', () => {
  const row = patch[0].insert[0]
  assert.equal(row.id, 'dsh-file-policy')
  assert.equal(row.name, pkg.name)
})
t('config.root 是绝对路径', () => {
  const root = patch[0].insert[0].config.root
  assert.ok(path.win32.isAbsolute(root), '不是绝对路径: ' + root)
})
t('config.root 反斜杠没被吃掉', () => {
  const root = patch[0].insert[0].config.root
  assert.ok(root.includes('\\'), 'YAML 里反斜杠丢了: ' + root)
  assert.equal(root, 'D:\\DSH Desktop\\Harness work')
})

console.log('模块与调用')

const mod = await import(pathToFileURL(path.join(dir, 'index.js')).href)
t('导出 inject=[tools]', () => assert.deepEqual(mod.inject, ['tools']))
t('导出 apply 函数', () => assert.equal(typeof mod.apply, 'function'))

const listeners = []
mod.apply(
  { on: (ev, fn) => { if (ev === 'tools/pre-execute') listeners.push(fn); return () => {} } },
  { root: 'D:\\DSH Desktop\\Harness work', allow: ['README.md'], log: false },
)
t('注册了一个 pre-execute 监听', () => assert.equal(listeners.length, 1))

const next = async () => ({ kind: 'allow' })
const run = (name, args) => listeners[0]({ name, arguments: args }, next)

const denied = await run('write', { file_path: 'D:\\DSH Desktop\\Harness work\\x.txt' })
t('根目录散件 -> deny', () => assert.equal(denied.kind, 'deny'))

const allowed = await run('write', { file_path: 'D:\\DSH Desktop\\Harness work\\工程坞\\a.txt' })
t('子目录 -> allow', () => assert.equal(allowed.kind, 'allow'))

const readme = await run('write', { file_path: 'D:\\DSH Desktop\\Harness work\\README.md' })
t('README.md -> allow', () => assert.equal(readme.kind, 'allow'))

const shell = await run('pwsh', { command: 'echo x > y.txt' })
t('pwsh -> allow（拦不住，明确放行）', () => assert.equal(shell.kind, 'allow'))

// 失败即放行：传一个会炸的 exec
const boom = await listeners[0](null, next)
t('异常输入 -> 放行（fail-open）', () => assert.equal(boom.kind, 'allow'))

console.log(failed === 0 ? '\nmanifest 检查全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
