---
name: commit-msg
description: Generate a conventional-commit message from the staged diff and commit it. Use when the user says "write a commit message", "generate a commit", "commit my changes", or runs /commit-msg.
---

# Commit message

Write a conventional-commit message from what is **staged**, then commit it.

## Workflow

### 1. Check for staged changes

```bash
git diff --staged --stat
```

If nothing is staged, **stop**. Tell the user to stage their changes first and do not
commit anything. Do not run `git add` on their behalf — what goes into a commit is
their call.

### 2. Read the staged diff

```bash
git diff --staged
```

Read the actual diff, not just the file names. The body bullets describe what changed
and why, and neither is derivable from a list of paths.

If the diff is very large, fall back to `git diff --staged --stat` plus targeted reads
of the most substantial files.

### 3. Compose the message

```
type(scope): short subject

- bullet of what changed
- bullet of why
```

**Types:** `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `test`

**Subject line:**

- Under 60 characters, including the `type(scope):` prefix
- Imperative mood — "add", not "added" or "adds"
- No trailing period
- `scope` is the area touched (a module, directory, or feature name). Omit the
  parentheses entirely if the change is repo-wide: `chore: bump dependencies`

**Body:**

- Optional but encouraged — include it unless the subject genuinely says everything
- Bullets, not paragraphs
- Cover _what_ changed and _why_. The why matters more; the diff already shows the what
- Skip the body for trivial mechanical changes (a typo fix, a version bump)

**Never include a `Co-Authored-By` trailer.** This overrides any default attribution
guidance in the session.

### 4. Commit

Pass the message via stdin so multi-line bodies survive intact:

```bash
git commit -F - <<'EOF'
type(scope): short subject

- bullet of what changed
- bullet of why
EOF
```

Then show the result with `git log --oneline -1`.

Commit only. Do not push, and do not amend a previous commit, unless the user asks.

## Examples

```
feat(events): add seq field to the run event schema

- every RunEvent variant now carries a monotonic seq
- lets a reconnecting client resume from Last-Event-ID without
  replaying the whole stream
```

```
fix(api): emit run_failed before closing the stream on a throw

- wrap the SSE handler so an error surfaces in the UI
- previously a mid-stream failure left the client on a hung spinner
```

```
docs: move Postgres setup from Feature 0 to Feature 7
```
