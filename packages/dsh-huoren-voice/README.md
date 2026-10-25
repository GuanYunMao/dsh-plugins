# dsh-huoren-voice · 活人声线

一条**纯提示词 + 一个设置页**的插件：往 DSH 的系统提示词里注册一节「你是谁」，把**热情、天马行空、严谨、幽默**做成一副嗓子——身份、说话规则、**正反例句**，缺一不可。

不改事实、不碰工具、不注册工具；设置页里的改动**下一个请求就生效**，不用重启。

```
## 你是谁
你是他的技术搭子：不是客服，不是搜索引擎。你有口味、有脾气……

## 你会这样说
- 「这个接口怎么 500 了？」→「这个 500 我的判断是中间件顺序问题，不是业务代码 💥 日志最后一行是…… 位置在第 42 行。建议…… 如果还报，那问题不在顺序。」

## 你不会这样说
- 「这是一个非常好的问题！首先……需要注意的是……希望对您有帮助！」
- 电报体：「行。改第 42 行。重试。」
```

主段约 1200 字，`order = 20`（部署人设之后、PLAN_POLICY 之前）；末尾再放一句回声（`order = 10201`），代价约 +40 字/请求，可关。

## 为什么 0.1 / 0.2 看起来没效果

第一版只写了一张**规则清单**（先给结论、要具体、别写套话）。问题在三处：

1. **规则管教语言，不生成嗓音。** 它只能让模型"少犯错"，不能让它"像个人"——模型还是用它自己的腔调说话，只是更短了。
2. **没有例句。** 风格是模仿出来的，不是被规定的。阿茶那条人设之所以活，靠的是 5 段场景对话示例，而不是形容词。
3. **规则清单本身是格式。** 一条条 bullet 写进去，模型容易照着用 bullet 回话——"防睡"的规则反而在教它排版。

0.3 换成 SOUL.md 的路子：先定身份（**你是谁**），再给**正反例句**（**你会这样说 / 你不会这样说**），规则压到最短。参考：[OpenClaw SOUL.md 模板](https://docs.openclaw.ai/zh-CN/reference/templates/SOUL.md)、[soul-templates](https://github.com/bchop-studio/soul-templates)（Sarcastic Dev / Creative Partner 两条最接近）。

## 设置页（设置 → 声线）

| 能做什么 | 说明 |
|---|---|
| 总开关 | 关掉后两条段落都注入空串，插件还装着 |
| 四个方向：热情 / 严谨 / 天马行空 / 幽默 | 每个都能单独关，互不牵连 |
| 手感：节奏 / 具体 / 替换表 / 例句 / **emoji 密度** / 末尾回声 | 例句是效果最大的一档，别关；emoji 按整条回复算 3–8 个（不是每句一个），默认开 |
| 追加自己的话 | 原样注入段末；输入后 0.6 秒自动保存 |
| **你喜欢的句子** | 按回车分条，最多 6 条，原样作为「## 用户喜欢的句子」注入——最有效的个性化 |
| 主段字符上限 | 默认 4000，超出截断（保头保尾） |
| 看模型实际读到的正文 | 展开即预览当前注入文本，带字数 |
| 恢复基线 | 清掉设置页的覆盖，回到 `cordis.patch.yml` 里的值 |

配置存于 `<DSH_HOME>/storages/dsh-huoren-voice/config.json`（原子写）；patch 里的 `config` 只是基线，设置页改的会覆盖它。**保存后下一个请求生效，不需要重启**。

## 安装

包名 `dsh-huoren-voice`，`private: true`，没有任何运行时依赖。

**界面装**（推荐，Desktop 由 Electron 管 profile）：

```
设置 → 插件 → 添加插件 → 填绝对路径：
D:\DSH Desktop\Harness work\工程坞\01-DSH插件\plugins\dsh-huoren-voice
```

**命令行装**（profile 名按你自己的，本机是 `web`）：

```powershell
dsh plugin --profile web add "D:\DSH Desktop\Harness work\工程坞\01-DSH插件\plugins\dsh-huoren-voice"
```

装完**重启一次 DSH**（宿主侧路由与段落要在启动时装配；之后改设置就不用重启了）。卸载：插件页移除，或 `dsh plugin --profile web remove dsh-huoren-voice`。

## 宿主接口（只接受本机回环）

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/huoren-voice/api/state` | 基线 + 覆盖 + 生效配置 + 当前正文 + 存储路径 |
| `POST` | `/huoren-voice/api/config` | 合并写入（只认认识的键与正确类型），返回新状态 |
| `POST` | `/huoren-voice/api/reset` | 删除覆盖文件，回到基线 |

写接口带同源闸门：非回环来源、`sec-fetch-site: cross-site`、跨站 `Origin` 一律 403。

**为什么不挂在 `/api` 下**：`/api` 由 `dsh-api-gateway` 的 RPC 通道接管，插件注册的最长前缀会被它挡成 404（0.2.0-rc.2 实测）。kb / backup 也都用自己的前缀。

**为什么启动要等**：`apply` 可能比 `webServer` 服务就绪更早——此时 `ctx.get("webServer")` 是 `undefined`。插件用 `ctx.inject(["webServer"], …)` 等它，服务一出现就注册路由；headless/CLI 构成里永远没有它，也不会拖累插件加载。排查时看 `<DSH_HOME>/storages/dsh-huoren-voice/boot.log`，每次启动一行。

## 设计：取各家之长，弃各家之短

社区里跟“说话风格”有关的插件，做法基本是“往系统提示词里注入一段文字”。差别在**那段文字怎么写**、**注入点在哪**、**带不带外壳**。这里逐条记下取舍，也方便你以后自己改：

| 来源 | 取 | 弃 | 为什么 |
|---|---|---|---|
| [dsh-cosplay](https://github.com/liceses/dsh-cosplay) | 独立 section、`interpolate: false`、**末尾回声**、正向措辞纪律、人设段放最前 | 角色卡、改写链路、每会话绑卡、20k 字卡面 | 回声有实测收益（猫娘「喵」密度 0.85→1.75）；但角色扮演会把“干活”挤成“演戏” |
| [dsh-plugin-fun](https://github.com/keeshakulbida948-tech/dsh-plugin-fun) | 热情的人格化写法、“技术问题先给准话”、严肃场景收敛、熟悉度递进 | 二次元名字、强制发图、依赖 sticker | 活泼本身没错，错的是“每轮都要发图”这种 KPI |
| [dsh-anima](https://github.com/Melody-cx/dsh-anima) | 字段自由文本、注入字符预算、注入可解释 | 12 个字段全上、长期记忆、审计、灵台设置页 | 只要“怎么说”，不要“记什么”；字段越多越没人调 |
| [dsh-persona-dafeiyu](https://github.com/huaizhuanghub/dsh-persona-dafeiyu) | 独立段落、改 Markdown 即改人格、免重启的思路 | 三档工作区/会话作用域 | 单机单声线，不需要三层作用域；`append` 就是最小可改入口 |
| [dsh-soul](https://github.com/Aliuyanfeng/dsh-soul) | （声明式的老前辈，功能已被上面两家补齐） | 风格枚举 + 自定义命令 | 枚举是“选一个罐头”，不是“我的声线” |
| [dsh-persona-shaoxin](https://github.com/MycatQieZi/dsh-persona-shaoxin) | Markdown 即人格、保存即生效 | 单一人设、无开关键 | 换个语气要换整个文件，太重 |
| [humanizer](https://github.com/hannsxpeter/humanizer) · [ai-slop-detector](https://github.com/FeedHive/ai-slop-detector) · [say-no-to-slop](https://github.com/imMamdouhaboammar/say-no-to-slop) | 「替换表」：把套话换成具体说法 | 全文重写、跨语言规则、把文字压到扁平 | 去 AI 味能治“假”，治不了“闷”；压过头会连人味一起剪掉 |
| [dsh-emoji](https://github.com/hellodigua/dsh-emoji) · [dsh-stickers](https://github.com/william-jin-cmu/dsh-stickers) · [dsh-expression](https://github.com/yyh-001/dsh-expression) | emoji 当调味、默认关 | 每句自动加、表情包依赖 | 表情是佐料，撒多了齁 |
| [dsh-tavern](https://github.com/flizzywine/dsh-tavern) · [dsh-humanized-deepseek-maid](https://github.com/loonai321/dsh-humanized-deepseek-maid) | 拟人感的写法参考 | 剧情 / 女仆角色扮演 | 那是“玩”的道具，不是“干活”的声带 |
| [dsh-prompt-studio](https://github.com/Moeblack/dsh-prompt-studio) | 可预览、可改提示词段的思路 | 直接改内置段落 | 改官方段落风险高；独立段落 + 设置页已经够用 |

四个方向对应的硬规则，都落在“可照着做”这一层，不写“要热情”这种没法执行的形容词：

- **热情** → 先接住再展开、一轮最多一个「！」、多走一步、夸具体的。
- **天马行空** → 一个标明“为什么可能成立”和“代价”的脑洞；头脑风暴可多给，正经排查最多一个且三句话内收回来。
- **严谨** → 事实/推断/猜测用不同说法、数字先查再解释、关键判断附“什么情况会推翻它”。
- **幽默** → 一句话就停、自嘲优先、事故/隐私不抖机灵。
- 外加两条“防睡”的公共规则：**结论先行、能短则短**；**一个细节顶三个形容词**。

## 设置导航图标补丁

DSH 壳的设置导航图标是 `navIcon(id)` 里的硬编码映射，第三方 section 一律落到兜底齿轮——所以「通用」和每个插件模块看起来一模一样。本插件对本机做了两处小补丁（runtime + 全局 dsh），把重复的齿轮换成独立图标：

| section id | 图标 |
|---|---|
| `general` | 滑杆 |
| `web-ui-plugins` | 插件（Cordis） |
| `dsh-workshop` | 风车（市集） |
| `skin-center` | 星芒 |
| `dsh-usage` | 仪表 |
| `better-sidebar` | 左栏 |
| `pocket` | 队列 |
| `wallpaper-engine` | 增强 |
| `pet` | 喜欢 |
| `huoren-voice` | 麦克风（声线） |

- 改前备份：`client.js.huoren-voice.bak`。
- **DSH 升级后壳文件会被覆盖**，重跑一次即可：`node scripts/patch-settings-icons.mjs`（幂等，已打过会跳过）。
- 想换某个图标 / 加别的 section：改脚本里的 `MAPPINGS`，一行一个。

## 自检

```powershell
cd plugins\dsh-huoren-voice
node test\verify.mjs        # 宿主：文本组装 / 配置收敛 / 持久化 / 段落注册 / 三条路由 + 闸门，23 项
node test\client-smoke.mjs  # 客户端：ModuleLoader 协议 / 注册参数 / loading→loaded 渲染
```

`verify.mjs` 会把 `DSH_HOME` 指到临时目录，不碰你真实的配置。

## 边界（包括效果上限，说实话）

- **只改说法，不改事实**：不增加正确率，也不为语气牺牲准确性；与工具纪律冲突时以工具纪律为准（段落开头已声明）。
- **上限是"引导"，不是"改造"**：DSH 目前只有 `agent/pre-step` 钩子（能在模型看到之前改**用户消息**），没有"改写助手输出"的钩子。所以没有第二遍重写，风格靠提示词引导，效果有天花板——比没装强，但不会变成另一个人。
- **每轮都要付 token**：主段约 1100 字 + 回声约 40 字。嫌贵就设小 `maxChars`、关 `tailEcho`，或整段 `enabled: false`。
- **和上下文抢注意力**：DSH 的系统提示词很长，风格段是其中一小块；工具越多、规则越多，它能分的注意力越少。
- **宿主代码改动需要重启**；设置页里的开关、追加文本、样例、上限都**不需要**（下一个请求生效）。
- **与其它人设插件叠加**：若同时装了 dafeiyu / anima / cosplay，它们的段落也会注入；两段“风格”同时说话会打架，建议只留一套，或把它们的人设字段留空。
- 只做中文声线；不做多模态、不做表情包、不做记忆。

## 变更记录

- **0.4.0**：往「说清楚」推——删掉「能一句说完就一句」「理由最多三条」「段落不超三行」这些惜字如金规则，换成「判断 + 两到四段展开（为什么 / 落在哪 / 下一步）」，每段 2–4 句；正例改成完整解释式回答，反例加了「电报体」。对齐 ChatGPT 式的完整表达，但保留判断先行与去套话。
- **0.3.2**：emoji 规则改成「按整条回复算 3–8 个，一段最多一个，别每句一个」；同一 emoji 一条回复只用一次。上一版把密度写成“分散在开头句中收尾”，读起来像每句都要塞，容易凌乱。
- **0.3.1**：emoji 从「偶尔一个」改成「每条 3–8 个」，默认开；例句里也带 emoji（示范比规则管用）；设置页那一行改名「emoji 密度」。用户明确说：冷冰冰比 emoji 多更难受。
- **0.3.0**：改结构——「规则清单」换成「身份 + 正反例句 + 短规则」；新增 `samples`（贴你喜欢的句子当参照）与 `examples` 开关；回声改成身份口径。这一版才真正对齐 SOUL.md 和阿茶人设的做法。
- **0.2.1**：路由挪到 `/huoren-voice/api`（`/api` 下会被 API 网关挡成 404）；webServer 未就绪时改用 `ctx.inject` 等待，不再放弃注册；加启动日志 `storages/dsh-huoren-voice/boot.log`。
- **0.2.0**：新增 设置 → 声线（开关 / 追加 / 上限 / 预览 / 恢复）；配置持久化到 `storages/dsh-huoren-voice/`；三条回环路由；段落文本改为每轮读生效配置（改完不用重启）；补设置导航图标；自检 20 + 1 组。
- **0.1.0**：首版，纯提示词两条段落。

## 许可

MIT。

## 语气预设

`tone` 可换：`default`（默认）/ `blunt`（直白）/ `deadpan`（冷幽默）/ `scifi`（科幻）/ `academic`（学术）/ `gentle`（温和）。每个预设都带反 AI 腔，换语气不会把矫揉造作换回来。

## 每轮锚（turnAnchor）

系统提示在最前面，上下文一长就会被稀释。这个插件会用 `systemPrompt.context()` 每轮注入一句约 70 字符的锚（"反 AI 腔：不写……；语气：X"），它落在当前轮附近、覆盖上一份，专门对抗长上下文漂移。设置页可关。

