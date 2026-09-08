import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  appendActivityEvent,
  readActivityEvents,
  ALLOWED_PHASES,
  REJECTED_FIELDS,
} from '../../skills/delegate-to-antigravity/scripts/lib/activity.mjs';

async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agy-act-test-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

test('phase allowlist accepts valid phases and rejects invalid ones', async () => {
  await withTempDir(async (jobDir) => {
    for (const phase of ALLOWED_PHASES) {
      const res = await appendActivityEvent(jobDir, { phase, message: `phase ${phase}` });
      assert.equal(res.phase, phase);
    }
    const events = await readActivityEvents(jobDir);
    assert.equal(events.length, ALLOWED_PHASES.size);

    await assert.rejects(
      () => appendActivityEvent(jobDir, { phase: 'invalid_phase' }),
      /Invalid or missing activity phase/
    );
    await assert.rejects(
      () => appendActivityEvent(jobDir, {}),
      /Invalid or missing activity phase/
    );
  });
});

test('explicitly rejects prohibited fields', async () => {
  await withTempDir(async (jobDir) => {
    for (const field of REJECTED_FIELDS) {
      await assert.rejects(
        () => appendActivityEvent(jobDir, { phase: 'running', [field]: 'forbidden' }),
        new RegExp(`Prohibited field in activity event: "${field}"`, 'i')
      );
    }
    await assert.rejects(
      () => appendActivityEvent(jobDir, { phase: 'running', extraProp: 123 }),
      /Unknown field in activity event/
    );
  });
});

test('normalizes control chars and caps string fields and file arrays', async () => {
  await withTempDir(async (jobDir) => {
    const longMessage = 'm'.repeat(300);
    const longTool = 't'.repeat(100);
    const longFile = 'f'.repeat(300);
    const filesList = Array.from({ length: 30 }, (_, i) => `file_${i}_${longFile}`);

    const res = await appendActivityEvent(jobDir, {
      phase: 'running',
      message: `hello\x00\x1fworld\r\n` + longMessage,
      tool: `run\t` + longTool,
      files: filesList,
      elapsedMs: 12.8,
    });

    assert.equal(res.message.length, 240);
    assert.match(res.message, /^hello world/);
    assert.doesNotMatch(res.message, /[\x00-\x1F]/);
    assert.equal(res.tool.length, 80);
    assert.equal(res.files.length, 20);
    assert.equal(res.files[0].length, 260);
    assert.equal(res.elapsedMs, 13);
  });
});

test('validates usage strictly to numeric input/output/total tokens', async () => {
  await withTempDir(async (jobDir) => {
    const valid = await appendActivityEvent(jobDir, {
      phase: 'running',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
    assert.deepEqual(valid.usage, { inputTokens: 100, outputTokens: 50, totalTokens: 150 });

    await assert.rejects(
      () => appendActivityEvent(jobDir, { phase: 'running', usage: { extra: 10 } }),
      /Prohibited usage key/
    );
    await assert.rejects(
      () => appendActivityEvent(jobDir, { phase: 'running', usage: { inputTokens: '100' } }),
      /Usage field "inputTokens" must be a non-negative number/
    );
    await assert.rejects(
      () => appendActivityEvent(jobDir, { phase: 'running', usage: { inputTokens: -5 } }),
      /Usage field "inputTokens" must be a non-negative number/
    );
  });
});

test('rejects append when jobDir does not exist', async () => {
  const nonExistent = path.join(os.tmpdir(), 'agy-non-existent-dir-' + Date.now());
  await assert.rejects(
    () => appendActivityEvent(nonExistent, { phase: 'running' }),
    /jobDir must be an existing directory|ENOENT/
  );
});

test('serializes concurrent append operations per path', async () => {
  await withTempDir(async (jobDir) => {
    const count = 25;
    const ops = Array.from({ length: count }, (_, i) =>
      appendActivityEvent(jobDir, { phase: 'running', message: `msg-${i}`, elapsedMs: i })
    );
    await Promise.all(ops);

    const events = await readActivityEvents(jobDir);
    assert.equal(events.length, count);
    const messages = new Set(events.map((e) => e.message));
    assert.equal(messages.size, count);
  });
});

test('bounded read returns newest max100 events and handles non-existent file', async () => {
  await withTempDir(async (jobDir) => {
    const empty = await readActivityEvents(jobDir);
    assert.deepEqual(empty, []);

    for (let i = 0; i < 115; i++) {
      await appendActivityEvent(jobDir, { phase: 'running', message: `event-${i}` });
    }

    const events = await readActivityEvents(jobDir);
    assert.equal(events.length, 100);
    assert.equal(events[0].message, 'event-15');
    assert.equal(events[99].message, 'event-114');
  });
});

test('read tolerates one truncated final line but rejects malformed earlier lines', async () => {
  await withTempDir(async (jobDir) => {
    const filePath = path.join(jobDir, 'activity.jsonl');

    // 1. Truncated final line
    await fsp.writeFile(
      filePath,
      JSON.stringify({ phase: 'accepted', timestamp: new Date().toISOString() }) +
        '\n{"phase":"runn'
    );
    const read1 = await readActivityEvents(jobDir);
    assert.equal(read1.length, 1);
    assert.equal(read1[0].phase, 'accepted');
    assert.equal(read1.truncatedTail, '{"phase":"runn');

    // 2. Malformed earlier line
    await fsp.writeFile(
      filePath,
      '{"phase":"accepted"}\n{invalid_json}\n{"phase":"completed"}\n'
    );
    await assert.rejects(
      () => readActivityEvents(jobDir),
      /Malformed activity event JSON at line 2/
    );
  });
});

test('rejects case-insensitive forbidden fields', async () => {
  await withTempDir(async (jobDir) => {
    for (const key of ['CHAINOFTHOUGHT', 'chainofthought', 'THINKING', 'Secret', 'Prompt']) {
      await assert.rejects(
        () => appendActivityEvent(jobDir, { phase: 'running', [key]: 'x' }),
        new RegExp(`Prohibited field in activity event: "${key}"`, 'i')
      );
    }
  });
});

test('strictly normalizes timestamps to canonical ISO', async () => {
  await withTempDir(async (jobDir) => {
    const epoch = 1700000000000;
    const res = await appendActivityEvent(jobDir, { phase: 'running', timestamp: epoch });
    assert.equal(res.timestamp, new Date(epoch).toISOString());
    const iso = '2026-09-09T00:00:00.000Z';
    const res2 = await appendActivityEvent(jobDir, { phase: 'running', timestamp: iso });
    assert.equal(res2.timestamp, iso);
    for (const bad of ['bad-date', NaN, null, false, '']) {
      await assert.rejects(() => appendActivityEvent(jobDir, { phase: 'running', timestamp: bad }), TypeError);
    }
  });
});

test('confines activity.jsonl to jobDir ignoring custom file options', async () => {
  await withTempDir(async (jobDir) => {
    const custom = path.join(jobDir, 'custom.jsonl');
    await appendActivityEvent(jobDir, { phase: 'running' }, { filePath: custom, filename: 'custom.jsonl' });
    assert.equal(await fsp.stat(path.join(jobDir, 'activity.jsonl')).then(() => true, () => false), true);
    assert.equal(await fsp.stat(custom).then(() => true, () => false), false);
    const read = await readActivityEvents(jobDir, { filePath: custom });
    assert.equal(read.length, 1);
  });
});

test('revalidates and sanitizes parsed events on read', async () => {
  await withTempDir(async (jobDir) => {
    const filePath = path.join(jobDir, 'activity.jsonl');
    await fsp.writeFile(filePath, '{"phase":"running","thinking":"leaked"}\n');
    await assert.rejects(() => readActivityEvents(jobDir), /Prohibited field in activity event/);
    await fsp.writeFile(filePath, '{"phase":"not_a_phase"}\n');
    await assert.rejects(() => readActivityEvents(jobDir), /Invalid or missing activity phase/);
    await fsp.writeFile(filePath, JSON.stringify({ phase: 'running', message: 'hi\x00world' }) + '\n');
    const sanitized = await readActivityEvents(jobDir);
    assert.equal(sanitized[0].message, 'hi world');
  });
});