import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './helpers/service.mjs';
import { CaptionRuntime } from '../public/runtime.js';
import { VoiceMeter, levelHeight } from '../public/waveform.js';
import { ApiKeyField } from '../public/api-key.js';

const wait = ms => new Promise(r => setTimeout(r, ms));

function keyInput(hasKey = false) {
  const events = new Map(), input = { value: '', selections: 0, select() { this.selections++; }, addEventListener(type, fn) { events.set(type, fn); } };
  const field = new ApiKeyField(input); field.reset(hasKey);
  return { input, field, focus: () => events.get('focus')(), edit: value => { input.value = value; events.get('input')(); } };
}

test('an untouched saved key remains masked and is never submitted, including focus without editing', () => {
  const k = keyInput(true);
  assert.match(k.input.value, /^•+$/); assert.deepEqual(k.field.patch(), {});
  k.focus(); assert.equal(k.input.selections, 1); assert.deepEqual(k.field.patch(), {});
  k.field.update(false); assert.equal(k.input.value, ''); assert.deepEqual(k.field.patch(), {});
  k.field.update(true); assert.match(k.input.value, /^•+$/); assert.deepEqual(k.field.patch(), {});
});

test('replacing or deleting a saved key uses the normal input value and discards remaining mask characters', () => {
  const k = keyInput(true);
  k.edit('••fixture-next-key••');
  assert.equal(k.input.value, 'fixture-next-key'); assert.deepEqual(k.field.patch(), { apiKey: 'fixture-next-key' });
  k.edit(''); assert.deepEqual(k.field.patch(), { apiKey: '' });
  const other = keyInput(true); assert.deepEqual(other.field.patch(), {});
});

test('editing addresses retains an explicitly entered replacement while reset removes typed credentials', () => {
  const k = keyInput(true);
  k.edit('fixture-explicit-key'); k.field.update(false);
  assert.deepEqual(k.field.patch(), { apiKey: 'fixture-explicit-key' });
  k.field.reset(true); assert.match(k.input.value, /^•+$/); assert.deepEqual(k.field.patch(), {});
  k.field.reset(); assert.equal(k.input.value, ''); assert.deepEqual(k.field.patch(), {});
});

test('a browser-filled value is submitted without treating the stored mask as a credential', () => {
  const k = keyInput(true);
  k.input.value = 'fixture-filled-key'; assert.deepEqual(k.field.patch(), { apiKey: 'fixture-filled-key' });
  k.field.reset(true); k.input.value = ''; assert.deepEqual(k.field.patch(), { apiKey: '' });
});

async function service(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-test-'));
  let calls = 0;
  const demo = createApp({ env: {}, dataDir: dir, transport: async () => { calls++; throw new Error('must not call a model for navigation or silence'); } });
  const listener = await new Promise((resolve, reject) => { const s = demo.app.listen(0, '127.0.0.1', () => resolve(s)); s.on('error', reject); });
  const base = 'http://127.0.0.1:' + listener.address().port;
  const api = async (route, data, method = data === undefined ? 'GET' : 'POST') => {
    const r = await fetch(base + route, { method, headers: { 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: r.status, body: await r.json() };
  };
  t.after(async () => { demo.close(); listener.closeAllConnections(); await new Promise(r => listener.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { api, base, calls: () => calls };
}

test('named meetings are listed before capture; saving service settings preserves their title', async t => {
  const s = await service(t);
  assert.equal((await s.api('/api/sessions')).body.items.length, 0);
  const created = await s.api('/api/sessions', { version: 2, draft: true, title: '  产品评审  ', description: '  讨论 Claude Code 与 MCP 的应用。  ' });
  assert.equal(created.status, 201); assert.equal(created.body.title, '产品评审'); assert.equal(created.body.status, 'ready');
  assert.equal(created.body.description, '讨论 Claude Code 与 MCP 的应用。');
  assert.equal(created.body.createdByUser, true); assert.equal(created.body.startedAt, undefined); assert.equal(created.body.recording.available, false);
  await s.api('/api/settings', { asr: { baseURL: 'http://localhost:8000', model: 'asr' }, translation: { useAsrConnection: true, model: 'text' } }, 'PUT');
  assert.equal((await s.api('/api/sessions/' + created.body.id)).body.title, '产品评审');
  assert.equal((await s.api('/api/sessions/' + created.body.id)).body.description, created.body.description);
  assert.equal((await s.api('/api/sessions')).body.items[0].id, created.body.id);
  const share = (await s.api('/api/sessions/' + created.body.id + '/share')).body;
  assert.equal((await s.api('/api/watch/' + new URL(share.url).pathname.split('/').at(-1))).body.status, 'ready');
  await s.api('/api/sessions/' + created.body.id + '/end', {});
  let done;
  for (let i = 0; i < 100; i++) { done = (await s.api('/api/sessions/' + created.body.id)).body; if (done.status === 'ended') break; await wait(5); }
  assert.equal(done.status, 'ended'); assert.equal((await s.api('/api/sessions')).body.items[0].id, created.body.id);
  assert.equal(s.calls(), 0);
  assert.equal((await s.api('/api/sessions', { draft: true, title: 'x'.repeat(121) })).status, 400);
  assert.equal((await s.api('/api/sessions', { draft: true, title: {} })).status, 400);
  for (const description of ['x'.repeat(4001), {}, null, 42]) assert.equal((await s.api('/api/sessions', { draft: true, description })).status, 400);
  for (const size of [300, 4000]) assert.equal((await s.api('/api/sessions', { draft: true, description: '术'.repeat(size) })).body.description.length, size);
});

test('pause and continue keep one recording timeline and expose paused status to the phone', async t => {
  const s = await service(t);
  await s.api('/api/settings', { asr: { baseURL: 'http://localhost:8000', model: 'asr' }, translation: { useAsrConnection: true, model: 'text' } }, 'PUT');
  const meeting = (await s.api('/api/sessions', { draft: true, title: '暂停测试' })).body;
  const base = '/api/sessions/' + meeting.id;
  assert.equal((await s.api(base + '/pause', {})).status, 409);
  await s.api(base + '/start', {});
  const audio = (id, at) => fetch(s.base + base + '/audio?chunkId=' + id + '&startMs=' + at, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(6400) });
  assert.equal((await audio('first', 0)).status, 200);
  await s.api(base + '/flush', {});
  const paused = (await s.api(base + '/pause', {})).body;
  assert.equal(paused.status, 'paused'); assert.equal(paused.recording.durationMs, 200);
  assert.equal((await fetch(s.base + base + '/download')).status, 409);
  const share = (await s.api(base + '/share')).body;
  assert.equal((await s.api('/api/watch/' + new URL(share.url).pathname.split('/').at(-1))).body.status, 'paused');
  const resumed = (await s.api(base + '/start', {})).body;
  assert.equal(resumed.startedAt, paused.startedAt); assert.equal(resumed.id, paused.id);
  assert.equal((await audio('second', 200)).status, 200);
  assert.equal((await audio('first', 0)).status, 200);
  assert.equal((await s.api(base)).body.recording.durationMs, 400); assert.equal(s.calls(), 0);
  await s.api(base + '/end', {});
  assert.equal((await s.api(base + '/pause', {})).status, 409);
});

function runtimeHarness() {
  let emit, captureStarts = 0, captureStops = 0, current = { id: 'initial', version: 2, status: 'ready', captions: [], segments: [] }, uploadRelease;
  let settings = { configured: true, asr: { baseURL: 'http://localhost:8000', model: 'asr', hasApiKey: true }, translation: { baseURL: 'http://localhost:9000', model: 'translate', hasApiKey: true, useAsrConnection: false } };
  const calls = [], uploadGate = new Promise(r => { uploadRelease = r; });
  const runtime = new CaptionRuntime({
    api: async (url, options) => {
      calls.push(url);
      if (url === '/api/settings') { if (options?.data) settings = { ...settings, ...options.data }; return { ...settings }; }
      if (url === '/api/sessions') current = { ...current, id: 'named', title: options.data.title, description: options.data.description, status: 'ready', startedAt: null };
      if (url.endsWith('/start')) current = { ...current, status: 'recording', startedAt: current.startedAt || '2026-10-22T01:00:00Z' };
      if (url.includes('/audio?')) { await uploadGate; return { accepted: true }; }
      if (url.endsWith('/pause')) current = { ...current, status: 'paused' };
      if (url.endsWith('/end')) current = { ...current, status: 'ended' };
      return { ...current };
    },
    capture: async () => { captureStarts++; return { ctx: { state: 'running' }, stop() { captureStops++; } }; },
    subscribe: (_id, receive) => { emit = receive; return () => {}; },
  });
  return { runtime, calls, release: uploadRelease, emit: data => emit(data), starts: () => captureStarts, stops: () => captureStops };
}

test('preparing and opening a meeting never starts capture; pause drains before exposing paused, continue uses the same ID', async () => {
  const h = runtimeHarness(), r = h.runtime;
  await r.init(); const named = await r.createMeeting('研发会', '  Claude Code 与 MCP  '); r.openMeeting(named);
  assert.equal(h.starts(), 0); assert.equal(r.snapshot().audio.recording, false); assert.equal(r.session.title, '研发会'); assert.equal(r.session.description, 'Claude Code 与 MCP');
  await r.start(); assert.equal(h.starts(), 1);
  r.audio.accept(new Int16Array(3200).buffer);
  const pausing = r.pause(); assert.equal(h.stops(), 1); assert.equal(r.audio.recording, false);
  assert.equal(h.calls.some(c => c.endsWith('/pause')), false);
  await assert.rejects(r.createMeeting('另一场'), /先结束/);
  h.release(); await pausing;
  assert.equal(r.session.status, 'paused'); assert.ok(h.calls.findIndex(c => c.endsWith('/pause')) > h.calls.findIndex(c => c.endsWith('/flush')));
  await wait(10); assert.equal(h.starts(), 1);
  await r.start(); assert.equal(r.session.id, 'named'); assert.equal(r.audio.timeMs, 200); assert.equal(h.starts(), 2);
  await r.pause(); assert.equal(h.stops(), 2); r.destroy();
});

test('confirming end during a pending pause waits for the last upload and never reopens capture', async () => {
  const h = runtimeHarness(), r = h.runtime;
  await r.init(); await r.createMeeting('会议'); await r.start(); r.audio.accept(new Int16Array(3200).buffer);
  const pausing = r.pause(), ending = r.end();
  assert.equal(h.stops(), 1); assert.equal(h.calls.some(c => c.endsWith('/end')), false);
  h.release(); await Promise.all([pausing, ending]);
  assert.equal(r.session.status, 'ended'); assert.equal(h.starts(), 1); assert.equal(h.calls.filter(c => c.endsWith('/end')).length, 1);
  r.destroy();
});

test('each service connection, key action and sharing change drains captured audio before saving without resuming', async t => {
  const changes = [
    { asr: { baseURL: 'http://localhost:8010/custom' } }, { asr: { model: 'new-asr' } },
    { asr: { apiKey: 'replacement-test-key' } }, { asr: { apiKey: '' } },
    { translation: { baseURL: 'http://localhost:9010/custom' } }, { translation: { model: 'new-translation' } },
    { translation: { apiKey: 'replacement-test-key' } }, { translation: { apiKey: '' } },
    { translation: { useAsrConnection: true } },
  ];
  for (const change of changes) await t.test(JSON.stringify(change), async () => {
    const h = runtimeHarness(), r = h.runtime;
    await r.init(); await r.start(); r.audio.accept(new Int16Array(3200).buffer);
    const callsBefore = h.calls.length, saving = r.save(change);
    assert.equal(r.audio.recording, false); assert.equal(h.stops(), 1);
    assert.equal(h.calls.slice(callsBefore).includes('/api/settings'), false);
    h.release(); await saving;
    const changes = h.calls.slice(callsBefore);
    assert.ok(changes.indexOf('/api/settings') > changes.findIndex(c => c.endsWith('/pause')));
    assert.equal(r.userStopped, true); assert.equal(r.resumeAfterDrain, false);
    await wait(0); assert.equal(h.starts(), 1); r.destroy();
  });
});

test('saving only network access leaves active capture and the configured connections unchanged', async () => {
  const h = runtimeHarness(), r = h.runtime;
  await r.init(); await r.start(); const asr = r.settings.asr, translation = r.settings.translation;
  await r.save({ asr: { baseURL: asr.baseURL, model: asr.model }, translation: { baseURL: translation.baseURL, model: translation.model, useAsrConnection: false }, networkAddress: '192.0.2.10' });
  assert.equal(r.audio.recording, true); assert.equal(h.stops(), 0);
  assert.equal(h.calls.some(c => c.endsWith('/pause')), false);
  r.destroy();
});

test('a failed audio upload prevents changing service settings and preserves the audio for retry', async () => {
  let settingsWrites = 0;
  const session = { id: 'retained-audio', version: 2, status: 'ready', captions: [] };
  const r = new CaptionRuntime({
    api: async (url, options) => {
      if (url === '/api/settings') { if (options?.method === 'PUT') settingsWrites++; return { configured: true, asr: { model: 'asr' } }; }
      if (url.endsWith('/start')) session.status = 'recording';
      if (url.includes('/audio?')) throw new Error('upload unavailable');
      return { ...session };
    }, capture: async () => ({ ctx: { state: 'running' }, stop() {} }), subscribe: () => () => {},
  });
  await r.init(); await r.start(); r.audio.accept(new Int16Array(3200).buffer); await wait(0);
  await assert.rejects(r.save({ asr: { apiKey: 'replacement-test-key' } }), /音频未上传/);
  assert.equal(settingsWrites, 0); assert.equal(r.audio.queue.length, 1); assert.equal(r.audio.recording, false); r.destroy();
});

test('an exited model error still allows correcting the API key without restarting capture', async () => {
  const h = runtimeHarness(), r = h.runtime;
  await r.init(); await r.start();
  r.receive({ ...r.session, error: 'authentication failed', processing: false, pendingTranslations: 0, draining: false });
  assert.equal(r.audio.recording, false);
  await r.save({ asr: { apiKey: 'corrected-test-key' } });
  assert.equal(h.calls.filter(c => c === '/api/settings').length, 2);
  assert.equal(r.userStopped, true); assert.equal(h.starts(), 1); r.destroy();
});

test('rounded sound bars retain only real volume history and settle during silence or pause', async () => {
  const h = runtimeHarness(), r = h.runtime;
  let changes = 0;
  const element = { dataset: { state: 'ready' }, children: Array.from({ length: 7 }, () => ({ style: {} })), setAttribute() { changes++; } };
  const meter = new VoiceMeter(element);
  r.audio.onLevel = (level, samples) => meter.update(level, samples);
  await r.init(); await r.start(); meter.state('recording');
  const voice = new Int16Array(1600).fill(2048), quiet = new Int16Array(1600);
  r.audio.accept(voice.buffer);
  assert.deepEqual(meter.levels.slice(0, 6), Array(6).fill(0)); assert.equal(meter.levels[6], levelHeight(2048 / 32768));
  const copyChanges = changes; meter.state('recording');
  for (let i = 0; i < 6; i++) r.audio.accept(voice.buffer);
  assert.ok(meter.levels.every(v => v === meter.levels[0])); assert.equal(changes, copyChanges);
  // Constant input remains constant after history fills. No invented rhythm.
  const stable = element.children.map(b => b.style.transform); r.audio.accept(voice.buffer);
  assert.deepEqual(element.children.map(b => b.style.transform), stable);
  for (let i = 0; i < 7; i++) r.audio.accept(quiet.buffer);
  assert.equal(element.dataset.state, 'recording'); assert.ok(meter.levels.every(v => v === 0));
  const p = r.pause(); h.release(); await p; meter.state('paused'); meter.update(.8, voice);
  assert.ok(element.children.every(b => b.style.transform === 'scaleY(0.125)'));
  assert.equal(levelHeight(-1), 0); assert.equal(levelHeight(Infinity), 1); assert.equal(levelHeight(NaN), 0); r.destroy();
});

test('save retry uploads retained audio even if a recovered SSE snapshot has cleared the earlier error', async () => {
  let uploadFails = true, sends = 0, captureStops = 0;
  let session = { id: 'save-retry', version: 2, status: 'ready', captions: [], segments: [] };
  const runtime = new CaptionRuntime({
    api: async url => {
      if (url === '/api/settings') return { configured: true };
      if (url.includes('/audio?')) { sends++; if (uploadFails) throw new Error('temporary upload failure'); return { accepted: true }; }
      if (url.endsWith('/start')) session = { ...session, status: 'recording', startedAt: '2026-10-22T01:00:00Z' };
      if (url.endsWith('/end')) session = { ...session, status: 'ended' };
      return { ...session };
    }, capture: async () => ({ ctx: { state: 'running' }, stop() { captureStops++; } }), subscribe: () => () => {},
  });
  await runtime.init(); await runtime.start(); runtime.audio.accept(new Int16Array(3200).buffer); await wait(0);
  await runtime.end(); assert.equal(runtime.endFailed, true); assert.equal(runtime.audio.queue.length, 1);
  runtime.translationFailed = true; runtime.receive({ ...session, translationErrors: 0, pendingTranslations: 0 });
  assert.equal(runtime.error, null); assert.equal(runtime.endFailed, true);
  uploadFails = false; await runtime.retry();
  assert.equal(runtime.session.status, 'ended'); assert.equal(runtime.audio.queue.length, 0); assert.equal(sends, 2); assert.equal(captureStops, 1);
  runtime.destroy();
});
