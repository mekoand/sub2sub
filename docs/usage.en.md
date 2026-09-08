# Usage

[README](../README.md) · [简体中文](usage.md) · [Install](install.en.md)

sub2sub shares access to authorized AI subscriptions through tasks. Delegate from your own conversation while the provider runs the work with Codex or Claude Code already signed in on their device. Save files and responses locally, then continue the same task for revisions. You do not need to sign in to the provider's account, and the same workflow works across your own devices.

For your first task, start with settings and pairing below. Once connected, jump to [delegating and following up](#delegate-and-follow-up), or open [local management](#local-management-and-statistics) to see your tasks and saved results.

## Roles and consent

The **caller** delegates work and receives results. The **provider** authorizes its selected Codex or Claude environment to execute the task and keeps that tool's subscription login on its own device. Both run the same plugin and can use either role as appropriate.

Pair with the provider's invitation and give the connection a name. Confirm task-file transfer during pairing or afterwards. Ordinary consent covers material needed for the user's delegated project; it does not include credentials, unrelated files, or separately sensitive material. Plugin consent does not override host approvals.

Keep invitations private. Do not publish them in issues, documentation, or screenshots.

## First use

On a new device, the assistant first explains and shows all current settings, including when you have already given it a task. The summary covers caller defaults for Codex and Claude, the provider's execution tool and model restrictions, input/result limits for both roles, retention and cleanup conditions, device name and advanced paths, existing connections and transfer consent, authorized callers, and current sharing state. Review it and confirm before connecting, sharing or delegating; the assistant then continues your original request.

Ask to change any setting before confirming. Unset Claude choices stay unset, and default models are not claimed to be available until the connected node's live catalog is checked. Reviewing the guide works without a local execution tool and does not start sharing or run a model. Approving settings does not authorize sending task files.

Confirmation and explicit skipping are remembered. An interrupted guide resumes with your saved settings; ask to reopen first-use settings whenever needed. Existing configurations, connections or task/sharing records are recognized on upgrade, preserving settings without forcing another introduction. Later ordinary settings queries remain concise; ask for advanced settings when needed.

## Delegate and follow up

Each turn can run for up to 30 minutes; longer work can continue in phases. Tasks run in a separate work copy with task network access, MCP, app, and browser integrations disabled. Prepare the required inputs and local tools before delegating.

When the time limit is reached, execution stops and sub2sub saves the available stage results locally. It reports unfinished work and waits for you to choose whether to continue the same task. If saving fails, retry collection; running the task again is not needed to retry a download. Files not yet written by the executing tool cannot be recovered by transfer.

Each delivery includes the current files, the provider's completed checks, and remaining work or checks with reasons. Checks follow the task: code tests, document review, data reconciliation, or other requested verification. Saving the files does not mean every requirement has been completed.

New task work copies have an internal `.sub2sub` directory for disposable tool caches. It is omitted from delivery and removed with the work copy. No additional setting is needed. Required outputs and files needed to continue stay outside that directory. Older tasks and other excluded paths keep their existing handling.

State the goal, input scope, output, and expected checks:

> Delegate the docs directory to work-computer. Build offline help pages without installing dependencies or using the network. Implement and test there, then return the pages and usage instructions.

The input preview identifies the destination, file count, and size. By default, it includes the current contents of Git-tracked files, including uncommitted edits. Select untracked files explicitly. Dependency folders and common credential paths are excluded; symbolic links and special files are not transferred as ordinary files.

A follow-up reuses the remote work copy and native conversation. Existing tasks keep their accepted model, effort, and retention; changing caller defaults affects new tasks only. Explicitly request a model change for a retained task.

A turn is ready for delivery after execution ends and its results are saved. Failed or interrupted tasks may expose recovery files; retrieving those files does not mean execution succeeded.

## Open results

| Field | Content |
| --- | --- |
| `workCopyDirectory` | Complete local task files, combining input and latest modifications |
| `responseFile` | Text response saved for this synchronization |
| `resultDirectory` | Changed files, `changes.json`, and historical response |

Ask your assistant to link the verified local files. Later result viewing uses the saved version without contacting the provider. During an unsaved follow-up, existing paths still describe the previous save.

Source files are not overwritten automatically. Compare or merge the returned work yourself. File changes produce an independent complete copy; a valid no-change synchronization reuses the existing copy while updating text and save records.

Retry `collect_result` on the same task after a download or confirmation failure; do not rerun the work merely because collection failed. Check skipped paths and execution errors in `changes.json`. Recover a necessary missing output in the original task.

## Settings and status

Caller settings keep one default model and effort for each execution tool, shared across nodes. Codex defaults to GPT-5.6 Luna / max. For the first Claude task, choose a model and effort from the node’s actual options; save them as defaults if desired. Single-task choices override these defaults.

Provider settings select one execution tool and its offered models, defaulting to all available models including future additions. Switch tools while the node is idle. A failed switch keeps the previous selection; existing tasks keep their original tool and session. Switch back before continuing them.

Query a local or paired node's **usage** to read current Codex account-wide allowance windows, remaining percentages and reset times. Each query refreshes from that node's execution account; sharing does not need to be started for a local query. Missing data stays unknown, past reset times are marked stale, and failures never reuse old numbers. Claude and older peers report unsupported queries. Quota is separate from availability: it does not select nodes or block tasks automatically. Paired callers can see this basic quota by default, without account emails or detailed usage history.

Advanced settings hold transfer limits and retention. Lists show each node's offered tool and each task's original tool alongside its times and saved results.

Input and result defaults are 20 MiB and 2,000 files each. Raw file bytes count, not compressed or base64 sizes. Supported limits are 1–67,108,864 bytes and 1–10,000 files. Both peers' limits apply, taking the smaller value. Restoring a cleaned task checks the complete upload size again.

Provider retention supports 1–365 days, default 7. Accepted tasks retain their original setting. Status queries, downloads, and `keep` do not extend the deadline; completing another turn resets it.

## Local management and statistics

Example requests: “Open sub2sub management”, “Show statistics for resources I used over the last 7 days”, “Help diagnose the office node's connection failure”, and “Submit this issue to GitHub”. The last request authorizes submission; a diagnosis request alone does not.

To see which node is busy or whether your results are saved, ask to open sub2sub management in your conversation. The private local link brings together nodes, tasks, and saved results, with pairing, settings, and on-demand model and quota queries. Continue task instructions and follow-ups in the original conversation. Saved answers and files can be previewed or downloaded when the provider is offline; artifact HTML and scripts are never executed by the page.

Management is enabled by default on a random `127.0.0.1` port, without opening a browser. Disable it in Settings or from the conversation; the preference is saved in sub2sub's own configuration. Ask to enable management again to reopen it. Each MCP process owns its temporary link, which expires when that host process exits. Other process links stop serving data on their next request after disabling. Independent sharing is unaffected; the page adds no background process.

With no page open there is no polling. A visible overview reads local records every 30 seconds and pauses when hidden. Refresh status explicitly checks peers; models and quota are queried only on demand, with their observation time. Failed queries and expired quota windows are not shown as current availability.

I use / I provide summarize retained tasks by resource and execution tool over 7 or 30 days: tasks, turns, outcomes and measured execution time. Windows use turn start time. Measurement begins with turns run in this version; older turns and unknown timing are not inferred. Caller totals cover received execution/result records, not all provider history. Refreshing or downloading again does not add turns. Work-copy cleanup preserves statistics; explicit task-record deletion removes the corresponding statistics on that side. Saved local results remain. These figures are not account quota, cost or quality scores.

Model usage groups native observations by actual model and source, with per-turn details and JSON export. Requested and actual models remain separate. — means unknown; partial records, field coverage and pending tasks stay visible. Task details show all retained turns for that task, independent of the overview period. Codex cached input is included in input, and reasoning in output. Claude input, cache reads and cache writes retain their separate native meanings. Categories are not added again and missing totals are not inferred. Caller and provider views describe the same consumption and must not be added together.

Provider settings include the node's concurrent task limit, default 4. One caller may use all slots, while one task can execute only one turn at a time. Lowering the limit lets existing tasks finish and applies to new work immediately, without a restart.

Use Troubleshooting to return to the conversation and reuse existing status queries. After an explicit request to submit to GitHub, the assistant prepares public-safe content, searches duplicates and uses the host's existing GitHub capability; otherwise it provides a draft. Never publish invitations, private management links, credentials, personal paths or private task content.

## Task lifecycle

1. Select and upload the first work copy; create a native conversation.
2. Save a completed phase locally and confirm that synchronization.
3. Continue using the remote files and original conversation.
4. Finish or let the task become eligible for idle cleanup.
5. After work-copy cleanup, restore saved local files to resume the original conversation.

| Choice | Effect |
| --- | --- |
| `keep` | Retain the current deadline |
| `workcopy` | Remove remote work files and transfer payloads; keep restoration metadata and native history |
| `records` | Also remove sub2sub task records; no automatic restoration |
| `all` | Also delete the associated native conversation and derived conversations |

Automatic expiry only cleans the remote work copy. Necessary outputs must have been confirmed saved, with no active or unknown execution. Checks run while sharing is active, so offline devices do not promise exact deletion times.

Local source, complete copies, historical downloads, and indexes are outside remote cleanup. Shared native logs, system backups and service-side retention are also outside the plugin's deletion scope.

## Connection management

Rename connections without changing tasks. Update a changed address for the same device while checking its existing identity; pair anew for a replacement device.

Resolve active work and uncollected output before deleting a connection. Pairing the same computer again does not restore old task associations. Already-saved local outputs remain available.

Providers can stop accepting new work, revoke a caller and interrupt its task, or clean one stopped task. Discarding uncollected output requires an explicit choice.

## Data locations

- Configuration: `~/.config/sub2sub/config.json`, or the `SUB2SUB_CONFIG` path.
- State: `~/.local/state/sub2sub`, or an absolute `stateRoot` in that configuration.
- On Windows, `~` means the current user's home directory.

These directories contain pairing credentials, identities, and task files. Do not share them wholesale. First use creates configuration as needed; `config.example.json` illustrates structure, with device-specific paths to replace.
