# dsh-backup-button

DSH（DeepSeek Harness）插件：侧边栏 💾 按钮 + 启动自动快照，把 profile 的关键配置存成可回看的副本。

## 三种触发

| 触发 | 什么时候 | 含凭据？ |
|---|---|---|
| boot-auto | 每次 harness 启动，按内容哈希去重（没变就不落盘） | 否 |
| manual | 点侧边栏 💾（`GET /backup/api/backup`） | **默认否**，见下 |
| cleanup | `GET /backup/api/cleanup`，清旧版平铺 `.bak`（保留 20 个） | — |

## 凭据策略（v2.1 起）

快照是**明文副本**，且保留最近 20 份。默认**不复制** `.credentials.yaml`——密钥跟着配置一起躺在
`backups/` 里，最容易在"把配置发给我看看"的时候泄出去。要恢复旧行为（手动快照包含凭据），在
profile 的 `cordis.patch.yml` 里给这一行加配置：

```yaml
- id: backup-button
  config:
    includeCredentials: true
```

手动快照的响应里会带 `credentials: included | excluded…`，一看就知道这次有没有把密钥写进去。

## 快照布局

```
<DSH_HOME>/backups/snapshots/<yyyyMMdd-HHmmss>-p<pid>/
├─ snapshot.json   { ts, time, trigger, pid, files:[{safe, original, hash, size}] }
├─ settings.yaml
├─ root__cordis.patch.yml
├─ web__cordis.patch.yml
├─ web__package.json
├─ web__pnpm-workspace.yaml
├─ web__pnpm-lock.yaml
├─ dev__cordis.patch.yml
├─ dev__package.json
└─ credentials.yaml   ← 只有 includeCredentials: true 时才有
```

超过 20 份自动删最旧的；删除只发生在快照目录（不碰其它文件）。

## 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/backup/api/backup` | 立即做一次手动快照 |
| GET | `/backup/api/snapshots` | 列出最近 50 份快照（时间/触发/文件数） |
| GET | `/backup/api/cleanup` | 清旧版平铺 `.bak`，保留 20 份 |

## 配置

| 项 | 默认 |
|---|---|
| `home` | `$DSH_HOME` 或 `~/.dsh` |
| `profile` | `$DSH_PROFILE` 或 `web` |
| `backupDir` | `<home>/backups` |
| `includeCredentials` | `false` |

## 自检

```powershell
node test/snapshot.test.mjs
```

用临时 DSH_HOME 真跑一遍 host 半：启动快照不含凭据、手动默认不含凭据、开关打开后含凭据、
快照列表端点可达、保留上限生效。
