# Changelog

## 0.6.0 — 2026-09-07

- Show all current settings on a new device and wait for confirmation before first pairing, sharing or delegation. Resume, explicitly skip or reopen the introduction without resetting settings; existing users keep their configuration.
- Check and install published updates in conversation using the existing release installer. Distinguish session, installed host and node versions; defer active/uncertain work and leave running nodes unchanged.
- Include dedicated light/dark plugin icons in the distribution. Codex manifest and native installation validation are separate from host UI verification.

- Run sharing in an independent node, with separate stop-accepting and exit controls and visible running/installed versions.
- Select Codex or Claude Code on macOS, with per-tool defaults and model restrictions. Preserve each task’s tool and original session through follow-ups, stage delivery and restoration.
- Read account-wide Codex quota locally or from a paired node without executing a task. Claude quota remains unsupported.
- Use the official Claude Agent SDK and Bash sandbox, reusing the existing task lifecycle and local delivery.

## 0.5.3 — 2026-09-07

- Add a Claude Code installation target using the existing bundled runtime, task service and Skill. Caller-only installation does not require local Codex, and both hosts can coexist.
- Refresh the Claude plugin on repeat installation and updates while preserving pairings and saved results.
- Present verified local deliverables and the saved answer with complete absolute links, including when viewing results after the work node goes offline.

## 0.5.2 — 2026-09-07

- Save available stage results when a turn reaches its 30-minute limit, report the interruption, and wait for the user to choose continuation. Failed saving can be retried without rerunning the task.
- Give new tasks an internal disposable cache directory that does not block delivery or work-copy cleanup. Preserve existing rules for older tasks and other excluded files.
- Tell the executing agent its deadline and require each final answer to describe current deliverables, completed checks, and unfinished work for every task type.
- Validate a simple Claude Code → Codex task and follow-up through a temporary MCP setup. The installer still targets Codex.

## 0.5.1 — 2026-09-06

- Fix the installer entry point when macOS launches it through a temporary-directory alias.
- Wait for the actual MCP response in the first-use test before closing its client.

## 0.5.0 — 2026-09-06

- One-command installation for Apple Silicon / Intel Macs and Windows x64. Release packages include a private Node runtime and production dependencies.
- Native Codex plugin installation, repeat installation, startup-path refresh, and migration from older plugin sources. Pairings and saved results are preserved.
- Sharing certificates are generated in-process; external OpenSSL is no longer required. Existing identities are reused.
- Task execution can use the bundled Node runtime for local scripts and checks. The native Codex CLI delegation and continuation flow has been exercised on macOS.
- Tailscale IPv4 address support (`100.64.0.0/10`). Real cross-network testing is scheduled for a later release.
- Bilingual README and installation guides now focus on tasks, team use, and local deliverables.

## 0.4.3 — 2026-09-06

- Preserve the order of sharing controls while discovering an existing listener; a delayed start cannot override a later stop.
- Prevent task-record and full cleanup from deleting changes made after the last confirmed local save.
- Separate Codex progress messages from the final delivered answer, preserving models with unspecified message phases.
- Add Chinese and English documentation, a text wordmark, MIT licensing, and source installation examples.
- Add `npm run package` and CI checks for macOS, Linux, and focused Windows platform behavior.

## 0.4.2 — 2026-09-06

- Fix Windows first-time certificate generation when the external OpenSSL default configuration is missing.
- Report the actual OpenSSL executable and configuration source on failure.
- Handle native Windows executables, path separators, and abandoned directory locks.
- Prepare Windows packages that launch Node directly.

## 0.4.1 — 2026-09-06

- Add task creation/end times and clearer saved-result access.
- Reuse the complete local work copy when an incremental return contains no file changes.
- Clarify retention, connection deletion, and current provider state.

## 0.4.0 — 2026-09-05

- Separate caller and provider settings, including model choices and transfer limits.
- Add incremental result synchronization and complete local task copies.
- Support work-copy cleanup followed by restoration into the original conversation.
- Add default seven-day idle retention and node/connection management.

## 0.3.0 — 2026-09-05

- Add explicit task-file consent and simpler invitation pairing.
- Separate work files, task records, and native-history cleanup choices.

Earlier versions established the LAN delegation and same-conversation workflow. These entries describe source history; a source version does not imply that every installed cache or platform was updated.
