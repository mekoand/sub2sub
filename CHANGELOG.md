# Changelog

## 0.4.3 — 2026-09-06

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
