<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <img src="docs/assets/wordmark.svg" alt="sub2sub" width="420">
  </picture>
</h1>

**Make better use of your AI subscriptions.**

Task delegation across your devices and team.

[![CI](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml/badge.svg)](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.5.1-6366f1)](CHANGELOG.md)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**English** · [简体中文](README.zh-CN.md) · [Install](docs/install.en.md)

</div>

AI subscriptions, model access, and working environments are often spread across a team's accounts and computers. sub2sub lets you put those resources to work: connect your devices, choose a node for each task, and bring the complete results back to your current workspace.

Projects such as [sub2api](https://github.com/Wei-Shaw/sub2api) distribute subscription resources through an API gateway. sub2sub applies a related idea to complete tasks. Work runs in the selected device's own AI environment, using its signed-in account and available models.

One computer can connect to several work nodes, and any device can send or receive tasks. Each owner chooses when to share and which models to offer. You decide where each task runs; each node handles one task at a time.

## Install

Install sub2sub on each computer where you want to send or receive tasks. Start with the devices you need and add more whenever you want.

Install Codex and sign in first, then run the command for your system. Packages include Node and certificate generation.

**macOS · Terminal**

```sh
/bin/bash -o pipefail -c 'curl -fsSL https://github.com/mekoand/sub2sub/releases/latest/download/install.sh | /bin/bash'
```

**Windows x64 · PowerShell**

```powershell
irm https://github.com/mekoand/sub2sub/releases/latest/download/install.ps1 | iex
```

Open a new Codex conversation or start `codex` in your terminal. Run the same command again to update while keeping pairings and saved results. [Installation guide](docs/install.en.md)

## Connect your work nodes

On a device that will receive work:

> Generate a sub2sub invitation.

On a device that will send work, paste the invitation:

> Connect this sub2sub invitation and name it office-mac.

Confirm the file-transfer scope when prompted. Repeat for other nodes you want to use, giving each a recognizable name. Keep the receiving node's sharing session open while it is working.

## Example: a team's documentation task

Your laptop is connected to `office-mac` and `windows-pc`. The Windows node is busy with another task; the Mac is available and offers the model you need. Send the documentation work to the Mac:

> Use sub2sub to send the docs directory to office-mac. Build an offline help site with search, check the links, and return the complete files.

The result is saved locally. Open it, review the pages, then continue the same task:

> Continue that task. Group the pages by topic and improve the mobile layout.

The node reuses its working files and conversation. Only changed files are transferred back, and you receive a complete local copy. Once the result is ready:

> Save the latest results, finish the task, and clean up its remote work copy.

Your source project stays unchanged until you choose to apply the result. Saved files remain available when the node goes offline. [Usage, settings, and cleanup](docs/usage.en.md)

## Across networks

Use [Tailscale](https://tailscale.com/) to connect participating devices across networks, then pair using each work node's Tailscale IPv4 address. Address support is included; real cross-network testing is planned for a later release. [Tailscale setup](docs/install.en.md#connecting-over-tailscale)

## Compatibility

Packages are available for macOS and Windows x64. Validated with Codex Desktop and with Codex CLI on macOS; other harnesses, including Claude and WorkBuddy, have not been tested. [Validation details](docs/validation.md)

## Development

```sh
npm ci
npm run check
npm test
```

[Development and packaging](docs/development.md) · [Architecture](docs/architecture.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

For problems, see [troubleshooting](docs/troubleshooting.en.md) or open an [issue](https://github.com/mekoand/sub2sub/issues).

[MIT](LICENSE) © 2026 mekoand
