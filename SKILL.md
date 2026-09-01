---
name: grok-to-codex-sessions
description: Inspect, back up, and migrate local Grok CLI sessions into native Codex threads grouped by project without model calls. Use when a user asks to sync, import, convert, repair, or troubleshoot Grok conversations in Codex /resume. Do not use for cloud account exports or unrelated chat platforms.
---

# Grok To Codex Sessions

Migrate local Grok CLI history into Codex's native thread storage. Treat this as a local data migration, not a chat summarization task.

## Preconditions

- Require Node.js 24 or newer and an installed `codex` CLI.
- Locate this skill's directory before running its scripts.
- Close Codex clients that have any target imported thread open. The script detects many concurrent changes, but Codex does not honor this tool's migration lock.
- Read [references/compatibility.md](references/compatibility.md) when the installed Codex version or filesystem layout differs from the tested versions.

## Workflow

1. Run a dry-run first:

   ```bash
   node <skill-directory>/scripts/grok-to-codex-sessions.mjs
   ```

2. Report selected session count, project count, source size, and the `new`, `update`, `repair`, `unchanged`, `empty`, and `failed` counts.
3. Before applying, tell the user that this writes Codex rollout JSONL and SQLite projection files. Obtain explicit confirmation if the user has not already authorized the migration.
4. Apply the migration:

   ```bash
   node <skill-directory>/scripts/grok-to-codex-sessions.mjs --apply
   ```

   Keep the automatic backup enabled. The tool retains the newest five backups by default; use `--backup-retention <n>` to change the bound. Use `--no-backup` only when the user explicitly requests it and understands the risk.
5. Run the same command without `--apply` again. Expect all successfully imported non-empty sessions to be `unchanged`.
6. Ask the user to restart Codex CLI and verify the imported `[Grok]` threads with `/resume`.

Use `--project <absolute-path>`, `--session <uuid>`, or `--limit <n>` to narrow a migration. Use `--grok-home` and `--codex-home` for isolated tests or non-default installations.

## Invariants

- Never call a model to transform the conversation.
- Read only `summary.json` and `chat_history.jsonl` from each Grok session.
- Never read or import `updates.jsonl`, tool traces, terminal logs, system prompts, or reasoning.
- Preserve each decoded source project path as the Codex thread `cwd`.
- Keep all generated response item IDs at 64 characters or fewer.
- Process sessions sequentially and hold the apply lock for the full write operation.
- Do not overwrite a migrated thread after it has been continued in Codex.
- Advance the manifest only after the canonical rollout and SQLite projections are rebuilt successfully.
- Never delete Grok source files. Deletion is a separate operation requiring an explicit request.

## Failure Handling

- On an apply-lock error, inspect `<codex-home>/grok-session-import/apply.lock/owner.json`. Remove a stale lock only after confirming that process is no longer running.
- On a continuation refusal, keep the Codex thread unchanged. Do not force an overwrite; migrate to a new thread only after getting user direction.
- On a rollout concurrency error, close active Codex clients and retry.
- On an internal schema mismatch, stop writing and consult [references/compatibility.md](references/compatibility.md). Do not guess table or event shapes.
- Backups are stored under `<codex-home>/grok-session-import/backups/` and include consistent SQLite snapshots plus selected imported rollouts.
