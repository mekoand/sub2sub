# Issue tracker: GitHub

Future requirements, specifications and work status are tracked in [mekoand/sub2sub Issues](https://github.com/mekoand/sub2sub/issues), starting after 0.5.3. Completed local Markdown tasks remain historical records. `.scratch/` may hold working notes, but current scope, decisions and status belong in the issue.

## Plan the work

- Search existing issues before creating one. A small change needs one issue; a larger effort may have a parent specification and independently verifiable child tasks.
- Each implementation issue states the problem, expected result, scope and non-goals, acceptance criteria, and blocking issues. Write from the user's perspective; each task should deliver a complete, testable behavior.
- Discuss unresolved product choices before marking work ready. Matt's `grill-with-docs` → `to-spec` → `to-tickets` flow fits larger work; an already clear small change can go directly to one issue. Contributors can follow this workflow without installing the skills.
- Use `triage` for incoming reports. Maintainer-approved specifications and tasks can use `ready-for-agent` directly. See [triage labels](triage-labels.md).

## Implement and finish

1. Read the issue, comments and linked decisions. Work within the maintainer's request: a planning or ticketing request ends after the issue updates.
2. Start an implementation task once its prerequisites are satisfied. `ready-for-agent` means the brief is clear; check blockers separately. Use native issue dependencies where available, otherwise list them under `Blocked by`. A prerequisite is satisfied by its required outcome, not merely by being closed as a duplicate or declined request.
3. Assign the issue when starting, and work on a branch from the public repository's current `main`. For a parent with implementation children, work the children and use the parent to track the combined result.
4. Open a PR linked to the issue. Record the checks actually run and any remaining limitations. Follow [the contribution guide](../../CONTRIBUTING.md) for testing and review.
5. Use `Closes #N` when the PR meets the issue's full acceptance criteria; merge then closes it. A partial PR uses `Refs #N` and leaves the issue open. Close a parent only after its overall acceptance criteria are met. Research-only issues close after the agreed findings are recorded; no code PR is required.

Issue open/closed state, assignees and linked PRs track progress. The triage labels describe what kind of attention an issue needs; they are not a second progress board. Update the issue when scope or blockers change, and record the release version when relevant.

## Tracker operations

Use `gh` with the explicit repository, even when working in a local copy without the public remote:

```sh
gh issue list --repo mekoand/sub2sub --state open
gh issue view 1 --repo mekoand/sub2sub --comments
```

Replace `1` with the relevant issue number. Read labels along with the body and comments. When a Matt skill says to publish a specification or ticket, create a GitHub issue; when it says to fetch a ticket, read that issue. For multiline issue, comment and PR bodies, use a file with actual newlines and `--body-file`.

**PRs as a request surface: no.** Incoming reports are triaged as issues; implementation PRs stay linked to their issues.
