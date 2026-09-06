<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <img src="docs/assets/wordmark.svg" alt="sub2sub" width="420">
  </picture>
</h1>

**Send the task to the right device.**

Task delegation for teams and people who work across computers.

[![CI](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml/badge.svg)](https://github.com/mekoand/sub2sub/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.5.0-6366f1)](CHANGELOG.md)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[简体中文](README.md) · **English** · [Install](docs/install.en.md)

</div>

sub2sub sends a task and selected files to an AI working on another computer, then brings the results back to your current conversation. Ask for another change, or save the complete result and carry on with your work.

## Why sub2sub

**Make your team's working environments available.** A teammate can share a computer as a work node. Its owner decides when to accept tasks and which models to offer. Everyone manages their own login; invitations authorize connections.

**Keep one workflow across your computers.** Describe a code change, documentation update, or data-processing task on your laptop and send it to your workstation. Files and a written response return to your conversation. Follow-ups continue the same task without preparing the inputs again.

**Keep the complete result.** Saved results stay on your computer and remain readable when the work node goes offline. Your source project is not overwritten automatically. You decide when to adopt the changes.

sub2sub connects devices, delivers tasks, and returns results. The AI environment on the selected device does the work. Use it for tasks with clear inputs, goals, and deliverables. You choose the destination; each work node runs one task at a time.

## Start in three steps

### 1. Install on both computers

Install Codex and sign in first, then run the command for your system. Release packages include Node and certificate generation. No source checkout, manual packaging, or OpenSSL installation is needed.

**macOS · Terminal**

```sh
/bin/bash -o pipefail -c 'curl -fsSL https://github.com/mekoand/sub2sub/releases/latest/download/install.sh | /bin/bash'
```

**Windows x64 · PowerShell**

```powershell
irm https://github.com/mekoand/sub2sub/releases/latest/download/install.ps1 | iex
```

Open a new Codex conversation after installation, or start `codex` in your terminal. Run the same command again to update while keeping existing pairings and results. [Installation and removal](docs/install.en.md)

### 2. Connect a work node

On the computer that will execute tasks, say:

> Generate a sub2sub invitation.

Share the invitation privately. On the computer sending the work, say:

> Connect this sub2sub invitation and name it workstation.

Confirm the file-transfer scope when prompted. Pair once, then use the name for later tasks.

### 3. Give it a task

```text
Use sub2sub to send the docs directory to workstation. Build an offline help site and check its links.

Continue that task. Add search and a mobile layout.

Save the latest results, finish the task, and clean up its remote work copy.
```

Delivery includes a written response and complete local files. Follow-ups reuse the remote work copy and return only the changes.

## Working from different networks?

Use **Tailscale** to connect the computers. Join a Tailscale network where both devices can reach each other, then generate the invitation using the work node's Tailscale IPv4 address. Pairing, delegation, and follow-ups work the same way.

> Generate a sub2sub invitation using the Tailscale address 100.x.x.x.

Replace the example with the node's actual address. Keep Tailscale connected and allow access to the sharing port, `47631` by default. [Tailscale setup](docs/install.en.md#connecting-over-tailscale)

## Just ask

| What you need | Example |
| --- | --- |
| Available devices | Show available sub2sub work nodes. |
| Saved results | Open the results already saved on this computer. |
| Default model | Change the default sub2sub model and reasoning effort. |
| Models this computer offers | Set the models this computer allows others to use. |
| Stop accepting new work | Stop sub2sub sharing. |

Remote work copies become eligible for cleanup after 7 idle days following the last turn, once the results are confirmed saved. You can also finish and clean up explicitly, as in the example above. See the [usage guide](docs/usage.en.md) for all options.

## Compatibility

**The full two-device workflow has been validated in Codex Desktop. Task delegation, follow-ups, result delivery, and cleanup have also been exercised through Codex CLI on macOS.** See the [validation record](docs/validation.md) for platform coverage. Other harnesses, including Claude and WorkBuddy, have not been tested. The current installer targets Codex.

- Release packages support Apple Silicon / Intel Macs and Windows x64.
- LAN IPv4 is supported, along with Tailscale IPv4 address handling. Real cross-network testing is planned for a later release.
- The work node's sharing process must stay running. Each turn can run for up to 30 minutes; longer work can continue in phases.
- Tasks use separate work copies. Task network access, MCP, app, and browser integrations are disabled. Prepare the required inputs and local tools beforehand.
- Input and individual result transfers each default to 20 MiB and 2,000 files. Advanced settings can adjust these limits.

## Contribute

```sh
npm ci
npm run check
npm test
```

[Development and packaging](docs/development.md) · [Architecture](docs/architecture.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

Check [troubleshooting](docs/troubleshooting.en.md), or open an [issue](https://github.com/mekoand/sub2sub/issues) with your system, version, and reproduction steps.

[MIT](LICENSE) © 2026 mekoand
