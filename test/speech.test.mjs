import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSpeechDetector, SpeechPipeline } from '../src/audio/speech-detector.js';
import { IncrementalAsr } from '../src/captions/incremental-asr.js';
import { ModelLane } from '../src/captions/model-lane.js';
import { createApp } from '../src/server.js';

function noise(ms) {
  const pcm = Buffer.alloc(ms * 32); let seed = 12345;
  for (let n = 0; n < pcm.length / 2; n++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const click = n % 16000 < 240 ? .25 : 0;
    pcm.writeInt16LE(Math.round(((seed / 2 ** 32 - .5) * .035 + .02 + click) * 32768), n * 2);
  }
  return pcm;
}
function pcmFromWav(file) {
  const wav = fs.readFileSync(file);
  for (let at = 12; at + 8 <= wav.length;) {
    const length = wav.readUInt32LE(at + 4);
    if (wav.toString('ascii', at, at + 4) === 'data') return wav.subarray(at + 8, at + 8 + length);
    at += 8 + length + length % 2;
  }
  throw new Error('WAV fixture has no audio');
}

test('real local VAD suppresses high-energy noise instead of asking ASR to invent silence captions', async t => {
  let calls = 0;
  const asr = new IncrementalAsr({ lane: new ModelLane(), recognize: async () => { calls++; return '嗯。'; }, onResult: () => assert.fail('noise became speech') });
  const speech = new SpeechPipeline({ onFrame: (pcm, at, p) => asr.feed(pcm, at, [p]) });
  t.after(() => { speech.close(); asr.close(); });
  speech.feed(noise(20000), 0); await speech.drain(); await asr.drain();
  assert.equal(speech.metrics.frames, 200); assert.equal(speech.metrics.speechFrames, 0); assert.equal(calls, 0);
});

test('real local VAD admits English speech, retains its audio, and resets between captures', async t => {
  const source = pcmFromWav(new URL('./fixtures/scan.wav', import.meta.url));
  const pcm = Buffer.alloc(Math.ceil(source.length / 3200) * 3200 + 32000); source.copy(pcm);
  const captions = [], inputs = [];
  const asr = new IncrementalAsr({ lane: new ModelLane(), recognize: async audio => { inputs.push(audio); return 'You can scan for live captions.'; }, onResult: r => captions.push(r) });
  const detector = await createSpeechDetector(), speech = new SpeechPipeline({ factory: async () => detector, onFrame: (pcm, at, p) => asr.feed(pcm, at, [p]) });
  t.after(() => { speech.close(); asr.close(); });
  speech.feed(pcm, 0); await speech.drain(); await asr.drain();
  assert.ok(speech.metrics.speechFrames >= 5); assert.ok(inputs.length); assert.equal(captions.at(-1).raw, 'You can scan for live captions.');
  const requests = inputs.length;
  speech.reset(); speech.feed(Buffer.alloc(320000), pcm.length / 32); await speech.drain(); await asr.drain();
  assert.equal(inputs.length, requests);
  const a = await createSpeechDetector(), b = await createSpeechDetector();
  const frame = pcm.subarray(0, 3200);
  assert.equal(await a.probability(frame), await b.probability(frame));
});

test('VAD failures retain the exact unprocessed offset and retry without duplicating earlier frames', async () => {
  const frames = []; let calls = 0, errors = 0;
  const speech = new SpeechPipeline({ factory: async () => ({ reset() {}, async probability() { if (++calls === 2) throw new Error('inference failed'); return .9; } }),
    onFrame: (_pcm, at) => frames.push(at), onError: () => errors++,
  });
  speech.feed(Buffer.alloc(6400), 500);
  await assert.rejects(speech.drain(), /人声检测/);
  assert.deepEqual(frames, [500]); assert.equal(speech.pendingMs, 100); assert.equal(errors, 1);
  await speech.retry(); assert.deepEqual(frames, [500, 600]); assert.equal(speech.pendingMs, 0);
  speech.close();
});

test('HTTP audio ACKs precede local VAD, preserve noise in WAV, and do not replay duplicate uploads', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-recording-'));
  let release, requests = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const service = createApp({ dataDir: dir,
    env: { ASR_BASE_URL: 'http://fake/v1', ASR_MODEL: 'asr', TRANSLATION_MODEL: 'text' },
    speechDetectorFactory: async () => { await gate; return createSpeechDetector(); },
    transport: async () => { requests++; throw new Error('Noise must not reach a model'); },
  });
  const server = await new Promise(resolve => { const s = service.app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { release(); service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const api = async (route, pcm) => {
    const response = await fetch(base + route, { method: pcm ? 'POST' : 'GET',
      headers: pcm ? { 'content-type': 'application/octet-stream' } : {}, body: pcm, signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.ok, true, await response.clone().text()); return response.json();
  };
  const session = await api('/api/sessions/current'), route = '/api/sessions/' + session.id;
  const pcm = noise(2000), upload = route + '/audio?startMs=0&chunkId=noise';
  assert.equal((await api(upload, pcm)).endMs, 2000);
  assert.equal((await api(upload, pcm)).endMs, 2000);
  const pending = await api(route);
  assert.equal(pending.processing, true); assert.equal(pending.recording.durationMs, 2000);
  release();
  await fetch(base + route + '/flush', { method: 'POST' });
  let result;
  for (let n = 0; n < 200; n++) {
    result = await api(route);
    if (!result.processing && !result.draining) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(result.processing, false); assert.equal(result.draining, false);
  assert.equal(result.metrics.vad.frames, 20); assert.equal(result.captionCount, 0); assert.equal(requests, 0);
  const wav = fs.readFileSync(path.join(dir, 'recordings', session.id, 'audio-0001.wav'));
  assert.deepEqual(wav.subarray(44), pcm);
});
