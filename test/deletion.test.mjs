import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { createApp } from './helpers/service.mjs';
import { MeetingDeletion } from '../src/storage/meeting-deletion.js';
import { RecordingStore } from '../src/storage/recording-store.js';
import { CaptionRuntime } from '../public/runtime.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-delete-test-'));
  let calls = 0;
  const service = createApp({ env: {}, dataDir: dir, transport: async () => { calls++; throw new Error('deleting/reading cannot call a model'); } });
  const server = await new Promise((resolve, reject) => { const s = service.app.listen(0, '0.0.0.0', () => resolve(s)); s.on('error', reject); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const res = await fetch(base + route, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const seed = (status = 'ended', audioBytes = 6400) => {
    const id = crypto.randomUUID(), token = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(path.join(dir, 'sessions', id + '.json'), JSON.stringify({ id, version: 2, kind: 'meeting', title: 'Temporary deletion test', createdAt: new Date().toISOString(), status, startedAt: new Date().toISOString(), watchToken: token, segments: [], captions: [{ id: 'c1', revision: 1, final: true, raw: '尚未批准。', translations: { zhHans: '尚未批准。', en: 'Not approved yet.', yue: '仲未批。' }, startMs: 0, endMs: 200 }] }));
    if (audioBytes) new RecordingStore(path.join(dir, 'recordings', id)).append(crypto.randomBytes(audioBytes), { id: 'recorded', startMs: 0 });
    return { id, token, route: '/api/sessions/' + id };
  };
  t.after(async () => { service.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, base, api, seed, port: server.address().port, calls: () => calls };
}

test('confirmed deletion purges all meeting files, revokes its token, and remains deleted after restart', async t => {
  const x = await fixture(t), s = x.seed(), other = x.seed();
  await x.api(s.route); await (await fetch(x.base + s.route + '/subtitles/original')).text();
  const checkpoint = fs.readFileSync(path.join(x.dir, 'sessions', s.id + '.json'), 'utf8');
  fs.writeFileSync(path.join(x.dir, 'current.json'), JSON.stringify({ id: s.id }));
  const settings = JSON.stringify({ version: 2, asr: { baseURL: '', model: '', apiKey: 'fixture-private-key' }, translation: { baseURL: '', model: '', apiKey: '', useAsrConnection: false }, networkAddress: '' });
  fs.writeFileSync(path.join(x.dir, 'settings.json'), settings);
  const host = await fetch(x.base + s.route + '/events', { signal: AbortSignal.timeout(5000) });
  const phone = await fetch(x.base + '/api/watch/' + s.token + '/events', { signal: AbortSignal.timeout(5000) });
  assert.equal((await x.api('/api/sessions/' + s.id.toUpperCase(), { confirm: true }, 'DELETE')).status, 200);
  assert.match(await host.text(), /event: deleted/); assert.match(await phone.text(), /event: deleted/);
  for (const route of [s.route, s.route + '/captions', s.route + '/download', s.route + '/subtitles/original', '/api/watch/' + s.token]) assert.equal((await fetch(x.base + route)).status, 404, route);
  assert.equal((await x.api('/api/sessions')).body.items.some(row => row.id === s.id), false);
  for (const file of [path.join('sessions', s.id + '.json'), path.join('recordings', s.id), path.join('subtitles', s.id)]) assert.equal(fs.existsSync(path.join(x.dir, file)), false);
  assert.equal(fs.existsSync(path.join(x.dir, 'current.json')), false);
  assert.equal(fs.readFileSync(path.join(x.dir, 'settings.json'), 'utf8'), settings);
  assert.equal((await x.api(other.route)).status, 200);
  assert.equal((await x.api(s.route, { confirm: true }, 'DELETE')).status, 200);
  assert.doesNotMatch(fs.readFileSync(path.join(x.dir, 'deleted', s.id + '.json'), 'utf8'), /approved|批准|Temporary|token/);
  assert.equal(x.calls(), 0);
  fs.writeFileSync(path.join(x.dir, 'sessions', s.id + '.json'), checkpoint); // Simulate a stale write before restart.
  const restarted = createApp({ env: {}, dataDir: x.dir, transport: async () => { throw new Error('restart cannot replay models'); } });
  const listener = await new Promise(r => { const l = restarted.app.listen(0, '127.0.0.1', () => r(l)); });
  t.after(async () => { restarted.close(); listener.closeAllConnections(); await new Promise(r => listener.close(r)); });
  const restartedBase = 'http://127.0.0.1:' + listener.address().port;
  assert.equal((await fetch(restartedBase + s.route)).status, 404);
  assert.equal((await fetch(restartedBase + '/api/watch/' + s.token)).status, 404);
  assert.equal(fs.existsSync(path.join(x.dir, 'sessions', s.id + '.json')), false);
});

test('deletion needs confirmation, rejects active meetings, and cannot be invoked from LAN or a foreign origin', async t => {
  const x = await fixture(t), ended = x.seed();
  assert.equal((await x.api(ended.route, {}, 'DELETE')).status, 400);
  for (const status of ['ready', 'recording', 'paused', 'finalizing']) {
    const s = x.seed(status, 0); await x.api(s.route); // Context is deliberately a saved fixture; mark active through start where supported.
    if (status === 'recording' || status === 'finalizing') continue; // Loaded active files correctly recover as interrupted.
    assert.equal((await x.api(s.route, { confirm: true }, 'DELETE')).status, 409);
  }
  await x.api('/api/settings', { asr: { baseURL: 'http://localhost:8000', model: 'a' }, translation: { baseURL: 'http://localhost:8000', model: 'b' } }, 'PUT');
  const ready = (await x.api('/api/sessions', { draft: true, title: 'active' })).body;
  await x.api('/api/sessions/' + ready.id + '/start', {});
  assert.equal((await x.api('/api/sessions/' + ready.id, { confirm: true }, 'DELETE')).status, 409);
  const foreign = await fetch(x.base + ended.route, { method: 'DELETE', headers: { origin: 'https://foreign.example', 'content-type': 'application/json' }, body: '{"confirm":true}' });
  assert.equal(foreign.status, 403);
  const address = Object.values(os.networkInterfaces()).flat().find(v => v?.family === 'IPv4' && !v.internal)?.address;
  if (address) assert.equal((await fetch('http://' + address + ':' + x.port + ended.route, { method: 'DELETE', headers: { host: 'localhost:' + x.port, 'content-type': 'application/json' }, body: '{"confirm":true}' })).status, 403);
  assert.equal((await x.api(ended.route)).status, 200);
  assert.equal((await x.api('/api/sessions/not-a-meeting', { confirm: true }, 'DELETE')).status, 404);
});

test('a deletion marker write failure retains the meeting; cleanup can be retried after a partial disk failure', async t => {
  const x = await fixture(t), s = x.seed();
  await x.api(s.route);
  fs.writeFileSync(path.join(x.dir, 'deleted'), 'temporary obstruction');
  assert.equal((await x.api(s.route, { confirm: true }, 'DELETE')).status, 503);
  assert.equal((await x.api(s.route)).status, 200);
  assert.equal(fs.existsSync(path.join(x.dir, 'recordings', s.id)), true);
  fs.unlinkSync(path.join(x.dir, 'deleted'));
  let failed = false;
  const deletion = new MeetingDeletion(x.dir, { ...fs, rmSync(file, options) { if (!failed && file === path.join(x.dir, 'recordings', s.id)) { failed = true; throw new Error('disk failure'); } return fs.rmSync(file, options); } });
  deletion.mark(s.id); assert.throws(() => deletion.purge(s.id), /disk failure/);
  assert.equal((await x.api(s.route)).status, 404, 'tombstone rejects even a cached meeting');
  assert.equal((await x.api('/api/watch/' + s.token)).status, 404);
  assert.equal((await x.api('/api/sessions')).body.items.some(row => row.id === s.id), false);
  new MeetingDeletion(x.dir).recover();
  assert.equal(fs.existsSync(path.join(x.dir, 'recordings', s.id)), false);
  assert.equal((await x.api(s.route, { confirm: true }, 'DELETE')).status, 200);
});

test('a meeting cannot be deleted during its archive download', async t => {
  const x = await fixture(t), s = x.seed('ended', 6400000);
  let request;
  const response = await new Promise((resolve, reject) => { request = http.get(x.base + s.route + '/download', res => { res.pause(); resolve(res); }); request.on('error', reject); });
  assert.equal(response.statusCode, 200);
  assert.equal((await x.api(s.route, { confirm: true }, 'DELETE')).status, 409);
  response.destroy(); request.destroy();
  let removed;
  for (let i = 0; i < 100; i++) { removed = await x.api(s.route, { confirm: true }, 'DELETE'); if (removed.status === 200) break; await sleep(5); }
  assert.equal(removed.status, 200);
});

test('forgetting a deleted saved meeting clears its subscription and does not prevent a new manual meeting', async () => {
  let disconnected = 0, captures = 0;
  const runtime = new CaptionRuntime({ api: async (route, options) => route === '/api/settings' ? { configured: true } : route === '/api/sessions' ? { id: 'new', title: options.data.title, version: 2, status: 'ready' } : { id: 'old', version: 2, status: 'ended', startedAt: '2026-10-22' }, capture: async () => { captures++; }, subscribe: () => () => disconnected++ });
  await runtime.init(); runtime.forgetMeeting('old');
  assert.equal(runtime.session, null); assert.equal(disconnected, 1); assert.equal(runtime.error, null);
  await runtime.createMeeting('next'); assert.equal(runtime.session.id, 'new'); assert.equal(captures, 0); runtime.destroy();
});
