# Settings and management

Use ordinary settings first. Keep the user's two roles in separate answers.

## 使用方

- `caller_settings`: query or change one default model/effort across all nodes. Changes affect new tasks. Use `start_task` / `continue_task` arguments only for an explicit task-specific choice.
- `list_models` with `peer`: read that provider's actual available and allowed model/effort combinations. On mismatch, present choices and wait for selection.
- `list_peers`: live availability, busy, stopped or unreachable state with check times. `check=false` is local records only.
- `list_tasks`: local tasks, ordered by latest known execution end (creation time before any end). Show peer, creation/end times in the user's local time, and saved results together. Do not add task titles or summaries. Older records without times remain undated. Read `responseFile` for the text answer, `resultDirectory/changes.json` for skipped-output and execution-error warnings, and open files under `workCopyDirectory`; `savedAt`/`savedRevision` identify the local save. `deliveryPending=true` marks an execution whose results have not yet been saved; missing freshness information means unknown. Viewing saved results uses only these local paths.
- `task_status`: use for an explicit current remote status query. `details=true` inspects actual remote file existence/count/size, especially when asked whether cleanup really happened. A local cleanup record alone is not a fresh remote check.
- `edit_peer`: rename a connection or change the same device's host/port. Address changes validate the existing identity. A different device requires new pairing and consent.
- `delete_peer`: before deletion, explain that this connection will lose continuation of its old tasks; pairing the same Mac again creates a new connection and does not restore them. Saved local results remain viewable. Inspect and handle running tasks and uncollected results. Finish, collect or explicitly abandon identified tasks before deletion. Supply `abandonTasks` only after explaining the particular lost/unknown results and receiving an explicit choice. Running tasks must be stopped. Deleting the local connection does not revoke remote pairing or delete remote files.

## 提供方

- `provider_settings`: select all currently available models (including future additions) or an explicit list. Upgrading an old explicit model setting preserves that restriction. `configure_model` remains a legacy single-model restriction; use the separate role settings in normal conversation.
- `sharing_status`: this machine's actual sharing process and active task. It works from another Codex conversation. `stop_sharing` pauses new execution; existing tasks may finish and results remain accessible. Closing a status-only conversation leaves the owner process running.
- `list_pairings`, `list_shared_tasks`, `cancel_shared_task`: authorized callers and owned tasks; verify interruption before cleanup.
- `cleanup_shared_task`: clean one stopped task, preserving its connection and other tasks. Select `workcopy`, `records` or `all`. For uncollected outputs, show the affected task and obtain the provider's explicit discard choice before passing `discardUncollected=true`. The caller's approval is not required for the provider's own deletion decision.
- `revoke_pairing`: disconnect one caller and interrupt its active task; default retains data. Explicit `records`/`all` may also discard that connection's uncollected outputs. `cleanup_shared_tasks` applies an explicit cleanup choice after disconnection. Keep those operations distinct from local connection deletion and single-task cleanup.

## 高级设置

Use the role's settings tool. Both roles can adjust `inputBytes`, `inputFiles`, `resultBytes`, `resultFiles`. The effective limit is the smaller of both sides; query the supported range rather than inventing a limit. Inputs count the full upload; results count the current transfer's changed files. Existing accepted result limits remain available for collection after defaults are tightened. Raising a limit leaves exclusions and transfer consent intact.

The provider can also set `retentionDays`, default seven. Existing tasks retain their accepted duration. Full local copies can accumulate beyond input limits despite individually small deltas; restoration checks the entire copy and reports whether limits or scope need adjustment. Never silently omit required files.
