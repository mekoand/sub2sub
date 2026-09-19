# Usage

[README](../README.md) · [简体中文](usage.md) · [Install](install.en.md)

sub2sub shares access to authorized AI subscriptions through tasks. Delegate from your own conversation while the host runs the work with Codex or Claude Code already signed in on their device. Save files and responses locally, then continue the same task for revisions. You do not need to sign in to the host's account, and the same workflow works across your own devices.

For your first task, start with settings and pairing below. Once connected, jump to [delegating and following up](#delegate-and-follow-up), or open [local management](#local-management-and-statistics) to see your tasks and saved results.


Cross-network service is off by default. Enable it on both devices before pairing across networks; existing connections retain their route until explicitly migrated. Active work, transfers and unresolved submissions block disabling the service until completed or explicitly cancelled. [Setup, migration and compatibility](install.en.md#cross-network-connections).

## Sharing rules per connection

Hosts can set a connection concurrency limit and fixed authorization deadline under **Resources I share → Authorized clients → Rules**, or use `pairing_settings` in their conversation. New and existing connections default to no extra limit and no expiry; the node total limit still applies. A blank field (`null` in the tool) removes that limit.

The page uses local time; the tool accepts UTC timestamps. Expiry blocks new tasks and follow-up execution while allowing active turns to finish and existing work to be queried, cancelled and collected. Activity never renews access; the host can extend the original connection to continue its tasks. Revocation still disconnects immediately and requires pairing again. Work-copy cleanup and saved results are unchanged.

The same Rules panel accepts an optional **cumulative Token limit** (`pairing_settings.tokenLimit`, a positive integer; `null` disables it). Hosts and clients see recorded consumption, remaining budget and incomplete usage. It belongs to this pairing, not a person or subscription account; separate connections and Hosts have separate budgets.

Each budgeted turn settles once when execution stops, including failures, cancellations and timeouts. At the limit, new tasks and follow-ups are refused; querying, cancelling and collecting retained results remain available. In-flight turns finish and can exceed the limit, especially when concurrent. There is no reservation, mid-turn interruption or periodic reset. Lowering the limit does not interrupt work. Increasing it gives additional room without erasing consumption. Deleting tasks/history, restarting, or disabling and re-enabling the budget does not reset it. Turns started while disabled and history before enabling are not backfilled.

Codex uses its native total; cached input and reasoning are not added again. Claude sums native per-model input, cache reads, cache writes and output, with thinking already included in output. When final usage is incomplete, known consumption is retained and new execution pauses. After checking that prior execution has stopped, the Host can explicitly accept the gap in Rules (`acceptUsageGap=true`); the incomplete marker remains, and unknown Tokens are never replaced with zero. Recovery after an interrupted Host restart follows the same rule. An accounting write failure stops new admission until the Host restarts sharing and recovers the pending receipt.

Budget counters are independent of deletable task statistics. They retain only the cumulative count, gap state and in-flight task/round identifiers; settled identifiers are removed, without retaining task text or files. These numbers are usage observations, not prices or the upstream account's remaining quota.

The Codex adapter uses the per-connection cumulative-counter behavior previously verified on Codex 0.153.4. Main-thread events do not cover child threads, so budgeted turns disable native `multi_agent` and `multi_agent_v2` features on both process and thread configuration, including resumes. The public [`multi_agent` setting](https://developers.openai.com/codex/config-reference/) controls collaboration tools; both flags were also confirmed by read-only `features list` on CLI 0.147.0. Claude uses `result.modelUsage` with SDK 0.3.263, whose [native totals include auxiliary work](https://code.claude.com/docs/en/agent-sdk/cost-tracking); its delegated tool surface remains Bash-only. Regression tests use synthetic native events, not live model execution. Different native versions may omit/change usage; incomplete final observations pause the budget rather than claiming complete coverage.

Delivery in the original conversation includes this turn’s answer and actual adjustments, saved artifact links and unfinished work. Management reuses the same saved answer without another summary request or a diff view.

## Roles and consent

The **Client** is the device that delegates tasks and receives results. The **Host** is the device that shares AI capabilities and executes authorized tasks; its owner retains the account credentials. One device can serve both roles. Codex and Claude Code are the supported AI tools; support for more tools is in development.

Pair with the host's invitation and give the connection a name. Confirm task-file transfer during pairing or afterwards. Ordinary consent covers material needed for the user's delegated project; it does not include credentials, unrelated files, or separately sensitive material. Plugin consent does not override managing-app approvals.

Keep invitations private. Do not publish them in issues, documentation, or screenshots.

Open “Help” in the management footer for invitation, connection, small-file task and follow-up examples. A short explanation also precedes first-use settings. Viewing help starts neither sharing nor cross-network service.

## First use

On a new device, the assistant first explains and shows all current settings, including when you have already given it a task. The summary covers client defaults for Codex and Claude, the host's execution tool and model restrictions, input/result limits for both roles, retention and cleanup conditions, device name and advanced paths, existing connections and transfer consent, authorized clients, and current sharing state. Review it and confirm before connecting, sharing or delegating; the assistant then continues your original request.

Ask to change any setting before confirming. Unset Claude choices stay unset, and default models are not claimed to be available until the connected node's live catalog is checked. Reviewing the guide works without a local execution tool and does not start sharing or run a model. Approving settings does not authorize sending task files.

Confirmation and explicit skipping are remembered. An interrupted guide resumes with your saved settings; ask to reopen first-use settings whenever needed. Existing configurations, connections or task/sharing records are recognized on upgrade, preserving settings without forcing another introduction. Later ordinary settings queries remain concise; ask for advanced settings when needed.

## Delegate and follow up

Each turn can run for up to 30 minutes; longer work can continue in phases. Tasks run in a separate work copy with task network access, MCP, app, and browser integrations disabled. Include the required inputs, dependency declarations, lockfiles and instructions when relevant; installed dependencies and credentials are not copied with the project.

When the time limit is reached, execution stops and sub2sub saves the available stage results locally. It reports unfinished work and waits for you to choose whether to continue the same task. If saving fails, retry collection; running the task again is not needed to retry a download. Files not yet written by the executing tool cannot be recovered by transfer.

Each delivery includes the current files, checks actually completed on each device, and remaining work or checks with reasons. Checks follow the task: code tests, document review, data reconciliation, or other requested verification. Saving the files does not mean every requirement has been completed.

New task work copies have an internal `.sub2sub` directory for disposable tool caches. It is omitted from delivery and removed with the work copy. No additional setting is needed. Required outputs and files needed to continue stay outside that directory. Older tasks and other excluded paths keep their existing handling.

State the goal, input scope, output, and expected checks:

> Delegate the docs directory to work-computer. Build offline help pages without installing dependencies or using the network. Implement and test there, then return the pages and usage instructions.

The input preview identifies the destination, file count, and size. By default, it includes the current contents of Git-tracked files, including uncommitted edits. Select untracked files explicitly. Dependency folders and common credential paths are excluded; symbolic links and special files are not transferred as ordinary files.

The client agent selects applicable root and nested `AGENTS.md` files and names their paths in the task prompt. Selecting only a subdirectory does not add ancestor rules; select untracked rules explicitly. Include required reference documents, templates or scripts within the existing authorization, preserving their layout. Host instructions require reading applicable rules before working; a transferred file does not prove model compliance.

Whole skills, `.agents` and `.codex` are not synchronized. Put a needed method's essential steps and constraints in the prompt; keep steps requiring local accounts, browsers, MCP or apps on the client when the task permits it. Explain missing material or host capabilities, and ask for a decision only when they block useful work or a completion requirement.

Conversation guidance calls for a brief submission acknowledgement, prompt updates for meaningful changes or decisions, and roughly one short update per minute during a long wait. It uses existing progress notifications rather than narrating each fragment or polling for commentary; actual timing depends on the managing app.

A follow-up reuses the remote work copy and native conversation. Existing tasks keep their accepted model, effort, and retention; changing client defaults affects new tasks only. Explicitly request a model change for a retained task.

A turn is ready for delivery after execution ends and its results are saved. Failed or interrupted tasks may expose recovery files; retrieving those files does not mean execution succeeded.

## Automatic host selection

Manual host selection remains the default. Enable **Settings → Automatic host selection** and enter existing connection names in priority order, one per line, or ask to configure that order in your conversation. Disabling it or clearing the candidates restores manual selection. Renaming a connection updates its candidate entry; deleting it removes the entry.

Only new tasks without an explicit host use the list. The client chooses the first candidate with task-file consent, available capacity, the requested execution tool and unchanged model/effort, and compatible known input limits. Automatic selection defaults to Codex; explicitly choose Claude and its model/effort when needed. Available connection-budget metadata is checked, but missing metadata does not establish a remaining balance. Models are never downgraded, and nodes using the same account are not counted as separate subscriptions.

Pairing and candidate settings do not authorize transfer of task files or instructions. The file preview shows the candidates and their individual consent; separately sensitive material still needs destination-specific consent. Explicitly choose a known suitable host for environment-specific requirements. Selection does not scan or infer device environments.

Passing checks does not guarantee admission. After selecting a host, the client submits once: refusal, timeout or disconnection never triggers another host submission. Keep the returned host, task ID and original error, and query that original task as directed. Follow-up, restoration, cancellation and collection stay on its original connection. If no candidate qualifies, the client reports each reason for your decision. The management page configures the rule; tasks still start in the original conversation.

## Different environments

The host checks the tools and dependencies needed for the task inside its task sandbox at the start of the existing turn. There is no extra routine confirmation or global setting. Checks are specific to the task, not a full environment scan, and may also reveal gaps later during execution.

| Situation | Handling |
| --- | --- |
| The environment is sufficient, or a missing tool is irrelevant to this task | Continue without interrupting the user |
| Changes can be made, but some checks cannot run on the host | Return the changes and missing checks; the client's own agent completes verification in a separate local verification copy under local permissions and task authorization |
| A missing requirement blocks explicitly required host-side execution or verification, or prevents useful work | Explain the gap and wait for a choice: prepare the environment, choose another host, or change the scope |
| The client also lacks the environment needed for verification | Report the remaining requirement and ask how to proceed |

The host still runs relevant checks available there. The client reviews reported checks and repeats them only for a new change, failure or concrete risk. Local verification is allowed by default, but it cannot replace an explicit host-side requirement. It does not authorize system dependency installation, credential transfer or expanded permissions. Review returned changes and scripts before local execution; source files and existing edits stay protected. Report host checks and client checks separately, and claim full completion only after required checks pass.

Before tests, builds, dependency preparation or other checks that may write files, copy the saved files into a separate verification directory. Keep the plugin-managed `workCopyDirectory`, `resultDirectory` and task index unchanged; they are used for later collection and restoration. Local edits or generated links there can contaminate results or block collection. Do not copy verification files back into those saved directories.

If a local check fails, distinguish an environment gap from an implementation problem. Continue the original task with necessary error details, commands and conditions for a fix within its scope, without routine reconfirmation. Repeating an unchanged task does not resolve a known environment gap. Local edits are not automatically sent to its existing remote work copy. Simply opening a saved result does not rerun checks.

## Open results

| Field | Content |
| --- | --- |
| `workCopyDirectory` | Complete local task files, combining input and latest modifications |
| `responseFile` | Text response saved for this synchronization |
| `resultDirectory` | Changed files, `changes.json`, and historical response |

Ask your assistant to link the verified local files. Later result viewing uses the saved version without contacting the host. During an unsaved follow-up, existing paths still describe the previous save.

Source files are not overwritten automatically. Compare or merge the returned work yourself. File changes produce an independent complete copy; a valid no-change synchronization reuses the existing copy while updating text and save records.

Retry `collect_result` on the same task after a download or confirmation failure; do not rerun the work merely because collection failed. Check skipped paths and execution errors in `changes.json`. Recover a necessary missing output in the original task.

## Settings and status

Client settings keep one default model and effort for each execution tool, shared across nodes. Codex defaults to GPT-5.6 Luna / max. For the first Claude task, choose a model and effort from the node’s actual options; save them as defaults if desired. Single-task choices override these defaults.

Host settings select one execution tool and its offered models, defaulting to all available models including future additions. Switch tools while the node is idle. A failed switch keeps the previous selection; existing tasks keep their original tool and session. Switch back before continuing them.

Query a local or paired node's **usage** to read current Codex account-wide allowance windows, remaining percentages and reset times. Each query refreshes from that node's execution account; sharing does not need to be started for a local query. Missing data stays unknown, past reset times are marked stale, and failures never reuse old numbers. Claude and older peers report unsupported queries. Quota is separate from availability: it does not select nodes or block tasks automatically. Paired clients can see this basic quota by default, without account emails or detailed usage history.

Advanced settings hold transfer limits and retention. Lists show each node's offered tool and each task's original tool alongside its times and saved results.

Input and result transfers default to unlimited bytes and file counts. The management page accepts size limits in MiB (including decimals) and file counts as integers. Tool API size parameters remain positive integer bytes. Use `null` (blank fields in the management page) for unlimited. When both peers set a limit, the smaller value applies; an unlimited peer honors the other peer's finite limit. Saved finite settings and limits already accepted by existing tasks are preserved.

Transfers strictly above 64 MiB of raw file content display a notice and continue without another confirmation. Non-local networks may be slower. Input limits count the complete work copy; result limits count this transfer's changes. Restoration checks the full input again. Unlimited does not promise bandwidth or disk capacity; actual failures remain errors.

Both nodes need chunked-transfer support. Older nodes retain their original limits, with an explanation before sending oversized inputs. An older local sharing process must also be restarted after active tasks finish to load the updated installation; upgrades do not restart active nodes automatically.

Supported versions negotiate file compression automatically to reduce bytes sent between devices; older nodes use uncompressed transfers. No additional setting is needed. Compression uses CPU and does not guarantee faster transfers for already-compressed files or fast connections. Preparing and saving files still takes time; previews and limits count original file content. See [synthetic measurements and limitations](development/transfer-performance.md).

Host retention supports 1–365 days, default 7. Accepted tasks retain their original setting. Status queries, downloads, and `keep` do not extend the deadline; completing another turn resets it.

**Delete all task content and native history at expiry** (`cleanupAllOnExpiry`) is an opt-in host setting, off by default. With it enabled, a new task requires acceptance of the host's exact retention period through the existing task-file consent flow (`authorize_peer.retentionPolicy`). The same accepted rule is reused for later tasks; a changed rule requires renewed consent before uploading. An older client cannot silently accept this rule. Changing settings does not shorten old tasks' accepted retention.

## Delegated session visibility

Host settings include **Keep delegated sessions in the task list** (`keepSessionVisible`), also configurable through conversation. This manages Codex sessions only; Claude reports unsupported and keeps its existing behavior.

Off by default: sessions may appear while executing, archive after each stopped turn, and restore the same session before continuation. On keeps them in the regular native task list for viewing progress. The setting applies only to new tasks; existing tasks retain their creation-time mode, and pre-feature tasks keep their existing behavior. Native-client input or takeover is not supported; the host's input box is not disabled.

Archiving retains native history and leaves work-copy retention and saved results unchanged. An archive error is reported separately from execution status; do not rerun work just to hide it. An unarchive error stops before a new turn starts. Remote file links may stop working after work-copy cleanup; use the client's saved complete copy. See [validation](validation.md) for the clients and versions actually checked.

## Local management and statistics

Example requests: “Open sub2sub management”, “Show statistics for resources I used over the last 7 days”, “Help diagnose the office node's connection failure”, and “Submit this issue to GitHub”. The last request authorizes submission; a diagnosis request alone does not.

To see which node is busy or whether your results are saved, ask to open sub2sub management in your conversation. The private local link brings together nodes, tasks, and saved results, with pairing, settings, and on-demand model and quota queries. Continue task instructions and follow-ups in the original conversation. Saved answers and files can be previewed or downloaded when the host is offline; artifact HTML and scripts are never executed by the page.

Management is enabled by default on a random `127.0.0.1` port, without opening a browser. Disable it in Settings or from the conversation; the preference is saved in sub2sub's own configuration. Ask to enable management again to reopen it. Each MCP process owns its temporary link, which expires when that process exits. Other process links stop serving data on their next request after disabling. Independent sharing is unaffected; the page adds no background process.

With no page open there is no polling. A visible overview reads local records every 30 seconds and pauses when hidden. Refresh status explicitly checks peers; models and quota are queried only on demand, with their observation time. Failed queries and expired quota windows are not shown as current availability.

Resources I use / Resources I share summarize retained tasks by resource and execution tool over 7 or 30 days: tasks, turns, outcomes and measured execution time. Windows use turn start time. Measurement begins with turns run in this version; older turns and unknown timing are not inferred. Client totals cover received execution/result records, not all host history. Refreshing or downloading again does not add turns. Work-copy cleanup preserves statistics; explicit task-record deletion removes the corresponding statistics on that side. Saved local results remain. These figures are not account quota, cost or quality scores.

Model usage groups native observations by actual model and source, with per-turn details and JSON export. Requested and actual models remain separate. — means unknown; partial records, field coverage and pending tasks stay visible. Task details show all retained turns for that task, independent of the overview period. Codex cached input is included in input, and reasoning in output. Claude input, cache reads and cache writes retain their separate native meanings. Categories are not added again and missing totals are not inferred. Client and host views describe the same consumption and must not be added together.

Host settings include the node's concurrent task limit, default 4. One client may use all slots, while one task can execute only one turn at a time. Lowering the limit lets existing tasks finish and applies to new work immediately, without a restart.

Use Troubleshooting to return to the conversation and reuse existing status queries. After an explicit request to submit to GitHub, the assistant prepares public-safe content, searches duplicates and uses the managing app's existing GitHub capability; otherwise it provides a draft. Never publish invitations, private management links, credentials, personal paths or private task content.

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

By default, automatic expiry only cleans the remote work copy after necessary outputs have been confirmed saved. For a task that accepted full expiry, the deadline starts at task acceptance and resets after every stopped turn. Once idle time expires, all host task content and associated native history, including identified descendants, are deleted even if results were not collected. This also applies to history retained after earlier work-copy or record cleanup; record cleanup keeps only the metadata needed for that accepted expiry. The original session cannot continue after expiry; available client files may be used to start a new task.

Active or uncertain execution and in-flight result transfers are protected; cleanup never cancels a task to meet its deadline. Cleanup failures remain visible and the existing maintenance cycle retries them. Checks run only while the host process is running, so an offline host is not reported as already cleaned. Expired tasks retain only minimal ownership, deadline, synchronization-receipt and cleanup metadata without instructions, answers, file lists or token history; independent connection budget totals are not task content and are outside cleanup.

Local source, complete copies, historical downloads, and indexes are outside remote cleanup. Shared native logs, system backups and service-side retention are also outside the plugin's deletion scope.

## Connection management

Rename connections without changing tasks. Update a changed address for the same device while checking its existing identity; pair anew for a replacement device.

Resolve active work and uncollected output before deleting a connection. Pairing the same computer again does not restore old task associations. Already-saved local outputs remain available.

Hosts can stop accepting new work, revoke a client and interrupt its task, or clean one stopped task. Discarding uncollected output requires an explicit choice.

## Data locations

- Configuration: `~/.config/sub2sub/config.json`, or the `SUB2SUB_CONFIG` path.
- State: `~/.local/state/sub2sub`, or an absolute `stateRoot` in that configuration.
- On Windows, `~` means the current user's home directory.

These directories contain pairing credentials, identities, and task files. Do not share them wholesale. First use creates configuration as needed; `config.example.json` illustrates structure, with device-specific paths to replace.

## Device names and local storage

Ask to rename this device in sub2sub, or edit its display name under Settings in the management page. This does not rename the operating system. Paired devices learn changes on subsequent contact; duplicate names receive local numbers. Leave the connection alias blank to follow the device name. Explicit aliases remain unchanged.

Ask to inspect local storage, or open Settings → Local storage. Inspect task records, input snapshots, answers and outputs, and complete copies, including old versus current files. Shared paths count once in totals. Figures are file bytes; actual disk space reclaimed can differ.

Preview paths, sizes and consequences before deletion. Clear old files only, or all local files, optionally removing the task record and its usage as well. In this version, clearing all local files prevents further collection or continuation of that task; start a new task from original inputs if needed. Source projects, remote data and native client history are preserved. Keeping the record marks it as locally cleared. Local cleanup is manual; host work copies retain their existing cleanup flow and retention policy.
