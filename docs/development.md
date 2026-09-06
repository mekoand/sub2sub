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

The runtime uses Node built-ins plus `selfsigned` for certificate generation. Dependencies are included in release packages, together with their license files. Existing sharing identities are reused.

## Plugin folder

```sh
npm run package -- /absolute/new/location/sub2sub
```

The parent must exist and the target must be new. This copies production dependencies, skills, manifests, and user documentation. Run `npm ci --omit=dev --ignore-scripts` before preparing a distribution. A source package uses your existing Node runtime.

On Windows, packaging writes the current Node.exe path into `.mcp.json`. For a known destination path when packaging elsewhere:

```sh
node scripts/package.mjs /absolute/new/location/sub2sub --windows-node 'C:\Program Files\nodejs\node.exe'
```

Register source packages through a local Codex marketplace using [OpenAI's plugin instructions](https://developers.openai.com/plugins/build/plugins). The example in [examples/marketplace.json](https://github.com/mekoand/sub2sub/blob/main/examples/marketplace.json) expects `./plugins/sub2sub` relative to the marketplace root. The public installer uses a separate `sub2sub` marketplace and handles this setup automatically.

## Complete releases

Build on macOS or Linux with `tar`, `zip`, and `unzip` installed:

```sh
npm ci --omit=dev --ignore-scripts
npm run release -- /absolute/output/directory
```

The builder downloads Node from nodejs.org, checks its published checksum, and creates:

- `sub2sub-darwin-arm64.tar.gz`
- `sub2sub-darwin-x64.tar.gz`
- `sub2sub-win32-x64.zip`
- `install.sh`, `install.ps1`, and `SHA256SUMS`

Each archive contains the plugin, its dependencies, and a private Node runtime with the Node license. It contains no credentials, pairings, task history, or user files. Installation generates machine-specific startup paths.

Keep the version in `package.json`, `.codex-plugin/plugin.json`, and both bootstrap scripts aligned. The release workflow builds assets as a draft release. Publish that draft after reviewing CI and installer smoke tests so the README's `latest/download` links remain usable.
