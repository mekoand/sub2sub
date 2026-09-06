# Contributing to sub2sub

中文或英文 Issue / PR 都欢迎。优先提交能复现的问题，以及解决该问题的小范围修改。

## Before changing code

- Track new requirements and work in [GitHub Issues](https://github.com/mekoand/sub2sub/issues), following the [issue workflow](https://github.com/mekoand/sub2sub/blob/main/docs/agents/issue-tracker.md). Keep small changes in one issue and link implementation PRs to it.
- Describe the concrete problem and expected behavior. Discuss changes to pairing, permissions, cleanup, or persisted data before a broad implementation.
- Read [the architecture](docs/architecture.md) and [usage and execution limits](docs/usage.en.md#delegate-and-follow-up).
- Never include invitations, credentials, real task state, personal paths, or private project content in a contribution. Use synthetic fixtures.

## Local checks

Use Node.js 22+ and run `npm ci` before testing. The runtime includes `selfsigned` for certificate generation.

```sh
# macOS / Linux
npm run check
npm test

# Windows platform regression
node --test test/platform.test.mjs
```

The complete suite is currently exercised on POSIX environments; the Windows job runs the dedicated platform tests. Do not describe one as proof that the other passed. Real-Codex smoke scripts consume the signed-in account's subscription and create temporary native history; run them only with explicit authorization.

## Pull requests

Explain the problem, the resulting behavior, the checks actually run, and remaining limitations. Include a focused regression test when behavior changes; documentation-only edits do not need artificial tests. Keep Chinese and English README claims aligned.

Validate external inputs and file/process/network boundaries, preserve useful error context, and avoid silent fallback. Do not add general frameworks or abstractions for a one-off operation. Independently review changes that affect execution, cleanup, persisted state, or release packaging before merging.

For packaging changes, prepare a new package and check its contents: licensing and public docs must be included; local state, internal notes, and credentials must not be included.

Contributions are distributed under the repository's [MIT License](LICENSE).
