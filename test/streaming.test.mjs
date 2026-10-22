import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelLane } from '../src/captions/model-lane.js';
import { IncrementalAsr, agreedPrefix, restorePrefix } from '../src/captions/incremental-asr.js';
import { SentenceBuffer, composeSources, sentenceCut } from '../src/captions/sentences.js';
import { createApp } from '../src/server.js';
import { translations } from '../src/providers/openai-compatible.js';
import { CaptionRuntime } from '../public/runtime.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let n = 0; n < 300; n++) { if (await fn()) return; await sleep(5); } throw new Error('condition not reached'); }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const trio = (text, complete = true) => ({ zhHans: text, en: text, yue: text, complete });
const frame = (value = 2200) => Buffer.from(new Int16Array(1600).fill(value).buffer);
const result = (id, raw, final = false, cutReason = null) => ({ id, raw, final, cutReason, revision: 1, startMs: 0, endMs: 1000 });
function sentences(t, extra = {}) {
  const captions = [], calls = [];
  const buffer = new SentenceBuffer({ captions, lane: new ModelLane(), partialMs: 0,
    translate: async (raw, prior, options) => { calls.push({ raw, prior, options }); return trio(raw, !/we’re\.?$|正式发。?$/.test(raw)); }, ...extra });
  buffer.voice(Date.now()); t.after(() => buffer.close());
  return { buffer, captions, calls };
}

test('provider lane skips busy provisional passes, cancels one for finals, and stays serial', async () => {
  const lane = new ModelLane(), gate = deferred(); let active = 0, max = 0, cancelled = false;
  const partial = lane.run(async signal => { active++; max = Math.max(max, active); signal.addEventListener('abort', () => { cancelled = true; }); await gate.promise; active--; return 'old'; });
  await sleep(0);
  assert.equal(lane.run(() => 'skipped'), null);
  const final = lane.run(async () => { active++; max = Math.max(max, active); active--; return 'final'; }, { final: true });
  assert.equal(cancelled, true); gate.resolve();
  assert.equal(await partial, 'old'); assert.equal(await final, 'final'); assert.equal(max, 1);
});

test('local agreement preserves original CJK, Cantonese and Latin spacing', () => {
  for (const [a, b, prefix] of [
    ['十五萬港元仲未批。', '十五萬港元仲未批，要等驗收。', '十五萬港元仲未批'],
    ['正式发', '正式发布要等审批。', '正式'],
    ['We are still', 'We are still reviewing it.', 'We are still'],
    ['Friday 先交預覽', 'Friday 先交預覽，日期未定。', 'Friday 先交預覽'],
  ]) assert.equal(agreedPrefix(a, b), prefix);
});

test('final ASR can retain a dropped earlier prefix only across a substantial matching suffix', () => {
  assert.equal(restorePrefix('负责人下周再定。the budget is still', 'the budget is still pending approval.'), '负责人下周再定。the budget is still pending approval.');
  assert.equal(restorePrefix('Maybe the budget is still pending approval.', 'the budget is still pending approval.'), 'Maybe the budget is still pending approval.');
  assert.equal(restorePrefix('The budget is approved.', 'The budget is not approved.'), 'The budget is not approved.');
  assert.equal(restorePrefix('错误短语 yes', 'yes'), 'yes');
});

test('ASR emits provisional updates during speech and a final pass after a 700ms pause', async t => {
  const outputs = [], calls = [];
  const engine = new IncrementalAsr({ lane: new ModelLane(), onResult: r => outputs.push(r),
    recognize: async pcm => { calls.push(pcm.length / 32); return pcm.length > 64000 ? '预算尚未批准，要等验收。' : '预算尚未批准。'; } });
  t.after(() => engine.close());
  for (let n = 0; n < 40; n++) { engine.feed(frame(), n * 100); await sleep(0); }
  assert.ok(outputs.length >= 2); assert.ok(outputs.every(r => !r.final)); assert.ok(outputs.some(r => r.stable));
  for (let n = 0; n < 7; n++) engine.feed(frame(0), 4000 + n * 100);
  await engine.drain();
  assert.equal(outputs.at(-1).final, true); assert.equal(outputs.at(-1).cutReason, 'pause');
  assert.equal(outputs.at(-1).raw, '预算尚未批准，要等验收。'); assert.equal(new Set(outputs.map(r => r.id)).size, 1);
  assert.ok(calls[0] >= 1000); assert.equal(engine.metrics.finals, 1);
});

test('server VAD keeps 300ms pre-roll, ignores 20s silence, and trims excessive trailing silence', async t => {
  const outputs = [], sizes = [];
  const engine = new IncrementalAsr({ lane: new ModelLane(), onResult: r => outputs.push(r), recognize: async pcm => { sizes.push(pcm.length); return '谢谢。'; } });
  t.after(() => engine.close());
  for (let n = 0; n < 200; n++) engine.feed(frame(0), n * 100);
  assert.equal(engine.metrics.requests, 0); assert.equal(engine.processing, false);
  for (let n = 0; n < 4; n++) engine.feed(frame(), 20000 + n * 100);
  for (let n = 0; n < 7; n++) engine.feed(frame(0), 20400 + n * 100);
  await engine.drain();
  assert.equal(outputs.at(-1).startMs, 19700); assert.equal(sizes.at(-1), 10 * 3200);
});

test('12s monologue cut uses a quiet boundary and final audio has no missing or overlapping frames', async t => {
  const finals = [], inputs = [];
  const engine = new IncrementalAsr({ lane: new ModelLane(), onResult: () => {}, recognize: async pcm => { finals.push(pcm); return '连续讲话。'; } });
  t.after(() => engine.close());
  // No event-loop yield: intermediate passes are cancelled before starting; only finals reach the model.
  for (let n = 0; n < 130; n++) {
    const value = n === 100 ? 1000 : 3000 + n;
    const data = frame(value); inputs.push(data); engine.feed(data, n * 100);
  }
  await engine.drain();
  assert.equal(finals.length, 2); assert.equal(finals[0].length, 101 * 3200);
  assert.deepEqual(Buffer.concat(finals), Buffer.concat(inputs));
});

test('ASR ignores a provisional response arriving after finalization and retains failed final audio for retry', async t => {
  const lane = new ModelLane(), gate = deferred(), outputs = []; let calls = 0, fail = true;
  const engine = new IncrementalAsr({ lane, onResult: r => outputs.push(r), recognize: async () => {
    calls++; if (calls === 1) { await gate.promise; return '旧临时结果'; }
    if (fail) throw new Error('temporary outage'); return '最终原文。';
  } }); t.after(() => engine.close());
  for (let n = 0; n < 12; n++) engine.feed(frame(), n * 100);
  await sleep(0); const draining = engine.drain(); gate.resolve();
  await assert.rejects(draining, /outage/); assert.equal(outputs.length, 0); assert.equal(engine.pendingFinals, 1);
  fail = false; await engine.retry(); assert.equal(outputs.length, 1); assert.equal(outputs[0].raw, '最终原文。');
});

test('language-switch prefix recovery requires confirmation from the earlier audio', async t => {
  for (const agrees of [true, false]) {
    let finalSeen = false; const outputs = [];
    const engine = new IncrementalAsr({ lane: new ModelLane(), onResult: r => outputs.push(r), recognize: async pcm => {
      if (pcm.length >= 4000 * 32) { finalSeen = true; return 'the budget is still pending approval.'; }
      return finalSeen && !agrees ? '不同的识别结果。' : '负责人下周再定。';
    } }); t.after(() => engine.close());
    for (let n = 0; n < 40; n++) { engine.feed(frame(), n * 100); await sleep(0); }
    await engine.drain();
    assert.equal(outputs.at(-1).raw, 'the budget is still pending approval.');
    assert.equal(outputs.at(-1).retainedPrefix, agrees);
    assert.equal(outputs.at(-1).text, agrees ? '负责人下周再定。 the budget is still pending approval.' : 'the budget is still pending approval.');
    assert.ok(outputs.at(-1).prefixCheck);
  }
});

test('cross-segment half words revise the same caption instead of appending two translations', async t => {
  const x = sentences(t);
  x.buffer.receive(result('u1', '周三先交预览，正式发。', true, 'limit'));
  await until(() => x.captions[0]?.translations); const id = x.captions[0].id;
  assert.equal(x.captions[0].final, false);
  x.buffer.receive(result('u2', '布要等审批。', true, 'pause'));
  await until(() => x.captions[0].final);
  assert.equal(x.captions.length, 1); assert.equal(x.captions[0].id, id);
  assert.equal(x.captions[0].raw, '周三先交预览，正式发布要等审批。');
  assert.equal(x.captions[0].translations.yue, x.captions[0].raw);
});

test('an incomplete sentence survives a short pause and is translated together with its continuation', async t => {
  const x = sentences(t);
  x.buffer.receive(result('u1', 'And we’re.', true, 'pause'));
  await until(() => x.captions[0]?.translations); assert.equal(x.captions[0].final, false);
  x.buffer.receive(result('u2', 'a global community.', true, 'pause'));
  await until(() => x.captions[0].final);
  assert.equal(x.captions[0].raw, 'And we’re a global community.'); assert.equal(x.captions.length, 1);
});

test('cumulative source replacements neither duplicate Chinese nor mutate a finalized caption', async t => {
  const x = sentences(t, { translate: async raw => trio(raw, false) });
  x.buffer.receive(result('u1', '十五万港元预算'));
  await until(() => x.captions[0]?.translations);
  x.buffer.receive({ ...result('u1', '十五万港元尚未批准。', true, 'pause'), revision: 2 });
  await x.buffer.flush(); const saved = structuredClone(x.captions[0]);
  x.buffer.receive({ ...result('u1', '错误的迟到原文', true, 'pause'), revision: 3 });
  x.buffer.receive(result('u2', '负责人未定。', true, 'pause')); await x.buffer.flush();
  assert.deepEqual(x.captions[0], saved); assert.equal(x.captions[0].raw, '十五万港元尚未批准。'); assert.equal(x.captions.length, 2);
});

test('stale translation response cannot overwrite a newer source revision', async t => {
  const gate = deferred(); let calls = 0;
  const x = sentences(t, { translate: async raw => { if (++calls === 1) await gate.promise; return trio(raw, false); } });
  x.buffer.receive(result('u1', '预算已经通过')); await until(() => calls === 1);
  x.buffer.receive(result('u1', '预算还没有通过，仍待审批。')); gate.resolve();
  await until(() => x.captions[0].translations?.zhHans === '预算还没有通过，仍待审批。');
  assert.equal(x.buffer.metrics.stale, 1); assert.equal(x.captions.length, 1);
});

test('idle closure waits for pending ASR and stop flushes unfinished text without inventing a continuation', async t => {
  let pending = true;
  const x = sentences(t, { idleMs: 25, asrPending: () => pending, translate: async raw => trio(raw, false) });
  x.buffer.receive(result('u1', '正式发。', true, 'limit')); await sleep(60);
  assert.equal(x.captions[0].final, false); pending = false;
  await until(() => x.captions[0].final); assert.equal(x.captions[0].raw, '正式发。');
  x.buffer.receive(result('u2', '新的未完句', true, 'stop')); await x.buffer.flush();
  assert.equal(x.captions[1].final, true); assert.equal(x.captions[1].raw, '新的未完句');
});

test('long finalized source splits at safe Unicode boundaries without losing its remainder', async t => {
  const x = sentences(t, { translate: async raw => trio(raw, false) });
  const raw = '预算尚未批准，要等客户验收；'.repeat(40) + '🚀还没有确定。';
  x.buffer.receive(result('u1', raw, true, 'limit')); await x.buffer.flush();
  assert.ok(x.captions.length > 2); assert.equal(x.captions.map(c => c.raw).join(''), raw);
  assert.ok(x.captions.every(c => [...c.raw].length <= 220 && c.final));
  assert.ok(!/[\uD800-\uDBFF]$/.test(raw.slice(0, sentenceCut(raw))));
});

test('refused provisional content is not resent on revision or final and cannot contaminate later context', async t => {
  const calls = [];
  const x = sentences(t, { translate: async (raw, prior) => {
    calls.push({ raw, prior }); if (raw.includes('跳过')) throw Object.assign(new Error('refused'), { kind: 'refusal' }); return trio(raw);
  } });
  x.buffer.receive(result('u1', '这句需要跳过')); await until(() => x.captions[0]?.skipped);
  x.buffer.receive(result('u1', '这句需要跳过并且还有后文。', true, 'pause'));
  x.buffer.receive(result('u2', '预算尚未批准。', true, 'pause')); await until(() => x.captions.at(-1).final);
  assert.equal(calls.length, 2); assert.deepEqual(calls[1].prior, []); assert.equal(x.captions.at(-1).translations.zhHans, '预算尚未批准。');
});

test('a failed final translation retries without leaving the current sentence stuck pending', async t => {
  let failing = true;
  const x = sentences(t, { translate: async raw => { if (failing) throw new Error('invalid key'); return trio(raw); } });
  x.buffer.receive(result('u1', '预算尚未批准。', true, 'pause'));
  await until(() => x.captions[0].translationError);
  failing = false; await x.buffer.retry();
  assert.equal(x.captions[0].final, true); assert.equal(x.buffer.pending, 0); assert.equal(x.buffer.current, null);
  assert.equal(x.captions[0].translations.zhHans, '预算尚未批准。');
});

test('three-language sentence response requires a boolean complete field', async () => {
  const settings = { baseURL: 'http://provider', model: 'model' }; let count = 0;
  const transport = async () => { count++; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(trio('内容', false)) } }] })); };
  const value = await translations('尚未批准。', settings, transport);
  assert.equal(value.complete, false); assert.equal(count, 1);
  await assert.rejects(translations('尚未批准。', settings, async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...trio('内容'), complete: 'true' }) } }] }))), e => e.kind === 'format');
});

test('source composition joins split words but keeps independent completed clauses', () => {
  assert.equal(composeSources([{ id: 'a', raw: '正式发。', offset: 0, joinIncomplete: true }, { id: 'b', raw: '布未定。', offset: 0 }]).raw, '正式发布未定。');
  assert.equal(composeSources([{ id: 'a', raw: '预算未批。', offset: 0 }, { id: 'b', raw: '负责人未定。', offset: 0 }]).raw, '预算未批。负责人未定。');
});

test('v2 runtime flushes after queued uploads and cannot resume after a manual stop', async () => {
  const calls = [], upload = deferred(); let receive, stopped = 0;
  const session = { id: 'x', version: 2, segments: [], captions: [], pendingTranslations: 0, processing: false };
  const runtime = new CaptionRuntime({
    api: async (url, init) => {
      calls.push(url);
      if (url === '/api/settings') return { configured: true, ...init?.data };
      if (url.includes('/audio?')) { await upload.promise; return { accepted: true }; }
      return { ...session };
    }, capture: async () => ({ ctx: { state: 'running' }, stop: () => stopped++ }), subscribe: (_id, callback) => { receive = callback; return () => {}; },
  });
  await runtime.init(); await runtime.start(); runtime.audio.accept(frame().buffer); runtime.audio.accept(frame().buffer);
  const draining = runtime.stop(); assert.equal(stopped, 1); assert.ok(!calls.some(c => c.endsWith('/flush')));
  upload.resolve(); await draining; assert.ok(calls.at(-1).endsWith('/flush'));
  receive({ ...session, backpressure: false }); assert.equal(runtime.audio.recording, false); assert.equal(runtime.userStopped, true);
  runtime.destroy();
});

test('stop while session creation is pending prevents a late microphone start', async () => {
  const gate = deferred(); let captures = 0;
  const runtime = new CaptionRuntime({
    api: async url => url === '/api/settings' ? { configured: true } : url === '/api/sessions/current' ? null : gate.promise,
    capture: async () => { captures++; return { ctx: { state: 'running' }, stop() {} }; }, subscribe: () => () => {},
  });
  await runtime.init(); const starting = runtime.start(); await sleep(0); runtime.stop();
  gate.resolve({ id: 'x', version: 2, segments: [], captions: [], pendingTranslations: 0, processing: false });
  await starting; assert.equal(captures, 0); assert.equal(runtime.userStopped, true); runtime.destroy();
});

test('v2 backpressure resumes after drain unless the user stops during the drain', async () => {
  for (const manualStop of [false, true]) {
    let receive, starts = 0;
    const session = { id: 'x', version: 2, segments: [], captions: [], update: 0, pendingTranslations: 0, processing: false };
    const runtime = new CaptionRuntime({
      api: async url => url === '/api/settings' ? { configured: true } : url.endsWith('/flush') ? { ...session, update: 2, draining: true } : { ...session },
      capture: async () => { starts++; return { ctx: { state: 'running' }, stop() {} }; },
      subscribe: (_id, callback) => { receive = callback; return () => {}; },
    });
    await runtime.init(); await runtime.start(); receive({ ...session, update: 1, backpressure: true, pendingFinals: 12 });
    await until(() => runtime.drainWaiters.length > 0); assert.equal(runtime.audio.recording, false);
    if (manualStop) runtime.stop();
    receive({ ...session, update: 3 });
    await until(() => !runtime.drainPromise);
    if (!manualStop) await until(() => runtime.audio.recording);
    assert.equal(starts, manualStop ? 1 : 2); runtime.destroy();
  }
});

test('service changes wait for old audio to drain, and stale API snapshots cannot regress SSE state', async () => {
  let receive, changedService = false;
  const session = { id: 'x', version: 2, segments: [], captions: [], update: 0, pendingTranslations: 0, processing: false };
  const runtime = new CaptionRuntime({
    api: async (url, init) => {
      if (url === '/api/settings') { if (init?.method === 'PUT') changedService = true; return { configured: true, translation: { model: 'old' }, ...init?.data }; }
      return url.endsWith('/flush') ? { ...session, update: 2, draining: true } : { ...session };
    }, capture: async () => ({ ctx: { state: 'running' }, stop() {} }), subscribe: (_id, callback) => { receive = callback; return () => {}; },
  });
  await runtime.init(); await runtime.start(); const saving = runtime.save({ translation: { model: 'new' } });
  await until(() => runtime.drainWaiters.length > 0); assert.equal(changedService, false);
  receive({ ...session, update: 3 }); await saving; assert.equal(changedService, true);
  receive({ ...session, update: 2, error: 'stale failure' }); assert.equal(runtime.error, null); assert.equal(runtime.session.update, 3);
  runtime.destroy();
});

async function server(t, transport) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-stream-'));
  const service = createApp({ dataDir: dir, transport, env: {} });
  const listener = await new Promise((resolve, reject) => { const s = service.app.listen(0, '127.0.0.1', e => e ? reject(e) : resolve(s)); s.on('error', reject); });
  t.after(async () => { service.close(); listener.closeAllConnections(); await new Promise(r => listener.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + listener.address().port;
  const api = async (route, body = {}, method = 'POST') => {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  await api('/api/settings', { asr: { baseURL: 'http://localhost:8000', model: 'asr' }, translation: { useAsrConnection: true, model: 'translator' } }, 'PUT');
  const session = (await api('/api/sessions')).body;
  const audio = (pcm, startMs, id) => fetch(base + '/api/sessions/' + session.id + '/audio?startMs=' + startMs + '&chunkId=' + id, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm });
  return { dir, base, api, audio, session };
}

test('HTTP audio ACK is independent of ASR completion, duplicate IDs are idempotent, and flush persists final captions', async t => {
  const gate = deferred(); let asrCalls = 0;
  const x = await server(t, async url => {
    if (String(url).endsWith('/audio/transcriptions')) { asrCalls++; await gate.promise; return new Response(JSON.stringify({ text: '十五万港元尚未批准。' })); }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(trio('十五万港元尚未批准。')) } }] }));
  });
  const pcm = Buffer.concat(Array(12).fill(frame()));
  assert.equal(x.session.version, 2);
  assert.equal((await x.audio(pcm, 0, 'a')).status, 200);
  assert.equal((await x.audio(pcm, 0, 'a')).status, 200); await until(() => asrCalls === 1);
  assert.equal((await x.audio(pcm, 0, 'overlap')).status, 409);
  const flush = x.api('/api/sessions/' + x.session.id + '/flush'); gate.resolve();
  assert.equal((await flush).status, 202);
  await until(async () => { const s = (await x.api('/api/sessions/' + x.session.id, {}, 'GET')).body; return !s.draining && s.captions[0]?.final; });
  const completed = await x.api('/api/sessions/' + x.session.id, {}, 'GET'); assert.equal(completed.body.captions.length, 1);
  assert.equal(completed.body.captions[0].final, true); assert.equal(completed.body.segments.length, 1);
  const stored = JSON.parse(fs.readFileSync(path.join(x.dir, 'sessions', x.session.id + '.json')));
  assert.equal(stored.segments[0].raw, '十五万港元尚未批准。'); assert.equal(stored.captions[0].translations.yue, '十五萬港元尚未批准。');
  assert.ok(asrCalls <= 2); assert.ok(!JSON.stringify(stored).includes('audio/wav'));
});

test('a final translation outage retains the recognized source and HTTP retry does not replay ASR', async t => {
  let asrCalls = 0, translationCalls = 0, unavailable = true;
  const x = await server(t, async url => {
    if (String(url).endsWith('/audio/transcriptions')) { asrCalls++; return new Response(JSON.stringify({ text: '预算尚未批准。' })); }
    translationCalls++;
    return unavailable ? new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }) : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(trio('预算尚未批准。')) } }] }));
  });
  const pcm = Buffer.concat([...Array(6).fill(frame()), ...Array(7).fill(frame(0))]);
  assert.equal((await x.audio(pcm, 0, 'preserved-source')).status, 200);
  await until(async () => (await x.api('/api/sessions/' + x.session.id, {}, 'GET')).body.translationErrors === 1);
  const failed = (await x.api('/api/sessions/' + x.session.id, {}, 'GET')).body;
  assert.equal(failed.segments[0].raw, '预算尚未批准。'); assert.equal(failed.captions.length, 0);
  const retained = JSON.parse(fs.readFileSync(path.join(x.dir, 'sessions', x.session.id + '.json')));
  assert.equal(retained.captions[0].translations, null); assert.equal(retained.captions[0].raw, '预算尚未批准。');
  const priorAsrCalls = asrCalls, priorTranslationCalls = translationCalls;
  unavailable = false; assert.equal((await x.api('/api/sessions/' + x.session.id + '/retry-translations')).status, 202);
  await until(async () => (await x.api('/api/sessions/' + x.session.id, {}, 'GET')).body.captions[0]?.final);
  const fixed = (await x.api('/api/sessions/' + x.session.id, {}, 'GET')).body;
  assert.equal(fixed.translationErrors, 0); assert.equal(fixed.captions[0].translations.zhHans, '预算尚未批准。');
  assert.equal(asrCalls, priorAsrCalls); assert.equal(translationCalls, priorTranslationCalls + 1);
  const stored = JSON.parse(fs.readFileSync(path.join(x.dir, 'sessions', x.session.id + '.json')));
  assert.equal(stored.segments.length, 1); assert.equal(stored.segments[0].raw, '预算尚未批准。');
});
