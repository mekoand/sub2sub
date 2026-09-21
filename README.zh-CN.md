<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <img src="docs/assets/wordmark.svg" alt="sub2sub" width="420">
  </picture>
</h1>

**无需交换账号，任务级跨设备共享 Codex、Claude Code 订阅。**

更多工具支持正在开发中。

[![CI](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml/badge.svg)](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.9.4-6366f1)](CHANGELOG.md)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md) · **简体中文** · [安装](docs/install.md) · [使用手册](docs/usage.md) · [参与贡献](CONTRIBUTING.zh-CN.md) · [安全报告](SECURITY.md)

</div>

sub2sub 通过任务代理共享已有 AI 订阅，提高个人与团队的资源利用率。

在当前对话中委托任务，由自己或队友授权的设备执行，答复与成果返回原对话，并可继续追加修改。各方自主决定共享对象、工具和模型。

![sub2sub 通过任务代理共享 Codex 和 Claude Code 订阅：委托任务给已授权设备，执行后返回成果](docs/assets/resource-sharing.zh-CN.png)

先[安装插件](#安装)，再[连接两台设备](#连接工作节点)，即可[尝试第一个任务](#先试一个小任务)。

## 它能帮你做什么

- **选择共享资源。** 从已连接设备中选择工具与模型，查询 Codex 剩余额度。[自动选择共享端](docs/usage.md#自动选择共享端)可按候选顺序为新任务选择设备，已提交任务沿用原设备。
- **控制共享范围。** 设置授权对象、开放模型、并发上限、授权期限和可选 Token 预算，随时停止接收新任务。[共享规则](docs/usage.md#按连接设置共享规则)
- **取回成果，继续修改。** 选定文件交给共享端处理，取回完整工作副本，在原任务中追加需求；何时采用修改由你决定。
- **查看资源用量。** 查看任务分布、执行时间、实际模型与 Token 用量，支持导出。[管理与统计](docs/usage.md#本机管理页与统计)

适合资料整理、离线页面和代码修改。任务在独立工作副本中执行，当前不启用任务联网、MCP、应用或浏览器集成。[执行范围与环境要求](docs/usage.md#派发和追加需求) · [会话展示](docs/usage.md#委托会话展示)

## 安装

两端电脑都需要安装。选择使用 sub2sub 的应用，并先登录该应用；共享端可单独选择执行工具。安装包自带 Node，无需运行 npm。

### 让 AI 帮你安装

发给当前使用的 Codex 或 Claude Code：

> 请按 https://github.com/mekoand/sub2sub 的说明，为我当前应用安装 sub2sub 最新正式版，确认版本和启用状态，并说明重启和首次使用步骤。

也可按下方命令手动安装。

### Codex

**macOS · 终端**（自动识别 Apple Silicon / Intel）

```sh
/bin/bash -o pipefail -c 'curl -fsSL https://github.com/mekoand/sub2sub/releases/latest/download/install.sh | /bin/bash'
```

**Windows x64 · PowerShell**

```powershell
irm https://github.com/mekoand/sub2sub/releases/latest/download/install.ps1 | iex
```

安装完成后，**完整退出并重新打开 Codex 桌面应用**；CLI 用户退出并重启 Codex。

### Claude Code

**macOS · 终端**（Apple Silicon / Intel）

```sh
/bin/bash -o pipefail -c 'curl -fsSL https://github.com/mekoand/sub2sub/releases/latest/download/install.sh | /bin/bash -s -- claude'
```

**Windows x64 · PowerShell**

```powershell
& ([scriptblock]::Create((irm https://github.com/mekoand/sub2sub/releases/latest/download/install.ps1))) -Target claude
```

安装后启动**新的 Claude Code 会话**。仅发起任务时无需安装 Codex。Claude Code 共享端目前需要 macOS；Windows 可作为使用端。[版本要求与自定义路径](docs/install.md#claude-code)

### 确认已加载

重启应用后，在对话中说：

> 查询 sub2sub 状态和版本，不修改设置。

确认加载版本，并按提示检查首次使用设置。接收任务前开启共享。

以后在原应用中说“升级 sub2sub”，按升级结果提示重启应用或共享节点。配对与已保存成果保留。[安装、更新与故障排查](docs/install.md)

## 连接工作节点

**共享端 Host** 接收并执行任务；**使用端 Client** 委托任务、接收成果。一台设备可兼任两者。

私网内可直接配对；不同网络先按[跨网络使用](#跨网络使用)开启服务。

在共享端说：

> 生成 sub2sub 邀请码。

把邀请码私下发给使用端，在使用端对话中粘贴并说：

> 连接这个 sub2sub 邀请码，把它叫作「办公室 Mac」。

按提示确认文件传输范围。开启共享后，保持共享端电脑唤醒并联网；管理对话可以关闭。

## 先试一个小任务

选一份示例文本 `notes.txt`，在当前对话中说：

> 用 sub2sub 只把 notes.txt 交给「办公室 Mac」，整理成 summary.md，返回这个文件和简短答复。

完成后，通过本地链接打开 `summary.md`。答复与文件保存到本机，源文件保持不变。

继续修改：

> 继续这个任务，把 summary.md 再精简一点，并保存最新成果到本地。

共享端沿用同一任务和工作文件，已保存的成果可离线查看。[委托、成果与清理](docs/usage.md)

## 示例：共享队友的 Claude Code 订阅

队友在 Mac 上登录 Claude Code 并授权共享。你在 Codex 中连接该设备，命名为「办公室 Mac」，然后委托任务：

> 用 sub2sub 把 docs 目录交给「办公室 Mac」，做成带搜索的离线帮助站点，检查链接并返回完整文件。

查看本地成果后，继续说：

> 继续这个任务，按主题分组页面，并调整手机上的排版。

共享端沿用原工作文件和 Claude 会话，你在本地获得更新后的完整副本。确认成果后：

> 保存最新成果，结束任务并清理远端工作副本。

按需要将修改应用到源项目。[成果使用与清理](docs/usage.md#打开和使用成果)

## 管理页与统计

在对话里说：

> 打开 sub2sub 管理页。

管理连接、共享规则、任务与本地成果，查询 Codex 额度。资源统计提供近 7 天或 30 天的任务分布、轮次和执行时间；模型与 Token 用量可按来源查看并导出 JSON，缺失数据会标注。

![sub2sub 本机管理页，使用示例设备与任务数据](docs/assets/management-demo.png)

管理页默认开启，可在设置中关闭。任务指令和追问留在原对话中。[管理页与统计说明](docs/usage.md#本机管理页与统计)

## 跨网络使用

双方开启跨网络连接服务后，照常交换邀请码。服务默认关闭，连接优先使用私网直连，必要时通过内置 Tailcat 使用公共中继。已有连接可主动迁移。[开启与迁移说明](docs/install.md#跨网络连接)

## 兼容性

使用端应用与共享端执行工具可以分别选择。

| 系统 | 使用端应用 | 共享端执行工具 | 验证情况 |
| --- | --- | --- | --- |
| macOS（Apple Silicon / Intel） | Codex Desktop、Codex CLI、Claude Code | Codex、Claude Code | Apple Silicon 已验证真实任务和 Mac 间传输；Intel 实机验证待补充。 |
| Windows x64 | Codex、Claude Code | Codex | 已验证安装、平台测试及 Mac 到 Windows 的 Codex 任务；Windows 使用端完整流程待补充验证。 |
| Linux | 仅源码开发，暂无发行包 | 暂未支持 | 已通过源码 CI。 |

WorkBuddy 和其他应用尚未实测。[版本与验证详情](docs/validation.md)

[v0.9.4](https://github.com/mekoand/sub2sub/releases/tag/v0.9.4) 更新了续作文件传输、传输性能和升级维护；具体变更与实测范围见发行说明。

## 开发

```sh
npm ci --omit=optional --ignore-scripts
npm run check
npm test
```

[开发与打包](docs/development.md) · [架构](docs/architecture.md) · [贡献指南](CONTRIBUTING.zh-CN.md) · [版本记录](CHANGELOG.md)

## 参与贡献与反馈

欢迎改进文档、翻译、复现缺陷、提交修复或工具适配方案。先阅读[贡献指南](CONTRIBUTING.zh-CN.md)（[English](CONTRIBUTING.md)）；问题与建议提交到 [Issues](https://github.com/mekoand/sub2sub/issues)，安全漏洞通过[私密入口](SECURITY.md)报告。

遇到问题，可在原对话中说“帮我排查 sub2sub 的这个问题”；需要提交反馈时，说“把这个问题提交到 GitHub”。助手会整理草稿并查重，通过可用工具提交，或将草稿交给你。[故障排查](docs/troubleshooting.md)

[MIT](LICENSE) © 2026 mekoand
