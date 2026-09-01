# Compatibility And Storage Contract

## Tested Baseline

- Node.js: 24.16.0
- Codex CLI: 0.150.1
- Grok source layout: percent-encoded absolute project directories under `~/.grok/sessions`
- Codex state databases: `state_5.sqlite` and `thread_history_1.sqlite`
- Codex rollout history mode: `paginated`

The migrator uses `node:sqlite` and Codex app-server methods, then builds the local history projection expected by this baseline. These formats and methods may change between Codex releases.

## Expected Grok Layout

```text
~/.grok/sessions/
  %2Fabsolute%2Fproject%2Fpath/
    <session-uuid>/
      summary.json
      chat_history.jsonl
      updates.jsonl        # ignored and never opened
```

`chat_history.jsonl` must contain JSON objects with `type` values such as `user` and `assistant`. The source is treated as append-only after import.

## Expected Codex Layout

The tested Codex generation stores thread metadata in `state_5.sqlite`, paginated turn and item projections in `thread_history_1.sqlite`, and rollout JSONL paths in the `threads` table. New threads are created through `codex app-server`; the script does not invent thread rows directly.

Stop before applying if any required database, table, column, app-server method, or rollout event shape differs. Update the implementation and its synthetic tests for the new generation instead of adding blind fallbacks.

## Upgrade Checklist

1. Run a one-session dry-run against disposable `--grok-home` and `--codex-home` directories.
2. Create a native Codex thread and compare its rollout event shapes and SQLite schema with the assumptions in the script.
3. Apply one synthetic session and confirm it appears in `/resume` with the expected title, working directory, turns, and messages.
4. Continue that imported thread in Codex and confirm a later source update is refused.
5. Confirm every `response_item` and projected item ID is at most 64 characters.
6. Only then test a backed-up copy of real local state.
