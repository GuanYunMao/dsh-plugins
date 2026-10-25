# dsh-file-policy

拦住落在**工作区根目录**的散件（脚本、截图、报告），并说明该放到哪儿。它是这套工作区规矩的"强制层"。

## 它做什么

监听 `tools/pre-execute`，只看 `write` / `edit` 这类写文件的工具：

| 目标路径 | 结果 |
|---|---|
| 工作区根下的单个文件（如 `Harness work\x.txt`） | **deny**，理由里给出该去的三个地方 |
| 根目录的 `README.md` | 放行 |
| 任何子目录（`工程坞\…`、`成品舱\…`） | 放行 |
| 工作区之外 | 放行（不归它管） |
| `pwsh` 及其它工具 | 放行 |

**拦不住的**：`pwsh` 里的 `> file`、脚本内部写文件。shell 能写到任何地方，这一层只覆盖模型直接调用文件工具的情况。

## 设计取舍（参照 dcg 的失败策略）

- 给了 deny 就 deny，理由里带**具体去处**和**逃生舱提示**，不是一句"拒绝"。
- 判定过程抛异常 → **放行**并记一行 warn。误杀一次正常写文件，比放过一次乱放更贵。
- `root` 为空 → 整个插件不生效（装着但没配置，不会误伤）。
- 三档模式：`deny`（默认）/ `ask`（弹确认）/ `log`（只记不拦，用于试运行）。

## 安装

```powershell
# 在插件目录里打包，再从产物安装（避免 link 依赖，源目录以后可以随便搬）
cd "工程坞\01-DSH插件\dsh-file-policy"
pnpm pack
dsh plugin --profile web add ".\local-dsh-file-policy-0.1.0.tgz"
```

装完**重启 DSH**（Host 插件的新模块代不会热加载）。

## 卸载

```powershell
dsh plugin --profile web remove @local/dsh-file-policy
```

## 配置

在 `cordis.patch.yml` 里：

```yaml
- insert:
    - id: dsh-file-policy
      name: '@local/dsh-file-policy'
      config:
        root: 'D:\DSH Desktop\Harness work'   # 工作区根，绝对路径
        allow: [README.md]                    # 根目录允许出现的文件名
        onViolation: deny                     # deny | ask | log
        bypassEnv: DSH_FILE_POLICY_BYPASS     # 设为 1 时整条策略跳过
        log: true                             # 每次判定打到 stderr
```

## 测试

```powershell
node test/policy.test.mjs     # 20 条策略用例，不需要 DSH
node test/manifest.test.mjs   # manifest / patch YAML / 模块加载 / 模拟调用
```

## 端到端验收（装完重启之后做）

绿灯只证明接线，不证明它真的拦得住。所以必须真拦一次：

1. 让我（或任何会话）在 `Harness work\x.txt` 写一个文件 → 应当被拒绝，理由里出现"工程坞 / 成品舱 / 收件箱"。
2. 在 `工程坞\01-DSH插件\x.txt` 写同一个文件 → 应当成功。
3. `log` 模式下重做第 1 步 → 文件应能写入，且终端出现 `[file-policy] 拦截`。

三条都对，才算装对了。

## 已知边界

- 拦不住 shell 写入（见上）。
- 拦不出"该进 01 还是 02"——那是语义判断，插件的判据只有路径。
- 工作区换位置要改 `config.root`，否则插件静默不生效（这是有意的：宁可不生效，也不要错误拦截）。
