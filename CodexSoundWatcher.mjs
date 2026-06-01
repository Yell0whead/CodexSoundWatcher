#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { existsSync, promises as fsPromises, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CODEX_HOME = join(homedir(), '.codex');
const DEFAULT_APPROVAL_RULES_PATH = join(DEFAULT_CODEX_HOME, 'rules', 'default.rules');
const DEFAULT_STATE_DB = join(DEFAULT_CODEX_HOME, 'state_5.sqlite');
const SYSTEM_DONE_SOUND = '/System/Library/Sounds/Glass.aiff';
const SYSTEM_ATTENTION_SOUND = '/System/Library/Sounds/Sosumi.aiff';
const DEFAULT_DONE_SOUND = join(SCRIPT_DIR, 'Sounds', 'Completion.aiff');
const DEFAULT_ATTENTION_SOUND = join(SCRIPT_DIR, 'Sounds', 'Attention.aiff');
const DEFAULT_REPEAT_MS = 180_000;
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_FRONTMOST_POLL_MS = 1_000;
const DEFAULT_THREAD_REFRESH_MS = 5_000;
const DEFAULT_COOLDOWN_MS = 2_000;
const DEFAULT_ACTIVE_IDLE_MS = 30_000;
const DEFAULT_EXEC_PERMISSION_GRACE_MS = 15_000;
const DEFAULT_PLAY_COUNT = 1;
const DEFAULT_SOUND_GAP_MS = 75;
const DEFAULT_ALERT_VOLUME = 1;
const DEFAULT_AUDIO_DUCKING = false;
const DEFAULT_DUCK_OUTPUT_VOLUME = 25;
const DEFAULT_SPOKEN_ATTENTION = false;
const DEFAULT_SPOKEN_COMPLETION = false;
const DEFAULT_PERMISSION_PHRASE = 'Codex needs your permission';
const DEFAULT_QUESTION_PHRASE = 'Codex has a question';
const DEFAULT_ATTENTION_PHRASE = 'Codex needs your attention';
const DEFAULT_COMPLETION_PHRASE = 'Codex finished';

function formatLocalTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffsetMinutes / 60);
  const remainingOffsetMinutes = absoluteOffsetMinutes % 60;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${sign}${pad(offsetHours)}:${pad(remainingOffsetMinutes)}`;
}

function nowLocalTimestamp() {
  return formatLocalTimestamp(new Date());
}

function writeLog(message) {
  console.log(`[${nowLocalTimestamp()}] ${message}`);
}

function writeError(message) {
  console.error(`[${nowLocalTimestamp()}] ${message}`);
}

function displayTitle(title) {
  const normalized = String(title || 'Untitled thread').replace(/\s+/g, ' ').trim();
  if (normalized.length <= 120) {
    return normalized;
  }
  return `${normalized.slice(0, 117)}...`;
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class CancelledAlertError extends Error {
  constructor(cancelKey) {
    super(`Alert was cancelled: ${cancelKey}`);
    this.name = 'CancelledAlertError';
  }
}

class InterruptedAlertError extends Error {
  constructor(reason) {
    super(`Alert was interrupted: ${reason}`);
    this.name = 'InterruptedAlertError';
  }
}

function isCancelledAlertError(error) {
  return error?.name === 'CancelledAlertError';
}

function isInterruptedAlertError(error) {
  return error?.name === 'InterruptedAlertError';
}

function isStoppedAlertError(error) {
  return isCancelledAlertError(error) || isInterruptedAlertError(error);
}

function attentionCancelKey(threadId, callId) {
  return `${threadId}:${callId}`;
}

function isCodexAppName(name) {
  return /codex/i.test(String(name || ''));
}

function normalizeComparableText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const GENERIC_MATCH_TOKENS = new Set([
  'about',
  'again',
  'can',
  'chat',
  'codex',
  'diagnose',
  'discuss',
  'does',
  'dont',
  'fix',
  'have',
  'here',
  'issue',
  'make',
  'please',
  'that',
  'the',
  'then',
  'this',
  'thread',
  'what',
  'when',
  'where',
  'why',
  'with',
  'would',
  'you',
]);

function meaningfulTokens(text) {
  return normalizeComparableText(text)
    .split(' ')
    .filter((token) => token.length >= 4 && !GENERIC_MATCH_TOKENS.has(token));
}

function threadSearchText(thread) {
  return normalizeComparableText(`${thread?.title || ''} ${thread?.firstUserMessage || ''}`);
}

export function matchActiveCodexThread(label, threads) {
  const normalizedLabel = normalizeComparableText(label);
  if (!normalizedLabel) {
    return { status: 'unknown', reason: 'empty_label', label: String(label || '') };
  }

  const exactMatches = threads.filter((thread) => {
    return normalizeComparableText(thread.title) === normalizedLabel
      || normalizeComparableText(thread.firstUserMessage) === normalizedLabel;
  });
  if (exactMatches.length === 1) {
    return {
      status: 'matched',
      reason: 'exact',
      confidence: 'exact',
      label,
      thread: exactMatches[0],
      threadId: exactMatches[0].id,
    };
  }
  if (exactMatches.length > 1) {
    return { status: 'unknown', reason: 'ambiguous_exact', label, matchCount: exactMatches.length };
  }

  const tokens = meaningfulTokens(label);
  if (tokens.length < 3) {
    return { status: 'unknown', reason: 'generic_label', label, tokens };
  }

  const fuzzyMatches = threads.filter((thread) => {
    const haystack = threadSearchText(thread);
    return tokens.every((token) => haystack.includes(token));
  });
  if (fuzzyMatches.length === 1) {
    return {
      status: 'matched',
      reason: 'token_match',
      confidence: 'token_match',
      label,
      thread: fuzzyMatches[0],
      threadId: fuzzyMatches[0].id,
      tokens,
    };
  }
  if (fuzzyMatches.length > 1) {
    return { status: 'unknown', reason: 'ambiguous_token_match', label, tokens, matchCount: fuzzyMatches.length };
  }

  return { status: 'unknown', reason: 'no_match', label, tokens };
}

function getTextFromMessagePayload(payload) {
  if (!payload || !Array.isArray(payload.content)) {
    return '';
  }
  return payload.content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return '';
      }
      if (typeof part.text === 'string') {
        return part.text;
      }
      if (typeof part.input_text === 'string') {
        return part.input_text;
      }
      if (typeof part.output_text === 'string') {
        return part.output_text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function stripMachineBlocks(text) {
  return String(text || '')
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, '')
    .trim();
}

export function finalAnswerNeedsAnswer(text) {
  const stripped = stripMachineBlocks(text);
  if (!stripped || stripped.includes('<proposed_plan>')) {
    return false;
  }
  return /\?\s*$/.test(stripped);
}

function parseFunctionArguments(rawArguments) {
  if (!rawArguments || typeof rawArguments !== 'string') {
    return {};
  }
  try {
    return JSON.parse(rawArguments);
  } catch {
    return {};
  }
}

function splitCommandTokens(command) {
  const text = String(command || '').trim();
  if (!text) {
    return [];
  }
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== '\'') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (escaped) {
    current += '\\';
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function commandLikelyBypassesPrefixRules(command) {
  const text = String(command || '');
  if (!text) {
    return true;
  }
  if (/[\r\n]/.test(text)) {
    return true;
  }
  if (/[|;&<>`]/.test(text)) {
    return true;
  }
  if (/\$\(/.test(text)) {
    return true;
  }
  if (/(^|\s)[A-Za-z_][A-Za-z0-9_]*=/.test(text)) {
    return true;
  }
  if (/[*?]/.test(text)) {
    return true;
  }
  return false;
}

function parseApprovedPrefixRules(text) {
  const rules = [];
  const pattern = /prefix_rule\s*\(\s*pattern\s*=\s*(\[[^\n]*\])\s*,\s*decision\s*=\s*"allow"/g;
  let match = pattern.exec(text);
  while (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        rules.push(parsed.map((token) => String(token)));
      }
    } catch {
      // Ignore malformed rule lines.
    }
    match = pattern.exec(text);
  }
  return rules;
}

function matchesPrefix(tokens, prefixTokens) {
  if (!Array.isArray(tokens) || !Array.isArray(prefixTokens)) {
    return false;
  }
  if (tokens.length < prefixTokens.length || prefixTokens.length === 0) {
    return false;
  }
  for (let index = 0; index < prefixTokens.length; index += 1) {
    if (tokens[index] !== prefixTokens[index]) {
      return false;
    }
  }
  return true;
}

function getTurnId(state, event) {
  return event?.payload?.turn_id || state.currentTurnId || 'unknown-turn';
}

export class CodexAlertEngine {
  constructor(options = {}) {
    this.repeatMs = options.repeatMs ?? DEFAULT_REPEAT_MS;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.execPermissionGraceMs = options.execPermissionGraceMs ?? DEFAULT_EXEC_PERMISSION_GRACE_MS;
    this.approvalRulesPath = options.approvalRulesPath || DEFAULT_APPROVAL_RULES_PATH;
    this.approvedPrefixRules = null;
    this.approvalRulesMtimeMs = null;
    this.threadStates = new Map();
    this.emittedKeys = new Map();
    this.clearActions = [];
  }

  getState(threadId) {
    if (!this.threadStates.has(threadId)) {
      this.threadStates.set(threadId, {
        threadId,
        title: threadId,
        currentTurnId: 'unknown-turn',
        running: false,
        sawFinalAnswer: false,
        lastFinalText: '',
        pendingAttention: new Map(),
      });
    }
    return this.threadStates.get(threadId);
  }

  processEvent(threadInfo, event, nowMs = Date.now()) {
    const threadId = threadInfo.id;
    const state = this.getState(threadId);
    state.title = threadInfo.title || state.title || threadId;

    if (event.type === 'turn_context' && event.payload?.turn_id) {
      state.currentTurnId = event.payload.turn_id;
      return [];
    }

    if (event.type === 'event_msg') {
      return this.processEventMessage(state, event, nowMs);
    }

    if (event.type === 'response_item') {
      return this.processResponseItem(state, event, nowMs);
    }

    return [];
  }

  processEventMessage(state, event, nowMs) {
    const payloadType = event.payload?.type;
    if (payloadType === 'task_started' || payloadType === 'user_message') {
      this.clearAttention(state);
      state.running = true;
      state.sawFinalAnswer = false;
      state.lastFinalText = '';
      return [];
    }

    if (payloadType !== 'task_complete') {
      return [];
    }

    state.running = false;
    const turnId = getTurnId(state, event);
    const alerts = [];
    if (state.sawFinalAnswer && state.pendingAttention.size === 0) {
      alerts.push(this.makeAlert(state, turnId, 'done', 'task_complete', nowMs));
    }
    this.clearAttention(state);
    return alerts.filter(Boolean);
  }

  processResponseItem(state, event, nowMs) {
    const payload = event.payload || {};
    if (payload.type === 'function_call') {
      return this.processFunctionCall(state, payload, nowMs);
    }

    if (payload.type === 'function_call_output') {
      this.clearAttentionCall(state, payload.call_id);
      return [];
    }

    if (payload.type !== 'message' || payload.role !== 'assistant') {
      return [];
    }

    if (payload.phase !== 'final_answer') {
      return [];
    }

    state.sawFinalAnswer = true;
    state.lastFinalText = getTextFromMessagePayload(payload);
    if (finalAnswerNeedsAnswer(state.lastFinalText)) {
      const turnId = getTurnId(state, event);
      const attentionId = `final-question:${turnId}`;
      state.pendingAttention.set(attentionId, {
        callId: attentionId,
        cancelKey: attentionCancelKey(state.threadId, attentionId),
        reason: 'final_question',
        turnId,
        lastPlayedAt: 0,
      });
      return [this.makeAlert(state, turnId, 'attention', 'final_question', nowMs, attentionId)].filter(Boolean);
    }

    return [];
  }

  processFunctionCall(state, payload, nowMs) {
    const name = payload.name;
    const turnId = getTurnId(state, { payload });
    let reason = null;
    let delayMs = 0;

    if (name === 'request_user_input') {
      reason = 'question';
    } else if (name === 'request_plugin_install') {
      reason = 'permission';
    } else if (name === 'exec_command') {
      const args = parseFunctionArguments(payload.arguments);
      if (args.sandbox_permissions === 'require_escalated') {
        if (this.isEscalatedExecLikelyAutoApproved(args)) {
          return [];
        }
        reason = 'permission';
        delayMs = this.execPermissionGraceMs;
      }
    }

    if (!reason) {
      return [];
    }

    const callId = payload.call_id || `${reason}:${turnId}`;
    state.pendingAttention.set(callId, {
      callId,
      cancelKey: attentionCancelKey(state.threadId, callId),
      reason,
      turnId,
      eligibleAt: nowMs + Math.max(0, Number(delayMs) || 0),
      lastPlayedAt: 0,
    });
    if (delayMs > 0) {
      return [];
    }
    return [this.makeAlert(state, turnId, 'attention', reason, nowMs, callId)].filter(Boolean);
  }

  getApprovedPrefixRules() {
    if (!this.approvalRulesPath) {
      return [];
    }
    try {
      const stats = statSync(this.approvalRulesPath);
      const mtimeMs = stats.mtimeMs;
      if (this.approvedPrefixRules && this.approvalRulesMtimeMs === mtimeMs) {
        return this.approvedPrefixRules;
      }
      const text = readFileSync(this.approvalRulesPath, 'utf8');
      this.approvedPrefixRules = parseApprovedPrefixRules(text);
      this.approvalRulesMtimeMs = mtimeMs;
      return this.approvedPrefixRules;
    } catch {
      this.approvedPrefixRules = [];
      this.approvalRulesMtimeMs = null;
      return this.approvedPrefixRules;
    }
  }

  isEscalatedExecLikelyAutoApproved(args) {
    const command = String(args?.cmd || '');
    if (!command || commandLikelyBypassesPrefixRules(command)) {
      return false;
    }
    const approvedRules = this.getApprovedPrefixRules();
    if (!approvedRules.length) {
      return false;
    }

    if (Array.isArray(args?.prefix_rule)) {
      const prefixRule = args.prefix_rule.map((token) => String(token));
      if (approvedRules.some((rule) => matchesPrefix(prefixRule, rule) && matchesPrefix(rule, prefixRule))) {
        return true;
      }
    }

    const commandTokens = splitCommandTokens(command);
    if (commandTokens.length === 0) {
      return false;
    }
    return approvedRules.some((rule) => matchesPrefix(commandTokens, rule));
  }

  clearAttention(state) {
    for (const pending of state.pendingAttention.values()) {
      this.queueClearAction(state, pending, 'thread_clear');
    }
    state.pendingAttention.clear();
  }

  clearAttentionCall(state, callId) {
    if (!callId) {
      return;
    }
    const pending = state.pendingAttention.get(callId);
    if (pending) {
      this.queueClearAction(state, pending, 'call_output');
    }
    state.pendingAttention.delete(callId);
  }

  queueClearAction(state, pending, reason) {
    this.clearActions.push({
      kind: 'attention_clear',
      reason,
      threadId: state.threadId,
      threadTitle: state.title,
      callId: pending.callId,
      cancelKey: pending.cancelKey || attentionCancelKey(state.threadId, pending.callId),
    });
  }

  collectClearActions() {
    const actions = this.clearActions;
    this.clearActions = [];
    return actions;
  }

  collectRepeatAlerts(nowMs = Date.now()) {
    const alerts = [];
    for (const state of this.threadStates.values()) {
      for (const pending of state.pendingAttention.values()) {
        if (pending.lastPlayedAt === 0) {
          if (nowMs < (pending.eligibleAt || 0)) {
            continue;
          }
          pending.lastPlayedAt = nowMs;
          alerts.push({
            kind: 'attention',
            reason: pending.reason,
            threadId: state.threadId,
            threadTitle: state.title,
            turnId: pending.turnId,
            timestampMs: nowMs,
            repeat: false,
            cancelKey: pending.cancelKey,
          });
          continue;
        }
        if (nowMs - pending.lastPlayedAt < this.repeatMs) {
          continue;
        }
        const alert = {
          kind: 'attention',
          reason: `${pending.reason}_repeat`,
          threadId: state.threadId,
          threadTitle: state.title,
          turnId: pending.turnId,
          timestampMs: nowMs,
          repeat: true,
          cancelKey: pending.cancelKey,
        };
        pending.lastPlayedAt = nowMs;
        alerts.push(alert);
      }
    }
    return alerts;
  }

  rescheduleAttentionAlert(alert, delayMs, nowMs = Date.now()) {
    if (!alert?.threadId || !alert?.cancelKey) {
      return false;
    }
    const state = this.threadStates.get(alert.threadId);
    if (!state) {
      return false;
    }
    const pending = Array.from(state.pendingAttention.values())
      .find((item) => item.cancelKey === alert.cancelKey);
    if (!pending) {
      return false;
    }
    const retryDelayMs = Number.isFinite(Number(delayMs))
      ? Math.max(0, Number(delayMs))
      : 0;
    if (pending.lastPlayedAt === 0) {
      pending.eligibleAt = nowMs + retryDelayMs;
      return true;
    }
    pending.lastPlayedAt = nowMs - this.repeatMs + retryDelayMs;
    return true;
  }

  makeAlert(state, turnId, kind, reason, nowMs, attentionCallId = null) {
    const key = `${state.threadId}:${turnId}:${kind}`;
    const lastEmittedAt = this.emittedKeys.get(key);
    if (lastEmittedAt && nowMs - lastEmittedAt < this.cooldownMs) {
      return null;
    }
    if (lastEmittedAt && kind === 'attention') {
      return null;
    }
    if (lastEmittedAt && kind === 'done') {
      return null;
    }
    this.emittedKeys.set(key, nowMs);

    if (attentionCallId && state.pendingAttention.has(attentionCallId)) {
      state.pendingAttention.get(attentionCallId).lastPlayedAt = nowMs;
    }

    return {
      kind,
      reason,
      threadId: state.threadId,
      threadTitle: state.title,
      turnId,
      timestampMs: nowMs,
      repeat: false,
      cancelKey: kind === 'attention' && attentionCallId ? attentionCancelKey(state.threadId, attentionCallId) : null,
    };
  }
}

export function parseJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return { type: 'parse_error', error: error.message, raw: line };
  }
}

export class SessionFileFollower {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.offset = options.startAtEnd && existsSync(filePath) ? statSync(filePath).size : 0;
    this.partial = '';
  }

  async readNewEvents() {
    if (!existsSync(this.filePath)) {
      return [];
    }

    const stat = await fsPromises.stat(this.filePath);
    if (stat.size < this.offset) {
      this.offset = 0;
      this.partial = '';
    }
    if (stat.size === this.offset) {
      return [];
    }

    const handle = await fsPromises.open(this.filePath, 'r');
    try {
      const length = stat.size - this.offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, this.offset);
      this.offset = stat.size;
      const text = this.partial + buffer.toString('utf8');
      const lines = text.split(/\r?\n/);
      this.partial = lines.pop() || '';
      return lines.map(parseJsonLine).filter(Boolean);
    } finally {
      await handle.close();
    }
  }
}

function execFileJson(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}${stderr ? `\n${stderr}` : ''}`;
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(stdout || '[]'));
      } catch (parseError) {
        parseError.message = `Could not parse JSON from ${command}: ${parseError.message}\n${stdout}`;
        reject(parseError);
      }
    });
  });
}

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}${stderr ? `\n${stderr}` : ''}`;
        reject(error);
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

export async function listActiveThreads(options = {}) {
  const stateDb = options.stateDb || process.env.CODEX_STATE_DB || DEFAULT_STATE_DB;
  const sqlite3Path = options.sqlite3Path || process.env.SQLITE3_PATH || '/usr/bin/sqlite3';
  const limit = Number(options.limit || 200);
  const query = `
    select id, title, first_user_message as firstUserMessage, rollout_path as rolloutPath, updated_at_ms as updatedAtMs
    from threads
    where archived = 0 and rollout_path is not null and rollout_path != ''
    order by updated_at_ms desc
    limit ${Number.isFinite(limit) ? Math.max(1, Math.min(limit, 1000)) : 200};
  `;
  return execFileJson(sqlite3Path, ['-readonly', '-json', stateDb, query]);
}

export async function getFrontmostAppName(options = {}) {
  const osascriptPath = options.osascriptPath || '/usr/bin/osascript';
  return execFileText(osascriptPath, [
    '-e',
    'tell application "System Events" to get name of first application process whose frontmost is true',
  ]);
}

export async function getSystemIdleOutput(options = {}) {
  const ioregPath = options.ioregPath || '/usr/sbin/ioreg';
  return execFileText(ioregPath, ['-r', '-c', 'IOHIDSystem', '-d', '1']);
}

export function parseHidIdleMs(output) {
  const text = String(output || '');
  const match = text.match(/"HIDIdleTime"\s*=\s*(\d+)/);
  if (!match) {
    return null;
  }
  const idleNs = Number(match[1]);
  if (!Number.isFinite(idleNs) || idleNs < 0) {
    return null;
  }
  return Math.floor(idleNs / 1_000_000);
}

function hidIdleParseFailureReason(output) {
  return String(output || '').includes('HIDIdleTime')
    ? 'malformed_hid_idle_time'
    : 'missing_hid_idle_time';
}

export class UserIdleDetector {
  constructor(options = {}) {
    const activeIdleMs = Number(options.activeIdleMs ?? DEFAULT_ACTIVE_IDLE_MS);
    this.activeIdleMs = Number.isFinite(activeIdleMs)
      ? Math.max(0, activeIdleMs)
      : DEFAULT_ACTIVE_IDLE_MS;
    this.provider = options.userIdleProvider || (() => getSystemIdleOutput(options));
    this.lastErrorMessage = '';
  }

  async detect() {
    try {
      const output = await this.provider();
      if (typeof output === 'object' && output !== null && Number.isFinite(Number(output.idleMs))) {
        return this.resultFromIdleMs(Number(output.idleMs));
      }
      const idleMs = Number.isFinite(Number(output)) && String(output).trim() !== ''
        ? Number(output)
        : parseHidIdleMs(output);
      if (!Number.isFinite(idleMs) || idleMs < 0) {
        return { status: 'unknown', reason: hidIdleParseFailureReason(output), activeIdleMs: this.activeIdleMs };
      }
      this.lastErrorMessage = '';
      return this.resultFromIdleMs(idleMs);
    } catch (error) {
      const message = error.stack || error.message;
      if (message !== this.lastErrorMessage) {
        writeError(`Could not read user idle time: ${message}`);
        this.lastErrorMessage = message;
      }
      return { status: 'unknown', reason: 'provider_error', error: error.message, activeIdleMs: this.activeIdleMs };
    }
  }

  resultFromIdleMs(idleMs) {
    return {
      status: 'known',
      idleMs,
      activeIdleMs: this.activeIdleMs,
      recentlyActive: idleMs <= this.activeIdleMs,
    };
  }
}

const CODEX_SIDEBAR_CHAT_LIST_PATH = 'list 1 of group 2 of list 1 of group 1 of group 1 of group 1 of group 1 of group 1 of group 1 of group 1 of UI element 1 of group 1 of group 1 of group 1 of group 1 of group 1 of group 1 of window 1 of process "Codex"';

async function getCodexAccessibilityValue(options, expression) {
  const osascriptPath = options.osascriptPath || '/usr/bin/osascript';
  return execFileText(osascriptPath, [
    '-e',
    `tell application "System Events" to get ${expression}`,
  ]);
}

export async function getCodexSidebarChatRows(options = {}) {
  const maxRows = Math.max(1, Math.min(Number(options.activeChatMaxRows || 25), 50));
  const countText = await getCodexAccessibilityValue(options, `count of groups of ${CODEX_SIDEBAR_CHAT_LIST_PATH}`);
  const count = Math.max(0, Math.min(Number.parseInt(countText, 10) || 0, maxRows));
  const rows = [];
  for (let index = 1; index <= count; index += 1) {
    const buttonPath = `button 1 of group ${index} of ${CODEX_SIDEBAR_CHAT_LIST_PATH}`;
    const [label, classList] = await Promise.all([
      getCodexAccessibilityValue(options, `name of static text 1 of ${buttonPath}`).catch(() => ''),
      getCodexAccessibilityValue(options, `value of attribute "AXDOMClassList" of ${buttonPath}`).catch(() => ''),
    ]);
    rows.push({ label, classList: String(classList || ''), index });
  }
  return rows;
}

function isActiveSidebarChatRow(row) {
  const classTokens = new Set(String(row?.classList || '').split(/[\s,]+/).filter(Boolean));
  return classTokens.has('h-token-nav-row') && classTokens.has('bg-token-list-hover-background');
}

export class ActiveCodexChatDetector {
  constructor(options = {}) {
    this.provider = options.activeChatProvider || (() => getCodexSidebarChatRows(options));
    this.lastErrorMessage = '';
  }

  async detect(threads = []) {
    try {
      const result = await this.provider();
      const labelResult = this.extractLabel(result);
      if (labelResult.status !== 'label') {
        return labelResult;
      }
      const match = matchActiveCodexThread(labelResult.label, threads);
      this.lastErrorMessage = '';
      return match;
    } catch (error) {
      const message = error.stack || error.message;
      if (message !== this.lastErrorMessage) {
        writeError(`Could not read active Codex chat: ${message}`);
        this.lastErrorMessage = message;
      }
      return { status: 'unknown', reason: 'provider_error', error: error.message };
    }
  }

  extractLabel(result) {
    if (!Array.isArray(result)) {
      const label = String(result?.label || '').trim();
      if (!label) {
        return { status: 'unknown', reason: 'empty_label', label };
      }
      return { status: 'label', label };
    }

    const activeRows = result.filter(isActiveSidebarChatRow);
    if (activeRows.length === 0) {
      return { status: 'unknown', reason: 'no_highlighted_row' };
    }
    if (activeRows.length > 1) {
      return { status: 'unknown', reason: 'ambiguous_highlighted_row', matchCount: activeRows.length };
    }

    const label = String(activeRows[0].label || '').trim();
    if (!label) {
      return { status: 'unknown', reason: 'empty_label' };
    }
    return { status: 'label', label };
  }
}

export class FrontmostAppMonitor {
  constructor(options = {}) {
    this.enabled = options.frontmostInterrupt !== false;
    this.pollMs = Math.max(250, Number(options.frontmostPollMs || DEFAULT_FRONTMOST_POLL_MS));
    this.provider = options.frontmostAppProvider || (() => getFrontmostAppName(options));
    this.matchesCodexApp = options.matchesCodexApp || isCodexAppName;
    this.onCodexFrontmost = options.onCodexFrontmost || (() => {});
    this.onFrontmostState = options.onFrontmostState || (() => {});
    this.lastIsCodex = null;
    this.interval = null;
    this.pollInFlight = false;
    this.lastErrorMessage = '';
  }

  async pollOnce() {
    if (!this.enabled || this.pollInFlight) {
      return { triggered: false, skipped: true };
    }
    this.pollInFlight = true;
    try {
      const appName = await this.provider();
      const isCodex = this.matchesCodexApp(appName);
      const triggered = this.lastIsCodex === false && isCodex;
      this.lastIsCodex = isCodex;
      this.lastErrorMessage = '';
      await this.onFrontmostState({ appName, isCodex, triggered });
      if (triggered) {
        await this.onCodexFrontmost(appName);
      }
      return { appName, isCodex, triggered };
    } catch (error) {
      const message = error.stack || error.message;
      if (message !== this.lastErrorMessage) {
        writeError(`Could not read frontmost app: ${message}`);
        this.lastErrorMessage = message;
      }
      return { triggered: false, error };
    } finally {
      this.pollInFlight = false;
    }
  }

  start(options = {}) {
    if (!this.enabled || this.interval) {
      return;
    }
    if (options.pollImmediately !== false) {
      this.pollOnce();
    }
    this.interval = setInterval(() => {
      this.pollOnce();
    }, this.pollMs);
  }

  stop() {
    if (!this.interval) {
      return;
    }
    clearInterval(this.interval);
    this.interval = null;
  }
}

export class SoundPlayer {
  constructor(options = {}) {
    this.dryRun = Boolean(options.dryRun);
    this.afplayPath = options.afplayPath || '/usr/bin/afplay';
    this.osascriptPath = options.osascriptPath || '/usr/bin/osascript';
    this.sayPath = options.sayPath || '/usr/bin/say';
    this.doneSound = options.doneSound || (existsSync(DEFAULT_DONE_SOUND) ? DEFAULT_DONE_SOUND : SYSTEM_DONE_SOUND);
    this.attentionSound = options.attentionSound || (existsSync(DEFAULT_ATTENTION_SOUND) ? DEFAULT_ATTENTION_SOUND : SYSTEM_ATTENTION_SOUND);
    this.playCount = Math.max(1, Number(options.playCount || DEFAULT_PLAY_COUNT));
    this.soundGapMs = Math.max(0, Number(options.soundGapMs || DEFAULT_SOUND_GAP_MS));
    this.alertVolume = this.normalizePositiveNumber(options.alertVolume, DEFAULT_ALERT_VOLUME);
    this.audioDucking = Boolean(options.audioDucking ?? DEFAULT_AUDIO_DUCKING);
    this.duckOutputVolume = Math.max(0, Math.min(100, Number(options.duckOutputVolume ?? DEFAULT_DUCK_OUTPUT_VOLUME)));
    this.outputVolumeProvider = options.outputVolumeProvider || (() => this.getOutputVolume());
    this.outputVolumeSetter = options.outputVolumeSetter || ((volume) => this.setOutputVolume(volume));
    this.spokenAttention = Boolean(options.spokenAttention ?? DEFAULT_SPOKEN_ATTENTION);
    this.spokenCompletion = Boolean(options.spokenCompletion ?? DEFAULT_SPOKEN_COMPLETION);
    this.queue = Promise.resolve();
    this.cancelledAttentionKeys = new Set();
    this.activeChildren = new Map();
    this.activeAudioChildren = new Set();
    this.activeAttentionChildren = new Set();
    this.activeAttentionChildrenByThreadId = new Map();
    this.audioInterruptGeneration = 0;
    this.attentionInterruptGeneration = 0;
    this.threadAttentionInterruptGenerations = new Map();
  }

  normalizePositiveNumber(value, fallback) {
    const numeric = Number(value ?? fallback);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
  }

  play(alert) {
    const baseAlert = {
      ...alert,
      audioInterruptGeneration: this.audioInterruptGeneration,
    };
    const queuedAlert = alert.kind === 'attention'
      ? {
          ...baseAlert,
          interruptGeneration: this.attentionInterruptGeneration,
          threadInterruptGeneration: this.getThreadInterruptGeneration(alert.threadId),
        }
      : baseAlert;
    this.queue = this.queue
      .then(() => this.playSequence(queuedAlert))
      .catch((error) => {
        writeError(error.stack || error.message);
      });
    return this.queue;
  }

  async playSequence(alert) {
    const soundPath = alert.kind === 'done' ? this.doneSound : this.attentionSound;
    const label = `${alert.kind}:${alert.reason}`;
    const title = displayTitle(alert.threadTitle);
    if (this.isCancelled(alert)) {
      writeLog(`Skipped cancelled ${label} for "${title}" (${alert.threadId})`);
      return;
    }
    if (this.isInterrupted(alert)) {
      writeLog(`Skipped interrupted ${label} for "${title}" (${alert.threadId})`);
      return;
    }
    if (this.dryRun) {
      writeLog(`[dry-run] ${label} x${this.playCount} "${title}" (${alert.threadId})`);
      return;
    }

    try {
      const spokeAlert = await this.withAudioDucking(alert, async () => {
        for (let count = 0; count < this.playCount; count += 1) {
          this.throwIfStopped(alert);
          await this.playOne(soundPath, alert);
          this.throwIfStopped(alert);
          if (count < this.playCount - 1 && this.soundGapMs > 0) {
            await wait(this.soundGapMs);
          }
        }
        return this.maybeSpeakAlert(alert);
      });
      writeLog(`Played ${label} x${this.playCount}${spokeAlert ? ' + speech' : ''} for "${title}" (${alert.threadId})`);
    } catch (error) {
      if (isStoppedAlertError(error)) {
        writeLog(`${isInterruptedAlertError(error) ? 'Interrupted' : 'Cancelled'} ${label} for "${title}" (${alert.threadId})`);
        return;
      }
      writeError(`${error.message}; falling back to ${alert.kind === 'attention' ? 'spoken alert' : 'system beep'}`);
      try {
        await this.playFallbackAlert(alert);
        writeLog(`Played ${label} fallback for "${title}" (${alert.threadId})`);
      } catch (fallbackError) {
        if (isStoppedAlertError(fallbackError)) {
          writeLog(`${isInterruptedAlertError(fallbackError) ? 'Interrupted' : 'Cancelled'} ${label} fallback for "${title}" (${alert.threadId})`);
          return;
        }
        throw fallbackError;
      }
    }
  }

  cancel(action) {
    if (action?.kind !== 'attention_clear' || !action.cancelKey) {
      return;
    }
    this.cancelledAttentionKeys.add(action.cancelKey);
    const children = this.activeChildren.get(action.cancelKey);
    if (!children || children.size === 0) {
      return;
    }
    for (const child of children) {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    }
  }

  interruptAttention(reason = 'attention interrupt') {
    this.attentionInterruptGeneration += 1;
    let killedCount = 0;
    for (const child of this.activeAttentionChildren) {
      if (!child.killed) {
        child.kill('SIGTERM');
        killedCount += 1;
      }
    }
    writeLog(`Interrupted attention audio (${reason}; killed ${killedCount})`);
    return killedCount;
  }

  interruptAttentionForThread(threadId, reason = 'thread attention interrupt') {
    if (!threadId) {
      return 0;
    }
    this.threadAttentionInterruptGenerations.set(
      threadId,
      this.getThreadInterruptGeneration(threadId) + 1,
    );
    let killedCount = 0;
    const children = this.activeAttentionChildrenByThreadId.get(threadId);
    if (children) {
      for (const child of children) {
        if (!child.killed) {
          child.kill('SIGTERM');
          killedCount += 1;
        }
      }
    }
    writeLog(`Interrupted attention audio for thread ${threadId} (${reason}; killed ${killedCount})`);
    return killedCount;
  }

  interruptAudio(reason = 'audio interrupt') {
    this.audioInterruptGeneration += 1;
    let killedCount = 0;
    for (const child of this.activeAudioChildren) {
      if (!child.killed) {
        child.kill('SIGTERM');
        killedCount += 1;
      }
    }
    writeLog(`Interrupted alert audio (${reason}; killed ${killedCount})`);
    return killedCount;
  }

  getThreadInterruptGeneration(threadId) {
    return threadId ? (this.threadAttentionInterruptGenerations.get(threadId) || 0) : 0;
  }

  isCancelled(alert) {
    return alert.kind === 'attention'
      && alert.cancelKey
      && this.cancelledAttentionKeys.has(alert.cancelKey);
  }

  isInterrupted(alert) {
    if (this.isAudioInterruptGenerationStale(alert.audioInterruptGeneration)) {
      return true;
    }
    if (alert.kind !== 'attention') {
      return false;
    }
    if (Number.isFinite(alert.interruptGeneration)
      && alert.interruptGeneration < this.attentionInterruptGeneration) {
      return true;
    }
    return this.isThreadInterruptGenerationStale(alert.threadId, alert.threadInterruptGeneration);
  }

  isCancelKeyCancelled(cancelKey) {
    return Boolean(cancelKey && this.cancelledAttentionKeys.has(cancelKey));
  }

  isInterruptGenerationStale(interruptGeneration) {
    return Number.isFinite(interruptGeneration) && interruptGeneration < this.attentionInterruptGeneration;
  }

  isAudioInterruptGenerationStale(audioInterruptGeneration) {
    return Number.isFinite(audioInterruptGeneration) && audioInterruptGeneration < this.audioInterruptGeneration;
  }

  isThreadInterruptGenerationStale(threadId, threadInterruptGeneration) {
    return Boolean(threadId)
      && Number.isFinite(threadInterruptGeneration)
      && threadInterruptGeneration < this.getThreadInterruptGeneration(threadId);
  }

  throwIfStopped(alert) {
    if (this.isCancelled(alert)) {
      throw new CancelledAlertError(alert.cancelKey);
    }
    if (this.isInterrupted(alert)) {
      throw new InterruptedAlertError('audio interrupt');
    }
  }

  trackChild(cancelKey, child, interruptible = false, threadId = null) {
    let children = null;
    if (cancelKey) {
      if (!this.activeChildren.has(cancelKey)) {
        this.activeChildren.set(cancelKey, new Set());
      }
      children = this.activeChildren.get(cancelKey);
      children.add(child);
    }
    this.activeAudioChildren.add(child);
    let threadChildren = null;
    if (interruptible) {
      this.activeAttentionChildren.add(child);
      if (threadId) {
        if (!this.activeAttentionChildrenByThreadId.has(threadId)) {
          this.activeAttentionChildrenByThreadId.set(threadId, new Set());
        }
        threadChildren = this.activeAttentionChildrenByThreadId.get(threadId);
        threadChildren.add(child);
      }
    }
    return () => {
      this.activeAudioChildren.delete(child);
      if (children) {
        children.delete(child);
      }
      if (children && children.size === 0) {
        this.activeChildren.delete(cancelKey);
      }
      if (interruptible) {
        this.activeAttentionChildren.delete(child);
        if (threadChildren) {
          threadChildren.delete(child);
          if (threadChildren.size === 0) {
            this.activeAttentionChildrenByThreadId.delete(threadId);
          }
        }
      }
    };
  }

  async withAudioDucking(alert, callback) {
    if (!this.audioDucking || this.duckOutputVolume >= 100) {
      return callback();
    }
    let originalVolume = null;
    let ducked = false;
    try {
      originalVolume = await this.outputVolumeProvider();
      const numericOriginal = Number(originalVolume);
      if (!Number.isFinite(numericOriginal)) {
        return callback();
      }
      const duckedVolume = Math.max(0, Math.min(numericOriginal, this.duckOutputVolume));
      if (duckedVolume < numericOriginal) {
        await this.outputVolumeSetter(duckedVolume);
        ducked = true;
        writeLog(`Ducked system output volume ${Math.round(numericOriginal)} -> ${Math.round(duckedVolume)} for ${alert.kind}:${alert.reason}`);
      }
    } catch (error) {
      writeError(`Could not duck system audio: ${error.message}`);
      originalVolume = null;
      ducked = false;
    }
    try {
      return await callback();
    } finally {
      if (ducked && Number.isFinite(Number(originalVolume))) {
        try {
          await this.outputVolumeSetter(originalVolume);
          writeLog(`Restored system output volume to ${Math.round(Number(originalVolume))}`);
        } catch (restoreError) {
          writeError(`Could not restore system audio volume: ${restoreError.message}`);
        }
      }
    }
  }

  async getOutputVolume() {
    const output = await execFileText(this.osascriptPath, [
      '-e',
      'output volume of (get volume settings)',
    ]);
    const volume = Number(output);
    if (!Number.isFinite(volume)) {
      throw new Error(`Unexpected output volume: ${output}`);
    }
    return volume;
  }

  async setOutputVolume(volume) {
    const clamped = Math.max(0, Math.min(100, Math.round(Number(volume))));
    if (!Number.isFinite(clamped)) {
      throw new Error(`Invalid output volume: ${volume}`);
    }
    await execFileText(this.osascriptPath, ['-e', `set volume output volume ${clamped}`]);
  }

  playOne(soundPath, alert) {
    const cancelKey = alert.kind === 'attention' ? alert.cancelKey : null;
    const args = this.alertVolume === 1
      ? [soundPath]
      : ['--volume', String(this.alertVolume), soundPath];
    return this.spawnAudio(this.afplayPath, args, {
      cancelKey,
      audioInterruptGeneration: alert.audioInterruptGeneration,
      interruptGeneration: alert.interruptGeneration,
      interruptible: alert.kind === 'attention',
      threadId: alert.kind === 'attention' ? alert.threadId : null,
      threadInterruptGeneration: alert.threadInterruptGeneration,
    }, `${this.afplayPath} ${args.join(' ')}`);
  }

  spawnAudio(command, args, playbackState = {}, label) {
    const cancelKey = playbackState.cancelKey || null;
    const audioInterruptGeneration = playbackState.audioInterruptGeneration;
    const interruptGeneration = playbackState.interruptGeneration;
    const interruptible = Boolean(playbackState.interruptible);
    const threadId = playbackState.threadId || null;
    const threadInterruptGeneration = playbackState.threadInterruptGeneration;
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: 'ignore',
        detached: false,
      });
      const untrack = this.trackChild(cancelKey, child, interruptible, threadId);
      child.on('error', (error) => {
        untrack();
        if (this.isCancelKeyCancelled(cancelKey)) {
          reject(new CancelledAlertError(cancelKey));
          return;
        }
        if (this.isAudioInterruptGenerationStale(audioInterruptGeneration)
          || this.isInterruptGenerationStale(interruptGeneration)
          || this.isThreadInterruptGenerationStale(threadId, threadInterruptGeneration)) {
          reject(new InterruptedAlertError('audio interrupt'));
          return;
        }
        reject(new Error(`Could not run ${label}: ${error.message}`));
      });
      child.on('close', (code, signal) => {
        untrack();
        if (this.isCancelKeyCancelled(cancelKey)) {
          reject(new CancelledAlertError(cancelKey));
          return;
        }
        if (this.isAudioInterruptGenerationStale(audioInterruptGeneration)
          || this.isInterruptGenerationStale(interruptGeneration)
          || this.isThreadInterruptGenerationStale(threadId, threadInterruptGeneration)) {
          reject(new InterruptedAlertError('audio interrupt'));
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`${label} exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
      });
    });
  }

  async maybeSpeakAlert(alert) {
    if (alert.kind === 'attention') {
      return this.maybeSpeak(alert, this.spokenAttention, this.attentionPhrase(alert), 'attention');
    }
    if (alert.kind === 'done') {
      return this.maybeSpeak(alert, this.spokenCompletion, DEFAULT_COMPLETION_PHRASE, 'completion');
    }
    return false;
  }

  async maybeSpeak(alert, enabled, phrase, label) {
    if (!enabled) {
      return false;
    }
    try {
      this.throwIfStopped(alert);
      await this.speak(phrase, alert);
      this.throwIfStopped(alert);
      return true;
    } catch (error) {
      if (isStoppedAlertError(error)) {
        throw error;
      }
      writeError(`Could not speak ${label} alert after sound: ${error.message}`);
      return false;
    }
  }

  async playFallbackAlert(alert) {
    if (alert.kind === 'attention') {
      try {
        this.throwIfStopped(alert);
        await this.speak(this.attentionPhrase(alert), alert);
        return;
      } catch (error) {
        if (isStoppedAlertError(error)) {
          throw error;
        }
        writeError(`Could not speak fallback alert: ${error.message}; falling back to system beep`);
        await this.playFallbackBeep(4, alert);
        return;
      }
    }

    if (alert.kind === 'done' && this.spokenCompletion) {
      try {
        this.throwIfStopped(alert);
        await this.speak(DEFAULT_COMPLETION_PHRASE, alert);
        return;
      } catch (error) {
        if (isStoppedAlertError(error)) {
          throw error;
        }
        writeError(`Could not speak fallback completion alert: ${error.message}; falling back to system beep`);
      }
    }

    await this.playFallbackBeep(2, alert);
  }

  attentionPhrase(alert) {
    const reason = String(alert.reason || '');
    if (reason.startsWith('permission')) {
      return DEFAULT_PERMISSION_PHRASE;
    }
    if (reason.includes('question')) {
      return DEFAULT_QUESTION_PHRASE;
    }
    return DEFAULT_ATTENTION_PHRASE;
  }

  speak(text, alert = null) {
    const isAttention = alert?.kind === 'attention';
    return this.spawnAudio(this.sayPath, [text], {
      cancelKey: isAttention ? alert.cancelKey : null,
      audioInterruptGeneration: alert?.audioInterruptGeneration,
      interruptGeneration: isAttention ? alert.interruptGeneration : undefined,
      interruptible: isAttention,
      threadId: isAttention ? alert.threadId : null,
      threadInterruptGeneration: isAttention ? alert.threadInterruptGeneration : undefined,
    }, `${this.sayPath} "${text}"`);
  }

  playFallbackBeep(count = 1, alert = null) {
    const isAttention = alert?.kind === 'attention';
    return this.spawnAudio(this.osascriptPath, ['-e', `beep ${count}`], {
      cancelKey: isAttention ? alert.cancelKey : null,
      audioInterruptGeneration: alert?.audioInterruptGeneration,
      interruptGeneration: isAttention ? alert.interruptGeneration : undefined,
      interruptible: isAttention,
      threadId: isAttention ? alert.threadId : null,
      threadInterruptGeneration: isAttention ? alert.threadInterruptGeneration : undefined,
    }, `${this.osascriptPath} beep ${count}`);
  }

  playNamed(name) {
    const alert = {
      kind: name === 'attention' ? 'attention' : 'done',
      reason: 'test',
      threadTitle: 'Test sound',
      threadId: 'test',
    };
    return this.play(alert);
  }
}

export class CodexSoundWatcher {
  constructor(options = {}) {
    this.options = options;
    this.engine = new CodexAlertEngine({
      repeatMs: options.repeatMs ?? DEFAULT_REPEAT_MS,
      cooldownMs: options.cooldownMs ?? DEFAULT_COOLDOWN_MS,
    });
    this.player = new SoundPlayer(options);
    this.followers = new Map();
    this.lastThreadRefreshMs = 0;
    this.codexIsFrontmost = false;
    this.activeCodexThreadId = null;
    this.activeCodexThreadLabel = '';
    this.activeCodexThreadConfidence = 'unknown';
    this.lastActiveCodexLogKey = '';
    this.userIdleMs = null;
    this.userRecentlyActive = null;
    this.lastUserIdleLogKey = '';
    this.activeChatDetector = options.frontmostInterrupt === false
      ? null
      : new ActiveCodexChatDetector(options);
    this.userIdleDetector = options.frontmostInterrupt === false
      ? null
      : new UserIdleDetector(options);
    this.frontmostMonitor = options.frontmostInterrupt === false
      ? null
      : new FrontmostAppMonitor({
        ...options,
        onFrontmostState: (state) => this.handleFrontmostState(state),
        onCodexFrontmost: (appName) => this.handleCodexFrontmost(appName),
      });
  }

  async refreshThreads(startAtEndForNew = true) {
    const threads = await listActiveThreads(this.options);
    const seenIds = new Set();
    for (const thread of threads) {
      seenIds.add(thread.id);
      if (!thread.rolloutPath || !existsSync(thread.rolloutPath)) {
        continue;
      }
      if (!this.followers.has(thread.id)) {
        this.followers.set(thread.id, {
          thread,
          follower: new SessionFileFollower(thread.rolloutPath, { startAtEnd: startAtEndForNew }),
        });
        writeLog(`Watching "${displayTitle(thread.title)}" (${thread.id})`);
      } else {
        this.followers.get(thread.id).thread = thread;
      }
    }

    for (const [threadId] of this.followers) {
      if (!seenIds.has(threadId)) {
        this.followers.delete(threadId);
      }
    }
  }

  async tick() {
    const nowMs = Date.now();
    if (nowMs - this.lastThreadRefreshMs > (this.options.threadRefreshMs ?? DEFAULT_THREAD_REFRESH_MS)) {
      await this.refreshThreads(true);
      this.lastThreadRefreshMs = nowMs;
    }

    for (const { thread, follower } of this.followers.values()) {
      const events = await follower.readNewEvents();
      for (const event of events) {
        if (event.type === 'parse_error') {
          writeError(`Could not parse ${thread.rolloutPath}: ${event.error}`);
          continue;
        }
        for (const alert of this.engine.processEvent({ id: thread.id, title: thread.title }, event, Date.now())) {
          await this.playOrSuppress(alert);
        }
        this.flushAudioCancellations();
      }
    }

    for (const alert of this.engine.collectRepeatAlerts(Date.now())) {
      await this.playOrSuppress(alert);
    }
  }

  async playOrSuppress(alert) {
    if (this.codexIsFrontmost && this.userIdleDetector) {
      const idleState = await this.refreshUserIdle();
      if (idleState?.recentlyActive === true) {
        const retryDelayMs = Math.max(0, Number(idleState.activeIdleMs || 0) - Number(idleState.idleMs || 0));
        const rescheduled = alert.kind === 'attention'
          && this.engine.rescheduleAttentionAlert(alert, retryDelayMs);
        const retrySuffix = rescheduled
          ? `; retrying after ${Math.ceil(retryDelayMs / 1000)}s`
          : '';
        writeLog(`Suppressed ${alert.kind}:${alert.reason} because Codex is frontmost and user was active ${Math.round(idleState.idleMs / 1000)}s ago for "${displayTitle(alert.threadTitle)}" (${alert.threadId})${retrySuffix}`);
        return;
      }
      if (idleState?.status === 'known') {
        writeLog(`Playing ${alert.kind}:${alert.reason}; Codex is frontmost but user has been idle ${Math.round(idleState.idleMs / 1000)}s for "${displayTitle(alert.threadTitle)}" (${alert.threadId})`);
      } else {
        writeLog(`Playing ${alert.kind}:${alert.reason}; Codex is frontmost but user idle state is unknown (${idleState?.reason || 'no_idle_state'}) for "${displayTitle(alert.threadTitle)}" (${alert.threadId})`);
      }
    }
    this.player.play(alert);
  }

  flushAudioCancellations() {
    for (const action of this.engine.collectClearActions()) {
      this.player.cancel(action);
    }
  }

  handleCodexFrontmost(appName) {
    return this.refreshUserIdle().then((idleState) => {
      if (idleState?.recentlyActive === true) {
        this.player.interruptAudio(`Codex frontmost: ${appName}`);
      } else if (idleState?.status === 'known') {
        writeLog(`Codex became frontmost, but user is idle ${Math.round(idleState.idleMs / 1000)}s; alert audio continues`);
      } else {
        writeLog(`Codex became frontmost, but user idle state is unknown (${idleState?.reason || 'no_idle_state'}); alert audio continues`);
      }
    });
  }

  async handleFrontmostState(state) {
    this.codexIsFrontmost = Boolean(state?.isCodex);
    if (!this.codexIsFrontmost) {
      this.activeCodexThreadId = null;
      this.activeCodexThreadLabel = '';
      this.activeCodexThreadConfidence = 'unknown';
      this.lastActiveCodexLogKey = '';
      this.userIdleMs = null;
      this.userRecentlyActive = null;
      this.lastUserIdleLogKey = '';
      return;
    }

    const wasRecentlyActive = this.userRecentlyActive;
    const idleState = await this.refreshUserIdle();
    if (wasRecentlyActive === false && idleState?.recentlyActive === true) {
      this.player.interruptAudio(`Codex user active: ${state?.appName || 'Codex'}`);
    }
  }

  getWatchedThreads() {
    return Array.from(this.followers.values()).map(({ thread }) => thread);
  }

  async refreshActiveCodexChat() {
    if (!this.activeChatDetector) {
      return { status: 'unknown', reason: 'disabled' };
    }
    const result = await this.activeChatDetector.detect(this.getWatchedThreads());
    this.activeCodexThreadId = result.threadId || null;
    this.activeCodexThreadLabel = result.label || '';
    this.activeCodexThreadConfidence = result.confidence || 'unknown';
    this.logActiveCodexChat(result);
    return result;
  }

  async refreshUserIdle() {
    if (!this.userIdleDetector) {
      return { status: 'unknown', reason: 'disabled' };
    }
    const result = await this.userIdleDetector.detect();
    this.userIdleMs = result.status === 'known' ? result.idleMs : null;
    this.userRecentlyActive = result.status === 'known' ? result.recentlyActive : null;
    this.logUserIdle(result);
    return result;
  }

  logActiveCodexChat(result) {
    const key = `${result.status || 'unknown'}:${result.reason || ''}:${result.threadId || ''}:${result.label || ''}:${result.matchCount || ''}`;
    if (key === this.lastActiveCodexLogKey) {
      return;
    }
    this.lastActiveCodexLogKey = key;
    if (result.threadId) {
      writeLog(`Active Codex chat matched "${displayTitle(result.thread?.title || result.label)}" (${result.threadId}) via ${result.reason}`);
      return;
    }
    writeLog(`Active Codex chat unknown (${result.reason || 'no_match'}${result.label ? `; label "${displayTitle(result.label)}"` : ''})`);
  }

  logUserIdle(result) {
    const key = result.status === 'known'
      ? `known:${result.recentlyActive}:${Math.floor(result.idleMs / 10_000)}`
      : `unknown:${result.reason || ''}`;
    if (key === this.lastUserIdleLogKey) {
      return;
    }
    this.lastUserIdleLogKey = key;
    if (result.status === 'known') {
      const idleSeconds = Math.round(result.idleMs / 1000);
      const thresholdSeconds = Math.round(result.activeIdleMs / 1000);
      writeLog(`User idle ${idleSeconds}s (${result.recentlyActive ? 'recently active' : `over ${thresholdSeconds}s threshold`})`);
      return;
    }
    writeLog(`User idle unknown (${result.reason || 'no_idle_state'})`);
  }

  async runOnce() {
    await this.refreshThreads(true);
    writeLog(`Active watched threads: ${this.followers.size}`);
    await this.tick();
  }

  async watch() {
    await this.refreshThreads(true);
    writeLog(`Codex sound watcher running. Poll interval: ${this.options.pollMs ?? DEFAULT_POLL_MS}ms`);
    if (this.frontmostMonitor) {
      await this.frontmostMonitor.pollOnce();
      this.frontmostMonitor.start({ pollImmediately: false });
      writeLog(`Frontmost app interruption enabled. Poll interval: ${this.frontmostMonitor.pollMs}ms`);
    }
    const runTick = async () => {
      try {
        await this.tick();
      } catch (error) {
        writeError(error.stack || error.message);
      }
    };
    await runTick();
    setInterval(runTick, this.options.pollMs ?? DEFAULT_POLL_MS);
  }
}

export function parseArgs(argv) {
  const options = {
    dryRun: false,
    diagnose: false,
    once: false,
    watch: false,
    testSound: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--diagnose') {
      options.diagnose = true;
    } else if (arg === '--once') {
      options.once = true;
    } else if (arg === '--watch') {
      options.watch = true;
    } else if (arg === '--test-sound') {
      options.testSound = argv[index + 1];
      index += 1;
    } else if (arg === '--repeat-ms') {
      options.repeatMs = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--poll-ms') {
      options.pollMs = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--frontmost-poll-ms') {
      options.frontmostPollMs = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--active-idle-ms') {
      options.activeIdleMs = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--state-db') {
      options.stateDb = argv[index + 1];
      index += 1;
    } else if (arg === '--done-sound') {
      options.doneSound = argv[index + 1];
      index += 1;
    } else if (arg === '--attention-sound') {
      options.attentionSound = argv[index + 1];
      index += 1;
    } else if (arg === '--play-count') {
      options.playCount = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--sound-gap-ms') {
      options.soundGapMs = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--alert-volume') {
      options.alertVolume = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--duck-output-volume') {
      options.duckOutputVolume = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--audio-ducking') {
      options.audioDucking = true;
    } else if (arg === '--no-audio-ducking') {
      options.audioDucking = false;
    } else if (arg === '--spoken-attention') {
      options.spokenAttention = true;
    } else if (arg === '--no-spoken-attention') {
      options.spokenAttention = false;
    } else if (arg === '--spoken-completion') {
      options.spokenCompletion = true;
    } else if (arg === '--no-spoken-completion') {
      options.spokenCompletion = false;
    } else if (arg === '--no-frontmost-interrupt') {
      options.frontmostInterrupt = false;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }

  return options;
}

function statusLine(status, label, detail = '') {
  const suffix = detail ? ` - ${detail}` : '';
  return `${status.padEnd(4)} ${label}${suffix}`;
}

async function checkCommand(label, command, args = []) {
  try {
    await execFileText(command, args);
    return { status: 'PASS', label };
  } catch (error) {
    return { status: 'WARN', label, detail: error.message.split('\n')[0] };
  }
}

async function diagnose(options = {}) {
  const checks = [];
  const add = (status, label, detail = '') => checks.push({ status, label, detail });

  add(process.platform === 'darwin' ? 'PASS' : 'FAIL', 'macOS platform', `detected ${process.platform}`);
  add('PASS', 'Node.js runtime', process.version);
  add(existsSync(options.doneSound || DEFAULT_DONE_SOUND) ? 'PASS' : 'FAIL', 'completion sound asset');
  add(existsSync(options.attentionSound || DEFAULT_ATTENTION_SOUND) ? 'PASS' : 'FAIL', 'attention sound asset');
  add(existsSync(options.stateDb || process.env.CODEX_STATE_DB || DEFAULT_STATE_DB) ? 'PASS' : 'FAIL', 'Codex state database', 'no path printed for privacy');
  add(existsSync('/usr/bin/afplay') ? 'PASS' : 'FAIL', 'afplay command');

  checks.push(await checkCommand('sqlite3 command', options.sqlite3Path || process.env.SQLITE3_PATH || '/usr/bin/sqlite3', ['--version']));

  try {
    const threads = await listActiveThreads(options);
    const watched = threads.filter((thread) => thread.rolloutPath && existsSync(thread.rolloutPath));
    add(threads.length > 0 ? 'PASS' : 'WARN', 'active Codex threads query', `${threads.length} active thread(s) with session metadata`);
    add(watched.length > 0 ? 'PASS' : 'WARN', 'readable Codex session logs', `${watched.length} readable rollout log(s)`);
  } catch (error) {
    add('FAIL', 'active Codex threads query', 'could not read Codex state database or expected schema');
  }

  try {
    await getFrontmostAppName(options);
    add('PASS', 'frontmost app detection');
  } catch (error) {
    add('WARN', 'frontmost app detection', 'grant Automation/Accessibility permissions or use --no-frontmost-interrupt');
  }

  try {
    const idleOutput = await getSystemIdleOutput(options);
    add(parseHidIdleMs(idleOutput) === null ? 'WARN' : 'PASS', 'user idle detection');
  } catch {
    add('WARN', 'user idle detection', 'frontmost suppression may be less precise');
  }

  console.log('Codex Sound Watcher diagnose');
  for (const check of checks) {
    console.log(statusLine(check.status, check.label, check.detail));
  }

  const failures = checks.filter((check) => check.status === 'FAIL').length;
  const warnings = checks.filter((check) => check.status === 'WARN').length;
  console.log(`Summary: ${failures} failure(s), ${warnings} warning(s)`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

function printHelp() {
  console.log(`Codex Sound Watcher

Usage:
  node CodexSoundWatcher.mjs --watch
  node CodexSoundWatcher.mjs --once --dry-run
  node CodexSoundWatcher.mjs --diagnose
  node CodexSoundWatcher.mjs --test-sound done
  node CodexSoundWatcher.mjs --test-sound attention

Options:
  --dry-run                 Log alerts instead of playing sounds.
  --diagnose                Check local Codex/macOS compatibility without printing private paths.
  --repeat-ms <ms>          Repeat interval for attention alerts. Default: ${DEFAULT_REPEAT_MS}.
  --poll-ms <ms>            Session file poll interval. Default: ${DEFAULT_POLL_MS}.
  --frontmost-poll-ms <ms>  Frontmost app poll interval. Default: ${DEFAULT_FRONTMOST_POLL_MS}.
  --active-idle-ms <ms>     User idle threshold for active-Codex suppression. Default: ${DEFAULT_ACTIVE_IDLE_MS}.
  --state-db <path>         Override Codex state database path.
  --done-sound <path>       Override completion sound.
  --attention-sound <path>  Override attention-needed sound.
  --play-count <count>      Number of times to play each alert sound. Default: ${DEFAULT_PLAY_COUNT}.
  --sound-gap-ms <ms>       Gap between repeated sound plays. Default: ${DEFAULT_SOUND_GAP_MS}.
  --alert-volume <volume>   afplay volume multiplier for alert sounds. Default: ${DEFAULT_ALERT_VOLUME}.
  --audio-ducking           Enable temporary system output volume ducking.
  --duck-output-volume <n>  Duck system output volume to this level when enabled. Default: ${DEFAULT_DUCK_OUTPUT_VOLUME}.
  --no-audio-ducking        Disable temporary system output volume ducking.
  --spoken-attention        Enable spoken phrases after attention sounds.
  --no-spoken-attention     Disable spoken phrases after attention sounds.
  --spoken-completion       Enable spoken phrases after completion sounds.
  --no-spoken-completion    Disable spoken phrases after completion sounds.
  --no-frontmost-interrupt  Disable interrupting alert audio when Codex becomes frontmost.
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.diagnose) {
    await diagnose(options);
    return;
  }

  const player = new SoundPlayer(options);
  if (options.testSound) {
    if (!['done', 'attention'].includes(options.testSound)) {
      throw new Error('--test-sound must be "done" or "attention"');
    }
    await player.playNamed(options.testSound);
    return;
  }

  const watcher = new CodexSoundWatcher(options);
  if (options.once) {
    await watcher.runOnce();
    return;
  }
  if (options.watch) {
    await watcher.watch();
    return;
  }

  printHelp();
}

const entrypoint = fileURLToPath(import.meta.url);
if (process.argv[1] === entrypoint) {
  main().catch((error) => {
    writeError(error.stack || error.message);
    process.exitCode = 1;
  });
}
