import { createHash } from "node:crypto";

const MAX_ITEM_ID_LENGTH = 64;

function parseChat(raw) {
  const hasTrailingNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  if (hasTrailingNewline)
    lines.pop();

  return lines.map((line, index) => {
    try {
      return { entry: JSON.parse(line), line, lineNumber: index + 1 };
    } catch (error) {
      throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
    }
  });
}

function stripGrokWrapper(text) {
  const queryMatches = [...text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi)];
  if (queryMatches.length > 0)
    return queryMatches.map((match) => match[1].trim()).filter(Boolean).join("\n\n");

  return text
    .replace(/<(?:user_info|system-reminder)>[\s\S]*?<\/(?:user_info|system-reminder)>/gi, "")
    .trim();
}

function userItem(entry) {
  if (entry.synthetic_reason)
    return null;

  const blocks = Array.isArray(entry.content) ? entry.content : [];
  const content = [];
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string") {
      const text = stripGrokWrapper(block.text);
      if (text)
        content.push({ type: "input_text", text });
    } else if (block?.type === "image" && typeof block.url === "string") {
      content.push({ type: "input_image", image_url: block.url });
    }
  }

  if (content.length === 0)
    return null;
  return { type: "message", role: "user", content };
}

function assistantItem(entry) {
  if (typeof entry.content !== "string" || !entry.content.trim())
    return null;
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: entry.content, annotations: [] }],
  };
}

function responseItems(entry) {
  if (entry.type === "user") {
    const item = userItem(entry);
    return item ? [item] : [];
  }
  if (entry.type === "assistant") {
    const item = assistantItem(entry);
    return item ? [item] : [];
  }
  return [];
}

function prefixHash(records, count) {
  const hash = createHash("sha256");
  for (let index = 0; index < count; index += 1) {
    hash.update(records[index].line);
    hash.update("\n");
  }
  return hash.digest("hex");
}

function sessionKey(session) {
  return `${session.cwd}\n${session.id}`;
}

function deterministicUuid(seed) {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function deterministicItemId(prefix, seed) {
  if (prefix.length >= MAX_ITEM_ID_LENGTH)
    throw new Error(`Item ID prefix is too long: ${prefix}`);
  const digest = createHash("sha256").update(seed).digest("hex");
  return `${prefix}${digest.slice(0, MAX_ITEM_ID_LENGTH - prefix.length)}`;
}

function validateItemIds(records) {
  for (const entry of records) {
    const ids = [entry.payload?.id, entry.payload?.item?.id];
    for (const id of ids) {
      if (typeof id === "string" && id.length > MAX_ITEM_ID_LENGTH)
        throw new Error(`Item ID exceeds ${MAX_ITEM_ID_LENGTH} characters: ${id}`);
    }
  }
}

function timestampMs(value, fallback) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function messageText(item) {
  return item.content
    .filter((block) => block.type === "input_text" || block.type === "output_text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

function groupTurns(records) {
  const messages = records.flatMap((record) => responseItems(record.entry));
  const turns = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ assistants: [], user: message });
      continue;
    }
    if (turns.length > 0)
      turns.at(-1).assistants.push(message);
  }
  return turns;
}

function findCodexContinuation(existingRollout, records, sessionId) {
  const importedTurnIds = new Set(groupTurns(records).map((_, index) =>
    deterministicUuid(`${sessionId}:turn:${index}`)));
  const existing = parseChat(existingRollout).map(({ entry }) => entry);
  return existing.find((entry) =>
    entry.type === "event_msg" &&
    entry.payload?.type === "task_started" &&
    typeof entry.payload.turn_id === "string" &&
    !importedTurnIds.has(entry.payload.turn_id));
}

function record(timestamp, type, payload) {
  return { timestamp: new Date(timestamp).toISOString(), type, payload };
}

function userProjectionContent(item) {
  const content = [];
  for (const block of item.content) {
    if (block.type === "input_text")
      content.push({ type: "text", text: block.text, text_elements: [] });
    else if (block.type === "input_image")
      content.push({ type: "text", text: `[Image: ${block.image_url}]`, text_elements: [] });
  }
  return content;
}

function appendSetup(output, setup, startedMs) {
  for (const setupEntry of setup) {
    const copied = structuredClone(setupEntry);
    copied.timestamp = new Date(startedMs).toISOString();
    output.push(copied);
  }
}

function appendUserProjection({ output, projectedItems, session, startedMs, threadId, turn, turnId, turnIndex }) {
  const userItemId = deterministicUuid(`${session.id}:turn:${turnIndex}:user`);
  const content = userProjectionContent(turn.user);
  const userMessage = structuredClone(turn.user);
  userMessage.id = `msg_${deterministicUuid(`${session.id}:turn:${turnIndex}:response:user`)}`;
  userMessage.internal_chat_message_metadata_passthrough = { turn_id: turnId };
  output.push(record(startedMs + 1, "response_item", userMessage));
  const userCompleted = record(startedMs + 2, "event_msg", {
    type: "item_completed",
    thread_id: threadId,
    turn_id: turnId,
    item: { type: "UserMessage", id: userItemId, content },
    started_at_ms: startedMs + 1,
    completed_at_ms: startedMs + 2,
  });
  output.push(userCompleted);
  projectedItems.push({
    turnId,
    itemId: userItemId,
    record: userCompleted,
    createdAtMs: startedMs + 2,
    itemType: "userMessage",
    itemJson: { type: "userMessage", id: userItemId, clientId: null, content },
  });
  return userItemId;
}

function appendAssistantProjections({ completedMs, output, projectedItems, session, startedMs, threadId, turn, turnId, turnIndex }) {
  let finalAgentItemId = null;
  let lastAgentMessage = null;
  for (let assistantIndex = 0; assistantIndex < turn.assistants.length; assistantIndex += 1) {
    const assistant = turn.assistants[assistantIndex];
    const isFinal = assistantIndex === turn.assistants.length - 1;
    const phase = isFinal ? "final_answer" : "commentary";
    const assistantItemId = deterministicItemId(
      "msg_",
      `${session.id}:turn:${turnIndex}:assistant:${assistantIndex}`,
    );
    const assistantMessage = structuredClone(assistant);
    assistantMessage.id = assistantItemId;
    assistantMessage.phase = phase;
    assistantMessage.internal_chat_message_metadata_passthrough = { turn_id: turnId };
    const itemMs = Math.min(completedMs, startedMs + 3 + assistantIndex * 2);
    output.push(record(itemMs, "response_item", assistantMessage));
    const text = messageText(assistant);
    const assistantCompleted = record(itemMs + 1, "event_msg", {
      type: "item_completed",
      thread_id: threadId,
      turn_id: turnId,
      item: { type: "AgentMessage", id: assistantItemId, content: [{ type: "Text", text }], phase },
      started_at_ms: itemMs,
      completed_at_ms: itemMs + 1,
    });
    output.push(assistantCompleted);
    projectedItems.push({
      turnId,
      itemId: assistantItemId,
      record: assistantCompleted,
      createdAtMs: itemMs + 1,
      itemType: "agentMessage",
      itemJson: { type: "agentMessage", id: assistantItemId, text, phase, memoryCitation: null },
    });
    if (isFinal) {
      finalAgentItemId = assistantItemId;
      lastAgentMessage = text;
    }
  }
  return { finalAgentItemId, lastAgentMessage };
}

function buildTerminal({ completedAt, completedMs, lastAgentMessage, startedAt, startedMs, turn, turnId }) {
  const durationMs = Math.max(0, completedMs - startedMs);
  if (turn.assistants.length === 0) {
    return record(completedMs, "event_msg", {
      type: "turn_aborted", turn_id: turnId, reason: "interrupted",
      started_at: startedAt, completed_at: completedAt, duration_ms: durationMs,
    });
  }
  return record(completedMs, "event_msg", {
    type: "task_complete", turn_id: turnId, last_agent_message: lastAgentMessage,
    started_at: startedAt, completed_at: completedAt, duration_ms: durationMs,
    time_to_first_token_ms: Math.min(durationMs, 1),
  });
}

function appendCanonicalTurn({ contextTemplate, createdMs, output, projectedItems, projectedTurns, session, setup, taskTemplate, threadId, turn, turnIndex, turnStepMs, updatedMs }) {
  const turnId = deterministicUuid(`${session.id}:turn:${turnIndex}`);
  const startedMs = Math.min(updatedMs, createdMs + turnIndex * turnStepMs);
  const completedMs = Math.min(updatedMs, startedMs + Math.max(1, turnStepMs - 1));
  const startedAt = Math.floor(startedMs / 1000);
  const completedAt = Math.floor(completedMs / 1000);
  const taskStartedPayload = {
    type: "task_started", turn_id: turnId, started_at: startedAt,
    collaboration_mode_kind: taskTemplate?.payload?.collaboration_mode_kind ?? "default",
  };
  if (Number.isInteger(taskTemplate?.payload?.model_context_window))
    taskStartedPayload.model_context_window = taskTemplate.payload.model_context_window;
  const taskStartRecord = record(startedMs, "event_msg", taskStartedPayload);
  output.push(taskStartRecord);
  if (turnIndex === 0)
    appendSetup(output, setup, startedMs);

  const context = structuredClone(contextTemplate);
  context.timestamp = new Date(startedMs).toISOString();
  context.payload.turn_id = turnId;
  output.push(context);
  const firstUserItemId = appendUserProjection({
    output, projectedItems, session, startedMs, threadId, turn, turnId, turnIndex,
  });
  const assistant = appendAssistantProjections({
    completedMs, output, projectedItems, session, startedMs, threadId, turn, turnId, turnIndex,
  });
  const terminalRecord = buildTerminal({
    completedAt, completedMs, lastAgentMessage: assistant.lastAgentMessage,
    startedAt, startedMs, turn, turnId,
  });
  output.push(terminalRecord);
  projectedTurns.push({
    turnId, taskStartRecord, terminalRecord,
    status: turn.assistants.length > 0 ? "completed" : "interrupted",
    startedAt, completedAt, durationMs: Math.max(0, completedMs - startedMs),
    firstUserItemId, finalAgentItemId: assistant.finalAgentItemId,
  });
}

function serializeCanonicalRollout({ output, projectedItems, projectedTurns, turns, updatedMs }) {
  validateItemIds(output);
  const offsets = new Map();
  let byteOffset = 0;
  const lines = output.map((entry, ordinal) => {
    entry.ordinal = ordinal;
    const line = JSON.stringify(entry);
    offsets.set(entry, { ordinal, start: byteOffset, end: byteOffset + Buffer.byteLength(line) + 1 });
    byteOffset += Buffer.byteLength(line) + 1;
    return line;
  });
  const firstUserMessage = messageText(turns[0].user);
  return {
    content: `${lines.join("\n")}\n`,
    fileSize: byteOffset,
    firstUserMessage,
    preview: firstUserMessage.replace(/\s+/g, " ").slice(0, 500),
    projectedItems: projectedItems.map((item) => ({ ...item, position: offsets.get(item.record) })),
    projectedTurns: projectedTurns.map((turn) => ({
      ...turn,
      startPosition: offsets.get(turn.taskStartRecord),
      endPosition: offsets.get(turn.terminalRecord),
    })),
    recordCount: output.length,
    updatedMs,
  };
}

function buildCanonicalRollout({ existingRollout, records, session, threadId }) {
  const original = parseChat(existingRollout).map(({ entry }) => entry);
  const sessionMeta = original.find((entry) => entry.type === "session_meta");
  const contextIndex = original.findIndex((entry) => entry.type === "turn_context");
  if (!sessionMeta || contextIndex < 0)
    throw new Error(`Codex rollout is missing session metadata or turn context: ${threadId}`);
  const setup = original.slice(1, contextIndex).filter((entry) =>
    entry.type === "world_state" ||
    (entry.type === "response_item" && ["developer", "user"].includes(entry.payload?.role)));
  const contextTemplate = structuredClone(original[contextIndex]);
  const taskTemplate = original.find((entry) =>
    entry.type === "event_msg" && entry.payload?.type === "task_started");
  const turns = groupTurns(records);
  if (turns.length === 0)
    throw new Error(`No user turns to project: ${session.id}`);

  const createdMs = timestampMs(session.createdAt, Date.now());
  const updatedMs = Math.max(createdMs, timestampMs(session.updatedAt, createdMs));
  const availableMs = Math.max(turns.length * 10, updatedMs - createdMs);
  const turnStepMs = Math.max(10, Math.floor(availableMs / turns.length));
  const output = [];
  const projectedTurns = [];
  const projectedItems = [];
  const meta = structuredClone(sessionMeta);
  meta.timestamp = new Date(createdMs).toISOString();
  meta.payload.timestamp = meta.timestamp;
  meta.payload.source = "cli";
  meta.payload.originator = "grok-to-codex-sessions";
  meta.payload.history_mode = "paginated";
  output.push(meta);

  turns.forEach((turn, turnIndex) => appendCanonicalTurn({
    contextTemplate, createdMs, output, projectedItems, projectedTurns, session,
    setup, taskTemplate, threadId, turn, turnIndex, turnStepMs, updatedMs,
  }));
  return serializeCanonicalRollout({ output, projectedItems, projectedTurns, turns, updatedMs });
}

export {
  buildCanonicalRollout,
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
};
