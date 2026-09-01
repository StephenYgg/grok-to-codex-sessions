# Grok to Codex Sessions

An experimental Codex Skill and dependency-free Node.js CLI that migrates local Grok CLI conversations into native Codex threads. It preserves project grouping and makes imported conversations discoverable through Codex CLI `/resume` without sending their content to a model.

> This project writes Codex's local rollout and SQLite projection files. Run the dry-run first, close active Codex clients, and keep the automatic backup enabled. Codex's local storage schema is not a public compatibility contract.

## What It Imports

- Session title and timestamps from `summary.json`
- User and assistant messages from `chat_history.jsonl`
- The decoded project path as the Codex thread working directory

It deliberately ignores `updates.jsonl`, tool traces, terminal logs, system prompts, synthetic reminders, and reasoning.

## Requirements

- macOS or Linux
- Node.js 24 or newer
- Codex CLI installed and authenticated
- Local Grok CLI sessions under `~/.grok/sessions`

Tested with Node.js 24.16.0 and Codex CLI 0.150.1. See [compatibility notes](references/compatibility.md) before using another Codex storage generation.

## Install As A Codex Skill

After publishing or cloning the repository, install it with Codex's skill installer or link it into the user skill directory:

```bash
git clone https://github.com/YOUR_ACCOUNT/grok-to-codex-sessions.git
mkdir -p "$HOME/.agents/skills"
ln -s "$(pwd)/grok-to-codex-sessions" "$HOME/.agents/skills/grok-to-codex-sessions"
```

Then invoke it explicitly:

```text
$grok-to-codex-sessions migrate my local Grok sessions into Codex
```

See the [Codex Skills documentation](https://developers.openai.com/codex/build-skills) for additional installation and discovery options.

## CLI Usage

Dry-run all sessions:

```bash
node scripts/grok-to-codex-sessions.mjs
```

Apply after reviewing the counts:

```bash
node scripts/grok-to-codex-sessions.mjs --apply
```

Limit the scope when validating a new environment:

```bash
node scripts/grok-to-codex-sessions.mjs --session 00000000-0000-4000-8000-000000000000
node scripts/grok-to-codex-sessions.mjs --project /absolute/path/to/project
node scripts/grok-to-codex-sessions.mjs --limit 5
```

Run `node scripts/grok-to-codex-sessions.mjs --help` for all options.

## Safety Model

- Dry-run is the default; writes require `--apply`.
- Apply runs are serialized with an atomic local lock.
- A consistent SQLite backup and copies of selected existing rollouts are created before writes; only the newest five backup sets are retained by default.
- Source history must remain append-only after its first import.
- Existing Codex continuations are detected and never overwritten.
- Generated item IDs are deterministically capped at 64 characters.
- Manifest progress is finalized only after rollout and projections are rebuilt.
- Sessions are processed sequentially, so work is bounded by the selected session count rather than fanning out with history size.

The lock coordinates this migrator only. It cannot stop another Codex process from writing, so close active Codex clients before applying.

## Development

```bash
npm test
npm run check
python3 /path/to/skill-creator/scripts/quick_validate.py .
```

Tests use synthetic records and temporary directories only. Never add real session files to fixtures or issue reports.

## Status

This is an experimental migration utility, not an official OpenAI or xAI project. Compatibility changes in either CLI may require updates to the parser or Codex projection writer.

## License

[MIT](LICENSE)
