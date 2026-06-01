#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ActiveCodexChatDetector,
  CodexAlertEngine,
  CodexSoundWatcher,
  FrontmostAppMonitor,
  SessionFileFollower,
  SoundPlayer,
  UserIdleDetector,
  finalAnswerNeedsAnswer,
  matchActiveCodexThread,
  parseHidIdleMs,
  parseArgs,
} from './CodexSoundWatcher.mjs';

const THREAD = { id: 'thread-1', title: 'Fixture Thread' };
const ACTIVE_ROW_CLASS = 'group relative h-token-nav-row bg-token-list-hover-background';
const INACTIVE_ROW_CLASS = 'group relative h-token-nav-row hover:bg-token-list-hover-background';

function hidIdleOutput(idleMs) {
  return `"HIDIdleTime" = ${Math.round(idleMs * 1_000_000)}`;
}

function eventMsg(type, extra = {}) {
  return {
    type: 'event_msg',
    payload: { type, ...extra },
  };
}

function finalMessage(text) {
  return {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text }],
    },
  };
}

function functionCall(name, args = {}, callId = `call-${name}`) {
  return {
    type: 'response_item',
    payload: {
      type: 'function_call',
      name,
      arguments: JSON.stringify(args),
      call_id: callId,
    },
  };
}

function functionOutput(callId) {
  return {
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: callId,
      output: 'ok',
    },
  };
}

function runEvents(events) {
  const engine = new CodexAlertEngine({ repeatMs: 100, cooldownMs: 2_000 });
  const alerts = [];
  let now = 1_000;
  for (const event of events) {
    alerts.push(...engine.processEvent(THREAD, event, now));
    now += 10;
  }
  return { engine, alerts, now };
}

function assertAlert(alerts, kind, reason) {
  assert.ok(
    alerts.some((alert) => alert.kind === kind && alert.reason === reason),
    `Expected ${kind}:${reason}; got ${JSON.stringify(alerts)}`,
  );
}

function pause(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForLogMatch(logPath, pattern, timeoutMs = 1_000) {
  const startedAt = Date.now();
  let lastText = '';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastText = await readFile(logPath, 'utf8');
      if (pattern.test(lastText)) {
        return lastText;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    await pause(20);
  }
  assert.fail(`Timed out waiting for ${pattern}; log was ${JSON.stringify(lastText)}`);
}

async function writeFakeAudioScript(dir) {
  const script = join(dir, 'fake-audio.mjs');
  await writeFile(script, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

const logPath = process.env.CODEX_SOUND_WATCHER_TEST_LOG;
const args = process.argv.slice(2).join(' ');
const duration = args.includes('done.aiff')
  ? Number(process.env.CODEX_SOUND_WATCHER_DONE_MS || 100)
  : Number(process.env.CODEX_SOUND_WATCHER_ATTENTION_MS || 5000);

appendFileSync(logPath, \`start \${args}\\n\`);
process.on('SIGTERM', () => {
  appendFileSync(logPath, 'terminated\\n');
  process.exit(0);
});
setTimeout(() => {
  appendFileSync(logPath, \`done \${args}\\n\`);
  process.exit(0);
}, duration);
`, 'utf8');
  await chmod(script, 0o755);
  return script;
}

async function testNormalCompletion() {
  const { alerts } = runEvents([
    eventMsg('task_started'),
    finalMessage('Done.'),
    eventMsg('task_complete'),
  ]);
  assertAlert(alerts, 'done', 'task_complete');
}

async function testPlanCompletion() {
  const { alerts } = runEvents([
    eventMsg('task_started'),
    finalMessage('<proposed_plan>\n# Plan\n</proposed_plan>'),
    eventMsg('task_complete'),
  ]);
  assertAlert(alerts, 'done', 'task_complete');
}

async function testRequestUserInputAttention() {
  const { alerts } = runEvents([
    eventMsg('task_started'),
    functionCall('request_user_input', { questions: [] }, 'call-question'),
  ]);
  assertAlert(alerts, 'attention', 'question');
}

async function testEscalatedPermissionAttention() {
  const engine = new CodexAlertEngine({ repeatMs: 100, cooldownMs: 2_000 });
  engine.processEvent(THREAD, eventMsg('task_started'), 1_000);
  const alerts = engine.processEvent(
    THREAD,
    functionCall('exec_command', { cmd: 'open .', sandbox_permissions: 'require_escalated' }, 'call-permission'),
    1_010,
  );
  assert.equal(alerts.length, 0);
  assert.equal(engine.collectRepeatAlerts(16_009).length, 0);
  const delayed = engine.collectRepeatAlerts(16_010);
  assert.equal(delayed.length, 1);
  assert.equal(delayed[0].kind, 'attention');
  assert.equal(delayed[0].reason, 'permission');
  assert.equal(delayed[0].repeat, false);
}

async function testPluginPermissionAttention() {
  const { alerts } = runEvents([
    eventMsg('task_started'),
    functionCall('request_plugin_install', { tool_id: 'chrome@openai-bundled' }, 'call-plugin'),
  ]);
  assertAlert(alerts, 'attention', 'permission');
}

async function testDuplicateEventsDoNotReplay() {
  const event = functionCall('request_user_input', { questions: [] }, 'call-question');
  const { alerts } = runEvents([
    eventMsg('task_started'),
    event,
    event,
  ]);
  assert.equal(alerts.filter((alert) => alert.kind === 'attention').length, 1);
}

async function testAttentionRepeatsUntilCleared() {
  const { engine, alerts } = runEvents([
    eventMsg('task_started'),
    functionCall('request_user_input', { questions: [] }, 'call-question'),
  ]);
  assert.equal(alerts.length, 1);
  const repeats = engine.collectRepeatAlerts(2_000);
  assert.equal(repeats.length, 1);
  engine.processEvent(THREAD, functionOutput('call-question'), 2_010);
  assert.equal(engine.collectRepeatAlerts(4_000).length, 0);
}

async function testSuppressedAttentionRetryUsesIdleThreshold() {
  const engine = new CodexAlertEngine({ repeatMs: 180_000, cooldownMs: 2_000, execPermissionGraceMs: 0 });
  engine.processEvent(THREAD, eventMsg('task_started'), 1_000);
  const alerts = engine.processEvent(
    THREAD,
    functionCall('exec_command', { cmd: 'open .', sandbox_permissions: 'require_escalated' }, 'call-permission'),
    1_010,
  );
  assert.equal(alerts.length, 1);

  assert.equal(engine.rescheduleAttentionAlert(alerts[0], 8_000, 2_000), true);
  assert.equal(engine.collectRepeatAlerts(9_999).length, 0);
  const repeats = engine.collectRepeatAlerts(10_000);
  assert.equal(repeats.length, 1);
  assert.equal(repeats[0].reason, 'permission_repeat');
}

async function testClearActionOnFunctionOutput() {
  const engine = new CodexAlertEngine({ repeatMs: 100, cooldownMs: 2_000, execPermissionGraceMs: 0 });
  engine.processEvent(THREAD, eventMsg('task_started'), 1_000);
  const alerts = engine.processEvent(
    THREAD,
    functionCall('exec_command', { cmd: 'open .', sandbox_permissions: 'require_escalated' }, 'call-permission'),
    1_010,
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].cancelKey, 'thread-1:call-permission');
  assert.deepEqual(engine.collectClearActions(), []);

  engine.processEvent(THREAD, functionOutput('call-permission'), 1_020);
  const clears = engine.collectClearActions();
  assert.equal(clears.length, 1);
  assert.equal(clears[0].kind, 'attention_clear');
  assert.equal(clears[0].cancelKey, alerts[0].cancelKey);
  assert.equal(clears[0].reason, 'call_output');
}

async function testUserMessageClearsAllAttentionAudio() {
  const engine = new CodexAlertEngine({ repeatMs: 100, cooldownMs: 2_000, execPermissionGraceMs: 0 });
  engine.processEvent(THREAD, eventMsg('task_started'), 1_000);
  engine.processEvent(THREAD, functionCall('request_user_input', { questions: [] }, 'call-question'), 1_010);
  engine.processEvent(
    THREAD,
    functionCall('exec_command', { cmd: 'open .', sandbox_permissions: 'require_escalated' }, 'call-permission'),
    1_020,
  );

  engine.processEvent(THREAD, eventMsg('user_message'), 1_030);
  const clearKeys = engine.collectClearActions().map((action) => action.cancelKey).sort();
  assert.deepEqual(clearKeys, ['thread-1:call-permission', 'thread-1:call-question']);
}

async function testAutoApprovedEscalatedPermissionDoesNotAlert() {
  const { engine, alerts, now } = runEvents([
    eventMsg('task_started'),
    functionCall('exec_command', { cmd: 'open .', sandbox_permissions: 'require_escalated' }, 'call-permission'),
    functionOutput('call-permission'),
  ]);
  assert.equal(alerts.length, 0);
  assert.equal(engine.collectRepeatAlerts(now + 60_000).length, 0);
}

async function testApprovedPrefixRuleSuppressesEscalatedPermissionAlert() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-sound-rules-'));
  try {
    const rulesPath = join(dir, 'default.rules');
    await writeFile(
      rulesPath,
      'prefix_rule(pattern=["./ExampleAllowedCommand"], decision="allow")\n',
      'utf8',
    );

    const engine = new CodexAlertEngine({
      repeatMs: 100,
      cooldownMs: 2_000,
      approvalRulesPath: rulesPath,
    });
    engine.processEvent(THREAD, eventMsg('task_started'), 1_000);
    const first = engine.processEvent(
      THREAD,
      functionCall(
        'exec_command',
        {
          cmd: './ExampleAllowedCommand --auth-check',
          sandbox_permissions: 'require_escalated',
          prefix_rule: ['./ExampleAllowedCommand'],
        },
        'call-auth-check',
      ),
      1_010,
    );
    const second = engine.processEvent(
      THREAD,
      functionCall(
        'exec_command',
        {
          cmd: './ExampleAllowedCommand --dry-run',
          sandbox_permissions: 'require_escalated',
          prefix_rule: ['./ExampleAllowedCommand'],
        },
        'call-dry-run',
      ),
      1_020,
    );

    assert.equal(first.length, 0);
    assert.equal(second.length, 0);
    assert.equal(engine.collectRepeatAlerts(120_000).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testRuleBypassSyntaxStillAlertsEscalatedPermission() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-sound-rules-'));
  try {
    const rulesPath = join(dir, 'default.rules');
    await writeFile(
      rulesPath,
      'prefix_rule(pattern=["./ExampleAllowedCommand"], decision="allow")\n',
      'utf8',
    );
    const engine = new CodexAlertEngine({
      repeatMs: 100,
      cooldownMs: 2_000,
      approvalRulesPath: rulesPath,
    });
    engine.processEvent(THREAD, eventMsg('task_started'), 1_000);
    engine.processEvent(
      THREAD,
      functionCall(
        'exec_command',
        {
          cmd: './ExampleAllowedCommand --dry-run > /tmp/out.log',
          sandbox_permissions: 'require_escalated',
          prefix_rule: ['./ExampleAllowedCommand'],
        },
        'call-dry-run',
      ),
      1_010,
    );

    assert.equal(engine.collectRepeatAlerts(16_009).length, 0);
    const delayed = engine.collectRepeatAlerts(16_010);
    assert.equal(delayed.length, 1);
    assert.equal(delayed[0].reason, 'permission');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testSoundPlayerCancelsActiveAttentionAudio() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-sound-player-'));
  const previousLogPath = process.env.CODEX_SOUND_WATCHER_TEST_LOG;
  try {
    const script = join(dir, 'fake-audio.mjs');
    const logPath = join(dir, 'audio.log');
    await writeFile(script, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

const logPath = process.env.CODEX_SOUND_WATCHER_TEST_LOG;
appendFileSync(logPath, \`start \${process.argv.slice(2).join(' ')}\\n\`);
process.on('SIGTERM', () => {
  appendFileSync(logPath, 'terminated\\n');
  process.exit(0);
});
setTimeout(() => {
  appendFileSync(logPath, 'done\\n');
  process.exit(0);
}, 5000);
`, 'utf8');
    await chmod(script, 0o755);
    process.env.CODEX_SOUND_WATCHER_TEST_LOG = logPath;

    const player = new SoundPlayer({
      afplayPath: script,
      sayPath: script,
      osascriptPath: script,
      attentionSound: 'attention.aiff',
      doneSound: 'done.aiff',
      playCount: 1,
      soundGapMs: 1,
      spokenCompletion: false,
      audioDucking: false,
    });
    const alert = {
      kind: 'attention',
      reason: 'permission',
      threadTitle: 'Fixture Thread',
      threadId: 'thread-1',
      cancelKey: 'thread-1:call-permission',
    };
    const playPromise = player.play(alert);
    await waitForLogMatch(logPath, /start .*attention\.aiff/);
    player.cancel({ kind: 'attention_clear', cancelKey: alert.cancelKey });
    await playPromise;

    const logText = await readFile(logPath, 'utf8');
    assert.match(logText, /start .*attention\.aiff/);
    assert.match(logText, /terminated/);
    assert.doesNotMatch(logText, /done/);
  } finally {
    if (previousLogPath === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_TEST_LOG;
    } else {
      process.env.CODEX_SOUND_WATCHER_TEST_LOG = previousLogPath;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function testSoundPlayerDefaultsToSinglePlay() {
  const player = new SoundPlayer();
  assert.equal(player.playCount, 1);
  assert.equal(player.alertVolume, 1);
  assert.equal(player.audioDucking, false);
  assert.equal(player.duckOutputVolume, 25);
  assert.equal(player.spokenAttention, false);
  assert.equal(player.spokenCompletion, false);
}

function activeRows(label) {
  return [
    { label: 'Inactive Thread', classList: INACTIVE_ROW_CLASS },
    { label, classList: ACTIVE_ROW_CLASS },
  ];
}

async function testActiveChatDetectorExactMatch() {
  const detector = new ActiveCodexChatDetector({
    activeChatProvider: async () => activeRows('Fixture Thread'),
  });
  const result = await detector.detect([{ ...THREAD, firstUserMessage: 'Fixture Thread' }]);
  assert.equal(result.status, 'matched');
  assert.equal(result.threadId, THREAD.id);
  assert.equal(result.confidence, 'exact');
}

async function testActiveChatDetectorConservativeTokenMatch() {
  const detector = new ActiveCodexChatDetector({
    activeChatProvider: async () => activeRows('Prevent auto-select scrolling'),
  });
  const result = await detector.detect([{
    id: 'thread-2',
    title: 'Can we prevent the "auto-select first email" feature from scrolling to reach its first message? Discuss',
    firstUserMessage: '',
  }]);
  assert.equal(result.status, 'matched');
  assert.equal(result.threadId, 'thread-2');
  assert.equal(result.confidence, 'token_match');
}

async function testActiveChatDetectorDuplicateExactMatchIsUnknown() {
  const result = matchActiveCodexThread('Fixture Thread', [
    { id: 'thread-1', title: 'Fixture Thread' },
    { id: 'thread-2', title: 'Fixture Thread' },
  ]);
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'ambiguous_exact');
}

async function testActiveChatDetectorGenericLabelIsUnknown() {
  const result = matchActiveCodexThread('Diagnose issue', [
    { id: 'thread-1', title: 'Diagnose account issue' },
  ]);
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'generic_label');
}

async function testActiveChatDetectorProviderFailureIsUnknown() {
  const detector = new ActiveCodexChatDetector({
    activeChatProvider: async () => {
      throw new Error('AX unavailable');
    },
  });
  const result = await detector.detect([THREAD]);
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'provider_error');
}

async function testActiveChatDetectorNoHighlightedRowIsUnknown() {
  const detector = new ActiveCodexChatDetector({
    activeChatProvider: async () => [{ label: 'Fixture Thread', classList: INACTIVE_ROW_CLASS }],
  });
  const result = await detector.detect([THREAD]);
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'no_highlighted_row');
}

async function testUserIdleDetectorParsesHidIdleTime() {
  assert.equal(parseHidIdleMs(hidIdleOutput(12_345)), 12_345);
  const detector = new UserIdleDetector({
    activeIdleMs: 30_000,
    userIdleProvider: async () => hidIdleOutput(1_250),
  });
  const result = await detector.detect();
  assert.equal(result.status, 'known');
  assert.equal(result.idleMs, 1_250);
  assert.equal(result.recentlyActive, true);
}

async function testUserIdleDetectorMissingValueIsUnknown() {
  const detector = new UserIdleDetector({
    userIdleProvider: async () => 'IOHIDSystem has no idle field',
  });
  const result = await detector.detect();
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'missing_hid_idle_time');
}

async function testUserIdleDetectorMalformedValueIsUnknown() {
  const detector = new UserIdleDetector({
    userIdleProvider: async () => '"HIDIdleTime" = not-a-number',
  });
  const result = await detector.detect();
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'malformed_hid_idle_time');
}

async function testUserIdleDetectorProviderFailureIsUnknown() {
  const detector = new UserIdleDetector({
    userIdleProvider: async () => {
      throw new Error('ioreg unavailable');
    },
  });
  const result = await detector.detect();
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'provider_error');
}

async function testFrontmostTransitionInterruptsOnce() {
  const appNames = ['Safari', 'Codex', 'Codex'];
  const triggers = [];
  const states = [];
  const monitor = new FrontmostAppMonitor({
    frontmostAppProvider: async () => appNames.shift(),
    onFrontmostState: async (state) => {
      states.push(state);
    },
    onCodexFrontmost: async (appName) => {
      triggers.push(appName);
    },
  });

  assert.equal((await monitor.pollOnce()).triggered, false);
  assert.equal((await monitor.pollOnce()).triggered, true);
  assert.equal((await monitor.pollOnce()).triggered, false);
  assert.deepEqual(triggers, ['Codex']);
  assert.deepEqual(states.map((state) => state.isCodex), [false, true, true]);
}

async function testNoFrontmostInterruptParseOption() {
  const options = parseArgs([
    '--no-frontmost-interrupt',
    '--frontmost-poll-ms',
    '2500',
    '--active-idle-ms',
    '30000',
    '--alert-volume',
    '2.5',
    '--duck-output-volume',
    '20',
    '--no-audio-ducking',
    '--no-spoken-completion',
  ]);
  assert.equal(options.frontmostInterrupt, false);
  assert.equal(options.frontmostPollMs, 2500);
  assert.equal(options.activeIdleMs, 30_000);
  assert.equal(options.alertVolume, 2.5);
  assert.equal(options.duckOutputVolume, 20);
  assert.equal(options.audioDucking, false);
  assert.equal(options.spokenCompletion, false);
}

async function testDiagnoseParseOption() {
  const options = parseArgs(['--diagnose']);
  assert.equal(options.diagnose, true);
}

async function testAudioEnhancementParseOptions() {
  const options = parseArgs([
    '--audio-ducking',
    '--spoken-attention',
    '--spoken-completion',
  ]);
  assert.equal(options.audioDucking, true);
  assert.equal(options.spokenAttention, true);
  assert.equal(options.spokenCompletion, true);
}

async function testSoundPlayerInterruptsActiveAttentionAudio() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-sound-interrupt-active-'));
  const previousLogPath = process.env.CODEX_SOUND_WATCHER_TEST_LOG;
  try {
    const script = await writeFakeAudioScript(dir);
    const logPath = join(dir, 'audio.log');
    process.env.CODEX_SOUND_WATCHER_TEST_LOG = logPath;

    const player = new SoundPlayer({
      afplayPath: script,
      sayPath: script,
      osascriptPath: script,
      attentionSound: 'attention.aiff',
      doneSound: 'done.aiff',
      playCount: 1,
      soundGapMs: 1,
      spokenAttention: false,
      spokenCompletion: false,
      audioDucking: false,
    });
    const alert = {
      kind: 'attention',
      reason: 'permission',
      threadTitle: 'Fixture Thread',
      threadId: 'thread-1',
      cancelKey: 'thread-1:call-permission',
    };

    const playPromise = player.play(alert);
    await waitForLogMatch(logPath, /start .*attention\.aiff/);
    player.interruptAttention('test frontmost');
    await playPromise;

    const logText = await readFile(logPath, 'utf8');
    assert.match(logText, /start .*attention\.aiff/);
    assert.match(logText, /terminated/);
    assert.doesNotMatch(logText, /done .*attention\.aiff/);
  } finally {
    if (previousLogPath === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_TEST_LOG;
    } else {
      process.env.CODEX_SOUND_WATCHER_TEST_LOG = previousLogPath;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function testSoundPlayerInterruptsActiveDoneAudio() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-sound-interrupt-active-done-'));
  const previousLogPath = process.env.CODEX_SOUND_WATCHER_TEST_LOG;
  const previousDoneMs = process.env.CODEX_SOUND_WATCHER_DONE_MS;
  try {
    const script = await writeFakeAudioScript(dir);
    const logPath = join(dir, 'audio.log');
    process.env.CODEX_SOUND_WATCHER_TEST_LOG = logPath;
    process.env.CODEX_SOUND_WATCHER_DONE_MS = '5000';

    const player = new SoundPlayer({
      afplayPath: script,
      sayPath: script,
      osascriptPath: script,
      attentionSound: 'attention.aiff',
      doneSound: 'done.aiff',
      playCount: 1,
      soundGapMs: 1,
      spokenAttention: false,
      spokenCompletion: false,
      audioDucking: false,
    });
    const alert = {
      kind: 'done',
      reason: 'task_complete',
      threadTitle: 'Done Thread',
      threadId: 'thread-done',
    };

    const playPromise = player.play(alert);
    await waitForLogMatch(logPath, /start .*done\.aiff/);
    player.interruptAudio('test active done');
    await playPromise;

    const logText = await readFile(logPath, 'utf8');
    assert.match(logText, /start .*done\.aiff/);
    assert.match(logText, /terminated/);
    assert.doesNotMatch(logText, /done .*done\.aiff/);
  } finally {
    if (previousLogPath === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_TEST_LOG;
    } else {
      process.env.CODEX_SOUND_WATCHER_TEST_LOG = previousLogPath;
    }
    if (previousDoneMs === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_DONE_MS;
    } else {
      process.env.CODEX_SOUND_WATCHER_DONE_MS = previousDoneMs;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function testSoundPlayerUsesAfplayVolumeOption() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-sound-volume-option-'));
  const previousLogPath = process.env.CODEX_SOUND_WATCHER_TEST_LOG;
  const previousAttentionMs = process.env.CODEX_SOUND_WATCHER_ATTENTION_MS;
  try {
    const script = await writeFakeAudioScript(dir);
    const logPath = join(dir, 'audio.log');
    process.env.CODEX_SOUND_WATCHER_TEST_LOG = logPath;
    process.env.CODEX_SOUND_WATCHER_ATTENTION_MS = '10';

    const player = new SoundPlayer({
      afplayPath: script,
      sayPath: script,
      osascriptPath: script,
      attentionSound: 'attention.aiff',
      doneSound: 'done.aiff',
      alertVolume: 2.5,
      playCount: 1,
      soundGapMs: 1,
      spokenAttention: false,
      spokenCompletion: false,
      audioDucking: false,
    });
    await player.play({
      kind: 'attention',
      reason: 'permission',
      threadTitle: 'Fixture Thread',
      threadId: 'thread-1',
      cancelKey: 'thread-1:call-permission',
    });

    const logText = await readFile(logPath, 'utf8');
    assert.match(logText, /start --volume 2\.5 attention\.aiff/);
  } finally {
    if (previousLogPath === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_TEST_LOG;
    } else {
      process.env.CODEX_SOUND_WATCHER_TEST_LOG = previousLogPath;
    }
    if (previousAttentionMs === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_ATTENTION_MS;
    } else {
      process.env.CODEX_SOUND_WATCHER_ATTENTION_MS = previousAttentionMs;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function testSoundPlayerDucksAndRestoresOutputVolume() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-sound-ducking-'));
  const previousLogPath = process.env.CODEX_SOUND_WATCHER_TEST_LOG;
  const previousDoneMs = process.env.CODEX_SOUND_WATCHER_DONE_MS;
  try {
    const script = await writeFakeAudioScript(dir);
    const logPath = join(dir, 'audio.log');
    const volumeChanges = [];
    process.env.CODEX_SOUND_WATCHER_TEST_LOG = logPath;
    process.env.CODEX_SOUND_WATCHER_DONE_MS = '10';

    const player = new SoundPlayer({
      afplayPath: script,
      sayPath: script,
      osascriptPath: script,
      attentionSound: 'attention.aiff',
      doneSound: 'done.aiff',
      playCount: 1,
      soundGapMs: 1,
      spokenAttention: false,
      spokenCompletion: false,
      audioDucking: true,
      outputVolumeProvider: async () => 80,
      outputVolumeSetter: async (volume) => {
        volumeChanges.push(volume);
      },
    });
    await player.play({
      kind: 'done',
      reason: 'task_complete',
      threadTitle: 'Done Thread',
      threadId: 'thread-done',
    });

    assert.deepEqual(volumeChanges, [25, 80]);
  } finally {
    if (previousLogPath === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_TEST_LOG;
    } else {
      process.env.CODEX_SOUND_WATCHER_TEST_LOG = previousLogPath;
    }
    if (previousDoneMs === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_DONE_MS;
    } else {
      process.env.CODEX_SOUND_WATCHER_DONE_MS = previousDoneMs;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function testSoundPlayerInterruptSkipsQueuedAttentionAudio() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-sound-interrupt-queued-'));
  const previousLogPath = process.env.CODEX_SOUND_WATCHER_TEST_LOG;
  const previousDoneMs = process.env.CODEX_SOUND_WATCHER_DONE_MS;
  try {
    const script = await writeFakeAudioScript(dir);
    const logPath = join(dir, 'audio.log');
    process.env.CODEX_SOUND_WATCHER_TEST_LOG = logPath;
    process.env.CODEX_SOUND_WATCHER_DONE_MS = '150';

    const player = new SoundPlayer({
      afplayPath: script,
      sayPath: script,
      osascriptPath: script,
      attentionSound: 'attention.aiff',
      doneSound: 'done.aiff',
      playCount: 1,
      soundGapMs: 1,
      spokenAttention: false,
      spokenCompletion: false,
      audioDucking: false,
    });
    const doneAlert = {
      kind: 'done',
      reason: 'task_complete',
      threadTitle: 'Done Thread',
      threadId: 'thread-done',
    };
    const attentionAlert = {
      kind: 'attention',
      reason: 'permission',
      threadTitle: 'Fixture Thread',
      threadId: 'thread-1',
      cancelKey: 'thread-1:call-permission',
    };

    const donePromise = player.play(doneAlert);
    const attentionPromise = player.play(attentionAlert);
    await waitForLogMatch(logPath, /start .*done\.aiff/);
    player.interruptAttention('test queued');
    await donePromise;
    await attentionPromise;

    const logText = await readFile(logPath, 'utf8');
    assert.match(logText, /start .*done\.aiff/);
    assert.doesNotMatch(logText, /start .*attention\.aiff/);
  } finally {
    if (previousLogPath === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_TEST_LOG;
    } else {
      process.env.CODEX_SOUND_WATCHER_TEST_LOG = previousLogPath;
    }
    if (previousDoneMs === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_DONE_MS;
    } else {
      process.env.CODEX_SOUND_WATCHER_DONE_MS = previousDoneMs;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function testSoundPlayerInterruptSkipsQueuedDoneAudio() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-sound-interrupt-queued-done-'));
  const previousLogPath = process.env.CODEX_SOUND_WATCHER_TEST_LOG;
  const previousAttentionMs = process.env.CODEX_SOUND_WATCHER_ATTENTION_MS;
  try {
    const script = await writeFakeAudioScript(dir);
    const logPath = join(dir, 'audio.log');
    process.env.CODEX_SOUND_WATCHER_TEST_LOG = logPath;
    process.env.CODEX_SOUND_WATCHER_ATTENTION_MS = '5000';

    const player = new SoundPlayer({
      afplayPath: script,
      sayPath: script,
      osascriptPath: script,
      attentionSound: 'attention.aiff',
      doneSound: 'done.aiff',
      playCount: 1,
      soundGapMs: 1,
      spokenAttention: false,
      spokenCompletion: false,
      audioDucking: false,
    });
    const attentionPromise = player.play({
      kind: 'attention',
      reason: 'permission',
      threadTitle: 'Attention Thread',
      threadId: 'thread-attention',
      cancelKey: 'thread-attention:call-permission',
    });
    const donePromise = player.play({
      kind: 'done',
      reason: 'task_complete',
      threadTitle: 'Done Thread',
      threadId: 'thread-done',
    });

    await waitForLogMatch(logPath, /start .*attention\.aiff/);
    player.interruptAudio('test queued done');
    await attentionPromise;
    await donePromise;

    const logText = await readFile(logPath, 'utf8');
    assert.match(logText, /start .*attention\.aiff/);
    assert.match(logText, /terminated/);
    assert.doesNotMatch(logText, /start .*done\.aiff/);
  } finally {
    if (previousLogPath === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_TEST_LOG;
    } else {
      process.env.CODEX_SOUND_WATCHER_TEST_LOG = previousLogPath;
    }
    if (previousAttentionMs === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_ATTENTION_MS;
    } else {
      process.env.CODEX_SOUND_WATCHER_ATTENTION_MS = previousAttentionMs;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function testSoundPlayerRepeatCanPlayAfterInterrupt() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-sound-interrupt-repeat-'));
  const previousLogPath = process.env.CODEX_SOUND_WATCHER_TEST_LOG;
  const previousAttentionMs = process.env.CODEX_SOUND_WATCHER_ATTENTION_MS;
  try {
    const script = await writeFakeAudioScript(dir);
    const logPath = join(dir, 'audio.log');
    process.env.CODEX_SOUND_WATCHER_TEST_LOG = logPath;
    process.env.CODEX_SOUND_WATCHER_ATTENTION_MS = '10';

    const player = new SoundPlayer({
      afplayPath: script,
      sayPath: script,
      osascriptPath: script,
      attentionSound: 'attention.aiff',
      doneSound: 'done.aiff',
      playCount: 1,
      soundGapMs: 1,
      spokenAttention: false,
      spokenCompletion: false,
      audioDucking: false,
    });
    const alert = {
      kind: 'attention',
      reason: 'permission_repeat',
      threadTitle: 'Fixture Thread',
      threadId: 'thread-1',
      cancelKey: 'thread-1:call-permission',
    };

    player.interruptAttention('test before repeat');
    await player.play(alert);

    const logText = await readFile(logPath, 'utf8');
    assert.match(logText, /start .*attention\.aiff/);
    assert.match(logText, /done .*attention\.aiff/);
  } finally {
    if (previousLogPath === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_TEST_LOG;
    } else {
      process.env.CODEX_SOUND_WATCHER_TEST_LOG = previousLogPath;
    }
    if (previousAttentionMs === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_ATTENTION_MS;
    } else {
      process.env.CODEX_SOUND_WATCHER_ATTENTION_MS = previousAttentionMs;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function testSoundPlayerThreadInterruptsOnlyMatchingActiveAudio() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-sound-thread-interrupt-active-'));
  const previousLogPath = process.env.CODEX_SOUND_WATCHER_TEST_LOG;
  try {
    const script = await writeFakeAudioScript(dir);
    const logPath = join(dir, 'audio.log');
    process.env.CODEX_SOUND_WATCHER_TEST_LOG = logPath;

    const player = new SoundPlayer({
      afplayPath: script,
      sayPath: script,
      osascriptPath: script,
      attentionSound: 'attention.aiff',
      doneSound: 'done.aiff',
      playCount: 1,
      soundGapMs: 1,
      spokenAttention: false,
      spokenCompletion: false,
      audioDucking: false,
    });
    const alert = {
      kind: 'attention',
      reason: 'permission',
      threadTitle: 'Fixture Thread',
      threadId: 'thread-1',
      cancelKey: 'thread-1:call-permission',
    };

    const playPromise = player.play(alert);
    await waitForLogMatch(logPath, /start .*attention\.aiff/);
    player.interruptAttentionForThread('thread-1', 'test active thread');
    await playPromise;

    const logText = await readFile(logPath, 'utf8');
    assert.match(logText, /terminated/);
    assert.doesNotMatch(logText, /done .*attention\.aiff/);
  } finally {
    if (previousLogPath === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_TEST_LOG;
    } else {
      process.env.CODEX_SOUND_WATCHER_TEST_LOG = previousLogPath;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function testSoundPlayerThreadInterruptDoesNotKillDifferentActiveAudio() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-sound-thread-interrupt-other-active-'));
  const previousLogPath = process.env.CODEX_SOUND_WATCHER_TEST_LOG;
  const previousAttentionMs = process.env.CODEX_SOUND_WATCHER_ATTENTION_MS;
  try {
    const script = await writeFakeAudioScript(dir);
    const logPath = join(dir, 'audio.log');
    process.env.CODEX_SOUND_WATCHER_TEST_LOG = logPath;
    process.env.CODEX_SOUND_WATCHER_ATTENTION_MS = '20';

    const player = new SoundPlayer({
      afplayPath: script,
      sayPath: script,
      osascriptPath: script,
      attentionSound: 'attention.aiff',
      doneSound: 'done.aiff',
      playCount: 1,
      soundGapMs: 1,
      spokenAttention: false,
      spokenCompletion: false,
      audioDucking: false,
    });
    const alert = {
      kind: 'attention',
      reason: 'permission',
      threadTitle: 'Other Thread',
      threadId: 'thread-2',
      cancelKey: 'thread-2:call-permission',
    };

    const playPromise = player.play(alert);
    await waitForLogMatch(logPath, /start .*attention\.aiff/);
    player.interruptAttentionForThread('thread-1', 'test different thread');
    await playPromise;

    const logText = await readFile(logPath, 'utf8');
    assert.doesNotMatch(logText, /terminated/);
    assert.match(logText, /done .*attention\.aiff/);
  } finally {
    if (previousLogPath === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_TEST_LOG;
    } else {
      process.env.CODEX_SOUND_WATCHER_TEST_LOG = previousLogPath;
    }
    if (previousAttentionMs === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_ATTENTION_MS;
    } else {
      process.env.CODEX_SOUND_WATCHER_ATTENTION_MS = previousAttentionMs;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function testSoundPlayerThreadInterruptSkipsOnlyMatchingQueuedAudio() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-sound-thread-interrupt-queued-'));
  const previousLogPath = process.env.CODEX_SOUND_WATCHER_TEST_LOG;
  const previousDoneMs = process.env.CODEX_SOUND_WATCHER_DONE_MS;
  const previousAttentionMs = process.env.CODEX_SOUND_WATCHER_ATTENTION_MS;
  try {
    const script = await writeFakeAudioScript(dir);
    const logPath = join(dir, 'audio.log');
    process.env.CODEX_SOUND_WATCHER_TEST_LOG = logPath;
    process.env.CODEX_SOUND_WATCHER_DONE_MS = '120';
    process.env.CODEX_SOUND_WATCHER_ATTENTION_MS = '10';

    const player = new SoundPlayer({
      afplayPath: script,
      sayPath: script,
      osascriptPath: script,
      attentionSound: 'attention.aiff',
      doneSound: 'done.aiff',
      playCount: 1,
      soundGapMs: 1,
      spokenAttention: false,
      spokenCompletion: false,
      audioDucking: false,
    });
    const donePromise = player.play({
      kind: 'done',
      reason: 'task_complete',
      threadTitle: 'Done Thread',
      threadId: 'thread-done',
    });
    const matchingPromise = player.play({
      kind: 'attention',
      reason: 'permission',
      threadTitle: 'Fixture Thread',
      threadId: 'thread-1',
      cancelKey: 'thread-1:call-permission',
    });
    const otherPromise = player.play({
      kind: 'attention',
      reason: 'permission',
      threadTitle: 'Other Thread',
      threadId: 'thread-2',
      cancelKey: 'thread-2:call-permission',
    });

    await waitForLogMatch(logPath, /start .*done\.aiff/);
    player.interruptAttentionForThread('thread-1', 'test queued thread');
    await donePromise;
    await matchingPromise;
    await otherPromise;

    const logText = await readFile(logPath, 'utf8');
    assert.match(logText, /start .*done\.aiff/);
    assert.equal((logText.match(/start .*attention\.aiff/g) || []).length, 1);
    assert.match(logText, /done .*attention\.aiff/);
  } finally {
    if (previousLogPath === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_TEST_LOG;
    } else {
      process.env.CODEX_SOUND_WATCHER_TEST_LOG = previousLogPath;
    }
    if (previousDoneMs === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_DONE_MS;
    } else {
      process.env.CODEX_SOUND_WATCHER_DONE_MS = previousDoneMs;
    }
    if (previousAttentionMs === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_ATTENTION_MS;
    } else {
      process.env.CODEX_SOUND_WATCHER_ATTENTION_MS = previousAttentionMs;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function testSoundPlayerThreadRepeatCanPlayAfterInterrupt() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-sound-thread-interrupt-repeat-'));
  const previousLogPath = process.env.CODEX_SOUND_WATCHER_TEST_LOG;
  const previousAttentionMs = process.env.CODEX_SOUND_WATCHER_ATTENTION_MS;
  try {
    const script = await writeFakeAudioScript(dir);
    const logPath = join(dir, 'audio.log');
    process.env.CODEX_SOUND_WATCHER_TEST_LOG = logPath;
    process.env.CODEX_SOUND_WATCHER_ATTENTION_MS = '10';

    const player = new SoundPlayer({
      afplayPath: script,
      sayPath: script,
      osascriptPath: script,
      attentionSound: 'attention.aiff',
      doneSound: 'done.aiff',
      playCount: 1,
      soundGapMs: 1,
      spokenAttention: false,
      spokenCompletion: false,
      audioDucking: false,
    });
    player.interruptAttentionForThread('thread-1', 'test before repeat');
    await player.play({
      kind: 'attention',
      reason: 'permission_repeat',
      threadTitle: 'Fixture Thread',
      threadId: 'thread-1',
      cancelKey: 'thread-1:call-permission',
    });

    const logText = await readFile(logPath, 'utf8');
    assert.match(logText, /start .*attention\.aiff/);
    assert.match(logText, /done .*attention\.aiff/);
  } finally {
    if (previousLogPath === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_TEST_LOG;
    } else {
      process.env.CODEX_SOUND_WATCHER_TEST_LOG = previousLogPath;
    }
    if (previousAttentionMs === undefined) {
      delete process.env.CODEX_SOUND_WATCHER_ATTENTION_MS;
    } else {
      process.env.CODEX_SOUND_WATCHER_ATTENTION_MS = previousAttentionMs;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function makeRecordingWatcher(options = {}) {
  const watcher = new CodexSoundWatcher({
    stateDb: '/dev/null',
    ...options,
  });
  const threads = options.threads || [{ ...THREAD, firstUserMessage: THREAD.title }];
  watcher.followers.clear();
  for (const thread of threads) {
    watcher.followers.set(thread.id, { thread, follower: null });
  }
  const played = [];
  const interrupted = [];
  watcher.player = {
    play(alert) {
      played.push(alert);
    },
    cancel() {},
    interruptAttention(reason) {
      interrupted.push(reason);
    },
    interruptAudio(reason) {
      interrupted.push(reason);
    },
    interruptAttentionForThread(threadId, reason) {
      interrupted.push({ threadId, reason });
    },
  };
  return { watcher, played, interrupted };
}

async function testWatcherSuppressesAttentionWhenCodexIsActive() {
  const { watcher, played } = makeRecordingWatcher({
    userIdleProvider: async () => hidIdleOutput(1_000),
  });
  await watcher.handleFrontmostState({ appName: 'Codex', isCodex: true });
  await watcher.playOrSuppress({
    kind: 'attention',
    reason: 'permission',
    threadTitle: 'Fixture Thread',
    threadId: 'thread-1',
    cancelKey: 'thread-1:call-permission',
  });
  assert.equal(played.length, 0);
}

async function testWatcherPlaysAttentionWhenCodexIsIdle() {
  const { watcher, played } = makeRecordingWatcher({
    userIdleProvider: async () => hidIdleOutput(120_000),
  });
  await watcher.handleFrontmostState({ appName: 'Codex', isCodex: true });
  await watcher.playOrSuppress({
    kind: 'attention',
    reason: 'permission',
    threadTitle: 'Fixture Thread',
    threadId: 'thread-1',
    cancelKey: 'thread-1:call-permission',
  });
  assert.equal(played.length, 1);
}

async function testWatcherPlaysAttentionWhenCodexIdleIsUnknown() {
  const { watcher, played } = makeRecordingWatcher({
    userIdleProvider: async () => 'no idle data',
  });
  await watcher.handleFrontmostState({ appName: 'Codex', isCodex: true });
  await watcher.playOrSuppress({
    kind: 'attention',
    reason: 'permission',
    threadTitle: 'Fixture Thread',
    threadId: 'thread-1',
    cancelKey: 'thread-1:call-permission',
  });
  assert.equal(played.length, 1);
}

async function testWatcherSuppressesRepeatWithoutClearingPendingAttention() {
  const { watcher, played } = makeRecordingWatcher({
    repeatMs: 100,
    activeIdleMs: 1_000,
    userIdleProvider: async () => hidIdleOutput(1_000),
  });
  await watcher.handleFrontmostState({ appName: 'Codex', isCodex: true });

  watcher.engine.processEvent(THREAD, eventMsg('task_started'), 1_000);
  const alerts = watcher.engine.processEvent(
    THREAD,
    functionCall('request_user_input', { questions: [] }, 'call-question'),
    1_010,
  );
  assert.equal(alerts.length, 1);
  await watcher.playOrSuppress(alerts[0]);
  assert.equal(played.length, 0);
  assert.equal(watcher.engine.getState(THREAD.id).pendingAttention.size, 1);

  const repeats = watcher.engine.collectRepeatAlerts(Date.now());
  assert.equal(repeats.length, 1);
  await watcher.playOrSuppress(repeats[0]);
  assert.equal(played.length, 0);
  assert.equal(watcher.engine.getState(THREAD.id).pendingAttention.size, 1);
}

async function testWatcherPlaysAttentionWhenNotFrontmost() {
  const { watcher, played } = makeRecordingWatcher();
  watcher.handleFrontmostState({ appName: 'Safari', isCodex: false });
  await watcher.playOrSuppress({
    kind: 'attention',
    reason: 'permission',
    threadTitle: 'Fixture Thread',
    threadId: 'thread-1',
    cancelKey: 'thread-1:call-permission',
  });
  assert.equal(played.length, 1);
}

async function testWatcherSuppressesAttentionForDifferentActiveThreadWhenCodexIsActive() {
  const { watcher, played } = makeRecordingWatcher({
    threads: [
      { ...THREAD, firstUserMessage: THREAD.title },
      { id: 'thread-2', title: 'Different Thread', firstUserMessage: 'Different Thread' },
    ],
    activeChatProvider: async () => activeRows('Different Thread'),
    userIdleProvider: async () => hidIdleOutput(1_000),
  });
  await watcher.handleFrontmostState({ appName: 'Codex', isCodex: true });
  await watcher.playOrSuppress({
    kind: 'attention',
    reason: 'permission',
    threadTitle: 'Fixture Thread',
    threadId: 'thread-1',
    cancelKey: 'thread-1:call-permission',
  });
  assert.equal(played.length, 0);
}

async function testWatcherSuppressesAttentionWhenActiveThreadUnknownButCodexIsActive() {
  const { watcher, played } = makeRecordingWatcher({
    activeChatProvider: async () => [{ label: 'Fixture Thread', classList: INACTIVE_ROW_CLASS }],
    userIdleProvider: async () => hidIdleOutput(1_000),
  });
  await watcher.handleFrontmostState({ appName: 'Codex', isCodex: true });
  await watcher.playOrSuppress({
    kind: 'attention',
    reason: 'permission',
    threadTitle: 'Fixture Thread',
    threadId: 'thread-1',
    cancelKey: 'thread-1:call-permission',
  });
  assert.equal(played.length, 0);
}

async function testWatcherSuppressesCompletionWhenCodexIsActive() {
  const { watcher, played } = makeRecordingWatcher({
    activeChatProvider: async () => activeRows('Fixture Thread'),
    userIdleProvider: async () => hidIdleOutput(1_000),
  });
  await watcher.handleFrontmostState({ appName: 'Codex', isCodex: true });
  await watcher.playOrSuppress({
    kind: 'done',
    reason: 'task_complete',
    threadTitle: 'Fixture Thread',
    threadId: 'thread-1',
  });
  assert.equal(played.length, 0);
}

async function testWatcherPlaysCompletionWhenCodexIsIdle() {
  const { watcher, played } = makeRecordingWatcher({
    userIdleProvider: async () => hidIdleOutput(120_000),
  });
  await watcher.handleFrontmostState({ appName: 'Codex', isCodex: true });
  await watcher.playOrSuppress({
    kind: 'done',
    reason: 'task_complete',
    threadTitle: 'Fixture Thread',
    threadId: 'thread-1',
  });
  assert.equal(played.length, 1);
}

async function testWatcherPlaysCompletionWhenNotFrontmost() {
  const { watcher, played } = makeRecordingWatcher();
  await watcher.handleFrontmostState({ appName: 'Safari', isCodex: false });
  await watcher.playOrSuppress({
    kind: 'done',
    reason: 'task_complete',
    threadTitle: 'Fixture Thread',
    threadId: 'thread-1',
  });
  assert.equal(played.length, 1);
}

async function testNoFrontmostInterruptDisablesSuppression() {
  const { watcher, played } = makeRecordingWatcher({ frontmostInterrupt: false });
  assert.equal(watcher.frontmostMonitor, null);
  assert.equal(watcher.activeChatDetector, null);
  assert.equal(watcher.userIdleDetector, null);
  await watcher.playOrSuppress({
    kind: 'attention',
    reason: 'permission',
    threadTitle: 'Fixture Thread',
    threadId: 'thread-1',
    cancelKey: 'thread-1:call-permission',
  });
  assert.equal(played.length, 1);
}

async function testWatcherInterruptsAllAudioOnFrontmostTransitionWhenActive() {
  const { watcher, interrupted } = makeRecordingWatcher({
    userIdleProvider: async () => hidIdleOutput(1_000),
  });
  await watcher.handleCodexFrontmost('Codex');
  assert.deepEqual(interrupted, ['Codex frontmost: Codex']);
}

async function testWatcherDoesNotInterruptOnFrontmostTransitionWhenIdle() {
  const { watcher, interrupted } = makeRecordingWatcher({
    userIdleProvider: async () => hidIdleOutput(120_000),
  });
  await watcher.handleCodexFrontmost('Codex');
  assert.deepEqual(interrupted, []);
}

async function testWatcherInterruptsAllAudioWhenUserReturnsFromIdleInCodex() {
  const idleOutputs = [hidIdleOutput(120_000), hidIdleOutput(1_000)];
  const { watcher, interrupted } = makeRecordingWatcher({
    userIdleProvider: async () => idleOutputs.shift() || hidIdleOutput(1_000),
  });
  await watcher.handleFrontmostState({ appName: 'Codex', isCodex: true });
  assert.deepEqual(interrupted, []);
  await watcher.handleFrontmostState({ appName: 'Codex', isCodex: true });
  assert.deepEqual(interrupted, ['Codex user active: Codex']);
}

async function testFinalQuestionAttention() {
  assert.equal(finalAnswerNeedsAnswer('Do you want me to continue?'), true);
  assert.equal(finalAnswerNeedsAnswer('<proposed_plan>\nDone?\n</proposed_plan>'), false);
  const { alerts } = runEvents([
    eventMsg('task_started'),
    finalMessage('Which option should I use?'),
  ]);
  assertAlert(alerts, 'attention', 'final_question');
}

async function testOldEventsIgnoredByFollowerStartup() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-sound-watcher-'));
  try {
    const file = join(dir, 'session.jsonl');
    await writeFile(file, `${JSON.stringify(eventMsg('task_complete'))}\n`, 'utf8');
    const follower = new SessionFileFollower(file, { startAtEnd: true });
    assert.deepEqual(await follower.readNewEvents(), []);
    await appendFile(file, `${JSON.stringify(eventMsg('task_started'))}\n`, 'utf8');
    const events = await follower.readNewEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.type, 'task_started');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const tests = [
  testNormalCompletion,
  testPlanCompletion,
  testRequestUserInputAttention,
  testEscalatedPermissionAttention,
  testPluginPermissionAttention,
  testDuplicateEventsDoNotReplay,
  testAttentionRepeatsUntilCleared,
  testAutoApprovedEscalatedPermissionDoesNotAlert,
  testApprovedPrefixRuleSuppressesEscalatedPermissionAlert,
  testRuleBypassSyntaxStillAlertsEscalatedPermission,
  testSuppressedAttentionRetryUsesIdleThreshold,
  testClearActionOnFunctionOutput,
  testUserMessageClearsAllAttentionAudio,
  testSoundPlayerCancelsActiveAttentionAudio,
  testSoundPlayerDefaultsToSinglePlay,
  testActiveChatDetectorExactMatch,
  testActiveChatDetectorConservativeTokenMatch,
  testActiveChatDetectorDuplicateExactMatchIsUnknown,
  testActiveChatDetectorGenericLabelIsUnknown,
  testActiveChatDetectorProviderFailureIsUnknown,
  testActiveChatDetectorNoHighlightedRowIsUnknown,
  testUserIdleDetectorParsesHidIdleTime,
  testUserIdleDetectorMissingValueIsUnknown,
  testUserIdleDetectorMalformedValueIsUnknown,
  testUserIdleDetectorProviderFailureIsUnknown,
  testFrontmostTransitionInterruptsOnce,
  testNoFrontmostInterruptParseOption,
  testDiagnoseParseOption,
  testAudioEnhancementParseOptions,
  testSoundPlayerInterruptsActiveAttentionAudio,
  testSoundPlayerInterruptsActiveDoneAudio,
  testSoundPlayerUsesAfplayVolumeOption,
  testSoundPlayerDucksAndRestoresOutputVolume,
  testSoundPlayerInterruptSkipsQueuedAttentionAudio,
  testSoundPlayerInterruptSkipsQueuedDoneAudio,
  testSoundPlayerRepeatCanPlayAfterInterrupt,
  testSoundPlayerThreadInterruptsOnlyMatchingActiveAudio,
  testSoundPlayerThreadInterruptDoesNotKillDifferentActiveAudio,
  testSoundPlayerThreadInterruptSkipsOnlyMatchingQueuedAudio,
  testSoundPlayerThreadRepeatCanPlayAfterInterrupt,
  testWatcherSuppressesAttentionWhenCodexIsActive,
  testWatcherPlaysAttentionWhenCodexIsIdle,
  testWatcherPlaysAttentionWhenCodexIdleIsUnknown,
  testWatcherSuppressesRepeatWithoutClearingPendingAttention,
  testWatcherPlaysAttentionWhenNotFrontmost,
  testWatcherSuppressesAttentionForDifferentActiveThreadWhenCodexIsActive,
  testWatcherSuppressesAttentionWhenActiveThreadUnknownButCodexIsActive,
  testWatcherSuppressesCompletionWhenCodexIsActive,
  testWatcherPlaysCompletionWhenCodexIsIdle,
  testWatcherPlaysCompletionWhenNotFrontmost,
  testNoFrontmostInterruptDisablesSuppression,
  testWatcherInterruptsAllAudioOnFrontmostTransitionWhenActive,
  testWatcherDoesNotInterruptOnFrontmostTransitionWhenIdle,
  testWatcherInterruptsAllAudioWhenUserReturnsFromIdleInCodex,
  testFinalQuestionAttention,
  testOldEventsIgnoredByFollowerStartup,
];

for (const test of tests) {
  await test();
  console.log(`ok ${test.name}`);
}
