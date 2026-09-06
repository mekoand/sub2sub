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
[![Version](https://img.shields.io/badge/version-0.4.3-6366f1)](CHANGELOG.md)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**简体中文** · [English](README.en.md) · [安装](docs/install.md)

</div>

sub2sub 让你在当前对话里，把一项工作连同需要的文件交给另一台电脑。任务在那里执行，成果回到本地。后续修改沿用同一份工作文件和任务上下文。

## 团队与多设备

**团队共用工作节点。** 成员可以开放自己的设备，供同事按任务选择。何时接收任务、开放哪些模型，由设备拥有者决定；发起人负责说明目标、选择文件和接收成果。已有的连接可以继续使用，登录由各自管理。

**自己的电脑分工。** 在笔记本上提出需求，让台式机完成一项代码修改、文档整理或数据处理。你留在当前对话里查看结果、追加要求，已保存的成果直接从本地打开。

每个节点一次执行一个任务。sub2sub 按你指定的设备派发工作，适合有明确输入和产出的独立任务。

## 一次任务，接着做完

例如，把项目文档交给一台名为「工作机」的设备：

```text
把 docs 目录交给「工作机」，做成一个离线帮助站点，完成后检查链接。

继续这个任务，补上搜索和移动端排版。

保存最新成果，结束任务并清理远端工作副本。
```

第一次传送选定的文件。接着修改时，远端继续使用原来的工作副本；阶段结束后，只回传发生变化的内容。本地得到完整文件和文字答复，源项目由你决定何时合入。

```mermaid
flowchart LR
    A[选定文件与任务] --> B[指定工作节点]
    B --> C[执行与追加修改]
    C --> D[保存完整成果到本地]
```

## 开始使用

当前安装包接入 **Codex**。两端准备 Codex、Node.js 22+ 和 Git；执行任务的设备登录自己的 ChatGPT 账号，并安装 OpenSSL 用于首次生成共享身份。设备之间通过局域网连接，默认端口为 `47631`。

```sh
git clone https://github.com/mekoand/sub2sub.git
cd sub2sub
```

按 [macOS / Windows 安装指南](docs/install.md)完成两端安装，然后在对话中：

1. 在工作节点说“生成 sub2sub 邀请码”，将邀请码私下发给使用者。
2. 使用者粘贴邀请码，给设备取名，并确认任务文件的传输范围。
3. 指定这台设备和要完成的工作。收到成果后，可以继续修改或结束任务。

邀请码 10 分钟有效，使用一次后失效。配对完成后，后续任务继续使用这条连接。

## 设置与成果

发起方共用一套默认模型和思考强度，也可以为单个任务指定。工作节点选择开放全部可用模型或指定列表。可用设备、当前任务和共享状态，都可以在对话中查询。

每次成果保存后，本地都有完整任务副本。节点离线时，已保存文件仍可查看。默认输入和单次回传的上限分别为 20 MiB、2,000 个文件，可在高级设置中调整。

远端工作副本默认保留到最后一轮结束后闲置 7 天；成果已确认保存、执行已停止时才清理。也可以明确结束后立即清理。保留任务记录与原生会话时，之后可从本地副本恢复续作。详细的保留、恢复与删除选项见[使用手册](docs/usage.md)。

## 连接与执行

- 设备通过私有 IPv4 网络直连，工作节点的共享进程需要保持运行。
- 每个节点同时执行一个任务，每轮最长 30 分钟；较长工作可以分阶段续做。
- 任务使用独立工作副本。当前执行环境关闭任务网络、MCP、应用和浏览器集成，适合在已有工具与所选文件内完成的工作。
- macOS 与 Windows 已完成双机流程验证。平台要求、测试覆盖和运行细节见[安装指南](docs/install.md)与[验证记录](docs/validation.md)。

## 打包与开发

使用 Node.js 内置模块，没有第三方 npm 运行依赖。在源码根目录打包：

```sh
npm run package -- /absolute/new/location/sub2sub
```

父目录须存在，目标目录须尚未创建。Windows 包在目标设备上准备，会写入该机实际 Node 路径。安装、更新与卸载步骤见[安装指南](docs/install.md)。

macOS / Linux 开发检查：

```sh
npm run check
npm test
```

Windows 平台检查：

```powershell
node --test test/platform.test.mjs
```

[架构说明](docs/architecture.md)介绍模块划分；[贡献指南](CONTRIBUTING.md)说明如何提交修改。反馈问题请附上复现步骤、系统和版本，并移除邀请码及个人配置。

[使用手册](docs/usage.md) · [故障排查](docs/troubleshooting.md) · [版本记录](CHANGELOG.md) · [Issues](https://github.com/mekoand/sub2sub/issues)

[MIT](LICENSE) © 2026 mekoand
