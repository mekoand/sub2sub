<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <img src="docs/assets/wordmark.svg" alt="sub2sub" width="420">
  </picture>
</h1>

**Share AI subscriptions across your team, task by task, without signing in to anyone else's account.**

Delegate work to another device, bring back responses and files, and request revisions in your current conversation. Connect directly on a private network, or enable cross-network service on both devices to use the same workflow across networks.

[![CI](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml/badge.svg)](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.9.2-6366f1)](CHANGELOG.md)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**English** · [简体中文](README.zh-CN.md) · [Install](docs/install.en.md) · [Usage](docs/usage.en.md)

</div>

sub2sub lets you delegate work through an AI subscription a teammate has authorized you to use. The provider stays signed in to Codex or Claude Code on their own device and authorizes connections through invitations. You submit a task and selected files from your own conversation, and their environment executes it.

Files and responses are saved on your device; the provider keeps their account login. For revisions, continue the same task from the original conversation, reusing its working files and session. The same workflow also works across your own devices.


## What you can do

- **Choose where each task runs.** Select an execution tool and available model from your paired nodes, with on-demand queries for a Codex node's remaining quota.
- **Bring back files and responses together.** Receive a complete local work copy with the inputs and latest changes. Decide when to apply them to your source project, and open saved results offline.
- **Request revisions on the same task.** “Improve the mobile layout too” continues with the provider's existing working files and session.
- **Choose session visibility.** New Codex tasks archive after each turn and restore on continuation by default. Providers can keep them in the native task list; existing tasks and file retention stay unchanged. [Details](docs/usage.en.md#delegated-session-visibility).
- **Keep sharing under the provider's control.** Providers choose authorized connections, an execution tool, and offered models. They can stop accepting new tasks at any time. Each node runs up to four tasks concurrently by default; the provider can adjust the limit. Full nodes reject new work without a queue, and lowering the limit lets existing tasks finish.

Good fits include organizing documents, building offline pages, and making code changes with clear inputs and outputs. Tasks run in separate work copies with task network access, MCP, app, and browser integrations disabled. Prepare the needed materials and local tools before delegating. [Execution scope and limits](docs/usage.en.md#delegate-and-follow-up)

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

After installation, start a **new Claude Code session**. Caller-only devices do not need Codex. Claude execution on receiving devices requires macOS; Windows can send tasks from Claude Code. [Requirements and custom paths](docs/install.en.md#claude-code)

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

The provider reuses the task's working files and Claude session. Only changed files are transferred back, and you receive a complete local copy. Once the result is ready:

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

Packages are available for macOS and Windows x64, with installation targets for Codex and Claude Code. Codex can execute on both platforms; Claude execution currently supports macOS. Task delegation is validated with Codex Desktop and with Codex CLI and Claude Code on macOS. WorkBuddy remains untested. [Validation details](docs/validation.md)

## Development

```sh
npm ci
npm run check
npm test
```

[Development and packaging](docs/development.md) · [Architecture](docs/architecture.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

If something gets stuck, ask “Help diagnose this sub2sub problem” in the original conversation. When you want to report it, say “Submit this issue to GitHub”. The assistant prepares a public-safe draft, checks for duplicates, and uses the host's existing submission tools. If those are unavailable, it gives you the draft. [Troubleshooting](docs/troubleshooting.en.md) · [Issues](https://github.com/mekoand/sub2sub/issues)

If sub2sub helps you, follow updates or leave a star on [GitHub](https://github.com/mekoand/sub2sub).

[MIT](LICENSE) © 2026 mekoand
