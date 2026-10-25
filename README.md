# dsh-plugins

A collection of self-built plugins for **DeepSeek Harness (DSH)** — each package can be installed on its own.

给 DeepSeek Harness 写的一批自研插件，每个包都能单独安装。

## 包里有什么

| 包 | 干什么 | 平台 / 依赖 |
|---|---|---|
| [dsh-kb](packages/dsh-kb) | 本地知识库：文档分块向量化，`kb_search` 检索带来源行号；项目/窗口记忆可回滚 | 需 DashScope embedding key |
| [dsh-tree-panel](packages/dsh-tree-panel) | 会话分支树：一个卡片 = 一轮对话，点卡片定位到该轮，右下角缩略图 | 纯 Client |
| [dsh-workspace-map](packages/dsh-workspace-map) | 主区域只读工作区地图：目录、说明、文件数/体积，按舱位分区 | 工作区根可配 |
| [dsh-file-policy](packages/dsh-file-policy) | 拦"往工作区根扔散件"的文件写操作，给出建议落点 | Host |
| [dsh-harness-monitor](packages/dsh-harness-monitor) | 多 harness 进程/端口/会话对照，分级释放 | Windows |
| [dsh-backup-button](packages/dsh-backup-button) | 配置快照：启动去重 + 一键手动快照，默认不含凭据 | — |
| [dsh-huoren-voice](packages/dsh-huoren-voice) | 把"说话风格"写成可开关的系统提示词，带设置页 | — |

## 安装

```bash
# 从本地目录
dsh plugin --profile web add <这个包所在的目录>
# 从 npm（发布后）
dsh plugin --profile web add <包名>
```

装完重启 DSH（Client 模块不热加载）。

## 结构

```
packages/
├─ dsh-kb/               Host + Client，路由 /kb/api/*
├─ dsh-tree-panel/       Client，槽位 sidebar.panellist / main
├─ dsh-workspace-map/    Host 构建 + Client 渲染
├─ dsh-file-policy/      Host，tools/pre-execute 拦截
├─ dsh-harness-monitor/  Host + Client，路由 /harness-monitor/api/*
├─ dsh-backup-button/    Host + Client，路由 /backup/api/*
└─ dsh-huoren-voice/     Host（系统提示词段落）+ Client（设置页）
```

## 共同约定

- 只用宿主主题 token 与 CSS 变量，不引外部字体/图标库。
- 破坏性操作二次确认；失败尽量 fail-soft（降级、不崩宿主）。
- 每个包带自检：`npm test`（多数是 `node test/*.test.mjs`，不依赖浏览器）。
- 库名、路径、跨源请求按"拒绝而不是清洗"处理。

## 已知边界

- Client 半依赖 DSH 0.2.x 的槽位 API，宿主大版本升级后可能需要小改。
- `dsh-kb` 需要 DashScope 的 embedding 额度；没配 key 时检索不可用，面板会给出提示。
- `dsh-workspace-map` 的工作区根用 `config.root` 或 `DSH_WORKSPACE_MAP_ROOT` 指定，默认当前工作目录。

## License

MIT
