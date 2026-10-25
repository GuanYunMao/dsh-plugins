# dsh-harness-monitor

本机同时跑多个 harness（桌面端 / 后台编码搭档 / dev）时，列出这些进程：PID、端口、工作目录、在服务哪个会话，并能分级释放。

## 功能

- 进程列表按类别分组（background / dev / desktop），标出"本界面"。
- 端口与"正在服务的会话"（本机读会话快照；其它机器走 `/whoami` 探测，10s TTL）。
- 分级释放：background 可直接释放；dev / desktop 必须显式确认。
- 面板右上角「?」里是用法说明；主面板只留状态和动作。

## 安装

```bash
dsh plugin --profile web add <包名或本地路径>
```

装完重启 DSH。**仅 Windows**：进程查询依赖 PowerShell + WMI；非 Windows 平台入口会自动隐藏（宿主返回 `available:false`）。

## 安全

- `/kill` 只接受**同源**请求（`sec-fetch-site` / Origin 校验），跨源 POST 一律 403；body 上限 64KB。
- 进程命令行在 PowerShell 侧脱敏（`--token` / `--api-key` / `sk-…` / `Bearer …`）后才回传。
- 列表结果 2 秒缓存；kill 成功后立即失效。

## 测试

```bash
npm test
```

License: MIT
