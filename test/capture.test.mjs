import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './helpers/service.mjs';
import { CaptionRuntime } from '../public/runtime.js';

async function service(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-owner-'));
  const service = createApp({ dataDir: dir, env: { ASR_BASE_URL: 'http://fake/v1', ASR_MODEL: 'asr', TRANSLATION_BASE_URL: 'http://fake/v1', TRANSLATION_MODEL: 'text' }, ...options });
  const server = await new Promise(resolve => { const s = service.app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const api = async (route, { data, body, method } = {}) => {
    const response = await fetch(base + route, { method: method || (data !== undefined || body ? 'POST' : 'GET'), headers: { 'content-type': body ? 'application/octet-stream' : 'application/json' }, body: body || (data === undefined ? undefined : JSON.stringify(data)) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status, code: value.code });
    // These runtime tests omit EventSource; return its eventual drained snapshot.
    if (route.endsWith('/flush')) {
      for (let n = 0; n < 100; n++) {
        const snapshot = await api(route.slice(0, -6));
        if (!snapshot.draining && !snapshot.processing && !snapshot.pendingTranslations) return snapshot;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error('Synthetic drain timed out');
    }
    return value;
  };
  const pages = [];
  const page = (captureError = null) => {
    let starts = 0;
    const runtime = new CaptionRuntime({ api, capture: async () => { starts++; if (captureError) throw captureError; return { ctx: { state: 'running' }, stop() {} }; }, subscribe: () => () => {} });
    pages.push(runtime); return { runtime, starts: () => starts };
  };
  t.after(async () => { for (const r of pages) r.destroy(); service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { api, page };
}

test('two host pages cannot start two microphones for the same meeting', async t => {
  const s = await service(t), a = s.page(), b = s.page();
  await a.runtime.init(); await b.runtime.init();
  await a.runtime.start(); await b.runtime.start();
  assert.equal(a.starts(), 1); assert.equal(b.starts(), 0); assert.equal(a.runtime.audio.recording, true);
  assert.match(b.runtime.error, /另一个页面正在收音/);
  await assert.rejects(s.api('/api/sessions/' + a.runtime.session.id + '/audio?startMs=0&chunkId=intruder&captureId=wrong-owner', { body: new Blob([new ArrayBuffer(6400)]) }), e => e.status === 409 && e.code === 'capture_busy');
  await a.runtime.pause();
});

test('a page opened before another capture synchronizes to the saved end only when starting an empty queue', async t => {
  const s = await service(t), a = s.page().runtime, b = s.page().runtime;
  await a.init(); await b.init(); await a.start();
  a.audio.accept(new ArrayBuffer(6400)); await a.audio.drain();
  b.receive(await s.api('/api/sessions/' + a.session.id));
  assert.equal(b.audio.timeMs, 0); assert.equal(b.session.ingestEndMs, 200);
  await a.pause(); await b.start(); assert.equal(b.audio.timeMs, 200);
  b.audio.accept(new ArrayBuffer(6400)); await b.pause();
  assert.equal(b.error, null); assert.equal(b.audio.timeMs, 400);
  assert.equal((await s.api('/api/sessions/' + b.session.id)).recording.durationMs, 400);
});

test('denied microphone permission releases the reservation without marking capture as started', async t => {
  const s = await service(t), a = s.page(Object.assign(new Error('denied'), { name: 'NotAllowedError' })), b = s.page();
  await a.runtime.init(); await b.runtime.init(); await a.runtime.start();
  const snapshot = await s.api('/api/sessions/' + a.runtime.session.id);
  assert.equal(a.runtime.captureOwned, false); assert.equal(snapshot.status, 'ready'); assert.equal(snapshot.startedAt, undefined);
  await b.runtime.start(); assert.equal(b.starts(), 1); assert.equal(b.runtime.audio.recording, true); await b.runtime.pause();
});

test('an abandoned lease can be replaced, but old pending audio cannot overwrite or move past the new owner', async t => {
  let now = 0;
  const s = await service(t, { captureNow: () => now }), a = s.page().runtime, b = s.page().runtime;
  await a.init(); await b.init(); await a.start();
  now += 15001; await b.start();
  assert.equal(b.audio.recording, true); b.audio.accept(new ArrayBuffer(6400)); await b.audio.drain();
  a.audio.accept(new ArrayBuffer(6400)); await assert.rejects(a.audio.drain(), /尚未上传/);
  const queued = a.audio.queue[0]; assert.equal(queued.startMs, 0); assert.equal(a.audio.queue.length, 1);
  await a.retry(); assert.equal(a.audio.queue[0], queued); assert.match(a.error, /另一个页面/);
  assert.equal((await s.api('/api/sessions/' + b.session.id)).recording.durationMs, 200);
  await b.pause();
});
