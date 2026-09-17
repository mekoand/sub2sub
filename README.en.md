<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <img src="docs/assets/wordmark.svg" alt="sub2sub" width="420">
  </picture>
</h1>

**A safer, lighter, smoother way to share AI resources and work together.**

Currently supports Codex and Claude Code, with support for more tools in development.

[![CI](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml/badge.svg)](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.9.2-6366f1)](CHANGELOG.md)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**English** · [简体中文](README.zh-CN.md) · [Install](docs/install.en.md) · [Usage](docs/usage.en.md) · [Contribute](CONTRIBUTING.md) · [Security](SECURITY.md)

</div>

sub2sub connects your devices and those your teammates authorize you to use, so you can share AI resources and collaborate through familiar AI tools. Send selected files, bring responses and results back, and continue the same task in your conversation. Account credentials stay with their owners, and hosts control what they share.

A **Host** shares AI capabilities and executes authorized tasks. A **Client** delegates tasks and receives results. One device can serve both roles. Connect directly on a private network, or enable cross-network service on both devices.

Start with [installation](#install), then [connect two devices](#connect-your-work-nodes). For a first task, send a small non-sensitive text file and ask for a summary.

![sub2sub local management with synthetic demo data](docs/assets/management-demo.png)

*The current management UI with synthetic device names and task records; no real accounts or task content are shown.*

## What you can do

- **Choose where each task runs.** Select an execution tool and available model from your paired nodes, with on-demand queries for a Codex node's remaining quota. Optionally enable [ordered host selection](docs/usage.en.md#automatic-host-selection) before new task submission; submitted tasks never reroute automatically.
- **Bring back files and responses together.** Receive a complete local work copy with the inputs and latest changes. Decide when to apply them to your source project, and open saved results offline.
- **Request revisions on the same task.** “Improve the mobile layout too” continues with the host's existing working files and session.
- **Choose session visibility.** New Codex tasks archive after each turn and restore on continuation by default. Hosts can keep them in the native task list; existing tasks and file retention stay unchanged. [Details](docs/usage.en.md#delegated-session-visibility).
- **Keep sharing under the host's control.** Hosts choose authorized connections, an execution tool, and offered models. They can stop accepting new tasks at any time. Each node runs up to four tasks concurrently by default; the host can adjust the limit. Full nodes reject new work without a queue, and lowering the limit lets existing tasks finish.

Good fits include organizing documents, building offline pages, and making code changes with clear inputs and outputs. Tasks run in separate work copies with task network access, MCP, app, and browser integrations disabled. The host checks the environment needed for the task. By default, checks unavailable there can be completed on the client; an explicit requirement to run on the host still applies. Required checks must pass before claiming completion. [Execution scope and limits](docs/usage.en.md#delegate-and-follow-up)

## Install

Install on both the computer sending tasks and the computer receiving them. Choose the app where you will use sub2sub below; the receiving device can choose its execution tool separately. Sign in to that app first. Packages include Node and certificate generation; no npm setup is needed.

### Ask your AI to install it

Send this to the Codex or Claude Code app you are using:

> Follow the installation instructions at https://github.com/mekoand/sub2sub to install the latest stable sub2sub release for the app I am using. Check and report the installed version, confirm it is the latest stable release and enabled, then tell me how to restart and get started.

The assistant chooses the installation method for your host and system. If it cannot run the installer, ask for the matching command. Restart the app as instructed after installation. You can also install manually below.

### Codex

**macOS · Terminal** (Apple Silicon or Intel, detected automatically)

```sh
/bin/bash -o pipefail -c 'curl -fsSL https://github.com/mekoand/sub2sub/releases/latest/download/install.sh | /bin/bash'
```

**Windows x64 · PowerShell**

```powershell
irm https://github.com/mekoand/sub2sub/releases/latest/download/install.ps1 | iex
```

After `Installed sub2sub` appears, **fully quit and reopen Codex Desktop**, or exit and restart the Codex CLI. Closing only a window or starting another conversation may keep the old plugin loaded.

### Claude Code

**macOS · Terminal** (Apple Silicon or Intel)

```sh
/bin/bash -o pipefail -c 'curl -fsSL https://github.com/mekoand/sub2sub/releases/latest/download/install.sh | /bin/bash -s -- claude'
```

**Windows x64 · PowerShell**

```powershell
& ([scriptblock]::Create((irm https://github.com/mekoand/sub2sub/releases/latest/download/install.ps1))) -Target claude
```

After installation, start a **new Claude Code session**. Client-only devices do not need Codex. Claude execution on receiving devices requires macOS; Windows can send tasks from Claude Code. [Requirements and custom paths](docs/install.en.md#claude-code)

### Confirm that it loaded

In your restarted app, ask:

> Show sub2sub status and version without changing settings.

Check the version loaded in the current conversation. A stopped sharing node is normal before you start receiving tasks. On first use, review the settings when prompted; this does not enable cross-network service or authorize file transfer.

To update later, say “Upgrade sub2sub” in the app you installed it into. Pairings and saved results are preserved. Restart that app to load the update; an existing sharing node keeps running until you explicitly restart it while idle. [Install, update and troubleshooting](docs/install.en.md)

## Connect your work nodes

For devices on different networks, first ask to **enable cross-network connection service on each device**. It is off by default. For devices already reachable on a private network, leave it off. [Cross-network setup and existing connections](docs/install.en.md#cross-network-connections)

On the computer that will **receive tasks**:

> Generate a sub2sub invitation.

On the computer that will **send tasks**, paste that invitation:

> Connect this sub2sub invitation and name it office-mac.

Confirm the file-transfer scope when prompted. Give each connection a recognizable name. Sharing runs independently after startup: keep the receiving computer awake and connected; its management conversation can close.

## Try one small task

Choose a short, non-sensitive text file such as `notes.txt` in your current workspace, then ask:

> Use sub2sub to send only notes.txt to office-mac. Summarize it in summary.md and return that file and a short answer.

After the task completes, open the local `summary.md` link. Success means the answer and file have been saved on your computer; a connected node alone does not mean a task has completed. Your source file remains unchanged.

To revise the result in the same conversation:

> Continue that task. Make summary.md shorter and save the updated result locally.

The receiving device reuses the original task and working files. You can open saved results even when it goes offline. [Delegation, results and cleanup](docs/usage.en.md)

## Example: delegate from Codex to Claude

A teammate is signed in to Claude Code on their Mac and authorizes you to use it through sub2sub. In your own Codex conversation, pair with that device, name the connection `office-mac`, and delegate the documentation task:

> Use sub2sub to send the docs directory to office-mac. Build an offline help site with search, check the links, and return the complete files.

The result is saved locally. Take a look, spot a mobile layout that could use some work, and continue:

> Continue that task. Group the pages by topic and improve the mobile layout.

The host reuses the task's working files and Claude session. Only changed files are transferred back, and you receive a complete local copy. Once the result is ready:

> Save the latest results, finish the task, and clean up its remote work copy.

Your source project stays unchanged until you choose to apply the result. Saved files remain available when the node goes offline. [Usage, settings, and cleanup](docs/usage.en.md)

## A compact view of tasks and results

Say this in your conversation:

> Open sub2sub management.

The local management page provides a compact view for nodes, tasks, and saved results, with pairing, settings, and on-demand Codex quota queries. Resource statistics over 7 or 30 days show where your tasks went, how many turns ran, and their measured execution time. Native model usage is available by turn, model and source, with partial-data notes and JSON export; no prices are calculated.

Management is enabled by default and can be turned off at any time. It shares the plugin process, adds no background service, and does not open a browser automatically. Task instructions and follow-ups stay in your conversation. [Management and statistics](docs/usage.en.md#local-management-and-statistics)

## Across networks

Cross-network service is off by default. Enable it on both devices, then exchange one invitation as usual. Private connections are tried first; the bundled Tailcat transport can use public relays when needed. Users do not select routes per task. Existing connections keep their current route until explicitly migrated. [Setup and migration](docs/install.en.md#cross-network-connections).

## Compatibility

The managing app is where you use the plugin; the Host chooses its execution tool separately.

| System | Managing apps / Client | Host execution | Validation and limits |
| --- | --- | --- | --- |
| macOS (Apple Silicon / Intel packages) | Codex Desktop, Codex CLI, Claude Code | Codex or Claude Code | Real tasks and Mac-to-Mac transfers validated on Apple Silicon; Intel installation has not had equivalent device testing. |
| Windows x64 | Codex and Claude Code installation targets | Codex; Claude execution unavailable | Native installation, platform tests, and Mac-to-Windows Codex tasks validated; equivalent Windows Client end-to-end testing remains incomplete. |
| Linux | Source development only; no release installer/package | Not advertised as a supported Host platform | Linux source CI passes; this does not establish distribution or real-device support. |

WorkBuddy and other managing apps remain untested. [Versions and validation details](docs/validation.md)

The current release is [v0.9.2](https://github.com/mekoand/sub2sub/releases/tag/v0.9.2). `main` can contain changes awaiting release, including the Host/Client terminology and environment guidance described here. Connection Token budgets, expiry-based full cleanup, and automatic Host selection are tracked in [#60](https://github.com/mekoand/sub2sub/issues/60), [#61](https://github.com/mekoand/sub2sub/issues/61), and [#62](https://github.com/mekoand/sub2sub/issues/62); they are not part of v0.9.2. Check [releases](https://github.com/mekoand/sub2sub/releases) before relying on a feature.

## Development

```sh
npm ci --omit=optional --ignore-scripts
npm run check
npm test
```

[Development and packaging](docs/development.md) · [Architecture](docs/architecture.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

If something gets stuck, ask “Help diagnose this sub2sub problem” in the original conversation. When you want to report it, say “Submit this issue to GitHub”. The assistant prepares a public-safe draft, checks for duplicates, and uses the host's existing submission tools. If those are unavailable, it gives you the draft. [Troubleshooting](docs/troubleshooting.en.md) · [Issues](https://github.com/mekoand/sub2sub/issues)

## Contribute and give feedback

Documentation, translations, bug reproductions, focused fixes, and tool-adapter proposals are welcome. Start with the [contribution guide](CONTRIBUTING.md) ([中文](CONTRIBUTING.zh-CN.md)). Use [Issues](https://github.com/mekoand/sub2sub/issues) for bugs, proposals, and planned work; report vulnerabilities through the [private security channel](SECURITY.md). See the [changelog](CHANGELOG.md) for updates and the [MIT License](LICENSE) for licensing.

sub2sub is community-maintained. Please keep discussion respectful and evidence-based. You are responsible for following the terms of the AI services you use. This project is not an official OpenAI or Anthropic product and does not imply their endorsement.

[MIT](LICENSE) © 2026 mekoand
