# Development and packaging

[README](../README.md) · [中文 README](../README.zh-CN.md)

End users should use the [installer](install.en.md). Source development requires Node.js 22+, npm, and Git.

```sh
git clone https://github.com/mekoand/sub2sub.git
cd sub2sub
npm ci
npm run check
npm test
```

Windows platform checks:

```powershell
npm ci
node --test test/platform.test.mjs
```

The runtime uses Node built-ins, `selfsigned` for certificates, and the official Claude Agent SDK for Claude execution. The SDK uses the provider's native Claude CLI; platform-specific optional CLI binaries are excluded from packages. Dependencies are included in release packages, together with their license files. Existing sharing identities are reused.

## Plugin folder

```sh
npm run package -- /absolute/new/location/sub2sub
```

The parent must exist and the target must be new. This copies production dependencies, skills, manifests, and user documentation. Run `npm ci --omit=dev --omit=optional --ignore-scripts` before preparing a distribution. A source package uses your existing Node runtime.

For real task tests, use the standalone Node included in a release package. Some system builds, such as Homebrew Node, depend on external dynamic libraries that a delegated task cannot read, even when the plugin itself starts successfully.

On Windows, packaging writes the current Node.exe path into `.mcp.json`. For a known destination path when packaging elsewhere:

```sh
node scripts/package.mjs /absolute/new/location/sub2sub --windows-node 'C:\Program Files\nodejs\node.exe'
```

Register source packages through a local Codex marketplace using [OpenAI's plugin instructions](https://developers.openai.com/plugins/build/plugins). The example in [examples/marketplace.json](https://github.com/mekoand/sub2sub/blob/main/examples/marketplace.json) expects `./plugins/sub2sub` relative to the marketplace root. The public installer uses a separate `sub2sub` marketplace and handles this setup automatically.

## Complete releases

Build on macOS or Linux with `tar`, `zip`, and `unzip` installed:

```sh
npm ci --omit=dev --omit=optional --ignore-scripts
npm run release -- /absolute/output/directory
```

The builder downloads Node from nodejs.org, checks its published checksum, and creates:

- `sub2sub-darwin-arm64.tar.gz`
- `sub2sub-darwin-x64.tar.gz`
- `sub2sub-win32-x64.zip`
- `install.sh`, `install.ps1`, and `SHA256SUMS`

Each archive contains the plugin, its dependencies, and a private Node runtime with the Node license. It contains no credentials, pairings, task history, or user files. Installation generates machine-specific startup paths.

The installer accepts an optional `codex` or `claude` target. Both use the same release directory and runtime. Claude receives a small plugin directory containing the shared Skill, documentation and an MCP entry pointing to that runtime and task service. Its local marketplace is separate from Codex's; updates register only the selected host. Installation selects the management host only. The node independently selects Codex App Server or Claude Agent SDK for execution; both use the same provider lifecycle and delivery code.

Keep the version in `package.json`, `.codex-plugin/plugin.json`, and both bootstrap scripts aligned. The release workflow builds assets as a draft release. Publish that draft after reviewing CI and installer smoke tests so the README's `latest/download` links remain usable.
