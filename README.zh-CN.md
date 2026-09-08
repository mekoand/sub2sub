<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <img src="docs/assets/wordmark.svg" alt="sub2sub" width="420">
  </picture>
</h1>

**无需登录对方账号，按任务粒度在团队中共享 AI 订阅。**

在当前 Codex 或 Claude Code 对话中，委托任务、取回成果、继续修改。

[![CI](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml/badge.svg)](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.7.0-6366f1)](CHANGELOG.md)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md) · **简体中文** · [安装](docs/install.md) · [使用手册](docs/usage.md)

</div>

sub2sub 让你使用队友授权共享的 AI 订阅完成任务。提供方在自己的设备上保持 Codex 或 Claude Code 登录，通过邀请码授权连接；你在自己的对话中提交任务和选定文件，由对方的执行环境处理。

文件和答复保存到你的设备上，账号登录始终由提供方保管。需要修改时，在原对话里继续同一项任务，沿用已有工作文件和会话。这套方式同样适用于你自己的多台设备。

## 它能帮你做什么

- **选择任务交给谁。** 从已配对节点中选择执行工具和可用模型，也可以按需查询 Codex 节点的剩余额度。
- **文件和答复一起取回。** 本地获得包含输入与最新修改的完整工作副本，源项目由你决定何时采用修改；保存的成果离线也能看。
- **在原任务中追加修改。** 继续说“把手机排版也调整一下”，执行方沿用原来的工作文件和会话。
- **共享由提供方控制。** 提供方决定授权连接、执行工具与开放模型，可以随时停止接收新任务。每个节点默认最多同时执行 4 项任务，可调整上限；名额满时不排队，调低上限不会中断已有任务。

适合资料整理、离线页面、代码修改这类输入与产物明确的工作。任务在独立副本中执行，当前不启用任务联网、MCP、应用或浏览器集成；委托前准备好所需材料和本地工具。[执行范围与限制](docs/usage.md#派发和追加需求)

## 安装

在需要发起或接收任务的电脑上安装 sub2sub。按需安装，可以随时加入更多设备。

使用 Codex 时，先安装并登录 Codex，再运行对应命令。安装包自带 Node 和证书生成能力。Claude Code 使用者可以选择 [Claude 安装命令](docs/install.md#claude-code)，发起端无需安装 Codex。macOS 工作节点可选择使用 Codex 或 Claude Code。

**macOS · Terminal**

```sh
/bin/bash -o pipefail -c 'curl -fsSL https://github.com/mekoand/sub2sub/releases/latest/download/install.sh | /bin/bash'
```

**Windows x64 · PowerShell**

```powershell
irm https://github.com/mekoand/sub2sub/releases/latest/download/install.ps1 | iex
```

安装完成后，完整退出并重新打开 Codex 桌面应用，或退出并重启终端中的 `codex`。新设备首次使用时会展示全部当前设置，确认后再继续。以后可在该宿主对话中说“检查 sub2sub 更新”或“升级 sub2sub”。安装保留配对和成果，重启宿主后加载新版，运行中的节点不会自动重启。[安装指南](docs/install.md)

## 连接工作节点

在准备接收任务的设备上：

> 生成 sub2sub 邀请码。

在发起任务的设备上粘贴邀请码：

> 连接这个 sub2sub 邀请码，把它叫作「办公室 Mac」。

按提示确认文件传输范围。需要使用其他节点时，分别配对并取一个容易识别的名字。开启共享后，节点独立运行，可以关闭管理对话；执行期间保持接收方电脑唤醒并联网。

## 示例：从 Codex 委托给 Claude

队友在 Mac 上登录了 Claude Code，并通过 sub2sub 授权你使用。你在自己的 Codex 对话中完成配对，把连接命名为「办公室 Mac」，随后把文档整理任务交过去：

> 用 sub2sub 把 docs 目录交给「办公室 Mac」，做成带搜索的离线帮助站点，检查链接并返回完整文件。

成果会保存到本地。打开看看，发现手机上的排版还可以再改，继续说：

> 继续这个任务，按主题分组页面，并调整手机上的排版。

提供方沿用同一任务的工作文件和 Claude 会话，只回传变化的文件；你在本地得到完整副本。确认成果后：

> 保存最新成果，结束任务并清理远端工作副本。

源项目由你决定何时采用这些修改。节点离线后，已经保存的文件仍可打开。[使用、设置与清理](docs/usage.md)

## 一个轻巧的管理页

在对话里说：

> 打开 sub2sub 管理页。

0.7.0 加入了简洁的本机管理页，集中查看节点、任务和已保存成果，也能配对、调整设置、按需查询 Codex 额度。近 7 天或 30 天的资源统计，帮你看看任务交给了谁、跑了几轮、用了多少执行时间。

管理页默认开启，可以随时关闭；它复用插件进程，不增加后台服务，也不会自动打开浏览器。任务指令和追问继续留在原对话里。[管理页与统计说明](docs/usage.md#本机管理页与统计)

## 跨网络使用

可以通过 [Tailscale](https://tailscale.com/) 连接不同网络中的设备，再使用各工作节点的 Tailscale IPv4 地址配对。地址支持已加入，真实跨网络实测安排在后续版本。[Tailscale 配置说明](docs/install.md#跨网络使用-tailscale)

## 兼容性

提供 macOS 和 Windows x64 安装包，可选择安装到 Codex 或 Claude Code。Codex 可在两种平台执行任务，Claude 执行目前支持 macOS。任务委托已在 Codex 桌面端及 macOS 的 Codex CLI、Claude Code 中验证。WorkBuddy 尚未实测。[验证详情](docs/validation.md)

## 开发

```sh
npm ci
npm run check
npm test
```

[开发与打包](docs/development.md) · [架构](docs/architecture.md) · [贡献指南](CONTRIBUTING.md) · [版本记录](CHANGELOG.md)

遇到问题，直接在原对话里说“帮我排查 sub2sub 的这个问题”。需要反馈时，再说“把这个问题提交到 GitHub”：助手会整理公开草稿并查重，使用宿主已有能力提交；没有提交能力时，把草稿交给你。[故障排查](docs/troubleshooting.md) · [Issues](https://github.com/mekoand/sub2sub/issues)

[MIT](LICENSE) © 2026 mekoand
