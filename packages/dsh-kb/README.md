# dsh-kb

给 DeepSeek Harness 用的本地知识库：把 `~/.dsh/kb/<库名>/` 下的 md/txt 切块、向量化，让 agent 用 `kb_search` 检索，并在侧边栏提供管理面板。

## 为什么

模型不会记得你两周前写的笔记。这个插件把"本地文档 + 项目记忆"变成可检索的库：检索结果带**来源文件、标题、行号、置信度**，能被引用、能核对。

## 功能

- **检索**：`kb_search` 工具 + 侧边栏「知识阁」；结果带来源行号，低置信会标注。
- **库管理**：按工作区自动绑定库；重命名/删除（有保护）、打开目录、导入文件、重建索引（带 scanning/embedding 进度）。
- **记忆**：项目记忆 / 窗口记忆，带版本与回滚；写入后可选自动重建索引。
- **文件页**：按库列记忆/文档清单，点行用系统程序打开。

## Embedding 与隐私

- **默认 `dashscope`**：文档文本块与查询词会发送到 `https://dashscope.aliyuncs.com` 做向量化；文档原件与索引本身始终留在本机。
- **完全离线**：把 `embedding.provider` 设为 `ollama`（或 `openai` 指向 LM Studio / vLLM），`baseUrl` 指向本机服务，装一个 embedding 模型（推荐 `bge-m3`），本地服务通常不需要 key。
  例：`ollama pull bge-m3`，然后 `provider: ollama, model: bge-m3, dimensions: 1024, baseUrl: http://127.0.0.1:11434`。
- 对话模型（如 Qwen 4B Instruct）**不能**直接当 embedding 用；llama-server 要加 `--embedding` 也只能算凑合，检索质量明显不如专用模型。

## 安装

```bash
dsh plugin --profile web add <npm 包名或本地路径>
```

装完重启 DSH。首次使用需要在 DSH 凭据里配置 `DASHSCOPE_API_KEY`（嵌入模型用 DashScope 的 text-embedding-v4）。

## 配置（patch 里）

| 键 | 默认 | 说明 |
|---|---|---|
| `kbRoot` | `~/.dsh/kb` | 库目录 |
| `embedding.provider` | `dashscope` | `dashscope` / `openai`（OpenAI 兼容） / `ollama`（原生） |
| `embedding.model` | `text-embedding-v4` | 嵌入模型；本地可用 `bge-m3` 等 |
| `embedding.dimensions` | 1024 | 向量维度；本地模型按它输出改（bge-m3=1024，nomic=768） |
| `embedding.baseUrl` | 空 | openai 默认 `http://127.0.0.1:11434/v1`；ollama 默认 `http://127.0.0.1:11434` |
| `chunking` | 见源码 | 分块大小/重叠 |
| `search.topK` | 5 | 默认返回条数 |

## 安全与鲁棒性

- 库名**拒绝**而不是静默清洗（`../x` 不会变成另一个合法库名）。
- 所有路由走宿主回环；破坏性操作有工作区绑定保护。
- `libraries.json` 损坏时先备份成 `.corrupt-<ts>` 再重建，不覆盖"库↔工作区"绑定。
- 单文档 >8MB 跳过、请求体 >1MB 拒绝、索引缓存上限 4 个库。

## 测试

```bash
npm test
```

License: MIT
