# Install, update, and remove

[简体中文](install.md) · [Back to README](../README.md)

Install sub2sub on each computer that will send or receive tasks. Add as many devices as you need: one computer can connect to several work nodes and can act as both caller and provider. Each work node signs in with its own Codex account and stays online while working.

## One-command installation

Install and sign in to a plugin-capable Codex version first. Packages support Apple Silicon / Intel Macs and Windows x64, and include Node and certificate-generation dependencies.

macOS, in Terminal:

```sh
/bin/bash -o pipefail -c 'curl -fsSL https://github.com/mekoand/sub2sub/releases/latest/download/install.sh | /bin/bash'
```

Windows, in the desktop user's PowerShell session:

```powershell
irm https://github.com/mekoand/sub2sub/releases/latest/download/install.ps1 | iex
```

After `Installed sub2sub` appears, open a new Codex conversation. CLI users should restart `codex`. Ask to generate a sub2sub invitation or paste an invitation from the other computer.

The installer downloads and checks the release, locates Codex, and installs through its native plugin commands. No manual directories, JSON editing, or npm commands are needed. Git is only needed for selecting a whole Git repository; explicitly selecting files or directories works without it.

Default program locations:

- macOS: `~/.local/share/sub2sub`
- Windows: `%LOCALAPPDATA%\sub2sub`

Download archives from [Releases](https://github.com/mekoand/sub2sub/releases). See [development](development.md) for source installation and packaging.

## First connection

1. Ask the work node to generate a sub2sub invitation. If several network addresses appear, choose one the other device can reach.
2. Paste the invitation on the calling computer, name the connection, and confirm the file-transfer scope.
3. Delegate a task using that name. Open the local deliverables, request changes, or finish the task.

Invitations are single-use and expire after 10 minutes. Paired connections can be reused. If the operating system asks for network access, allow the work node to accept connections on the private network you use. The default port is `47631`.

Repeat pairing to add other nodes, give each a name, then choose a node for each task. Each node runs one task at a time.

## Using the CLI

Run `codex` after installation and use the same invitation, delegation, and follow-up prompts in the interactive session. Keep the work node's CLI session open: exiting closes the sharing process it hosts. `codex exec` can send tasks, but should not host a work node that needs to stay online.

## Connecting over Tailscale

For computers on different networks, [Tailscale](https://tailscale.com/download) can provide connectivity:

1. Install Tailscale on the devices that need cross-network connections and join a network where they can reach each other. Teams can invite members or share individual devices.
2. Find the work node's IPv4 address in Tailscale.
3. Ask it to generate a sub2sub invitation using that address, for example `100.x.x.x` with the actual address substituted.
4. Paste the invitation as usual. Keep Tailscale connected and allow the caller to reach the work node's sharing port.

Router port forwarding and Tailscale Funnel are not needed. sub2sub uses the Tailscale IPv4 address; MagicDNS names and IPv6 are not currently accepted. Existing pairings remember their network address. When switching from LAN to Tailscale, save results and close the session hosting the work node. Start sharing in a new session using its Tailscale address, then ask the caller's assistant to update the connection address.

Version 0.5 accepts the usual Tailscale `100.64.0.0/10` range, with automated address-handling tests. Real cross-network pairing and result delivery will be tested in a later release. [Tailscale address documentation](https://tailscale.com/docs/concepts/tailscale-ip-addresses)

## Update

Finish or cancel active work and save its results, then run the installation command again. The installer refreshes cached plugin files and startup paths while keeping pairings, certificates, and task data. Older program versions remain available; existing sessions are not forcibly terminated. Start a new conversation on each updated device.

The installer uses the plugin ID `sub2sub@sub2sub`. After confirming the new installation is enabled, it removes older sub2sub installations from other sources to prevent duplicate loading. Other plugins and old marketplace catalogs remain unchanged.

Set `SUB2SUB_VERSION` before running the same command to select a published version that includes installer assets. Check release notes before downgrading across major versions so older code does not operate on incompatible task data.

## Installation problems

- **Download failed:** check access to GitHub Releases, then run the command again.
- **Codex not found:** open and sign in to Codex first. For custom locations, set `SUB2SUB_CODEX` to the native executable's absolute path. Windows requires `codex.exe`, not a `.cmd` or `.bat` launcher.
- **Installed but no tools:** start a new conversation or restart the CLI. `codex plugin list` should show `sub2sub@sub2sub` installed and enabled.
- **Windows SSH cannot access the desktop package:** install and run from the desktop user's PowerShell. SSH system sessions can have different app access and sandbox behavior.

Use `SUB2SUB_INSTALL_DIR` for a custom program directory and keep using it for updates. See [troubleshooting](troubleshooting.en.md) for other errors.

## Stop or remove

Ask to stop sub2sub sharing to stop accepting new tasks while allowing existing work to finish and be collected. Closing the provider process interrupts execution.

Save the results you need, then uninstall in the plugin directory or run:

```sh
codex plugin remove sub2sub@sub2sub
```

Uninstalling the plugin does not delete saved results. Use the [cleanup options](usage.en.md#task-lifecycle) for tasks and native history. To reclaim old program storage, close sessions using those versions and remove their subdirectories under `versions`, keeping the currently installed version.
