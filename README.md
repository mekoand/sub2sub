<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <img src="docs/assets/wordmark.svg" alt="sub2sub" width="420">
  </picture>
</h1>

**把任务交给合适的设备。**

面向团队和多设备用户的任务委托工具。

[![CI](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml/badge.svg)](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.5.1-6366f1)](CHANGELOG.md)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**简体中文** · [English](README.en.md) · [安装](docs/install.md)

</div>

sub2sub 让你在当前对话里，把任务和选定的文件交给另一台电脑上的 AI 执行，再把成果带回本地。你可以接着提出修改，也可以将完整成果保存下来，继续自己的工作。

## 为什么用 sub2sub

**让团队已有的工作环境用起来。** 同事可以把一台电脑开放为工作节点，大家按任务使用。设备拥有者决定何时接收工作、开放哪些模型；每个人管理自己的登录，使用者通过邀请码获得连接。

**多台电脑，保持一条工作线。** 在笔记本上提出需求，把代码修改、文档整理或数据处理交给工作机。完成后，文件和答复回到当前对话；补需求时继续原来的任务，不用重新整理输入。

**交到手的是完整成果。** 阶段结果保存在本地，执行设备离线后仍能打开。源项目不会被自动覆盖，你决定何时采用这些修改。

sub2sub 负责连接、传递任务和带回成果。任务由目标设备上的 AI 工作环境完成；它适合输入、目标和交付物明确的工作。每台工作节点同时执行一个任务，由你指定目标设备。

## 三步开始

### 1. 两台电脑各安装一次

先安装并登录 Codex，然后运行对应命令。安装包自带 Node 和证书生成能力，不需要下载源码、手工打包或安装 OpenSSL。

**macOS · Terminal**

```sh
/bin/bash -o pipefail -c 'curl -fsSL https://github.com/mekoand/sub2sub/releases/latest/download/install.sh | /bin/bash'
```

**Windows x64 · PowerShell**

```powershell
irm https://github.com/mekoand/sub2sub/releases/latest/download/install.ps1 | iex
```

安装完成后，开启新的 Codex 对话，或在终端启动 `codex`。再次运行同一条命令即可更新，保留已有配对和成果。[安装与卸载](docs/install.md)

### 2. 连接工作机

在执行任务的电脑上说：

> 生成 sub2sub 邀请码。

把邀请码私下发给使用者。在发起任务的电脑上说：

> 连接这个 sub2sub 邀请码，把它叫作「工作机」。

按提示确认文件传输范围。配对只需一次，后续任务直接使用这个名字。

### 3. 交给它一项工作

```text
用 sub2sub 把 docs 目录交给「工作机」，做成一个离线帮助站点，完成后检查链接。

继续这个任务，补上搜索和移动端排版。

保存最新成果，结束任务并清理远端工作副本。
```

收到的交付包含文字答复和本地完整文件。连续修改复用原来的远端工作副本，只回传变化的内容。

## 不在同一个局域网？

可以配合 **Tailscale** 使用：两台电脑先加入可互通的 Tailscale 网络，再让工作机使用自己的 Tailscale IPv4 地址生成邀请码。之后的连接、派发和续作步骤相同。

> 用 Tailscale 地址 100.x.x.x 生成 sub2sub 邀请码。

将示例地址换成工作机的实际地址。两端保持 Tailscale 在线，并允许访问共享端口（默认 `47631`）。[Tailscale 使用说明](docs/install.md#跨网络使用-tailscale)

## 日常直接问

| 想做的事 | 可以这样说 |
| --- | --- |
| 查看设备 | 查看 sub2sub 可用的工作节点。 |
| 查看成果 | 打开这个任务已保存到本地的成果。 |
| 调整默认模型 | 修改 sub2sub 的默认模型和思考强度。 |
| 限定本机提供的模型 | 设置这台电脑允许共享的模型。 |
| 停止接收新任务 | 停止 sub2sub 共享。 |

远端工作副本默认在最后一轮结束、闲置 7 天后具备清理条件，且必须已经确认保存成果。也可以像上面的例子一样，明确结束并立即清理。完整选项见[使用手册](docs/usage.md)。

## 兼容范围

**已在 Codex 桌面端验证双机完整流程，并在 macOS 的 Codex CLI 中完成实际任务派发、续作、回传和清理。** 各平台的具体覆盖见[验证记录](docs/validation.md)。Claude、WorkBuddy 等其他 harness 尚未实测，当前安装器面向 Codex。

- 安装包支持 Apple Silicon／Intel Mac 和 Windows x64。
- 支持局域网 IPv4，并已加入 Tailscale IPv4 地址支持；真实跨网络连接验证安排在后续版本。
- 执行设备需要保持共享进程运行。每轮最长 30 分钟，可分阶段继续。
- 当前任务使用独立文件副本，任务网络、MCP、应用和浏览器集成关闭。任务需要的资料和工具应事先准备好。
- 默认输入和单次回传分别限制为 20 MiB、2,000 个文件，可在高级设置中调整。

## 参与开发

```sh
npm ci
npm run check
npm test
```

[源码开发与打包](docs/development.md) · [架构](docs/architecture.md) · [贡献指南](CONTRIBUTING.md) · [版本记录](CHANGELOG.md)

遇到问题请查看[故障排查](docs/troubleshooting.md)，或在 [Issues](https://github.com/mekoand/sub2sub/issues) 提供系统、版本和复现步骤。

[MIT](LICENSE) © 2026 mekoand
