# Work-copy and delivery rules

Read for task preparation, result collection or cleanup.

## Select input

1. Identify the task and authorized provider. Choose required sources, tests, configuration and instructions. Default selection is current Git-tracked content, including uncommitted edits; use explicit paths for untracked or narrower task inputs.
2. Call `prepare_work_copy` with `peer`. Show destination, scope, file count and size before transfer. It freezes a local snapshot; later source edits are not included.
3. Check task-specific sensitive content. Credentials, unrelated files and separately sensitive material are outside the ordinary grant. Filename exclusions do not replace content inspection. Links, special files, common secret paths and dependency caches are excluded or rejected.
4. Use the returned constraints to resolve excess size/count by adjusting authorized advanced limits or narrowing scope. Do not truncate input or rename credentials to evade exclusions.

## Collect and continue

New tasks reserve the work copy's root `.sub2sub` directory for disposable tool caches and temporary files. The provider supplies its exact path. It is not transferred or treated as a missing deliverable, and is removed by the existing work-copy cleanup. Keep deliverables and files needed for continuation outside it. Do not classify arbitrary `.cache` directories, screenshots or intermediate tables as disposable; their purpose depends on the task. Older tasks keep their existing skipped-file rules.

After a completed phase, `collect_result` saves a complete `workCopyDirectory`, plus a historical `resultDirectory` containing this synchronization's changed files, `changes.json` and `response.md`. `responseFile` points directly to that text answer. A valid incremental return with no file additions, modifications or deletions reuses the existing complete copy; text, skipped paths and save confirmation still update. First collection and file changes build independent copies. Deleted files are removed from the new task copy; the source workspace and previous results remain unchanged.

Deliver local file links and the saved text answer together. For a later “view/open results” request, use `list_tasks` and these saved paths only, even if the provider is offline or the remote copy was cleared. Read the existing local `resultDirectory/changes.json` to retain skipped-output and execution-error warnings; a saved transfer alone does not mean all required outputs arrived. Do not connect to the provider or collect again just to view results. A pending execution means the paths still refer to an earlier save; clearly label it. Use only verified local files for links, even when the saved answer mentions remote paths.

Verify delivery: the main turn completed, saving succeeded, and required artifacts are present and readable. A text-only answer and an empty change list can be valid. Attribute quality checks to the provider. Failed/interrupted turns may return recovery files, but those do not establish successful execution.

The provider records successful saving only after the complete local generation and its index have been saved. Retry `collect_result` after download or confirmation failure; keep the same task ID. If an earlier result awaits confirmation, finish that synchronization before starting another turn.

Inspect `skipped` against required outputs. For a needed non-sensitive output, continue the same task to move it into a transferable path and collect again. Preserve credential exclusions. Only put paths known to contain no needed output into `discardPaths`; do not blindly copy the skipped list.

A new round reuses the remote copy. After ordinary cleanup, `continue_task` restores only this task's confirmed local file scope, including its known build outputs, checks the full upload limit and resumes the existing native session. Deleted native history, missing necessary inputs or explicitly discarded newer results are reported as recovery limits.

## Clean

Use the main skill's cleanup policy. `workcopy` is the normal recoverable cleanup; `records` and `all` are separate explicit broader deletion choices. Required results must be saved, skipped necessary outputs resolved, and execution stopped. Existing source, complete local copies, historical downloads and the local task index remain. Status queries distinguish recorded cleanup from fresh file inspection. Report failures and retry the same scoped operation after resolving them.
