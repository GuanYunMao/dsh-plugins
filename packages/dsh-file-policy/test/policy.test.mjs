// policy.test.mjs — 离线跑策略，不需要 DSH
// 用法： node test/policy.test.mjs
import assert from 'node:assert/strict'
import { decide, pickPath } from '../policy.js'

const ROOT = 'D:\\DSH Desktop\\Harness work'
let pass = 0
const fails = []

function check(name, actual, expected) {
  try {
    assert.equal(actual, expected)
    pass++
    console.log(`  PASS  ${name}`)
  } catch {
    fails.push(name)
    console.log(`  FAIL  ${name}  期望 ${expected}，实际 ${actual}`)
  }
}

const d = (tool, args, extra = {}) =>
  decide({ tool, args, root: ROOT, allow: ['README.md'], ...extra }).deny

console.log('policy: 根目录判定')

// 该拦的
check('根目录新建文件', d('write', { file_path: `${ROOT}\\x.txt` }), true)
check('根目录相对路径', d('write', { file_path: 'x.txt' }), true)
check('根目录用正斜杠', d('write', { file_path: 'D:/DSH Desktop/Harness work/y.md' }), true)
check('edit 已存在的根文件', d('edit', { file_path: `${ROOT}\\NUL` }), true)
check('大小写不同的路径', d('write', { file_path: 'd:\\dsH desktop\\harness WORK\\z.txt' }), true)
check('长路径前缀 \\\\?\\ 也要拦', d('write', { file_path: `\\\\?\\${ROOT}\\long.txt` }), true)
check('设备前缀 \\\\.\\ 也要拦', d('write', { file_path: `\\\\.\\${ROOT}\\dev.txt` }), true)
check('长路径前缀下的子目录放行', d('write', { file_path: `\\\\?\\${ROOT}\\工程坞\\long.txt` }), false)

// 该放的
check('根目录 README.md', d('write', { file_path: `${ROOT}\\README.md` }), false)
check('子目录文件', d('write', { file_path: `${ROOT}\\工程坞\\01-DSH插件\\a.txt` }), false)
check('子目录相对路径', d('write', { file_path: '成品舱\\03-供应链核查报告\\r.md' }), false)
check('工作区之外', d('write', { file_path: 'C:\\Windows\\Temp\\a.txt' }), false)
check('父目录逃逸', d('write', { file_path: '..\\..\\outside.txt' }), false)
check('非文件工具 pwsh', d('pwsh', { command: 'echo x > y.txt' }), false)
check('multi_edit 嵌套 edits 也要拦', d('multi_edit', { edits: [{ file_path: `${ROOT}\\nested.txt` }] }), true)
check('multi_edit 落在子目录放行', d('multi_edit', { edits: [{ file_path: `${ROOT}\\工程坞\\a.txt` }] }), false)
check('files[] 数组也要拦', d('apply_patch', { files: [`${ROOT}\\arr.txt`] }), true)
check('无路径参数', d('write', { content: 'x' }), false)
check('未配置 root', decide({ tool: 'write', args: { file_path: 'x.txt' }, root: '' }).deny, false)
check('逃生舱', d('write', { file_path: `${ROOT}\\x.txt` }, { bypass: true }), false)

// 参数取名
check('pickPath: file_path', pickPath({ file_path: 'a' }), 'a')
check('pickPath: path', pickPath({ path: 'b' }), 'b')
check('pickPath: 无', pickPath({}), '')

// 拒绝理由必须带去处
const v = decide({ tool: 'write', args: { file_path: `${ROOT}\\x.txt` }, root: ROOT, allow: ['README.md'] })
check('理由里提到工程坞', /工程坞/.test(v.reason), true)
check('理由里提到成品舱', /成品舱/.test(v.reason), true)
check('理由里提到逃生舱', /BYPASS/.test(v.reason), true)

console.log(`\n${pass} 通过，${fails.length} 失败`)
if (fails.length) {
  console.log('失败项：' + fails.join('、'))
  process.exit(1)
}
