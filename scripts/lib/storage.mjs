import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { backup as backupDatabase, DatabaseSync } from "node:sqlite";

import {
  buildCanonicalRollout,
  findCodexContinuation,
  parseChat,
  sessionKey,
} from "./conversation.mjs";

const MANIFEST_VERSION = 3;

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT")
      return fallback;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function acquireApplyLock(codexHome) {
  const importRoot = join(codexHome, "grok-session-import");
  const lockPath = join(importRoot, "apply.lock");
  const ownerPath = join(lockPath, "owner.json");
  await mkdir(importRoot, { recursive: true });
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error?.code === "EEXIST")
      throw new Error(`Another migration may be running. Inspect and remove stale lock: ${lockPath}`);
    throw error;
  }

  try {
    await writeJsonAtomic(ownerPath, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
  } catch (error) {
    await rmdir(lockPath).catch(() => {});
    throw error;
  }

  return async () => {
    await unlink(ownerPath).catch((error) => {
      if (error?.code !== "ENOENT")
        throw error;
    });
    await rmdir(lockPath).catch((error) => {
      if (error?.code !== "ENOENT")
        throw error;
    });
  };
}

async function backUpDatabase(sourcePath, destinationPath) {
  if (!existsSync(sourcePath))
    return false;
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backupDatabase(source, destinationPath);
  } finally {
    source.close();
  }
  return true;
}

async function createBackup({ codexHome, manifest, sessions }) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const backupRoot = join(codexHome, "grok-session-import", "backups", stamp);
  const rolloutsRoot = join(backupRoot, "rollouts");
  await mkdir(rolloutsRoot, { recursive: true });

  const databaseFiles = ["state_5.sqlite", "thread_history_1.sqlite"];
  const copiedDatabases = [];
  for (const file of databaseFiles) {
    if (await backUpDatabase(join(codexHome, file), join(backupRoot, file)))
      copiedDatabases.push(file);
  }

  const selectedThreadIds = sessions
    .map((session) => manifest.imports[sessionKey(session)]?.codexThreadId)
    .filter((threadId) => typeof threadId === "string");
  const copiedRollouts = [];
  const statePath = join(codexHome, "state_5.sqlite");
  if (selectedThreadIds.length > 0 && existsSync(statePath)) {
    const state = new DatabaseSync(statePath, { readOnly: true });
    try {
      const query = state.prepare("SELECT rollout_path FROM threads WHERE id = ?");
      for (const threadId of selectedThreadIds) {
        const rolloutPath = query.get(threadId)?.rollout_path;
        if (!rolloutPath || !existsSync(rolloutPath))
          continue;
        const destination = join(rolloutsRoot, `${threadId}.jsonl`);
        await copyFile(rolloutPath, destination);
        copiedRollouts.push(`${threadId}.jsonl`);
      }
    } finally {
      state.close();
    }
  }

  await writeJsonAtomic(join(backupRoot, "manifest.json"), manifest);
  await writeJsonAtomic(join(backupRoot, "backup.json"), {
    createdAt: new Date().toISOString(),
    databases: copiedDatabases,
    rollouts: copiedRollouts,
  });
  return backupRoot;
}

async function pruneBackups(codexHome, retention) {
  const backupsRoot = join(codexHome, "grok-session-import", "backups");
  const entries = await readdir(backupsRoot, { withFileTypes: true });
  const stale = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left))
    .slice(retention);
  for (const name of stale)
    await rm(join(backupsRoot, name), { recursive: true, force: true });
  return stale.length;
}
function rebuildProjection({ codexHome, session, threadId, rolloutPath, canonical }) {
  const historyPath = join(codexHome, "thread_history_1.sqlite");
  const statePath = join(codexHome, "state_5.sqlite");
  const database = new DatabaseSync(historyPath);
  try {
    database.exec(`ATTACH DATABASE ${JSON.stringify(statePath)} AS stateDb`);
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("DELETE FROM thread_items WHERE thread_id = ?").run(threadId);
      database.prepare("DELETE FROM thread_turns WHERE thread_id = ?").run(threadId);
      database.prepare("DELETE FROM thread_history_projection_state WHERE thread_id = ?").run(threadId);

      const insertTurn = database.prepare(`
        INSERT INTO thread_turns (
          thread_id, turn_id, rollout_ordinal, status, error_json, started_at,
          completed_at, duration_ms, first_user_item_id, final_agent_item_id,
          rollout_byte_offset, rollout_end_ordinal, rollout_end_byte_offset
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const turn of canonical.projectedTurns) {
        insertTurn.run(
          threadId, turn.turnId, turn.startPosition.ordinal, turn.status,
          turn.startedAt, turn.completedAt, turn.durationMs, turn.firstUserItemId,
          turn.finalAgentItemId, turn.startPosition.start, turn.endPosition.ordinal,
          turn.endPosition.end);
      }

      const insertItem = database.prepare(`
        INSERT INTO thread_items (
          thread_id, turn_id, item_id, rollout_ordinal, created_at_ms,
          item_json, item_type, updated_at_ordinal
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of canonical.projectedItems) {
        insertItem.run(
          threadId, item.turnId, item.itemId, item.position.ordinal,
          item.createdAtMs, JSON.stringify(item.itemJson), item.itemType,
          item.position.ordinal);
      }
      database.prepare(`
        INSERT INTO thread_history_projection_state (
          thread_id, next_rollout_byte_offset, next_rollout_ordinal
        ) VALUES (?, ?, ?)
      `).run(threadId, canonical.fileSize, canonical.recordCount);

      const updatedAt = Math.floor(canonical.updatedMs / 1000);
      const title = `[Grok] ${session.title}`.slice(0, 200);
      const update = database.prepare(`
        UPDATE stateDb.threads
        SET source = 'cli', title = ?, name = ?, first_user_message = ?, preview = ?,
            has_user_event = 1,
            updated_at = ?, updated_at_ms = ?, recency_at = ?, recency_at_ms = ?,
            rollout_path = ?, history_mode = 'paginated'
        WHERE id = ?
      `).run(
        title, title, canonical.firstUserMessage, canonical.preview, updatedAt,
        canonical.updatedMs, updatedAt, canonical.updatedMs, rolloutPath, threadId);
      if (update.changes !== 1)
        throw new Error(`Codex state row not found: ${threadId}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

async function repairThread({ codexHome, manifestEntry, records, session }) {
  const threadId = manifestEntry.codexThreadId;
  const state = new DatabaseSync(join(codexHome, "state_5.sqlite"), { readOnly: true });
  let rolloutPath;
  try {
    rolloutPath = state.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(threadId)?.rollout_path;
  } finally {
    state.close();
  }
  if (!rolloutPath)
    throw new Error(`Cannot locate Codex rollout: ${threadId}`);

  const beforeRead = await stat(rolloutPath);
  const existingRollout = await readFile(rolloutPath, "utf8");
  const afterRead = await stat(rolloutPath);
  if (beforeRead.size !== afterRead.size || beforeRead.mtimeMs !== afterRead.mtimeMs)
    throw new Error(`Codex rollout changed while it was being read; close active Codex clients and retry: ${threadId}`);
  const continuation = findCodexContinuation(existingRollout, records, session.id);
  if (continuation)
    throw new Error(`Codex thread has local continuation turn ${continuation.payload.turn_id}; refusing to overwrite it`);
  const canonical = buildCanonicalRollout({ existingRollout, records, session, threadId });
  const temporaryPath = `${rolloutPath}.repair-${process.pid}`;
  const rollbackPath = `${rolloutPath}.rollback-${process.pid}`;
  await writeFile(temporaryPath, canonical.content, { mode: 0o600 });
  const beforeReplace = await stat(rolloutPath);
  if (afterRead.size !== beforeReplace.size || afterRead.mtimeMs !== beforeReplace.mtimeMs) {
    await unlink(temporaryPath);
    throw new Error(`Codex rollout changed before replacement; close active Codex clients and retry: ${threadId}`);
  }

  await rename(rolloutPath, rollbackPath);
  await rename(temporaryPath, rolloutPath);
  try {
    rebuildProjection({ codexHome, session, threadId, rolloutPath, canonical });
  } catch (error) {
    await unlink(rolloutPath).catch(() => {});
    await rename(rollbackPath, rolloutPath);
    throw error;
  }
  await unlink(rollbackPath);
  return { threadId, turns: canonical.projectedTurns.length, items: canonical.projectedItems.length };
}
async function loadManifest(path) {
  const manifest = await readJson(path, null);
  if (!manifest)
    return { version: MANIFEST_VERSION, imports: {} };
  if (manifest.version === 1 && typeof manifest.imports === "object") {
    const imports = {};
    for (const [sourceSessionId, imported] of Object.entries(manifest.imports)) {
      if (!imported?.sourceCwd)
        throw new Error(`Cannot upgrade manifest entry without sourceCwd: ${sourceSessionId}`);
      imports[`${imported.sourceCwd}\n${sourceSessionId}`] = {
        ...imported,
        projectionComplete: true,
        sourceSessionId,
      };
    }
    return { version: MANIFEST_VERSION, imports };
  }
  if (manifest.version === 2 && typeof manifest.imports === "object") {
    return {
      version: MANIFEST_VERSION,
      imports: Object.fromEntries(Object.entries(manifest.imports).map(([key, imported]) => [
        key,
        { ...imported, projectionComplete: true },
      ])),
    };
  }
  if (manifest.version !== MANIFEST_VERSION || typeof manifest.imports !== "object")
    throw new Error(`Unsupported manifest format: ${path}`);
  return manifest;
}

export {
  acquireApplyLock,
  createBackup,
  loadManifest,
  pruneBackups,
  readJson,
  repairThread,
  writeJsonAtomic,
};
