import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Pcm16Encoder } from '../public/pcm-encoder.js';
import { CaptionAudio } from '../public/audio.js';
import { openMicrophone } from '../public/microphone.js';
import { pcmRms } from '../src/audio/pcm.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function encode(rate, channels) {
  const packets = [], encoder = new Pcm16Encoder(rate, buffer => packets.push(Buffer.from(buffer)));
  let start = 0;
  for (let block = 0; start < channels[0].length; block++) {
    const end = Math.min(channels[0].length, start + [127, 33, 1024, 256][block % 4]);
    encoder.push(channels.map(channel => channel.subarray(start, end))); start = end;
  }
  encoder.flush();
  return { pcm: Buffer.concat(packets), packets };
}

test('resampling maintains 16 kHz timing and a 1 kHz tone across irregular render blocks', () => {
  for (const rate of [16000, 44100, 48000, 96000]) {
    const wave = Float32Array.from({ length: rate }, (_, n) => .5 * Math.sin(2 * Math.PI * 1000 * n / rate));
    const { pcm, packets } = encode(rate, [wave]);
    assert.equal(pcm.length, 32000, String(rate));
    assert.equal(packets.length, 10);
    assert.ok(packets.every(packet => packet.length === 3200));
    assert.ok(pcmRms(pcm) > .34 && pcmRms(pcm) < .36);
    let crossings = 0;
    for (let i = 2; i < pcm.length; i += 2) if (pcm.readInt16LE(i - 2) < 0 && pcm.readInt16LE(i) >= 0) crossings++;
    assert.ok(crossings >= 998 && crossings <= 1001, String(crossings));
  }
});

test('fractional-rate sampling has no drift over ten seconds and produces explicit little-endian PCM', () => {
  const { pcm } = encode(44100, [new Float32Array(441000).fill(.5)]);
  assert.equal(pcm.length, 320000);
  // Zero padding at the stream edges produces a short filter transient.
  for (let i = 320; i < pcm.length - 320; i += 2) assert.equal(pcm.readInt16LE(i), 16384);
  assert.equal(pcmRms(pcm.subarray(320, -320)), .5);
  assert.equal(pcmRms(Buffer.from([0, 0, 64, 0, 64]).subarray(1)), .5);
  assert.equal(pcmRms(Buffer.alloc(0)), 0);
});

test('mono mixing cancels opposite channels, and out-of-range amplitudes saturate safely', () => {
  const channel = new Float32Array(4800).fill(.5);
  const mixed = encode(48000, [channel, channel.map(n => -n)]).pcm;
  assert.equal(pcmRms(mixed), 0);
  for (const [level, sample] of [[2, 32767], [-2, -32768]]) {
    const { pcm } = encode(48000, [new Float32Array(4800).fill(level)]);
    for (let i = 320; i < pcm.length - 320; i += 2) assert.equal(pcm.readInt16LE(i), sample);
    assert.ok([...new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2)].every(n => sample > 0 ? n >= 0 : n <= 0));
  }
});

test('stopping retains a short final packet and pads by less than one millisecond', () => {
  const { pcm, packets } = encode(48000, [new Float32Array(1788).fill(.25)]);
  assert.equal(packets.length, 1);
  assert.equal(pcm.length, 38 * 32);
  for (let i = 320; i < 596 * 2 - 320; i += 2) assert.equal(pcm.readInt16LE(i), 8192);
  assert.ok(pcm.subarray(596 * 2).every(byte => byte === 0));
});

test('rate conversion preserves speech-band tones and suppresses frequencies above the output Nyquist limit', () => {
  const referenceRms = .5 / Math.sqrt(2);
  for (const rate of [44100, 48000, 96000]) {
    for (const frequency of [100, 1000, 4000, 6400, 8800, 10000, 18000]) {
      const wave = Float32Array.from({ length: rate / 2 }, (_, i) => .5 * Math.sin(2 * Math.PI * frequency * i / rate));
      const { pcm } = encode(rate, [wave]);
      const signal = pcm.subarray(320, -320);
      const gain = pcmRms(signal) / referenceRms;
      if (frequency <= 6400) assert.ok(Math.abs(20 * Math.log10(gain)) < .1, `${rate} Hz input, ${frequency} Hz passband`);
      else assert.ok(gain < .001, `${rate} Hz input, ${frequency} Hz stopband`);
    }
  }
});

test('filtering keeps a quiet wanted tone when a much louder ultrasonic component is present', () => {
  for (const rate of [44100, 48000, 96000]) {
    const wave = Float32Array.from({ length: rate }, (_, i) => .05 * Math.sin(2 * Math.PI * 1000 * i / rate) + .9 * Math.sin(2 * Math.PI * 10000 * i / rate));
    const { pcm } = encode(rate, [wave]);
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2).subarray(160, -160);
    let wanted = 0, alias = 0;
    for (let i = 0; i < samples.length; i++) {
      wanted += samples[i] / 32768 * Math.sin(2 * Math.PI * 1000 * (i + 160) / 16000);
      alias += samples[i] / 32768 * Math.sin(2 * Math.PI * 6000 * (i + 160) / 16000);
    }
    assert.ok(Math.abs(2 * wanted / samples.length - .05) < .0001);
    assert.ok(Math.abs(2 * alias / samples.length) < .0001);
  }
});

test('filter lookahead is bounded and flush preserves sub-filter-length audio exactly once', () => {
  const packets = [], encoder = new Pcm16Encoder(48000, data => packets.push(Buffer.from(data)));
  encoder.push([new Float32Array(4800)]);
  assert.equal(packets.length, 0);
  encoder.push([new Float32Array(256)]);
  assert.equal(packets.length, 1);
  encoder.flush();
  const before = Buffer.concat(packets);
  assert.equal(before.length / 32, 106);
  encoder.flush(); encoder.push([new Float32Array(4800)]);
  assert.deepEqual(Buffer.concat(packets), before);
  const tiny = encode(48000, [new Float32Array(30).fill(.25)]).pcm;
  assert.equal(tiny.length, 32);
  assert.ok(pcmRms(tiny) > 0);
});

test('the AudioWorklet emits PCM, flushes once, and stops processing after its acknowledgement', () => {
  const messages = []; let Processor;
  const code = fs.readFileSync(new URL('../public/pcm-worklet.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '');
  vm.runInNewContext(code, {
    Pcm16Encoder, sampleRate: 48000,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (data, transfer) => messages.push(transfer ? structuredClone(data, { transfer }) : data) }; } },
    registerProcessor(name, implementation) { assert.equal(name, 'live-subtitles-microphone'); Processor = implementation; },
  });
  const processor = new Processor();
  assert.equal(processor.process([[new Float32Array(4800).fill(.25)]]), true);
  processor.process([[new Float32Array(1788).fill(.25)]]);
  processor.port.onmessage({ data: { type: 'flush' } });
  assert.deepEqual(messages.map(message => message.byteLength || message.type), [3200, 1216, 'flushed']);
  processor.port.onmessage({ data: { type: 'flush' } });
  assert.equal(processor.process([[new Float32Array(4800)]]), false);
  assert.equal(messages.length, 3);
});

function browser(t, { permissionError, suspended = false } = {}) {
  const saved = new Map(), log = [], nodes = [];
  const track = { stop() { log.push('track-stop'); this.onended?.(); } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const audioNode = () => ({ connect() {}, disconnect() { log.push('disconnect'); } });
  class Context {
    constructor() { this.state = suspended ? 'suspended' : 'running'; this.audioWorklet = { addModule: async path => { assert.equal(path, '/pcm-worklet.js'); } }; this.destination = {}; }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; log.push('context-close'); return Promise.resolve(); }
    createMediaStreamSource() { return audioNode(); }
    createGain() { return { ...audioNode(), gain: { value: 1 } }; }
  }
  class Worklet {
    constructor(_ctx, name) {
      assert.equal(name, 'live-subtitles-microphone'); Object.assign(this, audioNode());
      this.port = { postMessage: () => log.push('flush'), close: () => log.push('port-close') }; nodes.push(this);
    }
  }
  for (const [key, value] of Object.entries({ AudioContext: Context, AudioWorkletNode: Worklet, navigator: { mediaDevices: { getUserMedia: async () => { if (permissionError) throw permissionError; return stream; } } } })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  t.after(() => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return { log, nodes, track };
}

test('capture releases the microphone immediately, delivers its tail, and closes the graph exactly once', async t => {
  const x = browser(t), received = []; let ended = 0;
  const capture = await openMicrophone({ onPcm: data => received.push(data), onEnded: () => ended++ });
  const stopping = capture.stop();
  assert.equal(capture.stop(), stopping);
  assert.deepEqual(x.log, ['track-stop', 'flush']);
  const tail = new ArrayBuffer(1216);
  x.nodes[0].port.onmessage({ data: tail });
  x.nodes[0].port.onmessage({ data: { type: 'flushed' } });
  await stopping;
  assert.deepEqual(received, [tail]); assert.equal(ended, 0); assert.equal(capture.ctx.state, 'closed');
  assert.equal(x.log.filter(event => event === 'context-close').length, 1);
  assert.equal(x.log.filter(event => event === 'disconnect').length, 3);
});

test('permission denial closes the unused context and preserves the browser error', async t => {
  const error = Object.assign(new Error('permission denied'), { name: 'NotAllowedError' });
  const x = browser(t, { permissionError: error });
  await assert.rejects(openMicrophone({ onPcm() {} }), value => value === error);
  assert.deepEqual(x.log, ['context-close']);
});

test('autoplay blocking releases the granted device and gives an actionable reason', async t => {
  const x = browser(t, { suspended: true });
  await assert.rejects(openMicrophone({ onPcm() {} }), error => error.name === 'NotAllowedError' && error.reason === 'autoplay');
  assert.deepEqual(x.log, ['track-stop', 'context-close']);
});

test('pause waits for late worklet PCM, uploads it once, and ignores messages from a stopped capture', async () => {
  let onPcm, finish, stopped = 0, starts = 0;
  const sent = [], levels = [];
  const audio = new CaptionAudio({
    capture: async callbacks => {
      starts++; onPcm = callbacks.onPcm;
      return { ctx: { state: 'running' }, stop() { stopped++; return new Promise(resolve => { finish = resolve; }); } };
    },
    send: async chunk => sent.push({ startMs: chunk.startMs, bytes: Buffer.from(await chunk.body.arrayBuffer()) }),
    onLevel: level => levels.push(level),
  });
  await audio.start(); onPcm(new ArrayBuffer(3200)); const stale = onPcm;
  audio.stop(); const draining = audio.drain(); let drained = false; draining.then(() => { drained = true; });
  await tick(); await audio.start(); assert.equal(starts, 1); assert.equal(stopped, 1); assert.equal(drained, false);
  onPcm(new ArrayBuffer(1216)); finish(); await draining;
  assert.equal(sent.length, 1); assert.equal(sent[0].bytes.length, 4416); assert.equal(audio.timeMs, 138);
  assert.equal(levels.at(-1), 0);
  stale(new ArrayBuffer(3200)); assert.equal(audio.timeMs, 138);
  await audio.start(); assert.equal(starts, 2); audio.stop(); finish(); await audio.drain();
});
