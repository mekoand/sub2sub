<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <img src="docs/assets/wordmark.svg" alt="sub2sub" width="420">
  </picture>
</h1>

**给你的 AI 找个搭子。**

把任务交给另一台电脑的 Codex 或 Claude，成果带回当前对话。

[![CI](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml/badge.svg)](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.7.0-6366f1)](CHANGELOG.md)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md) · **简体中文** · [安装](docs/install.md) · [使用手册](docs/usage.md)

</div>

你在笔记本上忙着推进项目，办公室的电脑正好空着；或者，你在 Codex 里工作，也想用上另一台 Mac 的 Claude。

sub2sub 让你在当前 Codex 或 Claude Code 对话里，把一项独立任务交给自己或队友授权共享的电脑。对方用自己的 AI 环境完成工作和检查，成果保存到你本地。还想再改，接着在原对话里说就行。

## 它能帮你做什么

- **用上已有的订阅和设备。** 连接多个工作节点，按任务选择需要的工具和模型；执行账号留在对应设备上。
- **少搬一次上下文。** 追加一句“把手机排版也调整一下”，同一任务沿用原来的工作文件和对话。
- **少来回倒腾文件。** 文件变化回传后形成完整本地副本，源项目由你决定何时采用修改；保存的成果离线也能看。
- **共享的事，自己做主。** 拥有者决定何时开放、提供哪个工具和哪些模型。你选择任务交给谁，每个节点同时执行一个任务。

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

## 走一遍：委托文档整理

你的笔记本已连接「办公室 Mac」和「Windows 工作机」。Windows 节点正在处理另一项任务，Mac 空闲且提供你需要的模型，因此将文档工作交给 Mac：

> 用 sub2sub 把 docs 目录交给「办公室 Mac」，做成带搜索的离线帮助站点，检查链接并返回完整文件。

成果会保存到本地。打开看看，发现手机上的排版还可以再改，继续说：

> 继续这个任务，按主题分组页面，并调整手机上的排版。

不用重新讲一遍需求：节点沿用原有工作文件和对话，只回传变化的文件；你在本地得到完整副本。确认成果后：

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
