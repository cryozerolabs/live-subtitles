import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from './helpers/service.mjs';
import { endpoint, recognize, translations, wavFile } from '../src/providers/openai-compatible.js';
import { CaptionAudio } from '../public/audio.js';
import { CaptionRuntime } from '../public/runtime.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'text/plain;charset=UTF-8' } });
const trio = { zhHans: '十五万港元尚未批准。', en: 'HK$150,000 has not been approved.', yue: '十五萬港元仲未批。' };
const chatResponse = () => json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...trio, complete: true }) } }] });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let n = 0; n < 100; n++) { if (await fn()) return; await sleep(5); } throw new Error('condition not reached'); }
async function serve(t, transport = async url => String(url).endsWith('/audio/transcriptions') ? json({ text: '十五万港元还没批准。' }) : chatResponse()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-test-'));
  const service = createApp({ dataDir: dir, transport, env: {} });
  const server = await new Promise(resolve => { const value = service.app.listen(0, '127.0.0.1', () => resolve(value)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const api = async (route, data, method = data === undefined ? 'GET' : 'POST') => {
    const r = await fetch(base + route, { method, headers: { 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: r.status, body: await r.json() };
  };
  return { dir, base, api };
}

test('endpoint normalization accepts base/full URLs and rejects URL credentials', () => {
  assert.equal(endpoint('https://api.example.com/v1/', 'asr'), 'https://api.example.com/v1/audio/transcriptions');
  assert.equal(endpoint('https://example.org', 'translation'), 'https://example.org/chat/completions');
  assert.equal(endpoint('https://example.org/services/custom/', 'translation'), 'https://example.org/services/custom/chat/completions');
  assert.equal(endpoint('http://localhost:8000/v1/audio/transcriptions', 'asr'), 'http://localhost:8000/v1/audio/transcriptions');
  for (const value of ['ftp://example.org', 'https://user:key@example.org', 'https://example.org?key=private']) assert.throws(() => endpoint(value, 'asr'));
});

test('ASR sends mono 16 kHz WAV and reads JSON even when Content-Type is text/plain', async () => {
  const pcm = Buffer.alloc(32000, 7), raw = '我哋星期五先交展示，正式上線未定。';
  const result = await recognize(pcm, { baseURL: 'http://provider/v1', model: 'asr-model', apiKey: 'test-key' }, async (url, options) => {
    assert.equal(url, 'http://provider/v1/audio/transcriptions');
    assert.equal(options.headers.authorization, 'Bearer test-key');
    assert.equal(options.body.get('model'), 'asr-model');
    assert.equal(options.body.get('response_format'), 'json');
    assert.equal(options.body.get('language'), null);
    assert.equal(options.body.get('prompt'), null);
    const wav = Buffer.from(await options.body.get('file').arrayBuffer());
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.deepEqual(wav.subarray(44), pcm);
    return json({ text: raw });
  });
  assert.equal(result, raw);
  assert.equal(wavFile(pcm).length, pcm.length + 44);
});

test('ASR failure never falls back to generated or sample captions', async () => {
  await assert.rejects(recognize(Buffer.alloc(3200), { baseURL: 'http://provider', model: 'asr' }, async () => json({ error: 'no' }, 401)), /密钥/);
  await assert.rejects(recognize(Buffer.alloc(3200), { baseURL: 'http://provider', model: 'asr' }, async () => json({ result: 'missing' })), /text/);
});

test('keyless local providers receive no Authorization header and provider timeouts remain errors', async () => {
  assert.equal(await recognize(Buffer.alloc(3200), { baseURL: 'http://localhost:8000/custom', model: 'local-asr' }, async (url, options) => {
    assert.equal(url, 'http://localhost:8000/custom/audio/transcriptions'); assert.equal(options.headers.authorization, undefined);
    assert.equal(options.redirect, 'error'); return json({ text: '本地识别。' });
  }), '本地识别。');
  await translations('预算未批。', { baseURL: 'http://localhost:9000/custom', model: 'local-translation' }, async (url, options) => {
    assert.equal(url, 'http://localhost:9000/custom/chat/completions'); assert.equal(options.headers.authorization, undefined);
    assert.equal(options.redirect, 'error'); return chatResponse();
  });
  await assert.rejects(recognize(Buffer.alloc(3200), { baseURL: 'http://provider', model: 'asr' }, async () => { throw new DOMException('provider timed out', 'TimeoutError'); }), error => error.name === 'TimeoutError');
});

test('observed non-speech markers do not become subtitles or translation failures', async () => {
  const settings = { baseURL: 'http://provider', model: 'asr' };
  assert.equal(await recognize(Buffer.alloc(3200), settings, async () => json({ text: '<music>' })), '');
  assert.equal(await recognize(Buffer.alloc(3200), settings, async () => json({ text: '<noise>' })), '');
  assert.equal(await recognize(Buffer.alloc(3200), settings, async () => json({ text: 'The music has not started.' })), 'The music has not started.');
});

test('one text request returns three real translations; Cantonese is independent of Traditional Chinese', async () => {
  const raw = '十五万港元还没批准。';
  const result = await translations(raw, { baseURL: 'http://provider', model: 'translation-model' }, async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.model, 'translation-model');
    const input = JSON.parse(request.messages[1].content);
    assert.equal(input.utterance, raw); assert.deepEqual(input.context, ['前文。']);
    return json({ choices: [{ message: { content: JSON.stringify({ ...trio, complete: true }) } }] });
  }, ['前文。']);
  assert.equal(result.yue, '十五萬港元仲未批。');
  assert.notEqual(result.yue, '十五萬港元尚未批准。');
  assert.equal(raw, '十五万港元还没批准。');
  const customer = await translations('需要客户验收。', { baseURL: 'http://provider', model: 'model' }, async () => json({ choices: [{ message: { content: JSON.stringify({ zhHans: '需要客户验收。', en: 'Customer acceptance is required.', complete: true, yue: '要等客户驗收先得。' }) } }] }));
  assert.equal(customer.yue, '要等客戶驗收先得。');
});

test('missing Cantonese, absent text service, or truncated model output is an explicit error', async () => {
  await assert.rejects(translations('原文', {}), /翻译服务/);
  await assert.rejects(translations('原文', { baseURL: 'http://provider', model: 'model' }, async () => json({ choices: [{ message: { content: '{"zhHans":"中文","en":"English","complete":true}' } }] })), error => error.kind === 'format');
  await assert.rejects(translations('原文', { baseURL: 'http://provider', model: 'model' }, async () => json({ choices: [{ finish_reason: 'length', message: { content: JSON.stringify({ ...trio, complete: true }) } }] })), /不完整/);
});

test('refusal metadata and malformed responses have distinct errors without blaming settings', async () => {
  const settings = { baseURL: 'http://provider', model: 'model' };
  for (const choice of [{ message: { refusal: 'declined', content: '' } }, { finish_reason: 'content_filter', message: { content: '' } }]) {
    await assert.rejects(translations('原文', settings, async () => json({ choices: [choice] })), error => error.kind === 'refusal' && /拒绝了这段内容/.test(error.message));
  }
  for (const content of ['无法处理这句话。', 'null', '[]', '{broken']) {
    await assert.rejects(translations('原文', settings, async () => json({ choices: [{ message: { content } }] })), error => error.kind === 'format' && /格式异常/.test(error.message) && !/设置/.test(error.message));
  }
  await assert.rejects(translations('原文', settings, async () => new Response('not JSON')), error => error.kind === 'format');
});

test('malformed captions retry once with the same utterance and service, without replaying ASR', async () => {
  const calls = [], raw = '负责人下周再定。';
  const result = await translations(raw, { baseURL: 'http://provider', model: 'model' }, async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, model: body.model, input: JSON.parse(body.messages[1].content) });
    return calls.length === 1 ? json({ choices: [{ message: { content: 'not JSON' } }] }) : chatResponse();
  }, ['前文。']);
  assert.equal(result.yue, trio.yue); assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.input.utterance), [raw, raw]);
  assert.deepEqual(calls.map(c => c.input.context), [['前文。'], []]);
  assert.ok(calls.every(c => c.url === 'http://provider/chat/completions' && c.model === 'model'));
});

test('format retry is bounded and explicit refusals or invalid keys are never automatically retried', async () => {
  for (const mode of ['format', 'refusal', 'credentials']) {
    let count = 0;
    await assert.rejects(translations('原文', { baseURL: 'http://provider', model: 'model' }, async () => {
      count++;
      if (mode === 'credentials') return json({ error: 'invalid key' }, 401);
      return json({ choices: [{ finish_reason: mode === 'refusal' ? 'content_filter' : 'stop', message: { content: 'not JSON' } }] });
    }));
    assert.equal(count, mode === 'format' ? 2 : 1);
  }
});

test('unsupported JSON mode is retried without changing models or providers', async () => {
  let count = 0;
  const result = await translations('原文', { baseURL: 'http://provider', model: 'model' }, async (url, options) => {
    assert.equal(url, 'http://provider/chat/completions');
    const req = JSON.parse(options.body); assert.equal(req.model, 'model');
    if (++count === 1) return new Response('response_format not supported', { status: 400 });
    assert.equal(req.response_format, undefined); return chatResponse();
  });
  assert.equal(count, 2); assert.equal(result.en, trio.en);
});

test('provider parameter fallbacks retain the requested model, endpoint and key', async () => {
  const calls = [];
  const result = await translations('预算尚未批准。', { baseURL: 'http://provider/custom', model: 'translator', apiKey: 'test-key' }, async (url, options) => {
    const payload = JSON.parse(options.body); calls.push(payload);
    assert.equal(url, 'http://provider/custom/chat/completions'); assert.equal(payload.model, 'translator');
    assert.equal(options.headers.authorization, 'Bearer test-key');
    if (calls.length === 1) return new Response('max_completion_tokens unsupported', { status: 400 });
    if (calls.length === 2) return new Response('temperature unsupported', { status: 400 });
    if (calls.length === 3) return new Response('response_format unsupported', { status: 400 });
    return chatResponse();
  });
  assert.equal(result.en, trio.en); assert.equal(calls.length, 4);
  assert.equal(calls[1].max_completion_tokens, undefined); assert.equal(calls[1].max_tokens, calls[0].max_completion_tokens);
  assert.equal(calls[2].temperature, undefined); assert.equal(calls[3].response_format, undefined);
});

test('settings persist independent connections and redact keys, with shared transport and atomic validation', async t => {
  const { api, dir } = await serve(t);
  const initial = (await api('/api/settings')).body;
  assert.equal(initial.configured, false); assert.equal(initial.asr.baseURL, ''); assert.equal(initial.asr.model, '');
  const result = await api('/api/settings', {
    asr: { baseURL: 'http://localhost:8000/custom', model: 'asr', apiKey: 'never-echo-this' },
    translation: { model: 'translator', useAsrConnection: true },
  }, 'PUT');
  assert.equal(result.status, 200); assert.equal(result.body.configured, true);
  assert.equal(result.body.asr.hasApiKey, true); assert.equal(result.body.translation.useAsrConnection, true);
  assert.equal(result.body.translation.hasApiKey, false); assert.ok(!JSON.stringify(result.body).includes('never-echo-this'));
  assert.equal(fs.statSync(path.join(dir, 'settings.json')).mode & 0o777, 0o600);
  assert.equal((await api('/api/settings', { asr: { baseURL: 'https://user:private@example.org', apiKey: 'replacement' } }, 'PUT')).status, 400);
  const unchanged = (await api('/api/settings')).body;
  assert.equal(unchanged.asr.baseURL, 'http://localhost:8000/custom'); assert.equal(unchanged.asr.hasApiKey, true);
  assert.equal(unchanged.translation.model, 'translator');
  assert.equal((await api('/api/settings', { asr: { model: '' } }, 'PUT')).status, 400);
  assert.equal((await api('/api/settings')).body.asr.model, 'asr');
});

test('changing one service origin clears only its saved key; path changes keep the same-origin key', async t => {
  const { api } = await serve(t);
  await api('/api/settings', {
    asr: { baseURL: 'http://asr.local/v1', model: 'asr', apiKey: 'asr-private-key' },
    translation: { baseURL: 'http://translation.local/v1', model: 'translator', apiKey: 'translation-private-key', useAsrConnection: false },
  }, 'PUT');
  const sameOrigin = await api('/api/settings', { asr: { baseURL: 'http://asr.local/custom' } }, 'PUT');
  assert.equal(sameOrigin.body.asr.hasApiKey, true); assert.equal(sameOrigin.body.translation.hasApiKey, true);
  const changed = await api('/api/settings', { asr: { baseURL: 'http://other.local/v1' } }, 'PUT');
  assert.equal(changed.body.asr.hasApiKey, false); assert.equal(changed.body.translation.hasApiKey, true);
  const independent = await api('/api/settings', { translation: { baseURL: 'http://new-translation.local/custom' } }, 'PUT');
  assert.equal(independent.body.translation.hasApiKey, false);
});

test('foreign Origin and Host are blocked; removed features have no routes or UI', async t => {
  const { base } = await serve(t);
  assert.equal((await fetch(base + '/api/settings', { headers: { origin: 'https://foreign.example' } })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => http.get(base + '/api/settings', { headers: { host: 'foreign.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject));
  assert.equal(hostStatus, 403);
  const html = await (await fetch(base)).text();
  assert.doesNotMatch(html, /Ming|Demo|OpenCaptions|会议纪要|data-export|历史管理/);
  assert.match(html, /data-language="yue"/);
  assert.equal((await fetch(base + '/api/sessions')).status, 200);
});

function makeAudio(extra = {}) {
  let frames, stopped = 0, sends = 0;
  const audio = new CaptionAudio({
    capture: async options => { frames = options.onPcm; return { ctx: { state: 'running' }, stop: () => stopped++ }; },
    send: async () => { sends++; }, chunkId: () => 'test-chunk', ...extra,
  });
  return { audio, frame: value => { const data = new Int16Array(1600); data.fill(value); frames(data.buffer); }, stopped: () => stopped, sends: () => sends };
}

test('20 seconds of silence remains active while PCM reaches the server for VAD', async () => {
  const x = makeAudio(); await x.audio.start();
  for (let n = 0; n < 200; n++) { x.frame(0); await Promise.resolve(); }
  await until(() => !x.audio.sending);
  assert.equal(x.audio.recording, true); assert.equal(x.sends(), 100); assert.equal(x.audio.timeMs, 20000);
  x.audio.stop(); assert.equal(x.stopped(), 1);
});

test('PCM uploads every 200 ms and stop flushes the final 100 ms exactly once', async () => {
  const sent = [];
  const x = makeAudio({ send: async chunk => sent.push(chunk) }); await x.audio.start();
  x.frame(0); assert.equal(sent.length, 0); x.frame(2000);
  await until(() => !x.audio.sending);
  assert.equal(sent.length, 1); assert.equal(sent[0].startMs, 0); assert.equal(sent[0].body.size, 6400);
  x.frame(2000); x.audio.stop(); await x.audio.drain();
  assert.equal(sent.length, 2); assert.equal(sent[1].startMs, 200); assert.equal(sent[1].body.size, 3200);
  x.audio.stop(); assert.equal(sent.length, 2);
});

test('failed audio stays queued with the same ID and body for explicit retry', async () => {
  const sent = []; let rejected = false;
  const x = makeAudio({ send: async chunk => { sent.push(chunk); if (!rejected) { rejected = true; throw new Error('offline'); } } });
  await x.audio.start();
  for (let n = 0; n < 2; n++) x.frame(2000);
  x.audio.stop(); await until(() => x.audio.failed && !x.audio.sending);
  assert.equal(x.audio.queue.length, 1); assert.equal(x.audio.recording, false);
  await x.audio.retry();
  assert.equal(sent.length, 2); assert.equal(sent[0], sent[1]); assert.equal(x.audio.queue.length, 0);
});

test('upload backpressure pauses at 12 seconds without discarding recorded speech', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const x = makeAudio({ send: async () => gate }); await x.audio.start();
  for (let n = 0; n < 12 * 40; n++) x.frame(2000);
  assert.equal(x.audio.recording, false); assert.equal(x.audio.queue.length, 60); assert.equal(x.stopped(), 1);
  release(); await until(() => !x.audio.sending);
  assert.equal(x.audio.queue.length, 0);
});

test('a late microphone permission result after stopping is released instead of becoming live', async () => {
  let resolveCapture, stopped = 0;
  const audio = new CaptionAudio({ capture: () => new Promise(resolve => { resolveCapture = resolve; }), send: async () => {} });
  const start = audio.start(); audio.stop();
  resolveCapture({ ctx: { state: 'running' }, stop: () => stopped++ });
  await start; assert.equal(audio.recording, false); assert.equal(stopped, 1);
});

test('PCM transport preserves every frame across upload and stop boundaries', async () => {
  for (const pauseAt of [18, 32]) {
    const sent = [], frames = [];
    const x = makeAudio({ send: async chunk => sent.push(chunk) }); await x.audio.start();
    for (let n = 0; n < 45; n++) {
      const frame = new Int16Array(1600).fill(n === pauseAt || n === pauseAt + 1 ? 0 : 2000 + n).buffer;
      frames.push(Buffer.from(frame)); x.audio.accept(frame);
    }
    x.audio.stop(); await until(() => !x.audio.sending);
    assert.deepEqual(sent.map(s => s.startMs), Array.from({ length: 23 }, (_, n) => n * 200));
    assert.equal(sent[0].body.size, 6400);
    const uploaded = await Promise.all(sent.map(async s => Buffer.from(await s.body.arrayBuffer())));
    assert.deepEqual(Buffer.concat(uploaded), Buffer.concat(frames));
  }
});

function runtimeFixture(options = {}) {
  let starts = 0, stops = 0, frames, listener;
  const settings = { configured: true, asr: { baseURL: 'http://localhost:8000', model: 'asr' }, translation: { baseURL: 'http://localhost:9000', model: 'translator', useAsrConnection: false }, ...options.settings };
  let session = { id: 'session', version: 2, status: 'ready', captions: [], pendingTranslations: 0, translationErrors: 0 };
  const runtime = new CaptionRuntime({
    api: async (url, init) => {
      if (url === '/api/settings') {
        if (init?.data) {
          const next = init.data;
          Object.assign(settings, next, { asr: { ...settings.asr, ...next.asr }, translation: { ...settings.translation, ...next.translation } });
          settings.configured = !!(settings.asr?.baseURL && settings.asr.model && settings.translation?.model && (settings.translation.useAsrConnection || settings.translation.baseURL));
        }
        return { ...settings };
      }
      if (url === '/api/sessions') return { ...session };
      if (url.endsWith('/start')) session = { ...session, status: 'recording', startedAt: '2026-10-22T00:00:00Z' };
      if (url.endsWith('/pause')) session = { ...session, status: 'paused' };
      if (url.endsWith('/retry-translations')) session = { ...session, translationErrors: 0, pendingTranslations: options.retryPending || 0 };
      return { ...session };
    },
    capture: async args => { starts++; frames = args.onPcm; if (options.denied && starts === 1) throw Object.assign(new Error('no'), { name: 'NotAllowedError', reason: options.denialReason }); return { ctx: { state: 'running' }, stop: () => stops++ }; },
    subscribe: (_id, receive) => { listener = receive; return () => {}; },
    onSettings: options.onSettings || (() => {}),
  });
  return { runtime, starts: () => starts, stops: () => stops, frames: () => frames, update: value => { session = { ...session, ...value }; listener({ ...session }); } };
}

test('configured page waits for a gesture and stays in started/waiting state during silence', async () => {
  const x = runtimeFixture(); await x.runtime.init();
  assert.equal(x.starts(), 0); assert.equal(x.runtime.snapshot().phase, 'ready');
  await x.runtime.start();
  assert.equal(x.starts(), 1); assert.equal(x.runtime.snapshot().phase, 'waiting');
  for (let n = 0; n < 200; n++) { x.frames()(new Int16Array(1600).buffer); await Promise.resolve(); }
  assert.equal(x.runtime.snapshot().phase, 'waiting');
  x.runtime.destroy();
});

test('missing configuration opens settings; saving still requires a start gesture', async () => {
  let opened = 0;
  const x = runtimeFixture({ settings: { configured: false }, onSettings: () => opened++ });
  await x.runtime.init();
  assert.equal(opened, 1); assert.equal(x.starts(), 0);
  await x.runtime.save({ asr: { baseURL: 'http://localhost:8000', model: 'asr' }, translation: { model: 'translator', useAsrConnection: true } });
  assert.equal(x.starts(), 0); await x.runtime.start();
  await until(() => x.runtime.audio.recording);
  assert.equal(x.starts(), 1); x.runtime.destroy();
});

test('permission denial is explicit; a later gesture can enable the microphone', async () => {
  const x = runtimeFixture({ denied: true }); await x.runtime.init(); await x.runtime.start();
  assert.equal(x.runtime.snapshot().phase, 'error'); assert.equal(x.runtime.errorKind, 'microphone');
  assert.equal(x.runtime.audio.recording, false);
  await x.runtime.start(); assert.equal(x.runtime.snapshot().phase, 'waiting'); assert.equal(x.starts(), 2);
  x.runtime.destroy(); assert.equal(x.stops(), 1);
});

test('autoplay blocking and pending permission have distinct recovery messages', async () => {
  for (const [reason, message] of [['autoplay', /阻止了自动收音/], ['permission-timeout', /尚未返回麦克风授权/]]) {
    const x = runtimeFixture({ denied: true, denialReason: reason }); await x.runtime.init(); await x.runtime.start();
    assert.equal(x.runtime.errorKind, 'microphone'); assert.match(x.runtime.error, message);
    await x.runtime.start(); assert.equal(x.runtime.audio.recording, true); x.runtime.destroy();
  }
});

test('manual stop preserves captions; settings save cannot silently resume', async () => {
  const x = runtimeFixture(); await x.runtime.init(); await x.runtime.start();
  x.update({ captions: [{ id: 's1', translations: trio }] });
  x.runtime.stop(); await x.runtime.save({ translation: { model: 'new-model' } });
  assert.equal(x.starts(), 1); assert.equal(x.runtime.audio.recording, false);
  assert.equal(x.runtime.session.captions[0].translations.yue, trio.yue);
  await x.runtime.start(); assert.equal(x.starts(), 2);
  x.runtime.destroy(); assert.equal(x.stops(), 2);
});

test('translation failure pauses capture while retaining previously shown captions', async () => {
  const x = runtimeFixture(); await x.runtime.init(); await x.runtime.start();
  x.update({ captions: [{ id: 's1', translations: trio }], translationErrors: 1 });
  assert.equal(x.runtime.audio.recording, false); assert.equal(x.runtime.snapshot().phase, 'error');
  assert.equal(x.runtime.session.captions[0].translations.en, trio.en);
  x.runtime.destroy();
});

test('the page shows the actual translation failure even when it is outside the rolling window', async () => {
  const x = runtimeFixture(); await x.runtime.init(); await x.runtime.start();
  const message = '翻译服务返回格式异常，原文已保留，请重试。';
  x.update({ captions: [{ id: 's60', translations: trio }], translationErrors: 1, translationFailure: { segmentId: 's1', kind: 'format', message } });
  assert.equal(x.runtime.error, message); assert.doesNotMatch(x.runtime.error, /设置/);
  assert.equal(x.runtime.session.captions[0].translations.en, trio.en);
  x.runtime.destroy();
});

test('ignored captions create no actionable warning while capture and later captions continue', async () => {
  const x = runtimeFixture(); await x.runtime.init(); await x.runtime.start();
  const refused = { translationErrors: 0, translationSkipped: 1, translationFailure: null };
  x.update({ ...refused, captions: [{ id: 's1', raw: '未译原文', translations: null }] });
  assert.equal(x.runtime.audio.recording, true); assert.equal(x.runtime.error, null);
  assert.equal(x.runtime.snapshot().warning, undefined); assert.equal(x.stops(), 0);
  x.update({ ...refused, captions: [{ id: 's1', raw: '未译原文', translations: null }, { id: 's2', translations: trio }] });
  assert.equal(x.runtime.session.captions[1].translations.yue, trio.yue);
  await x.runtime.stop(); await x.runtime.start(); assert.equal(x.starts(), 2);
  x.runtime.destroy();
});

test('ignored segments never change recording or manual-stop state', async () => {
  for (const stopped of [false, true]) {
    const x = runtimeFixture(); await x.runtime.init(); await x.runtime.start();
    if (stopped) x.runtime.stop();
    for (let n = 1; n <= 20; n++) x.update({ translationErrors: 0, translationSkipped: n });
    assert.equal(x.starts(), 1); assert.equal(x.runtime.audio.recording, !stopped);
    assert.equal(x.runtime.error, null); x.runtime.destroy();
  }
});

test('retry resumes capture after translation drains, but respects a manual stop', async () => {
  for (const stopped of [false, true]) {
    const x = runtimeFixture({ retryPending: 1 }); await x.runtime.init(); await x.runtime.start();
    x.update({ translationErrors: 1 });
    if (stopped) x.runtime.stop();
    const retrying = x.runtime.retry();
    await sleep(0); assert.equal(x.starts(), 1);
    x.update({ pendingTranslations: 0 }); await retrying;
    if (!stopped) await until(() => x.runtime.audio.recording);
    assert.equal(x.starts(), stopped ? 1 : 2);
    x.runtime.destroy();
  }
});
