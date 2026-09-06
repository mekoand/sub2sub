# Usage

[README](../README.md) · [简体中文](usage.md) · [Install](install.en.md)

## Roles and consent

The **caller** delegates work and receives results. The **provider** authorizes its Codex environment to execute the task. Both run the same plugin and can use either role as appropriate.

Pair with the provider's invitation and give the connection a name. Confirm task-file transfer during pairing or afterwards. Ordinary consent covers material needed for the user's delegated project; it does not include credentials, unrelated files, or separately sensitive material. Plugin consent does not override host approvals.

Keep invitations private. Do not publish them in issues, documentation, or screenshots.

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

Ask Codex to link the verified local files. Later result viewing uses the saved version without contacting the provider. During an unsaved follow-up, existing paths still describe the previous save.

Source files are not overwritten automatically. Compare or merge the returned work yourself. File changes produce an independent complete copy; a valid no-change synchronization reuses the existing copy while updating text and save records.

Retry `collect_result` on the same task after a download or confirmation failure; do not rerun the work merely because collection failed. Check skipped paths and execution errors in `changes.json`. Recover a necessary missing output in the original task.

## Settings and status

Ask to show caller settings, change the default model/effort, select provider models, show advanced settings, list available nodes, inspect local sharing, or show delegated tasks.

Input and result defaults are 20 MiB and 2,000 files each. Raw file bytes count, not compressed or base64 sizes. Supported limits are 1–67,108,864 bytes and 1–10,000 files. Both peers' limits apply, taking the smaller value. Restoring a cleaned task checks the complete upload size again.

Provider retention supports 1–365 days, default 7. Accepted tasks retain their original setting. Status queries, downloads, and `keep` do not extend the deadline; completing another turn resets it.

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

Local source, complete copies, historical downloads, and indexes are outside remote cleanup. System backups and service-side retention are also outside the plugin's deletion scope.

## Connection management

Rename connections without changing tasks. Update a changed address for the same device while checking its existing identity; pair anew for a replacement device.

Resolve active work and uncollected output before deleting a connection. Pairing the same computer again does not restore old task associations. Already-saved local outputs remain available.

Providers can stop accepting new work, revoke a caller and interrupt its task, or clean one stopped task. Discarding uncollected output requires an explicit choice.

## Data locations

- Configuration: `~/.config/sub2sub/config.json`, or the `SUB2SUB_CONFIG` path.
- State: `~/.local/state/sub2sub`, or an absolute `stateRoot` in that configuration.
- On Windows, `~` means the current user's home directory.

These directories contain pairing credentials, identities, and task files. Do not share them wholesale. First use creates configuration as needed; `config.example.json` illustrates structure, with device-specific paths to replace.
