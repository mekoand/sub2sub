<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <img src="docs/assets/wordmark.svg" alt="sub2sub" width="420">
  </picture>
</h1>

**无需登录对方账号，按任务粒度在团队中共享 AI 订阅。**

在当前对话中委托另一台设备处理任务，取回答复与文件，再继续修改。私网内可直接连接；双方主动开启跨网络服务后，也可在不同网络之间使用同一流程。

[![CI](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml/badge.svg)](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.9.2-6366f1)](CHANGELOG.md)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md) · **简体中文** · [安装](docs/install.md) · [使用手册](docs/usage.md)

</div>

sub2sub 让你使用队友授权共享的 AI 订阅完成任务。提供方在自己的设备上保持 Codex 或 Claude Code 登录，通过邀请码授权连接；你在自己的对话中提交任务和选定文件，由对方的执行环境处理。

文件和答复保存到你的设备上，账号登录始终由提供方保管。需要修改时，在原对话里继续同一项任务，沿用已有工作文件和会话。这套方式同样适用于你自己的多台设备。


## 它能帮你做什么

- **选择任务交给谁。** 从已配对节点中选择执行工具和可用模型，也可以按需查询 Codex 节点的剩余额度。
- **文件和答复一起取回。** 本地获得包含输入与最新修改的完整工作副本，源项目由你决定何时采用修改；保存的成果离线也能看。
- **在原任务中追加修改。** 继续说“把手机排版也调整一下”，执行方沿用原来的工作文件和会话。
- **会话展示可选。** 新建 Codex 委托默认在每轮结束后归档，续作时恢复；提供方可设置保留在客户端任务列表中。只影响新任务，工作副本清理规则不变。详见[会话展示](docs/usage.md#委托会话展示)。
- **共享由提供方控制。** 提供方决定授权连接、执行工具与开放模型，可以随时停止接收新任务。每个节点默认最多同时执行 4 项任务，可调整上限；名额满时不排队，调低上限不会中断已有任务。

适合资料整理、离线页面、代码修改这类输入与产物明确的工作。任务在独立副本中执行，当前不启用任务联网、MCP、应用或浏览器集成；委托前准备好所需材料和本地工具。[执行范围与限制](docs/usage.md#派发和追加需求)

## 安装

发起任务和接收任务的电脑都需要安装。按你准备用 sub2sub 的应用选择命令，并先登录该应用；接收任务的设备可以另外选择执行工具。安装包自带 Node 和证书生成能力，无需运行 npm。

### 让 AI 帮你安装

把下面这段话发给你正在使用的 Codex 或 Claude Code：

> 请按照 https://github.com/mekoand/sub2sub 的安装说明，为我当前使用的应用安装 sub2sub 最新正式版。请核对并报告安装版本，确认是最新正式版且已启用，再告诉我如何重启，以及第一次怎样使用。

助手会根据当前宿主和系统选择安装方法；无法执行安装时，可让它给出对应命令。安装后仍需按提示重启应用。你也可以按下方步骤手动安装。

### Codex

**macOS · 终端**（自动识别 Apple Silicon / Intel）

```sh
/bin/bash -o pipefail -c 'curl -fsSL https://github.com/mekoand/sub2sub/releases/latest/download/install.sh | /bin/bash'
```

**Windows x64 · PowerShell**

```powershell
irm https://github.com/mekoand/sub2sub/releases/latest/download/install.ps1 | iex
```

看到 `Installed sub2sub` 后，**完整退出并重新打开 Codex 桌面应用**；CLI 用户退出并重启 Codex。仅关闭窗口或新建对话可能仍加载旧插件。

### Claude Code

**macOS · 终端**（Apple Silicon / Intel）

```sh
/bin/bash -o pipefail -c 'curl -fsSL https://github.com/mekoand/sub2sub/releases/latest/download/install.sh | /bin/bash -s -- claude'
```

**Windows x64 · PowerShell**

```powershell
& ([scriptblock]::Create((irm https://github.com/mekoand/sub2sub/releases/latest/download/install.ps1))) -Target claude
```

安装后启动**新的 Claude Code 会话**。只发起任务的设备无需安装 Codex。接收方使用 Claude 执行目前需要 macOS；Windows 上的 Claude Code 可以发起委托。[版本要求与自定义路径](docs/install.md#claude-code)

### 确认已加载

重启应用后，在对话中说：

> 查询 sub2sub 状态和版本，不修改设置。

确认当前对话加载的版本。尚未开始接收任务时，共享节点处于停止状态是正常的。首次使用按提示检查设置；这一步不会自动开启跨网服务，也不等于文件传输授权。

以后在安装它的应用中说“升级 sub2sub”即可。配对和已保存成果会保留；重启应用后加载新版，运行中的共享节点则要等空闲后明确退出并重新开启。[安装、更新与故障排查](docs/install.md)

## 连接工作节点

设备处于不同网络时，先分别在双方设备上要求**开启跨网络连接服务**，该服务默认关闭。设备在私网内已可互通时，保持关闭即可。[跨网设置与旧连接迁移](docs/install.md#跨网络连接)

在准备**接收任务**的电脑上：

> 生成 sub2sub 邀请码。

在准备**发起任务**的电脑上粘贴邀请码：

> 连接这个 sub2sub 邀请码，把它叫作「办公室 Mac」。

按提示确认文件传输范围，并给连接取一个容易识别的名字。开启共享后节点独立运行，可以关闭管理对话；执行期间保持接收方电脑唤醒并联网。

## 先试一个小任务

在当前工作目录中选一个不含敏感内容的短文本文件，例如 `notes.txt`，然后说：

> 用 sub2sub 只把 notes.txt 交给「办公室 Mac」，整理成 summary.md，返回这个文件和简短答复。

任务完成后，打开本地 `summary.md` 链接。答复和文件都保存到本机才算这次委托完成；连接成功本身不代表任务完成。源文件保持不变。

需要修改时，在原对话继续说：

> 继续这个任务，把 summary.md 再精简一点，并保存最新成果到本地。

接收方沿用同一任务和工作文件。已经保存的成果在对方离线后仍可打开。[委托、成果与清理](docs/usage.md)

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

简洁的本机管理页，集中查看节点、任务和已保存成果，也能配对、调整设置、按需查询 Codex 额度。近 7 天或 30 天的资源统计，帮你看看任务交给了谁、跑了几轮、用了多少执行时间。还可按轮次、实际模型和来源查看原生用量，保留缺失项说明并导出 JSON，不计算价格。

管理页默认开启，可以随时关闭；它复用插件进程，不增加后台服务，也不会自动打开浏览器。任务指令和追问继续留在原对话里。[管理页与统计说明](docs/usage.md#本机管理页与统计)

## 跨网络使用

跨网络连接服务默认关闭。双方主动开启后，照常交换一个邀请码即可，用户无需为每项任务选择连接方式。系统优先尝试私网直连，必要时通过内置 Tailcat 连接，可使用公共中继。旧连接保持原方式，用户可以主动迁移。[开启与迁移说明](docs/install.md#跨网络连接)

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

如果 sub2sub 对你有帮助，欢迎到 [GitHub](https://github.com/mekoand/sub2sub) 关注更新或点一个 Star。

[MIT](LICENSE) © 2026 mekoand
