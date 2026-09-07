# Troubleshooting

[README](../README.md) · [简体中文](troubleshooting.md) · [Install](install.en.md)

Check both peers' plugin, Node, and selected execution tool versions and actual executable paths. Remove invitations, tokens, personal paths, and project content before sharing diagnostics.

| Symptom | Next step |
| --- | --- |
| `ECONNREFUSED` after pairing | Check that the device is awake and connected, then start sharing again. Reuse the existing pairing |
| Connection timeout | Check the selected IPv4 address, reachability, sleep state, and inbound port permission |
| Invalid or expired invitation | Request a new invitation; it lasts 10 minutes, is single-use, and replaces the previous one |
| Provider busy | Inspect the existing task; one provider executes one active task |
| Unsupported model or effort | Choose from returned actual options; pairing does not prove model access or remaining usage |
| Turn reaches the 30-minute limit | In 0.5.2+, available stage results are saved automatically. Read the saved files and unfinished status, then choose whether to continue the same task. Retry `collect_result` if saving failed |
| Result limit exceeded | Remove unnecessary task-generated temporary output or explicitly adjust both peers' limits; preserve needed files |
| Save confirmation failed | Retry `collect_result` on the same task, not a duplicate execution |
| Cleanup refused | Check unsaved outputs, running state, filesystem permissions, and host approval feedback |
| Native Codex not found on Windows | Use actual `codex.exe`, not an npm `.cmd` or `.bat` shim |
| Windows certificate generation fails | Update to 0.5, which includes certificate generation and no longer needs external OpenSSL; include the underlying error if it persists |
| Windows Codex initialization fails or times out | Start sharing from the logged-in user's desktop session. An SSH session can read quota but may fail to start native Codex work |
| Node is reachable locally but LAN TLS times out after install/update | Check Windows Firewall permission for the actual Node path shown in sharing status. A different program/version path may have a separate rule; allow it only on the intended private network |
| Claude cannot be selected | On macOS, install Claude Code 2.1.263+ and sign in with its subscription. A failed switch keeps the previous tool selected |
| Cannot switch execution tool | Finish or cancel the active turn first. Retained tasks need their original tool selected before continuation |
| Claude quota shows unsupported | Claude quota is not available in this version; no Codex balance is substituted |
| Browser not found | Inspect standard installation locations as well as PATH; installed does not mean callable in the sandbox |
| New version not loaded | Check sub2sub updates to distinguish session, actual host installation and node versions. Fully quit and reopen Codex desktop (a new conversation or closing the window is insufficient), or exit/restart the CLI. Exit/start an independent node when idle. For 0.5.3, save work and end the old provider conversation first; see the installation guide |

## Execution failure versus delivery failure

A stopped failed task can still contain recoverable work. Inspect and save that work before continuing the same native conversation. If only collection failed, fix collection and retry rather than executing again.

Deleted native history, missing local restoration files, or explicitly discarded newer output can prevent recovery. A new task should not be presented as continuation of the old conversation.

## Browser and temporary files

Delegated execution disables built-in browser, app, and network integrations. A browser executable can still fail under the host sandbox or GPU environment; no valid page output means no browser acceptance.

New tasks provide an internal `.sub2sub` directory for disposable caches and temporary files. These files do not count toward delivery limits and follow the existing work-copy cleanup. Keep deliverables and files needed for continuation outside it. Older tasks and other excluded directories retain their existing rules; sub2sub does not guess which files can be discarded.

## Report an issue

Include platform and versions, the failing phase, minimal reproduction, expected/actual behavior, and sanitized error/status output. State whether execution is still active and whether the latest necessary results were saved.

Use [GitHub Issues](https://github.com/mekoand/sub2sub/issues). Never post invitations, pairing tokens, login material, or complete configuration/state directories.
