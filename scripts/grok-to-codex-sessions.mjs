#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  deterministicItemId,
  deterministicUuid,
  findCodexContinuation,
  groupTurns,
  parseChat,
  prefixHash,
  responseItems,
  sessionKey,
  stripGrokWrapper,
  validateItemIds,
} from "./lib/conversation.mjs";
import {
  acquireApplyLock,
  createBackup,
  loadManifest,
  pruneBackups,
  readJson,
  repairThread,
  writeJsonAtomic,
} from "./lib/storage.mjs";

const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_BACKUP_RETENTION = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: grok-to-codex-sessions [options]\n\n`);
  stream.write(`Migrates Grok chat history into native Codex threads without calling a model.\n`);
  stream.write(`Grok updates.jsonl, terminal logs, system prompts, and reasoning are never read.\n\n`);
  stream.write(`Options:\n`);
  stream.write(`  --dry-run             Inspect only (default)\n`);
  stream.write(`  --apply               Create/update Codex threads\n`);
  stream.write(`  --session <uuid>      Migrate one Grok session\n`);
  stream.write(`  --project <path>      Migrate sessions belonging to one project path\n`);
  stream.write(`  --limit <n>           Process at most n selected sessions\n`);
  stream.write(`  --grok-home <path>    Default: ~/.grok\n`);
  stream.write(`  --codex-home <path>   Default: ~/.codex\n`);
  stream.write(`  --chunk-bytes <n>     Maximum injected JSON payload per request\n`);
  stream.write(`  --no-backup           Skip the automatic pre-apply backup\n`);
  stream.write(`  --backup-retention <n> Keep the newest n backups (default: 5)\n`);
  stream.write(`  --help                Show this help\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {
    apply: false,
    backupRetention: DEFAULT_BACKUP_RETENTION,
    chunkBytes: DEFAULT_CHUNK_BYTES,
    codexHome: join(homedir(), ".codex"),
    grokHome: join(homedir(), ".grok"),
    limit: null,
    backup: true,
    project: null,
    session: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length)
        usage(2);
      return argv[index];
    };

    switch (arg) {
      case "--apply":
        options.apply = true;
        break;
      case "--dry-run":
        options.apply = false;
        break;
      case "--session":
        options.session = value();
        break;
      case "--project":
        options.project = resolve(value());
        break;
      case "--limit":
        options.limit = Number.parseInt(value(), 10);
        break;
      case "--grok-home":
        options.grokHome = resolve(value());
        break;
      case "--codex-home":
        options.codexHome = resolve(value());
        break;
      case "--chunk-bytes":
        options.chunkBytes = Number.parseInt(value(), 10);
        break;
      case "--no-backup":
        options.backup = false;
        break;
      case "--backup-retention":
        options.backupRetention = Number.parseInt(value(), 10);
        break;
      case "--help":
      case "-h":
        usage(0);
        break;
      default:
        process.stderr.write(`Unknown option: ${arg}\n`);
        usage(2);
    }
  }

  if (options.session && !UUID_RE.test(options.session))
    throw new Error(`Invalid session id: ${options.session}`);
  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit <= 0))
    throw new Error("--limit must be a positive integer");
  if (!Number.isInteger(options.chunkBytes) || options.chunkBytes < 64 * 1024)
    throw new Error("--chunk-bytes must be at least 65536");
  if (!Number.isInteger(options.backupRetention) || options.backupRetention <= 0)
    throw new Error("--backup-retention must be a positive integer");

  return options;
}


function decodeProjectDirectory(name) {
  try {
    return decodeURIComponent(name);
  } catch {
    return null;
  }
}

async function discoverSessions(options) {
  const sessionsRoot = join(options.grokHome, "sessions");
  const projectEntries = await readdir(sessionsRoot, { withFileTypes: true });
  const sessions = [];

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory())
      continue;

    const cwd = decodeProjectDirectory(projectEntry.name);
    if (!cwd || !cwd.startsWith("/"))
      continue;
    if (options.project && resolve(cwd) !== options.project)
      continue;

    const projectDirectory = join(sessionsRoot, projectEntry.name);
    const sessionEntries = await readdir(projectDirectory, { withFileTypes: true });
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory() || !UUID_RE.test(sessionEntry.name))
        continue;
      if (options.session && sessionEntry.name !== options.session)
        continue;

      const directory = join(projectDirectory, sessionEntry.name);
      const chatPath = join(directory, "chat_history.jsonl");
      const summaryPath = join(directory, "summary.json");
      if (!existsSync(chatPath) || !existsSync(summaryPath))
        continue;

      const summary = await readJson(summaryPath, {});
      const chatStat = await stat(chatPath);
      sessions.push({
        chatPath,
        chatSize: chatStat.size,
        createdAt: summary.created_at ?? null,
        cwd,
        directory,
        id: sessionEntry.name,
        title: summary.generated_title || summary.session_summary || sessionEntry.name,
        updatedAt: summary.last_active_at || summary.updated_at || null,
      });
    }
  }

  sessions.sort((left, right) =>
    String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")) ||
    left.id.localeCompare(right.id));
  return options.limit === null ? sessions : sessions.slice(0, options.limit);
}



function buildChunks(records, startLine, maxBytes) {
  const chunks = [];
  let current = { endLine: startLine, items: [], size: 0 };

  for (let index = startLine; index < records.length; index += 1) {
    const items = responseItems(records[index].entry);
    const size = Buffer.byteLength(JSON.stringify(items));
    if (current.items.length > 0 && current.size + size > maxBytes) {
      chunks.push(current);
      current = { endLine: index, items: [], size: 0 };
    }
    current.items.push(...items);
    current.size += size;
    current.endLine = index + 1;
  }

  if (current.endLine > startLine)
    chunks.push(current);
  return chunks;
}

class AppServerClient {
  constructor(codexHome) {
    this.codexHome = codexHome;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.child = null;
  }

  async start() {
    this.child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      env: { ...process.env, CODEX_HOME: this.codexHome },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-16_384);
    });
    this.child.on("exit", (code, signal) => {
      const error = new Error(`codex app-server exited (${code ?? signal})\n${this.stderr}`);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.pending.clear();
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === undefined)
        return;
      const pending = this.pending.get(String(message.id));
      if (!pending)
        return;
      clearTimeout(pending.timer);
      this.pending.delete(String(message.id));
      if (message.error)
        pending.reject(new Error(`${pending.method}: ${message.error.message ?? JSON.stringify(message.error)}`));
      else
        pending.resolve(message.result);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "grok-to-codex-sessions",
        title: "Grok to Codex session migrator",
        version: "1.0.0",
      },
      capabilities: null,
    });
    this.notify("initialized");
  }

  request(method, params) {
    const id = String(this.nextId++);
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`${method}: request timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { method, reject: rejectPromise, resolve: resolvePromise, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method, params = undefined) {
    const message = params === undefined ? { method } : { method, params };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close() {
    if (!this.child)
      return;
    this.child.stdin.end();
    await new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGTERM");
        resolvePromise();
      }, 2_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }
}

function threadIdFromResult(result) {
  const id = result?.thread?.id ?? result?.threadId ?? result?.id;
  if (typeof id !== "string" || !id)
    throw new Error(`thread/start returned no thread id: ${JSON.stringify(result)}`);
  return id;
}

async function createThread(client, session) {
  const result = await client.request("thread/start", {
    approvalPolicy: "never",
    cwd: session.cwd,
    ephemeral: false,
    sandbox: "read-only",
    threadSource: "grok-import",
  });
  const threadId = threadIdFromResult(result);
  await client.request("thread/name/set", {
    name: `[Grok] ${session.title}`.slice(0, 200),
    threadId,
  });
  return threadId;
}


async function migrateSession({ client, manifest, manifestPath, options, raw: sourceRaw = null, session }) {
  const raw = sourceRaw ?? await readFile(session.chatPath, "utf8");
  const records = parseChat(raw);
  const importKey = sessionKey(session);
  const existing = manifest.imports[importKey] ?? null;
  const startLine = existing?.importedChatLines ?? 0;

  if (startLine > records.length)
    throw new Error(`source history shrank from ${startLine} to ${records.length} lines`);
  if (existing && existing.prefixHash !== prefixHash(records, startLine))
    throw new Error("source history changed before the last imported line");

  const allItems = records.reduce((count, record) => count + responseItems(record.entry).length, 0);
  const pendingItems = records.slice(startLine)
    .reduce((count, record) => count + responseItems(record.entry).length, 0);

  if (!options.apply) {
    const status = existing
      ? (!existing.projectionComplete ? "repair" : (startLine === records.length ? "unchanged" : "update"))
      : (allItems === 0 ? "empty" : "new");
    return { allItems, lineCount: records.length, pendingItems, status };
  }
  if (existing && startLine === records.length && existing.projectionComplete)
    return {
      allItems,
      lineCount: records.length,
      pendingItems: 0,
      status: "unchanged",
      threadId: existing.codexThreadId,
    };
  if (!existing && allItems === 0)
    return { allItems: 0, lineCount: records.length, pendingItems: 0, status: "empty" };

  if (existing) {
    return {
      allItems,
      lineCount: records.length,
      pendingItems,
      status: existing.projectionComplete ? "update" : "repair",
      threadId: existing.codexThreadId,
    };
  }

  const threadId = await createThread(client, session);

  manifest.imports[importKey] = {
    codexThreadId: threadId,
    createdAt: session.createdAt,
    importedAt: new Date().toISOString(),
    importedChatLines: startLine,
    prefixHash: prefixHash(records, startLine),
    projectionComplete: false,
    sourceCwd: session.cwd,
    sourceSessionId: session.id,
    sourceTitle: session.title,
    sourceUpdatedAt: session.updatedAt,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(manifestPath, manifest);

  for (const chunk of buildChunks(records, startLine, options.chunkBytes)) {
    if (chunk.items.length > 0)
      await client.request("thread/inject_items", { items: chunk.items, threadId });
    const imported = manifest.imports[importKey];
    imported.importedChatLines = chunk.endLine;
    imported.prefixHash = prefixHash(records, chunk.endLine);
    imported.sourceUpdatedAt = session.updatedAt;
    imported.updatedAt = new Date().toISOString();
    await writeJsonAtomic(manifestPath, manifest);
  }

  return { allItems, lineCount: records.length, pendingItems, status: "created", threadId };
}

async function runMigration(options) {
  const manifestPath = join(options.codexHome, "grok-session-import", "manifest.json");
  const manifest = await loadManifest(manifestPath);
  const sessions = await discoverSessions(options);
  if (options.session && sessions.length === 0)
    throw new Error(`Grok session not found: ${options.session}`);

  const projects = new Set(sessions.map((session) => session.cwd));
  const totalBytes = sessions.reduce((sum, session) => sum + session.chatSize, 0);
  process.stdout.write(`${options.apply ? "Applying" : "Dry run"}: ${sessions.length} sessions across ${projects.size} projects, ${(totalBytes / 1024 / 1024).toFixed(1)} MiB chat history\n`);
  process.stdout.write(`Manifest: ${manifestPath}\n`);

  const plannedSources = new Map();
  const plannedStatuses = [];
  if (options.apply) {
    for (const session of sessions) {
      const raw = await readFile(session.chatPath, "utf8");
      plannedSources.set(sessionKey(session), raw);
      try {
        const planned = await migrateSession({
          client: null,
          manifest,
          manifestPath,
          options: { ...options, apply: false },
          raw,
          session,
        });
        plannedStatuses.push(planned.status);
      } catch {
        // The main pass reports the session-specific validation error without mutating it.
      }
    }

    const hasMutations = plannedStatuses.some((status) => ["new", "repair", "update"].includes(status));
    if (options.backup && hasMutations) {
      const backupPath = await createBackup({ codexHome: options.codexHome, manifest, sessions });
      process.stdout.write(`Backup: ${backupPath}\n`);
      const pruned = await pruneBackups(options.codexHome, options.backupRetention);
      if (pruned > 0)
        process.stdout.write(`Pruned backups: ${pruned}\n`);
    }
    await writeJsonAtomic(manifestPath, manifest);
  }

  let client = null;
  if (options.apply && plannedStatuses.includes("new")) {
    client = new AppServerClient(options.codexHome);
    await client.start();
  }

  const counters = { created: 0, empty: 0, failed: 0, new: 0, repair: 0, repaired: 0, unchanged: 0, update: 0 };
  const repairCandidates = [];
  try {
    for (const session of sessions) {
      try {
        const raw = plannedSources.get(sessionKey(session)) ?? null;
        const result = await migrateSession({ client, manifest, manifestPath, options, raw, session });
        counters[result.status] = (counters[result.status] ?? 0) + 1;
        if (options.apply && ["created", "repair", "update"].includes(result.status) && result.threadId && result.allItems > 0)
          repairCandidates.push({ raw, session, threadId: result.threadId });
        const target = result.threadId ? ` -> ${result.threadId}` : "";
        process.stdout.write(`[${result.status}] ${session.cwd} :: ${session.id} :: ${session.title} (${result.pendingItems}/${result.allItems} pending messages)${target}\n`);
      } catch (error) {
        counters.failed += 1;
        process.stderr.write(`[failed] ${session.cwd} :: ${session.id}: ${error.message}\n`);
      }
    }
  } finally {
    await client?.close();
  }

  if (options.apply) {
    for (const candidate of repairCandidates) {
      try {
        const records = parseChat(candidate.raw);
        const imported = manifest.imports[sessionKey(candidate.session)];
        const repaired = await repairThread({
          codexHome: options.codexHome,
          manifestEntry: imported,
          records,
          session: candidate.session,
        });
        imported.importedChatLines = records.length;
        imported.prefixHash = prefixHash(records, records.length);
        imported.projectionComplete = true;
        imported.sourceTitle = candidate.session.title;
        imported.sourceUpdatedAt = candidate.session.updatedAt;
        imported.updatedAt = new Date().toISOString();
        await writeJsonAtomic(manifestPath, manifest);
        counters.repaired += 1;
        process.stdout.write(`[repaired] ${candidate.session.id} -> ${repaired.threadId} (${repaired.turns} turns, ${repaired.items} items)\n`);
      } catch (error) {
        counters.failed += 1;
        process.stderr.write(`[repair failed] ${candidate.session.cwd} :: ${candidate.session.id}: ${error.message}\n`);
      }
    }
  }

  process.stdout.write(`Summary: ${JSON.stringify(counters)}\n`);
  if (counters.failed > 0)
    process.exitCode = 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let releaseLock = null;
  try {
    if (options.apply)
      releaseLock = await acquireApplyLock(options.codexHome);
    await runMigration(options);
  } finally {
    await releaseLock?.();
  }
}

export {
  acquireApplyLock,
  createBackup,
  decodeProjectDirectory,
  deterministicItemId,
  deterministicUuid,
  findCodexContinuation,
  groupTurns,
  loadManifest,
  parseArgs,
  parseChat,
  prefixHash,
  pruneBackups,
  responseItems,
  stripGrokWrapper,
  validateItemIds,
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${basename(process.argv[1])}: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
