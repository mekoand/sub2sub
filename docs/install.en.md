# Install, update, and uninstall

[README](../README.en.md) · [简体中文](install.md) · [Troubleshooting](troubleshooting.en.md)

This guide prepares a package from source and installs it through a dedicated local marketplace. Install on both devices. Run the provider from its desktop login session; routine use then happens in Codex conversations.

## Requirements

- Node.js 22+, Git, and Codex supporting native plugins and the required App Server permission APIs.
- A provider signed into Codex with its own ChatGPT account. OpenSSL must be on PATH for the first sharing identity.
- Matching sub2sub versions on both devices and direct private IPv4 connectivity.
- Inbound access to the chosen provider port,47631 by default. Select an appropriate local-network scope when the OS asks.

```sh
node --version
codex --version
openssl version
```

OpenSSL is needed to create the provider identity; existing identities are reused. Version 0.4.2 supplies its own temporary minimal configuration and does not require `OPENSSL_CONF`. There are no npm dependencies to install.

The normal Codex installation commands persist marketplace and enablement settings. You run these commands in your terminal; do not edit global Codex configuration or approval rules manually. Command syntax follows the [official plugin guide](https://developers.openai.com/plugins/build/plugins) and Codex 0.152.x CLI help.

## 1. Get the source

```sh
git clone https://github.com/mekoand/sub2sub.git
cd sub2sub
```

Use a **new dedicated directory** for the following steps. If it already exists, choose another name rather than overwriting an existing marketplace or old package.

## 2A. Prepare on macOS

Run from the repository root:

```sh
sub2sub_market="$HOME/sub2sub-marketplace"
mkdir "$sub2sub_market"
mkdir -p "$sub2sub_market/plugins" "$sub2sub_market/.agents/plugins"
node scripts/package.mjs "$sub2sub_market/plugins/sub2sub"
cp examples/marketplace.json "$sub2sub_market/.agents/plugins/marketplace.json"
/bin/sh "$sub2sub_market/plugins/sub2sub/bin/launch.sh" --check
```

The final package directory must be named `sub2sub`, its parent must exist, and the target itself must not exist. The launcher checks `SUB2SUB_NODE`, bundled application runtimes, Homebrew, and PATH for a working Node 22+ executable.

The check reports actual Node/Codex paths and state information. It does not create an invitation or start sharing. If `codex` is not on PATH, use the application's actual executable path in subsequent commands.

## 2B. Prepare on Windows

Run PowerShell **on the target Windows device**, from the repository root:

```powershell
$sub2subMarket = Join-Path $HOME 'sub2sub-marketplace'
New-Item -ItemType Directory -Path $sub2subMarket -ErrorAction Stop
New-Item -ItemType Directory -Path "$sub2subMarket\plugins", "$sub2subMarket\.agents\plugins" -Force
node .\scripts\package.mjs "$sub2subMarket\plugins\sub2sub"
Copy-Item .\examples\marketplace.json "$sub2subMarket\.agents\plugins\marketplace.json"
node "$sub2subMarket\plugins\sub2sub\scripts\setup-check.mjs"
```

Packaging on Windows writes the **current Node.exe absolute path** to the generated `.mcp.json` and launches `bin/mcp.mjs` directly. It does not require `/bin/sh`. Rebuild and reinstall if Node moves. Do not install the source root's macOS launcher configuration directly, or copy POSIX `npm start` / `npm run check` commands into PowerShell.

The provider needs native `codex.exe`. An npm `.cmd` / `.bat` shim is not a valid direct provider executable. If discovery fails, set the actual native path in sub2sub's own `provider.codexPath` configuration. Paths are device-specific.

<details>
<summary>Native codex.exe not found after an npm install</summary>

From the source repository root, run this PowerShell snippet. It searches only npm’s `@openai` directory and, with one candidate, updates sub2sub’s own `provider.codexPath` while preserving other settings. If there are no or multiple candidates, identify the correct binary for this installation first. Stop sharing before this change and restart the plugin afterwards.

```powershell
$sub2subNpmRoot = (npm.cmd root -g).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot locate global npm packages.' }
$sub2subNative = @(Get-ChildItem -LiteralPath (Join-Path $sub2subNpmRoot '@openai') -Recurse -File -Filter codex.exe -ErrorAction Stop)
$sub2subNative.FullName
if ($sub2subNative.Count -ne 1) { throw 'Select the native codex.exe for this device; no configuration was changed.' }
@'
import os from 'node:os';
import path from 'node:path';
import { Config } from './lib/config.mjs';
const file = process.env.SUB2SUB_CONFIG || path.join(os.homedir(), '.config/sub2sub/config.json');
await new Config(file).update(config => {
  config.provider = { ...config.provider, codexPath: process.argv[2] };
});
'@ | node --input-type=module - "$($sub2subNative[0].FullName)"
if ($LASTEXITCODE -ne 0) { throw 'Configuration update failed.' }
node "$sub2subMarket\plugins\sub2sub\scripts\setup-check.mjs"
```

</details>

Cross-platform packaging is available when the target path is known:

```sh
node scripts/package.mjs /absolute/new/location/sub2sub --windows-node 'C:\Program Files\nodejs\node.exe'
```

That path must match the target computer; it is an example, not a universal installation location.

## 3. Register and install

macOS:

```sh
codex plugin marketplace add "$sub2sub_market"
codex plugin add sub2sub@sub2sub-local
```

Windows PowerShell:

```powershell
codex plugin marketplace add "$sub2subMarket"
codex plugin add sub2sub@sub2sub-local
```

Alternatively, register the marketplace, restart the desktop app, select **sub2sub Local** in the plugin directory, and install. Update Codex first if these commands or required permission APIs are unavailable.

The example's `./plugins/sub2sub` path is relative to the marketplace root, not `.agents/plugins/`. It registers a dedicated catalog without replacing your existing personal plugin list.

```sh
codex plugin list
```

Confirm installation and enablement, then start a **new Codex conversation**. Editing source files or a package does not update an already-running plugin process.

## 4. Pair and try a task

1. Ask the provider to generate a sub2sub invitation. Select a reachable LAN address if multiple interfaces exist.
2. Share it privately; the caller pastes it and names the connection. Invitations expire after 10 minutes and work once.
3. Confirm the task-file scope, delegate a small task, and verify a successful local save.
4. Continue the same delegated task for follow-ups; pairing is not repeated each turn.

Start a Windows provider from the desktop login session. In the tested environment, the SSH system session could not initialize the native sandbox while the same program worked in the desktop session. This observation is not a claim about every Windows setup.

## Update and roll back

1. Finish or cancel active work, collect necessary results, and complete pending save confirmations.
2. Stop accepting new tasks; keep the old package and local results.
3. Prepare the target version in a new directory, check it, and update through Codex's plugin installation flow on both devices.
4. Start new conversations, verify the loaded version and tools, then resume sharing.

Versions 0.4.x use complete local copies and incremental synchronization. Old tasks do not retroactively receive the seven-day retention policy. When rolling back to 0.3, use a separate sub2sub state directory rather than having old code interpret new synchronization records.

Pairing, certificates, and task state live in sub2sub's own directories, not the package. Do not remove them as an update step. Adjust changed marketplace paths through Codex marketplace management instead of replacing global configuration files.

## Stop and uninstall

Stopping sharing rejects new work while allowing the current task to finish and results to be collected. Exiting the hosting process interrupts execution. Restart sharing to reuse existing pairings.

After execution stops and necessary results are saved, uninstall through the plugin directory or:

```sh
codex plugin remove sub2sub@sub2sub-local
```

Uninstalling code does not delete task data, native history, or local results. Apply the intended [cleanup choice](usage.en.md#task-lifecycle) before uninstalling.
