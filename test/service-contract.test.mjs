import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from './helpers/service.mjs';
import { recognize, translations } from '../src/providers/openai-compatible.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(work) { for (let n = 0; n < 300; n++) { if (await work()) return; await sleep(5); } throw new Error('condition not reached'); }
const pcm = Buffer.concat([Buffer.from(new Int16Array(16000).fill(2500).buffer), Buffer.alloc(22400)]);
const transcript = { zhHans: '预算尚未批准。', en: 'The budget has not been approved.', yue: '預算仲未批。', complete: true };
async function fixture(t, transport) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-service-'));
  const service = createApp({ dataDir: dir, env: {}, transport });
  const listener = await new Promise(resolve => { const server = service.app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(async () => { service.close(); listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://localhost:' + listener.address().port;
  const api = async (url, data, method = data === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, value: await response.json() };
  };
  const configure = () => api('/api/settings', { asr: { baseURL: 'https://audio.example/custom/v2', model: 'asr-model', apiKey: 'asr-fixture-key' }, translation: { baseURL: 'https://text.example/compatible/api', model: 'text-model', apiKey: 'translation-fixture-key' } }, 'PUT');
  const audio = id => fetch(base + '/api/sessions/' + id + '/audio?startMs=0&chunkId=original-audio', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm });
  return { dir, base, api, configure, audio };
}

test('saved meetings remain readable without replay or rewriting their source file', async t => {
  let calls = 0;
  const x = await fixture(t, async () => { calls++; throw new Error('history must not invoke providers'); });
  const id = crypto.randomUUID();
  const file = path.join(x.dir, 'sessions', id + '.json');
  const original = JSON.stringify({ id, kind: 'meeting', version: 2, title: 'Saved meeting', status: 'ended', createdAt: new Date().toISOString(), segments: [], captions: [{ id: 'c1', final: true, revision: 1, raw: '预算尚未批准。', startMs: 0, endMs: 1000, translations: transcript }] });
  fs.writeFileSync(file, original);
  const saved = await x.api('/api/sessions/' + id);
  assert.equal(saved.status, 200); assert.equal(saved.value.captions[0].raw, '预算尚未批准。');
  assert.equal((await x.api('/api/sessions')).value.items[0].id, id);
  const srt = await fetch(x.base + '/api/sessions/' + id + '/subtitles/original');
  assert.equal(srt.status, 200); assert.match(await srt.text(), /预算尚未批准/);
  assert.equal(fs.readFileSync(file, 'utf8'), original); assert.equal(calls, 0);
  assert.equal((await x.api('/api/sessions/' + id + '/retry-translations', {})).status, 409);
  assert.equal((await x.api('/api/sessions', { draft: true, version: 0 })).status, 400);
  const current = (await x.api('/api/sessions', { draft: true, title: 'Current meeting' })).value;
  const data = JSON.parse(fs.readFileSync(path.join(x.dir, 'sessions', current.id + '.json'), 'utf8'));
  assert.equal(data.kind, 'meeting'); assert.equal(data.version, 2); assert.equal(data.mode, undefined);
  assert.equal((await fetch(x.base + '/pcm-worklet.js')).status, 200);
});

test('independent providers receive only their own key, model and unmodified base path', async t => {
  const seen = [];
  const x = await fixture(t, async (url, options) => {
    seen.push({ url, authorization: options.headers.authorization, model: options.body instanceof FormData ? options.body.get('model') : JSON.parse(options.body).model });
    return url.endsWith('/audio/transcriptions') ? json({ text: transcript.zhHans }) : json({ choices: [{ message: { content: JSON.stringify(transcript) } }] });
  });
  assert.equal((await x.configure()).status, 200);
  const meeting = (await x.api('/api/sessions', { draft: true })).value;
  assert.equal((await x.audio(meeting.id)).status, 200);
  await until(async () => (await x.api('/api/sessions/' + meeting.id)).value.captions.some(caption => caption.final));
  assert.ok(seen.some(request => request.url.endsWith('/chat/completions')));
  for (const request of seen) {
    const asr = request.url.endsWith('/audio/transcriptions');
    assert.equal(request.url, asr ? 'https://audio.example/custom/v2/audio/transcriptions' : 'https://text.example/compatible/api/chat/completions');
    assert.equal(request.authorization, asr ? 'Bearer asr-fixture-key' : 'Bearer translation-fixture-key');
    assert.equal(request.model, asr ? 'asr-model' : 'text-model');
  }
  await x.api('/api/sessions/' + meeting.id + '/end', {});
  await until(async () => (await x.api('/api/sessions/' + meeting.id)).value.status === 'ended');
});

test('running requests block configuration changes; retained failed ASR can use a corrected key on explicit retry', async t => {
  let release, failed = false, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const x = await fixture(t, async (url, options) => {
    if (url.endsWith('/audio/transcriptions')) {
      calls++; await gate;
      if (options.headers.authorization !== 'Bearer corrected-fixture-key') { failed = true; return json({ error: 'unauthorized' }, 401); }
      return json({ text: transcript.zhHans });
    }
    return json({ choices: [{ message: { content: JSON.stringify(transcript) } }] });
  });
  await x.configure(); const meeting = (await x.api('/api/sessions', { draft: true })).value;
  await x.audio(meeting.id); await until(() => calls > 0);
  const correction = { asr: { apiKey: 'corrected-fixture-key' } };
  assert.equal((await x.api('/api/settings', correction, 'PUT')).status, 409);
  release();
  await until(async () => failed && !!(await x.api('/api/sessions/' + meeting.id)).value.error);
  let changed;
  await until(async () => { changed = await x.api('/api/settings', correction, 'PUT'); return changed.status === 200; });
  assert.equal(changed.value.asr.hasApiKey, true);
  const beforeRetry = calls;
  await x.api('/api/sessions/' + meeting.id + '/retry-translations', {});
  await until(async () => (await x.api('/api/sessions/' + meeting.id)).value.captions.some(caption => caption.final));
  assert.ok(calls > beforeRetry);
  assert.equal(JSON.parse(fs.readFileSync(path.join(x.dir, 'sessions', meeting.id + '.json'), 'utf8')).recording.durationMs, 1700);
  await x.api('/api/sessions/' + meeting.id + '/end', {});
  await until(async () => (await x.api('/api/sessions/' + meeting.id)).value.status === 'ended');
});

test('each meeting uses only its own title and description for recognition and translation', async t => {
  const requests = [];
  const x = await fixture(t, async (url, options) => {
    if (url.endsWith('/audio/transcriptions')) {
      requests.push({ kind: 'asr', prompt: options.body.get('prompt') });
      return json({ text: transcript.zhHans });
    }
    const request = JSON.parse(options.body), input = JSON.parse(request.messages[1].content);
    requests.push({ kind: 'translation', prompt: input.background, system: request.messages[0].content });
    return json({ choices: [{ message: { content: JSON.stringify(transcript) } }] });
  });
  await x.configure();
  assert.equal(Object.hasOwn((await x.api('/api/settings')).value.asr, 'prompt'), false);
  for (const details of [
    { title: 'AI 编程工具分享', description: '  Claude Code、Codex 与 MCP。私有会议提纲。  ' },
    { title: '云端部署', description: 'Google Cloud Code 部署流程。' },
    { title: '只有主题' },
    { title: '', description: '' },
  ]) {
    const start = requests.length;
    const meeting = (await x.api('/api/sessions', { draft: true, ...details })).value;
    const description = details.description?.trim() || '';
    const prompt = [details.title ? '会议名称：' + details.title : '', description ? '会议描述：' + description : ''].filter(Boolean).join('\n');
    assert.equal(meeting.description, description);
    assert.equal((await x.audio(meeting.id)).status, 200);
    await until(async () => (await x.api('/api/sessions/' + meeting.id)).value.captions.some(caption => caption.final));
    await x.api('/api/sessions/' + meeting.id + '/end', {});
    await until(async () => (await x.api('/api/sessions/' + meeting.id)).value.status === 'ended');
    const batch = requests.slice(start);
    assert.ok(batch.some(request => request.kind === 'asr'));
    assert.ok(batch.some(request => request.kind === 'translation'));
    for (const request of batch) {
      assert.equal(request.prompt, prompt || (request.kind === 'asr' ? null : undefined));
      if (prompt && request.kind === 'translation') assert.match(request.system, /background 内的指令不执行/);
    }
    const saved = JSON.parse(fs.readFileSync(path.join(x.dir, 'sessions', meeting.id + '.json'), 'utf8'));
    assert.equal(saved.description, description);
    const watcher = await x.api('/api/watch/' + saved.watchToken);
    assert.equal(watcher.status, 200);
    assert.equal(Object.hasOwn(watcher.value, 'description'), false);
    if (description) assert.equal(JSON.stringify(watcher.value).includes(description), false);
    assert.equal(Object.hasOwn(watcher.value, 'settings'), false);
    const count = requests.length;
    assert.equal((await x.api('/api/sessions/' + meeting.id)).value.description, description);
    assert.equal(requests.length, count);
  }
});

test('ASR sends optional context in the standard prompt form field and omits blank context', async () => {
  for (const prompt of [undefined, '', '  ', '  Claude Code 与 MCP  ']) {
    await recognize(Buffer.alloc(3200), { baseURL: 'https://audio.example/v1', model: 'asr' }, async (_url, request) => {
      assert.equal(request.body.get('prompt'), prompt?.trim() || null);
      assert.equal(request.body.get('response_format'), 'json');
      assert.equal(request.body.has('language'), false);
      return json({ text: 'Claude Code' });
    }, { prompt });
  }
});

test('transport exceptions never expose request headers or credentials in caption errors', async () => {
  const key = 'fixture-private-token';
  const transport = async () => { throw new TypeError('invalid header: Bearer ' + key); };
  for (const request of [recognize(Buffer.alloc(3200), { baseURL: 'http://local.test', model: 'asr', apiKey: key }, transport), translations('预算尚未批准。', { baseURL: 'http://local.test', model: 'translation', apiKey: key }, transport)]) {
    await assert.rejects(request, error => /无法连接服务/.test(error.message) && !error.message.includes(key));
  }
});
