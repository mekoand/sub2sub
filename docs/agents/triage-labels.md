# Triage labels

Use Matt's five canonical roles directly:

| Label | Meaning |
| --- | --- |
| `needs-triage` | Maintainer needs to evaluate the issue. |
| `needs-info` | Required information is missing. |
| `ready-for-agent` | The brief is clear enough for an agent; prerequisites still need checking. |
| `ready-for-human` | Human judgment, access or implementation is needed. |
| `wontfix` | The request will not be pursued; record the reason and close it. |

After triage, keep exactly one role label. Use `bug` or `enhancement` for the category; other existing labels may add context. Maintainer-approved tasks can enter as `ready-for-agent` without repeating triage.

Use GitHub open/closed state and linked PRs for progress and completion, following [the issue workflow](issue-tracker.md). A closed issue may be completed or declined; retain that distinction when evaluating dependencies.
