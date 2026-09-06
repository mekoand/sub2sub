<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <img src="docs/assets/wordmark.svg" alt="sub2sub" width="420">
  </picture>
</h1>

**让已有的 AI 订阅用起来。**

面向团队和多设备用户的任务委托工具。

[![CI](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml/badge.svg)](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.5.2-6366f1)](CHANGELOG.md)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md) · **简体中文** · [安装](docs/install.md)

</div>

团队的 AI 订阅、可用模型和工作环境，往往分散在不同账号与电脑上。sub2sub 让你把这些资源用于需要它们的任务：连接设备，选择执行节点，完成后将完整成果带回当前工作区。

[sub2api](https://github.com/Wei-Shaw/sub2api) 通过 API 网关分配订阅资源，sub2sub 将相近的思路用在完整任务上。工作在选定设备自己的 AI 环境中执行，使用该节点已登录的账号与可用模型。

一台电脑可以连接多个工作节点，每台电脑也可以按需发起或接收任务。节点拥有者决定何时开放、提供哪些模型；使用者决定每项任务交给谁。每个节点同时执行一个任务。

## 安装

在需要发起或接收任务的电脑上安装 sub2sub。按需安装，可以随时加入更多设备。

先安装并登录 Codex，再运行对应命令。安装包自带 Node 和证书生成能力。

**macOS · Terminal**

```sh
/bin/bash -o pipefail -c 'curl -fsSL https://github.com/mekoand/sub2sub/releases/latest/download/install.sh | /bin/bash'
```

**Windows x64 · PowerShell**

```powershell
irm https://github.com/mekoand/sub2sub/releases/latest/download/install.ps1 | iex
```

安装完成后，开启新的 Codex 对话，或在终端启动 `codex`。再次运行同一条命令即可更新，保留已有配对和成果。[安装指南](docs/install.md)

## 连接工作节点

在准备接收任务的设备上：

> 生成 sub2sub 邀请码。

在发起任务的设备上粘贴邀请码：

> 连接这个 sub2sub 邀请码，把它叫作「办公室 Mac」。

按提示确认文件传输范围。需要使用其他节点时，分别配对并取一个容易识别的名字。执行任务期间，接收方保持共享会话打开。

## 使用案例：团队文档整理

你的笔记本已连接「办公室 Mac」和「Windows 工作机」。Windows 节点正在处理另一项任务，Mac 空闲且提供你需要的模型，因此将文档工作交给 Mac：

> 用 sub2sub 把 docs 目录交给「办公室 Mac」，做成带搜索的离线帮助站点，检查链接并返回完整文件。

成果会保存到本地。打开检查页面后，继续同一任务：

> 继续这个任务，按主题分组页面，并调整手机上的排版。

节点沿用原有工作文件和对话，只回传变化的文件；你在本地得到完整副本。确认成果后：

> 保存最新成果，结束任务并清理远端工作副本。

源项目由你决定何时采用这些修改。节点离线后，已经保存的文件仍可打开。[使用、设置与清理](docs/usage.md)

## 跨网络使用

可以通过 [Tailscale](https://tailscale.com/) 连接不同网络中的设备，再使用各工作节点的 Tailscale IPv4 地址配对。地址支持已加入，真实跨网络实测安排在后续版本。[Tailscale 配置说明](docs/install.md#跨网络使用-tailscale)

## 兼容性

提供 macOS 和 Windows x64 安装包。已在 Codex 桌面端及 macOS 的 Codex CLI 中验证；Claude、WorkBuddy 等其他 harness 尚未实测。[验证详情](docs/validation.md)

## 开发

```sh
npm ci
npm run check
npm test
```

[开发与打包](docs/development.md) · [架构](docs/architecture.md) · [贡献指南](CONTRIBUTING.md) · [版本记录](CHANGELOG.md)

遇到问题可查看[故障排查](docs/troubleshooting.md)，或提交 [Issue](https://github.com/mekoand/sub2sub/issues)。

[MIT](LICENSE) © 2026 mekoand
