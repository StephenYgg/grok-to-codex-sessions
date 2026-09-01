import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  acquireApplyLock,
  createBackup,
  deterministicItemId,
  deterministicUuid,
  findCodexContinuation,
  loadManifest,
  parseChat,
  prefixHash,
  pruneBackups,
  responseItems,
  stripGrokWrapper,
  validateItemIds,
} from "../scripts/grok-to-codex-sessions.mjs";

async function withTemporaryDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "grok-codex-test-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("deterministic item IDs are stable and capped at 64 characters", () => {
  const first = deterministicItemId("msg_", "session:turn:assistant:0");
  const second = deterministicItemId("msg_", "session:turn:assistant:0");
  assert.equal(first, second);
  assert.equal(first.length, 64);
  assert.match(first, /^msg_[0-9a-f]+$/);
});

test("item ID validation rejects IDs longer than Codex accepts", () => {
  assert.throws(
    () => validateItemIds([{ payload: { id: "x".repeat(65) } }]),
    /exceeds 64 characters/,
  );
});

test("Grok wrappers are removed without importing reminders", () => {
  const wrapped = [
    "<user_info>private metadata</user_info>",
    "<system-reminder>internal reminder</system-reminder>",
    "<user_query>Keep this question</user_query>",
  ].join("\n");
  assert.equal(stripGrokWrapper(wrapped), "Keep this question");
});

test("synthetic user records and non-conversation records are ignored", () => {
  assert.deepEqual(responseItems({ type: "user", synthetic_reason: "system", content: [] }), []);
  assert.deepEqual(responseItems({ type: "tool", content: "secret output" }), []);
});

test("invalid JSONL reports the source line", () => {
  assert.throws(() => parseChat('{"type":"user"}\nnot-json\n'), /line 2/);
});

test("Codex continuation detection distinguishes imported and local turns", () => {
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const records = parseChat(`${JSON.stringify({
    type: "user",
    content: [{ type: "text", text: "question" }],
  })}\n`);
  const importedTurnId = deterministicUuid(`${sessionId}:turn:0`);
  const importedOnly = `${JSON.stringify({
    type: "event_msg",
    payload: { type: "task_started", turn_id: importedTurnId },
  })}\n`;
  assert.equal(findCodexContinuation(importedOnly, records, sessionId), undefined);

  const localTurn = {
    type: "event_msg",
    payload: { type: "task_started", turn_id: "11111111-1111-4111-8111-111111111111" },
  };
  const mixed = `${importedOnly}${JSON.stringify(localTurn)}\n`;
  assert.deepEqual(findCodexContinuation(mixed, records, sessionId), localTurn);
});

test("manifest v2 upgrades to a completed v3 projection", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "manifest.json");
    await writeFile(path, JSON.stringify({
      version: 2,
      imports: { key: { codexThreadId: "thread-id" } },
    }));
    const manifest = await loadManifest(path);
    assert.equal(manifest.version, 3);
    assert.equal(manifest.imports.key.projectionComplete, true);
  });
});

test("apply lock permits one writer and releases cleanly", async () => {
  await withTemporaryDirectory(async (codexHome) => {
    const release = await acquireApplyLock(codexHome);
    await assert.rejects(() => acquireApplyLock(codexHome), /Another migration may be running/);
    await release();
    const releaseAgain = await acquireApplyLock(codexHome);
    await releaseAgain();
  });
});

test("backup creates consistent SQLite snapshots in an isolated Codex home", async () => {
  await withTemporaryDirectory(async (codexHome) => {
    await mkdir(codexHome, { recursive: true });
    for (const name of ["state_5.sqlite", "thread_history_1.sqlite"]) {
      const database = new DatabaseSync(join(codexHome, name));
      database.exec("CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES ('ok')");
      database.close();
    }

    const backupRoot = await createBackup({
      codexHome,
      manifest: { version: 3, imports: {} },
      sessions: [],
    });
    const metadata = JSON.parse(await readFile(join(backupRoot, "backup.json"), "utf8"));
    assert.deepEqual(metadata.databases.sort(), ["state_5.sqlite", "thread_history_1.sqlite"]);

    const backup = new DatabaseSync(join(backupRoot, "state_5.sqlite"), { readOnly: true });
    try {
      assert.equal(backup.prepare("SELECT value FROM sample").get().value, "ok");
    } finally {
      backup.close();
    }
  });
});

test("backup retention removes only older backup directories", async () => {
  await withTemporaryDirectory(async (codexHome) => {
    const root = join(codexHome, "grok-session-import", "backups");
    for (const name of ["20260101T000000000Z", "20260102T000000000Z", "20260103T000000000Z"])
      await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, "README.txt"), "preserve non-directory entries");

    assert.equal(await pruneBackups(codexHome, 2), 1);
    assert.deepEqual((await readdir(root)).sort(), [
      "20260102T000000000Z",
      "20260103T000000000Z",
      "README.txt",
    ]);
  });
});

test("CLI dry-run discovers a project session and never opens updates.jsonl", async () => {
  await withTemporaryDirectory(async (directory) => {
    const grokHome = join(directory, "grok");
    const codexHome = join(directory, "codex");
    const sessionId = "00000000-0000-4000-8000-000000000002";
    const sessionDirectory = join(grokHome, "sessions", encodeURIComponent("/tmp/example-project"), sessionId);
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, "summary.json"), JSON.stringify({
      created_at: "2026-01-01T00:00:00Z",
      generated_title: "Synthetic session",
      last_active_at: "2026-01-01T00:01:00Z",
    }));
    await writeFile(join(sessionDirectory, "chat_history.jsonl"), `${JSON.stringify({
      type: "user",
      content: [{ type: "text", text: "hello" }],
    })}\n`);
    await writeFile(join(sessionDirectory, "updates.jsonl"), "this is intentionally invalid JSONL");

    const script = fileURLToPath(new URL("../scripts/grok-to-codex-sessions.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [
      script,
      "--grok-home", grokHome,
      "--codex-home", codexHome,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run: 1 sessions across 1 projects/);
    assert.match(result.stdout, /\[new\] \/tmp\/example-project/);
    assert.match(result.stdout, /"new":1/);
  });
});

test("unchanged apply neither starts app-server nor creates a backup", async () => {
  await withTemporaryDirectory(async (directory) => {
    const grokHome = join(directory, "grok");
    const codexHome = join(directory, "codex");
    const cwd = "/tmp/unchanged-project";
    const sessionId = "00000000-0000-4000-8000-000000000006";
    const sessionDirectory = join(grokHome, "sessions", encodeURIComponent(cwd), sessionId);
    const chat = `${JSON.stringify({
      type: "user",
      content: [{ type: "text", text: "already imported" }],
    })}\n`;
    await mkdir(sessionDirectory, { recursive: true });
    await mkdir(join(codexHome, "grok-session-import"), { recursive: true });
    await writeFile(join(sessionDirectory, "summary.json"), JSON.stringify({
      generated_title: "Unchanged session",
    }));
    await writeFile(join(sessionDirectory, "chat_history.jsonl"), chat);
    await writeFile(join(codexHome, "grok-session-import", "manifest.json"), JSON.stringify({
      version: 3,
      imports: {
        [`${cwd}\n${sessionId}`]: {
          codexThreadId: "thread-id",
          importedChatLines: 1,
          prefixHash: prefixHash(parseChat(chat), 1),
          projectionComplete: true,
          sourceCwd: cwd,
          sourceSessionId: sessionId,
        },
      },
    }));

    const script = fileURLToPath(new URL("../scripts/grok-to-codex-sessions.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [
      script,
      "--apply",
      "--grok-home", grokHome,
      "--codex-home", codexHome,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[unchanged\]/);
    assert.doesNotMatch(result.stdout, /Backup:/);
  });
});
