# Contributing to sub2sub

**English** · [简体中文](CONTRIBUTING.zh-CN.md)

Contributions in Chinese or English are welcome: improve documentation and translations, reproduce a bug, fix a focused problem, or discuss support for another execution tool. This is a community-maintained project. Keep discussion respectful and base reports on observed behavior.

## Before you start

Search [existing issues](https://github.com/mekoand/sub2sub/issues). For features or behavior changes, open or comment on an issue with the problem, expected result, and scope before implementing. Small wording or typo fixes can go straight to a PR. The [issue workflow](https://github.com/mekoand/sub2sub/blob/main/docs/agents/issue-tracker.md) explains how larger work is tracked; no special skills or agent tools are required to contribute.

Read [the architecture](docs/architecture.md) and [execution limits](docs/usage.en.md#delegate-and-follow-up) when changing behavior. Discuss pairing, permissions, cleanup, or persisted-data changes before a broad implementation. For another tool adapter, first describe its execution, permissions, session, and usage interfaces in an issue.

Never publish invitations, credentials, real task content, private addresses, or personal paths. Use synthetic fixtures and redact logs and screenshots. Report vulnerabilities through the [private security channel](SECURITY.md), not a public issue.

## Make a change

1. Fork the repository and clone your fork. Create a branch from the current `main`:

   ```sh
   git clone https://github.com/YOUR-USERNAME/sub2sub.git
   cd sub2sub
   git switch -c fix/short-description
   ```

2. Use Node.js 22+ and install dependencies as CI does:

   ```sh
   npm ci --omit=optional --ignore-scripts
   ```

   The Host uses its installed native Claude CLI; SDK-bundled optional CLI binaries are not needed.

3. Make a focused change. For behavior changes, add a regression test at an existing public interface. Documentation-only edits need link and factual checks, not artificial tests. Keep `README.md`, its English copy `README.en.md`, and `README.zh-CN.md` aligned.

4. Run the relevant checks and record what passed:

   ```sh
   # macOS / Linux
   npm run check
   npm test

   # Windows platform regression
   node --test test/platform.test.mjs
   ```

   CI runs the full suite on Linux/macOS and the dedicated platform tests on Windows. These are different validation scopes. Real-model smoke scripts consume the signed-in account's allowance and create native history; run them only with explicit authorization. See [development and packaging](docs/development.md) and [validation scope](docs/validation.md).

5. Commit, push your branch to your fork, and open a PR against `mekoand/sub2sub:main`. Explain the problem, resulting behavior, checks actually run, and limitations. Link the issue; use `Closes #N` only if the PR completes its scope. For a wording-only PR, say that no issue is needed.

## Review expectations

Keep the smallest sufficient change. Validate external inputs and file/process/network boundaries, preserve useful error context, and avoid silent fallback. Do not add a general framework for a one-off operation. Execution, cleanup, persisted-state, and release-packaging changes need an independent review before merging.

For packaging changes, prepare a new package and inspect its contents: licensing and linked public docs must be included; local state, internal notes, and credentials must not be included.

Contributions are distributed under the [MIT License](LICENSE). Use of AI services remains subject to their terms; sub2sub is not an official OpenAI or Anthropic product.
