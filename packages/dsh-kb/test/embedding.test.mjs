import assert from 'node:assert/strict'
import { embedBatch } from '../lib/index.js'

const originalFetch = globalThis.fetch
const stub = (payload, ok = true) => {
  globalThis.fetch = async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  })
}

try {
  // openai：服务端可能乱序返回（index 字段），要按 index 还原
  stub({ data: [{ index: 1, embedding: [0.2, 0.4] }, { index: 0, embedding: [0.1, 0.3] }] })
  assert.deepEqual(
    await embedBatch(['a', 'b'], '', { embedding: { provider: 'openai', model: 'm', dimensions: 2, baseUrl: 'http://127.0.0.1:1/v1' } }),
    [[0.1, 0.3], [0.2, 0.4]],
  )

  // ollama 原生 /api/embed
  stub({ embeddings: [[1, 2], [3, 4]] })
  assert.deepEqual(
    await embedBatch(['a', 'b'], '', { embedding: { provider: 'ollama', model: 'm', dimensions: 2, baseUrl: 'http://127.0.0.1:1' } }),
    [[1, 2], [3, 4]],
  )

  // dashscope 原生形状
  stub({ output: { embeddings: [{ text_index: 0, embedding: [0.5, 0.5] }] } })
  assert.deepEqual(
    await embedBatch(['a'], 'k', { embedding: { provider: 'dashscope', model: 'm', dimensions: 2 } }),
    [[0.5, 0.5]],
  )

  // 维度不符要拒绝，并把"改 dimensions"的提示带出来
  stub({ data: [{ index: 0, embedding: [1, 2, 3] }] })
  await assert.rejects(
    () => embedBatch(['a'], '', { embedding: { provider: 'openai', model: 'm', dimensions: 2, baseUrl: 'http://127.0.0.1:1/v1' } }),
    /维度不符/,
  )

  // 本地服务不带 key 也能跑（请求头不应含 authorization）
  let seenAuth
  globalThis.fetch = async (_url, init) => {
    seenAuth = init.headers.authorization
    return { ok: true, status: 200, json: async () => ({ embeddings: [[1, 2]] }), text: async () => '' }
  }
  await embedBatch(['a'], '', { embedding: { provider: 'ollama', model: 'm', dimensions: 2, baseUrl: 'http://127.0.0.1:1' } })
  assert.equal(seenAuth, undefined)

  console.log('embedding.test.mjs 通过：三种 provider 的解析/排序/维度/免 key')
} finally {
  globalThis.fetch = originalFetch
}
