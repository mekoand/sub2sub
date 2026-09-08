# Install, update, and remove

[简体中文](install.md) · [Back to README](../README.md)

Install sub2sub on both the sending and receiving computers. The provider signs in to its chosen Codex or Claude Code subscription account and authorizes pairing. The caller delegates from its own conversation without signing in to the provider's account. The executing device stays online while working. Any computer can send or receive tasks and connect to multiple devices.

Follow the installation and host restart steps below, then generate or connect an invitation in your conversation to start [your first delegation](usage.en.md#delegate-and-follow-up). To look around first, say “Open sub2sub management”. It's enabled by default, can be turned off at any time, and won't open a browser automatically. [Management guide](usage.en.md#local-management-and-statistics)

## Codex

Install and sign in to a plugin-capable Codex version first. Packages support Apple Silicon / Intel Macs and Windows x64, and include Node and certificate-generation dependencies.

macOS, in Terminal:

```sh
/bin/bash -o pipefail -c 'curl -fsSL https://github.com/mekoand/sub2sub/releases/latest/download/install.sh | /bin/bash'
```

Windows, in the desktop user's PowerShell session:

```powershell
irm https://github.com/mekoand/sub2sub/releases/latest/download/install.ps1 | iex
```

After `Installed sub2sub` appears, **fully quit and reopen the Codex desktop app**. Closing a window or starting a new conversation may retain the old plugin process. CLI users should exit and restart `codex`. Ask to generate a sub2sub invitation or paste an invitation from the other computer.

The installer downloads and checks the release, locates Codex, and installs through its native plugin commands. No manual directories, JSON editing, or npm commands are needed. Git is only needed for selecting a whole Git repository; explicitly selecting files or directories works without it.

Default program locations:

- macOS: `~/.local/share/sub2sub`
- Windows: `%LOCALAPPDATA%\sub2sub`

Download archives from [Releases](https://github.com/mekoand/sub2sub/releases). See [development](development.md) for source installation and packaging.

## Claude Code

Install the native Claude Code CLI and sign in, then run the command for your system. A computer that only sends tasks from Claude Code does not need Codex installed. A macOS work node can also execute through its Claude subscription: install Claude Code 2.1.263 or later, sign in, then ask sub2sub to select Claude as the provider tool. This selection is independent of the app used to manage sub2sub. Claude execution on Windows is not supported yet.

macOS:

```sh
/bin/bash -o pipefail -c 'curl -fsSL https://github.com/mekoand/sub2sub/releases/latest/download/install.sh | /bin/bash -s -- claude'
```

Windows PowerShell:

```powershell
& ([scriptblock]::Create((irm https://github.com/mekoand/sub2sub/releases/latest/download/install.ps1))) -Target claude
```

Start a new `claude` session after installation. `claude plugin list` should show `sub2sub@sub2sub` enabled. Connect an invitation from a work node and delegate tasks in the same conversation. The installer registers a native Claude plugin with the existing Skill and MCP service through a local marketplace, following [Claude's plugin model](https://code.claude.com/docs/en/plugins-reference#mcp-servers).

Both installation targets can coexist in the same program directory and reuse pairings and saved results. Run the command for each host you use. Updates use the same command and target; a Claude update does not update Codex's cached plugin, or vice versa.

## First connection

1. Ask the work node to generate a sub2sub invitation. If several network addresses appear, choose one the other device can reach.
2. Paste the invitation on the calling computer, name the connection, and confirm the file-transfer scope.
3. Delegate a task using that name. Open the local deliverables, request changes, or finish the task.

Invitations are single-use and expire after 10 minutes. Paired connections can be reused. If the operating system asks for network access, allow the work node to accept connections on the private network you use. The default port is `47631`.

Repeat pairing to add other nodes, give each a name, then choose a node for each task. Each node runs up to four tasks concurrently by default. Providers can adjust the limit; full nodes reject new work without a queue.

## Using the CLI

Run `codex` after installation and use the same invitation, delegation, and follow-up prompts in the interactive session. Starting sharing creates an independent node. Closing the CLI session leaves it available; a later session reconnects to the same node. One-shot CLI calls can start sharing too. The computer must remain awake and connected; start sharing manually after a reboot.

## Connecting over Tailscale

For computers on different networks, [Tailscale](https://tailscale.com/download) can provide connectivity:

1. Install Tailscale on the devices that need cross-network connections and join a network where they can reach each other. Teams can invite members or share individual devices.
2. Find the work node's IPv4 address in Tailscale.
3. Ask it to generate a sub2sub invitation using that address, for example `100.x.x.x` with the actual address substituted.
4. Paste the invitation as usual. Keep Tailscale connected and allow the caller to reach the work node's sharing port.

Router port forwarding and Tailscale Funnel are not needed. sub2sub uses the Tailscale IPv4 address; MagicDNS names and IPv6 are not currently accepted. Existing pairings remember their network address. When switching from LAN to Tailscale, save results and explicitly exit the sub2sub node. Start sharing again using its Tailscale address, then ask the caller's assistant to update the connection address.

Version 0.5 accepts the usual Tailscale `100.64.0.0/10` range, with automated address-handling tests. Real cross-network pairing and result delivery will be tested in a later release. [Tailscale address documentation](https://tailscale.com/docs/concepts/tailscale-ip-addresses)

## Update

Say “check sub2sub updates” in your conversation. The assistant calls `update_plugin` with `action=check`, a read-only query for the latest published stable release. It distinguishes the current conversation version, the host's actual registered installation and the running node version. An unreachable or stopped node is reported explicitly; loaded code is not proof of the installed version.

An explicit “upgrade sub2sub” request permits `action=install`. This reuses the release download, checksum and installer flow for the managing host's registered directory. It does not infer the host from the provider execution tool, create another installation or downgrade a newer/source/prerelease installation. If older installation metadata cannot identify the host, specify it; if registration cannot establish the directory, use the original installation procedure above. Codex and Claude installations update separately.

Active tasks, unsaved caller work or uncertain local state defer installation. Wait for work to end, check task status and save results, then retry. Upgrading does not cancel tasks, clean data or restart nodes. Pairings, certificates, configuration, task data, saved results and previous program versions are retained. Errors identify the check or download/installation stage. After an interrupted attempt, inspect the host plugin list before retrying; an installation attempt is not confirmed success.

After installation is verified in host registration, fully quit and reopen the Codex desktop app. A new conversation or closing its window does not ensure the new code is loaded. CLI users should exit and restart `codex` or `claude`. Independent nodes keep running the old version; when idle, use the existing exit-node and start-sharing operations from the new session. **For 0.5.3, sharing belongs to the old provider conversation and has no independent-node exit command: finish work and save results, end that old provider conversation, then start sharing in the new one.** Version 0.5.3 has no conversation update tool, so its first upgrade still uses the installation command above. Pair again only if identity changed. Peers use existing capability checks; arbitrary old/new combinations are not guaranteed compatible.

Both hosts use the plugin ID `sub2sub@sub2sub`. The Codex installer also migrates older sub2sub installations from other sources after confirming the replacement is enabled. The Claude installer manages its user-scope installation only. Other plugins remain unchanged.

Set `SUB2SUB_VERSION` before running the same command to select a published version that includes installer assets. Exit the node and check release notes before downgrading. Older releases do not support Claude tasks or per-tool settings: save and finish Claude work, clean up its history if desired, and switch back to Codex first. Do not use an older release to continue or clean up retained Claude tasks.

## Installation problems

- **Download failed:** check access to GitHub Releases, then run the command again.
- **Codex not found:** open and sign in to Codex first. For custom locations, set `SUB2SUB_CODEX` to the native executable's absolute path. Windows requires `codex.exe`, not a `.cmd` or `.bat` launcher.
- **Claude not found:** restart your terminal after installing the native Claude Code CLI. For a custom location, set `SUB2SUB_CLAUDE` to the executable's absolute path; Windows requires `claude.exe`.
- **Installed but no tools:** fully quit and reopen the Codex desktop app, or exit and restart the CLI. Run `codex plugin list` or `claude plugin list` for the host you use; it should show `sub2sub@sub2sub` installed and enabled.
- **Windows SSH cannot access the desktop package:** install and run from the desktop user's PowerShell. SSH system sessions can have different app access and sandbox behavior.

Use `SUB2SUB_INSTALL_DIR` for a custom program directory and keep using it for updates. See [troubleshooting](troubleshooting.en.md) for other errors.

## Stop or remove

Ask to stop sub2sub sharing to stop accepting new tasks while allowing existing work to finish and be collected. To stop the background process too, ask to exit the sub2sub node. An active task must finish or be cancelled first. Closing the management app alone leaves the node running.

Save the results you need and exit the node, then uninstall in the plugin directory or run:

```sh
codex plugin remove sub2sub@sub2sub
```

For Claude Code, use `claude plugin uninstall sub2sub@sub2sub --scope user`. Each command removes only that host's plugin registration.

Uninstalling the plugin does not delete saved results. Use the [cleanup options](usage.en.md#task-lifecycle) for tasks and native history. To reclaim old program storage, close sessions using those versions and remove their subdirectories under `versions`, keeping the currently installed version.
