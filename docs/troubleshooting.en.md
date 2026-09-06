# Troubleshooting

[README](../README.en.md) · [简体中文](troubleshooting.md) · [Install](install.en.md)

Check both peers' plugin, Node, and Codex versions and actual executable paths. Remove invitations, tokens, personal paths, and project content before sharing diagnostics.

| Symptom | Next step |
| --- | --- |
| `ECONNREFUSED` after pairing | Restart provider sharing; the hosting process may have exited. Reuse the pairing first |
| Connection timeout | Check the selected IPv4 address, reachability, sleep state, and inbound port permission |
| Invalid or expired invitation | Request a new invitation; it lasts 10 minutes, is single-use, and replaces the previous one |
| Provider busy | Inspect the existing task; one provider executes one active task |
| Unsupported model or effort | Choose from returned actual options; pairing does not prove model access or remaining usage |
| `Turn exceeded 30 minutes` | Inspect the original task, collect recovery files if appropriate, and resume in smaller phases |
| Result limit exceeded | Remove unnecessary task-generated temporary output or explicitly adjust both peers' limits; preserve needed files |
| Save confirmation failed | Retry `collect_result` on the same task, not a duplicate execution |
| Cleanup refused | Check unsaved outputs, running state, filesystem permissions, and host approval feedback |
| Native Codex not found on Windows | Use actual `codex.exe`, not an npm `.cmd` or `.bat` shim |
| Windows certificate generation fails | Update to 0.5, which includes certificate generation and no longer needs external OpenSSL; include the underlying error if it persists |
| Windows sandbox initialization fails | Use the desktop login session; SSH system sessions are an observed limitation |
| Browser not found | Inspect standard installation locations as well as PATH; installed does not mean callable in the sandbox |
| New version not loaded | Update the installed cache and start a new conversation; source edits do not update running processes |

## Execution failure versus delivery failure

A stopped failed task can still contain recoverable work. Inspect and save that work before continuing the same native conversation. If only collection failed, fix collection and retry rather than executing again.

Deleted native history, missing local restoration files, or explicitly discarded newer output can prevent recovery. A new task should not be presented as continuation of the old conversation.

## Browser and temporary files

Delegated execution disables built-in browser, app, and network integrations. A browser executable can still fail under the host sandbox or GPU environment; no valid page output means no browser acceptance.

A real complex-task trial generated browser profiles exceeding the default result limit, and the task's deletion policy refused cleanup. Separate temporary output from deliverables and check the final directory. The current version cannot guarantee unattended cleanup in every environment. Do not deliver a user's browser profile or disable the sandbox as a workaround.

## Report an issue

Include platform and versions, the failing phase, minimal reproduction, expected/actual behavior, and sanitized error/status output. State whether execution is still active and whether the latest necessary results were saved.

Use [GitHub Issues](https://github.com/mekoand/sub2sub/issues). Never post invitations, pairing tokens, login material, or complete configuration/state directories.
