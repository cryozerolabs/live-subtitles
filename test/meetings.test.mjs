import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createApp } from './helpers/service.mjs';
import { RecordingStore } from '../src/storage/recording-store.js';
import { CaptionRuntime } from '../public/runtime.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let n = 0; n < 200; n++) { if (await fn()) return; await sleep(5); } throw new Error('condition not reached'); }
const json = v => new Response(JSON.stringify(v));
const trio = { zhHans: '预算十五万，尚未批准。', en: 'The budget is 150,000, pending approval.', yue: '預算十五萬，仲未批。', complete: true };
const provider = async url => String(url).endsWith('/audio/transcriptions') ? json({ text: trio.zhHans }) : json({ choices: [{ message: { content: JSON.stringify(trio) } }] });
async function server(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-test-'));
  const service = createApp({ env: {}, dataDir: dir, transport: provider, ...extra });
  const listener = await new Promise((resolve, reject) => { const s = service.app.listen(0, '0.0.0.0', () => resolve(s)); s.on('error', reject); });
  const base = 'http://127.0.0.1:' + listener.address().port;
  const api = async (route, data, method = data === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  await api('/api/settings', { asr: { baseURL: 'http://localhost:8000', model: 'asr' }, translation: { baseURL: 'http://localhost:8000', model: 'translator' } }, 'PUT');
  const audio = (id, pcm, startMs, chunkId) => fetch(base + '/api/sessions/' + id + '/audio?startMs=' + startMs + '&chunkId=' + chunkId, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm });
  t.after(async () => { service.close(); listener.closeAllConnections(); await new Promise(r => listener.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, base, api, audio, service, listener };
}
function zipEntries(buffer) {
  const entries = new Map();
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'valid ZIP end record');
  let at = buffer.readUInt32LE(end + 16);
  while (buffer.readUInt32LE(at) === 0x02014b50) {
    const method = buffer.readUInt16LE(at + 10), bytes = buffer.readUInt32LE(at + 20), nameBytes = buffer.readUInt16LE(at + 28);
    const name = buffer.subarray(at + 46, at + 46 + nameBytes).toString('utf8'), offset = buffer.readUInt32LE(at + 42);
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    const payload = buffer.subarray(start, start + bytes);
    entries.set(name, method === 8 ? zlib.inflateRawSync(payload) : payload);
    at += 46 + nameBytes + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return entries;
}

test('durable audio preserves silence and every sample, rolls WAVs, and deduplicates after recovery', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wav-journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const frames = Array.from({ length: 9 }, (_, n) => Buffer.from(new Int16Array(1600).fill(n === 4 ? 0 : 2000 + n).buffer));
  let store = new RecordingStore(dir, { partBytes: 12800 });
  store.append(Buffer.concat(frames.slice(0, 6)), { id: 'first', startMs: 0, capturedAt: 10000 });
  store.append(Buffer.concat(frames.slice(6)), { id: 'last', startMs: 600, capturedAt: 10600 });
  assert.equal(store.summary().durationMs, 900); assert.equal(store.parts.length, 3);
  const wavs = store.parts.map(p => fs.readFileSync(path.join(dir, p.file)));
  for (const wav of wavs) { assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt32LE(40), wav.length - 44); }
  assert.deepEqual(Buffer.concat(wavs.map(w => w.subarray(44))), Buffer.concat(frames));
  store = new RecordingStore(dir, { partBytes: 12800 });
  assert.equal(store.append(Buffer.concat(frames.slice(0, 6)), { id: 'first', startMs: 0 }).duplicate, true);
  assert.equal(store.summary().durationMs, 900);
  assert.throws(() => store.append(Buffer.alloc(19200), { id: 'first', startMs: 0 }), /内容不一致/);
  assert.deepEqual(store.parts.map(p => p.offsetMs), [0, 400, 800]);
});

test('a torn journal and uncommitted WAV tail are repaired to the last durable receipt', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wav-recover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pcm = Buffer.alloc(3200, 7), store = new RecordingStore(dir);
  store.append(pcm, { id: 'a', startMs: 0 });
  fs.appendFileSync(path.join(dir, 'audio-0001.wav'), Buffer.alloc(6400, 3));
  fs.appendFileSync(path.join(dir, 'chunks.jsonl'), '{"id":"torn');
  fs.writeFileSync(path.join(dir, 'audio-0002.wav'), Buffer.alloc(99));
  const recovered = new RecordingStore(dir);
  assert.equal(recovered.summary().bytes, 3200); assert.equal(recovered.receipts.size, 1);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'audio-0001.wav')).subarray(44), pcm);
  assert.equal(fs.existsSync(path.join(dir, 'audio-0002.wav')), false);
  recovered.append(pcm, { id: 'b', startMs: 100 });
  assert.equal(new RecordingStore(dir).summary().durationMs, 200);
});

test('draft is shareable before capture; end saves audio independently of models and next meeting has its own link', async t => {
  let calls = 0;
  const x = await server(t, { transport: async (...args) => { calls++; return provider(...args); } });
  const draft = (await x.api('/api/sessions/current')).body;
  assert.equal(draft.status, 'ready'); assert.equal(draft.startedAt, undefined);
  assert.equal((await x.api('/api/sessions')).body.items.length, 0);
  const share = (await x.api('/api/sessions/' + draft.id + '/share')).body;
  assert.match(share.url, /\/watch\/[A-Za-z0-9_-]{43}$/); assert.match(share.qr, /^data:image\/png;base64,/);
  const token = new URL(share.url).pathname.split('/').at(-1);
  const waiting = (await x.api('/api/watch/' + token)).body;
  assert.equal(waiting.status, 'ready'); assert.equal(calls, 0); assert.equal(waiting.segments, undefined);
  await x.api('/api/sessions/' + draft.id + '/start', {});
  const pcm = Buffer.alloc(6400); // quiet audio must also be kept
  assert.equal((await x.audio(draft.id, pcm, 0, 'a')).status, 200);
  const wav = fs.readFileSync(path.join(x.dir, 'recordings', draft.id, 'audio-0001.wav'));
  assert.deepEqual(wav.subarray(44), pcm); assert.equal(calls, 0);
  assert.equal((await x.audio(draft.id, pcm, 0, 'a')).status, 200);
  assert.equal((await x.audio(draft.id, Buffer.alloc(6400, 1), 0, 'a')).status, 409);
  await x.api('/api/sessions/' + draft.id + '/end', {});
  await until(async () => (await x.api('/api/sessions/' + draft.id)).body.status === 'ended');
  await x.api('/api/sessions/' + draft.id + '/end', {});
  assert.equal((await x.audio(draft.id, pcm, 200, 'b')).status, 409);
  const saved = (await x.api('/api/sessions')).body.items[0]; assert.equal(saved.id, draft.id); assert.equal(saved.recording.durationMs, 200);
  const response = await fetch(x.base + '/api/sessions/' + draft.id + '/download');
  const entries = zipEntries(Buffer.from(await response.arrayBuffer()));
  assert.deepEqual(entries.get('audio-0001.wav').subarray(44), pcm);
  assert.deepEqual([...entries.keys()].sort(), ['audio-0001.wav', '原文.srt', '中文.srt', 'English.srt', '粵語.srt'].sort());
  assert.ok(fs.existsSync(path.join(x.dir, 'sessions', draft.id + '.json')), 'internal metadata remains available');
  const next = (await x.api('/api/sessions', { version: 2, draft: true })).body;
  assert.notEqual(next.id, draft.id);
  assert.notEqual((await x.api('/api/sessions/' + next.id + '/share')).body.url, share.url);
  assert.equal((await x.api('/api/watch/' + token)).body.status, 'ended');
});

test('finalizing rejects further audio, late model response is saved, and repeated end is idempotent', async t => {
  let release, calls = 0;
  const gate = new Promise(r => { release = r; });
  const x = await server(t, { transport: async (...args) => { calls++; await gate; return provider(...args); } });
  const s = (await x.api('/api/sessions', {})).body, pcm = Buffer.from(new Int16Array(1600 * 12).fill(2000).buffer);
  await x.audio(s.id, pcm, 0, 'speech'); await until(() => calls > 0);
  await x.api('/api/sessions/' + s.id + '/end', {});
  assert.equal((await x.api('/api/sessions/' + s.id)).body.status, 'finalizing');
  assert.equal((await x.audio(s.id, Buffer.alloc(3200), 1200, 'late')).status, 409);
  release(); await until(async () => (await x.api('/api/sessions/' + s.id)).body.status === 'ended');
  const done = (await x.api('/api/sessions/' + s.id)).body;
  assert.equal(done.captions[0].translations.yue, trio.yue); assert.equal(done.captions[0].final, true);
  const total = calls; await x.api('/api/sessions/' + s.id + '/end', {}); assert.equal(calls, total);
});

test('a disk error does not acknowledge audio or call ASR; retry saves the original chunk once', async t => {
  let calls = 0;
  const x = await server(t, { transport: async (...args) => { calls++; return provider(...args); } });
  const s = (await x.api('/api/sessions', {})).body;
  fs.mkdirSync(path.join(x.dir, 'recordings')); fs.writeFileSync(path.join(x.dir, 'recordings', s.id), 'not a directory');
  const pcm = Buffer.alloc(6400);
  const failed = await x.audio(s.id, pcm, 0, 'same'); assert.equal(failed.status, 503); assert.match((await failed.json()).error, /录音未能保存/); assert.equal(calls, 0);
  fs.unlinkSync(path.join(x.dir, 'recordings', s.id));
  assert.equal((await x.audio(s.id, pcm, 0, 'same')).status, 200);
  assert.equal((await x.audio(s.id, pcm, 0, 'same')).status, 200);
  assert.equal((await x.api('/api/sessions/' + s.id)).body.recording.durationMs, 200);
});

test('a provider failure during end still saves the recording and leaves no processing state stuck', async t => {
  const x = await server(t, { transport: async () => new Response('{"error":"invalid key"}', { status: 401 }) });
  const s = (await x.api('/api/sessions', {})).body;
  await x.audio(s.id, Buffer.from(new Int16Array(1600 * 12).fill(2000).buffer), 0, 'speech');
  await x.api('/api/sessions/' + s.id + '/end', {});
  await until(async () => (await x.api('/api/sessions/' + s.id)).body.status === 'ended');
  const done = (await x.api('/api/sessions/' + s.id)).body;
  assert.equal(done.recording.durationMs, 1200); assert.equal(done.processing, false); assert.equal(done.pendingTranslations, 0); assert.equal(done.pendingFinals, 0);
  assert.match(done.error, /密钥/);
  assert.equal((await fetch(x.base + '/api/sessions/' + s.id + '/download')).status, 200);
});

test('restart exposes saved audio as interrupted without replaying a provider or duplicating data', async t => {
  let calls = 0;
  const x = await server(t, { transport: async (...args) => { calls++; return provider(...args); } });
  const s = (await x.api('/api/sessions', {})).body;
  await x.audio(s.id, Buffer.alloc(6400), 0, 'a'); x.service.close();
  const restarted = createApp({ env: {}, dataDir: x.dir, transport: async () => { throw new Error('must not call provider'); } });
  const listener = await new Promise(r => { const l = restarted.app.listen(0, '127.0.0.1', () => r(l)); });
  t.after(() => { restarted.close(); listener.closeAllConnections(); listener.close(); });
  const body = await (await fetch('http://127.0.0.1:' + listener.address().port + '/api/sessions/' + s.id)).json();
  assert.equal(body.status, 'interrupted'); assert.equal(body.recording.durationMs, 200); assert.equal(calls, 0);
});

test('history and downloads contain all captions beyond the live window, with no model replay', async t => {
  const x = await server(t, { transport: async () => { throw new Error('must not call provider'); } });
  const id = crypto.randomUUID(), captions = Array.from({ length: 151 }, (_, n) => ({ id: 'c' + (n + 1), startMs: n * 1000, endMs: (n + 1) * 1000, revision: 2, final: true, raw: '原文' + n, translations: { ...trio, zhHans: '未批准 ' + n } }));
  fs.writeFileSync(path.join(x.dir, 'sessions', id + '.json'), JSON.stringify({ id, version: 2, kind: 'meeting', title: '长会议', createdAt: new Date().toISOString(), status: 'ended', segments: [], captions }));
  assert.equal((await x.api('/api/sessions/' + id)).body.captions.length, 60);
  assert.ok((await x.api('/api/sessions')).body.items.some(s => s.id === id));
  const tail = (await x.api('/api/sessions/' + id + '/captions')).body; assert.equal(tail.items.length, 60); assert.equal(tail.hasBefore, true);
  assert.equal(tail.items[0].raw, '原文91');
  const early = (await x.api('/api/sessions/' + id + '/captions?before=' + tail.items[0].id + '&limit=100')).body;
  assert.equal(early.items.length, 91); assert.equal(early.hasBefore, false);
  const later = (await x.api('/api/sessions/' + id + '/captions?after=c1')).body; assert.equal(later.items[0].id, 'c2'); assert.equal(later.hasAfter, true);
  const response = await fetch(x.base + '/api/sessions/' + id + '/download'), entries = zipEntries(Buffer.from(await response.arrayBuffer()));
  assert.deepEqual([...entries.keys()].sort(), ['原文.srt', '中文.srt', 'English.srt', '粵語.srt'].sort());
  assert.equal(entries.get('中文.srt').toString().trim().split(/\n\n/).length, 151);
  assert.equal(JSON.parse(fs.readFileSync(path.join(x.dir, 'sessions', id + '.json'))).captions.length, 151);
});

test('phone snapshot, SSE and caption pages include original text but never service credentials', async t => {
  const x = await server(t, { transport: async () => { throw new Error('reading captions must not replay models'); } });
  const id = crypto.randomUUID(), token = crypto.randomBytes(32).toString('base64url');
  const raw = 'The budget of 150,000 has not been approved.';
  fs.writeFileSync(path.join(x.dir, 'sessions', id + '.json'), JSON.stringify({
    id, version: 2, kind: 'meeting', title: '双语字幕', createdAt: new Date().toISOString(), status: 'ended', watchToken: token,
    segments: [], captions: [{ id: 'c1', revision: 3, final: true, raw, translations: trio, startMs: 0, endMs: 4000 }],
  }));
  const snapshot = (await x.api('/api/watch/' + token)).body;
  const page = (await x.api('/api/watch/' + token + '/captions')).body;
  assert.equal(snapshot.captions[0].raw, raw); assert.equal(page.items[0].raw, raw);
  assert.equal(snapshot.captions[0].translations.yue, trio.yue);
  assert.doesNotMatch(JSON.stringify(snapshot), /watchToken|apiKey|baseURL/);
  const controller = new AbortController();
  const response = await fetch(x.base + '/api/watch/' + token + '/events', { signal: controller.signal });
  const reader = response.body.getReader();
  const event = new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  assert.equal(JSON.parse(event.slice(event.indexOf('data:') + 5).trim()).captions[0].raw, raw);
});

test('records outside the meeting schema are excluded without modifying their files', async t => {
  const x = await server(t, { transport: async () => { throw new Error('listing must not replay models'); } });
  const id = crypto.randomUUID(), sampleId = crypto.randomUUID();
  fs.writeFileSync(path.join(x.dir, 'sessions', id + '.json'), JSON.stringify({ id, kind: 'meeting', version: 2, status: 'ended', title: '已保存会议', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), segments: [], captions: [] }));
  const file = path.join(x.dir, 'sessions', sampleId + '.json');
  const invalid = JSON.stringify({ id: sampleId, kind: 'meeting', version: 0, segments: [] });
  fs.writeFileSync(file, invalid);
  const page = await x.api('/api/sessions');
  assert.equal(page.status, 200); assert.deepEqual(page.body.items.map(s => s.id), [id]);
  assert.equal(fs.readFileSync(file, 'utf8'), invalid);
  assert.equal((await x.api('/api/sessions/' + sampleId)).status, 404);
});

test('LAN viewers have only token-scoped read access even with a forged localhost Host', async t => {
  const address = Object.values(os.networkInterfaces()).flat().find(v => v?.family === 'IPv4' && !v.internal)?.address;
  if (!address) { t.skip('no LAN interface on this host'); return; }
  const x = await server(t), draft = (await x.api('/api/sessions/current')).body;
  const share = (await x.api('/api/sessions/' + draft.id + '/share')).body, token = new URL(share.url).pathname.split('/').at(-1);
  const lan = 'http://' + address + ':' + x.listener.address().port;
  for (const route of ['/watch/' + token, '/api/watch/' + token, '/watch.js', '/transcript.js']) assert.equal((await fetch(lan + route)).status, 200);
  for (const route of ['/api/settings', '/api/sessions', '/api/sessions/' + draft.id, '/api/sessions/' + draft.id + '/download', '/', '/microphone.js']) {
    assert.equal((await fetch(lan + route, { headers: { host: 'localhost:' + x.listener.address().port } })).status, 403, route);
  }
  assert.equal((await fetch(lan + '/api/sessions/' + draft.id + '/end', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(lan + '/api/sessions/' + draft.id + '/preferred-language', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"language":"yue"}' })).status, 403);
  assert.equal((await fetch(lan + '/api/watch/' + 'a'.repeat(43))).status, 404);
  const publicBody = await (await fetch(lan + '/api/watch/' + token)).json();
  assert.equal(publicBody.segments, undefined); assert.equal(publicBody.settings, undefined); assert.equal(publicBody.recording, undefined);
});

test('runtime end releases capture immediately but waits for queued audio; next start resets the audio timeline', async () => {
  let receive, release, stopped = 0, starts = 0, seq = 0;
  const upload = new Promise(r => { release = r; }), calls = [];
  let s = { id: 'one', version: 2, status: 'ready', captions: [], segments: [] };
  const runtime = new CaptionRuntime({
    api: async url => {
      calls.push(url);
      if (url === '/api/settings') return { configured: true };
      if (url.includes('/audio?')) { await upload; return { accepted: true }; }
      if (url === '/api/sessions') s = { ...s, id: 'new-' + ++seq, status: 'ready', startedAt: null };
      if (url.endsWith('/start')) s = { ...s, status: 'recording', startedAt: new Date().toISOString() };
      if (url.endsWith('/end')) { s = { ...s, status: 'finalizing' }; setTimeout(() => receive({ ...s, status: 'ended' }), 0); }
      return { ...s };
    },
    capture: async () => { starts++; return { ctx: { state: 'running' }, stop: () => stopped++ }; },
    subscribe: (_id, callback) => { receive = callback; return () => {}; },
  });
  await runtime.init(); assert.equal(starts, 0); await runtime.start();
  runtime.audio.accept(new Int16Array(1600).buffer); runtime.audio.accept(new Int16Array(1600).buffer);
  const ending = runtime.end(); assert.equal(stopped, 1); assert.equal(runtime.audio.recording, false);
  assert.equal(calls.some(c => c.endsWith('/end')), false);
  release(); await ending; assert.equal(runtime.session.status, 'ended'); assert.equal(runtime.snapshot().phase, 'ended');
  await runtime.start(); assert.notEqual(runtime.session.id, 'one'); assert.equal(runtime.audio.timeMs, 0); assert.equal(starts, 2);
  runtime.destroy();
});

test('ending during backpressure drain does not deadlock and never resumes the microphone', async () => {
  let receive, starts = 0;
  let session = { id: 'x', version: 2, status: 'ready', update: 0, captions: [], segments: [] };
  const runtime = new CaptionRuntime({
    api: async url => {
      if (url === '/api/settings') return { configured: true };
      if (url.endsWith('/start')) session = { ...session, status: 'recording' };
      if (url.endsWith('/flush')) return { ...session, update: 2, draining: true };
      if (url.endsWith('/end')) session = { ...session, update: 4, status: 'ended' };
      return { ...session };
    }, capture: async () => { starts++; return { ctx: { state: 'running' }, stop() {} }; },
    subscribe: (_id, callback) => { receive = callback; return () => {}; },
  });
  await runtime.init(); await runtime.start();
  receive({ ...session, update: 1, backpressure: true, pendingFinals: 12 });
  await until(() => runtime.drainWaiters.length);
  const ending = runtime.end();
  receive({ ...session, update: 3, backpressure: false, pendingFinals: 0, draining: false });
  await ending;
  assert.equal(runtime.session.status, 'ended'); assert.equal(runtime.audio.recording, false); assert.equal(starts, 1); runtime.destroy();
});

test('an initial connection failure can be retried without implicitly starting capture', async () => {
  let offline = true, captures = 0;
  const runtime = new CaptionRuntime({
    api: async url => { if (offline) throw new Error('offline'); return url === '/api/settings' ? { configured: true } : { id: 'x', status: 'ready', version: 2, captions: [], segments: [] }; },
    capture: async () => { captures++; return { ctx: { state: 'running' }, stop() {} }; }, subscribe: () => () => {},
  });
  await runtime.init(); assert.ok(runtime.error); offline = false; await runtime.retry();
  assert.equal(captures, 0); assert.equal(runtime.audio.recording, false); assert.equal(runtime.snapshot().phase, 'ready'); runtime.destroy();
});

test('a disconnected collector finalizes as interrupted even while a viewer remains connected', async t => {
  const x = await server(t, { disconnectMs: 20 }), s = (await x.api('/api/sessions/current')).body;
  const share = (await x.api('/api/sessions/' + s.id + '/share')).body, token = new URL(share.url).pathname.split('/').at(-1);
  const collector = new AbortController(), viewer = new AbortController();
  const c = await fetch(x.base + '/api/sessions/' + s.id + '/events', { signal: collector.signal });
  await c.body.getReader().read();
  const v = await fetch(x.base + '/api/watch/' + token + '/events', { signal: viewer.signal });
  await v.body.getReader().read();
  await x.api('/api/sessions/' + s.id + '/start', {}); await x.audio(s.id, Buffer.alloc(6400), 0, 'a');
  collector.abort();
  await until(async () => (await x.api('/api/sessions/' + s.id)).body.status === 'interrupted');
  viewer.abort(); assert.equal((await x.api('/api/sessions/' + s.id)).body.recording.durationMs, 200);
});
