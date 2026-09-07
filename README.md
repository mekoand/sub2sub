<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <img src="docs/assets/wordmark.svg" alt="sub2sub" width="420">
  </picture>
</h1>

**Give your AI a teammate.**

Delegate to Codex or Claude on another computer. Bring the results back to this conversation.

[![CI](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml/badge.svg)](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.7.0-6366f1)](CHANGELOG.md)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**English** · [简体中文](README.zh-CN.md) · [Install](docs/install.en.md) · [Usage](docs/usage.en.md)

</div>

You're working on your laptop while the office computer is idle. Or you're in Codex and want a hand from Claude on another Mac.

With sub2sub, delegate a self-contained task from your current Codex or Claude Code conversation to a computer shared by you or a teammate. Work and checks run in that computer's AI environment, and the results are saved locally for you. For revisions, just keep talking.

## What you can do

- **Put existing subscriptions and devices to work.** Connect several work nodes and choose the tool and model for each task. Each execution account stays on its own device.
- **Skip the context recap.** “Improve the mobile layout too” continues the same task, with its working files and conversation intact.
- **Spend less time moving files around.** Returned changes become a complete local copy. Decide when to apply them to your source project, and open saved results even when the node is offline.
- **Keep sharing on your terms.** Owners choose when to share, which tool to run, and which models to offer. You choose where each task goes; each node runs one task at a time.

Good fits include organizing documents, building offline pages, and making code changes with clear inputs and outputs. Tasks run in separate work copies with task network access, MCP, app, and browser integrations disabled. Prepare the needed materials and local tools before delegating. [Execution scope and limits](docs/usage.en.md#delegate-and-follow-up)

## Install

Install sub2sub on each computer where you want to send or receive tasks. Start with the devices you need and add more whenever you want.

For Codex, install it and sign in first, then run the command for your system. Packages include Node and certificate generation. Claude Code callers can use the [Claude installation commands](docs/install.en.md#claude-code) without installing Codex locally. On macOS, work nodes can offer Codex or Claude Code.

**macOS · Terminal**

```sh
/bin/bash -o pipefail -c 'curl -fsSL https://github.com/mekoand/sub2sub/releases/latest/download/install.sh | /bin/bash'
```

**Windows x64 · PowerShell**

```powershell
irm https://github.com/mekoand/sub2sub/releases/latest/download/install.ps1 | iex
```

Fully quit and reopen the Codex desktop app, or exit and restart `codex` in your terminal. On a new device, sub2sub shows all current settings and waits for your confirmation before proceeding. Later, say “Check sub2sub updates” or “Upgrade sub2sub” in that host. Installation preserves pairings and saved results; restarting the host loads the updated code, and running nodes are not automatically restarted. [Installation guide](docs/install.en.md)

## Connect your work nodes

On a device that will receive work:

> Generate a sub2sub invitation.

On a device that will send work, paste the invitation:

> Connect this sub2sub invitation and name it office-mac.

Confirm the file-transfer scope when prompted. Repeat for other nodes you want to use, giving each a recognizable name. Sharing runs independently after startup. Keep the receiving computer awake and connected; its management conversation can close.

## Try a round trip with your docs

Your laptop is connected to `office-mac` and `windows-pc`. The Windows node is busy with another task; the Mac is available and offers the model you need. Send the documentation work to the Mac:

> Use sub2sub to send the docs directory to office-mac. Build an offline help site with search, check the links, and return the complete files.

The result is saved locally. Take a look, spot a mobile layout that could use some work, and continue:

> Continue that task. Group the pages by topic and improve the mobile layout.

No need to explain everything again: the node reuses its working files and conversation. Only changed files are transferred back, and you receive a complete local copy. Once the result is ready:

> Save the latest results, finish the task, and clean up its remote work copy.

Your source project stays unchanged until you choose to apply the result. Saved files remain available when the node goes offline. [Usage, settings, and cleanup](docs/usage.en.md)

## A compact view of tasks and results

Say this in your conversation:

> Open sub2sub management.

Version 0.7.0 adds a compact local page for nodes, tasks, and saved results, with pairing, settings, and on-demand Codex quota queries. Resource statistics over 7 or 30 days show where your tasks went, how many turns ran, and their measured execution time.

Management is enabled by default and can be turned off at any time. It shares the plugin process, adds no background service, and does not open a browser automatically. Task instructions and follow-ups stay in your conversation. [Management and statistics](docs/usage.en.md#local-management-and-statistics)

## Across networks

Use [Tailscale](https://tailscale.com/) to connect participating devices across networks, then pair using each work node's Tailscale IPv4 address. Address support is included; real cross-network testing is planned for a later release. [Tailscale setup](docs/install.en.md#connecting-over-tailscale)

## Compatibility

Packages are available for macOS and Windows x64, with installation targets for Codex and Claude Code. Codex can execute on both platforms; Claude execution currently supports macOS. Task delegation is validated with Codex Desktop and with Codex CLI and Claude Code on macOS. WorkBuddy remains untested. [Validation details](docs/validation.md)

## Development

```sh
npm ci
npm run check
npm test
```

[Development and packaging](docs/development.md) · [Architecture](docs/architecture.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

If something gets stuck, ask “Help diagnose this sub2sub problem” in the original conversation. When you want to report it, say “Submit this issue to GitHub”. The assistant prepares a public-safe draft, checks for duplicates, and uses the host's existing submission tools. If those are unavailable, it gives you the draft. [Troubleshooting](docs/troubleshooting.en.md) · [Issues](https://github.com/mekoand/sub2sub/issues)

[MIT](LICENSE) © 2026 mekoand
