# Security Policy

Session histories can contain source code, credentials, personal data, and internal project names. Do not attach real `summary.json`, `chat_history.jsonl`, Codex rollouts, SQLite databases, manifests, or backup directories to public issues.

For a suspected vulnerability, contact the repository maintainer privately through the security reporting channel configured on GitHub. Include a synthetic reproduction and the affected versions. Redact local usernames, absolute project paths, thread IDs, and message content.

The tool operates only on local files and the local Codex app-server process. It does not intentionally make network requests or send session content to a model.
