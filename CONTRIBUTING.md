# Contributing

Contributions that add verified Grok or Codex storage generations, clearer failure modes, and synthetic regression tests are welcome.

## Development Rules

- Use Node.js 24 or newer.
- Keep the runtime dependency-free unless a dependency removes substantial correctness risk.
- Preserve dry-run as the default.
- Never add fixtures copied from real conversations, manifests, rollouts, or user directories.
- Keep `updates.jsonl`, reasoning, system prompts, terminal logs, and tool traces outside the import path.
- Add tests for storage format changes and failure recovery.

Run before opening a pull request:

```bash
npm run check
```

Describe the exact Grok and Codex CLI versions used for any compatibility change. Redact usernames, project paths, thread IDs, and conversation content from logs.
