import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';

const modelPath = fileURLToPath(new URL('../../assets/silero-vad/silero_vad.onnx', import.meta.url));
let sharedSession;

export async function createSpeechDetector() {
  sharedSession ||= ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1,
  }).catch(error => { sharedSession = null; throw error; });
  return new SpeechDetector(await sharedSession);
}

class SpeechDetector {
  constructor(session) {
    this.session = session;
    this.rate = new ort.Tensor('int64', BigInt64Array.of(16000n), []);
    this.reset();
  }

  reset() {
    this.state = new ort.Tensor('float32', new Float32Array(256), [2, 1, 128]);
    this.context = new Float32Array(64); this.remaining = new Float32Array(0);
  }

  async probability(pcm) {
    const samples = new Float32Array(this.remaining.length + pcm.length / 2);
    samples.set(this.remaining);
    for (let n = 0; n < pcm.length / 2; n++) samples[this.remaining.length + n] = pcm.readInt16LE(n * 2) / 32768;
    let offset = 0, probability = 0;
    // Carry partial 32ms windows across uploads; padding every 100ms would add
    // artificial silence and change the recurrent detector's audio stream.
    while (offset + 512 <= samples.length) {
      const input = new Float32Array(576);
      input.set(this.context); input.set(samples.subarray(offset, offset + 512), 64);
      const result = await this.session.run({ input: new ort.Tensor('float32', input, [1, 576]), state: this.state, sr: this.rate });
      probability = Math.max(probability, result.output.data[0]);
      this.state = result.stateN; this.context = input.slice(-64); offset += 512;
    }
    this.remaining = samples.slice(offset);
    return probability;
  }
}

// Durable recording ACKs stay independent of local inference. A failed frame
// remains queued at its exact offset and can be retried without feeding twice.
export class SpeechPipeline {
  constructor({ factory = createSpeechDetector, onFrame, onError = () => {}, onChange = () => {} }) {
    Object.assign(this, { factory, onFrame, onError, onChange });
    this.queue = []; this.task = null; this.detector = null; this.error = null; this.closed = false;
    this.metrics = { frames: 0, speechFrames: 0, elapsedMs: 0 };
  }
  get pendingMs() { return this.queue.reduce((n, item) => n + (item.pcm.length - item.offset) / 32, 0); }
  feed(pcm, startMs) {
    if (this.closed) return;
    this.queue.push({ pcm: Buffer.from(pcm), startMs, offset: 0 });
    void this.pump();
  }
  pump() {
    if (this.task || this.error || this.closed || !this.queue.length) return this.task;
    this.task = Promise.resolve().then(async () => {
      this.detector ||= await this.factory();
      while (!this.closed && this.queue.length) {
        const item = this.queue[0];
        while (!this.closed && item.offset < item.pcm.length) {
          const frame = item.pcm.subarray(item.offset, item.offset + 3200), started = performance.now();
          const probability = await this.detector.probability(frame);
          if (this.closed) return;
          if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Invalid speech probability');
          this.onFrame(frame, item.startMs + item.offset / 32, probability);
          item.offset += frame.length; this.metrics.frames++;
          if (probability >= .5) this.metrics.speechFrames++;
          this.metrics.elapsedMs += performance.now() - started;
        }
        if (!this.closed) this.queue.shift();
      }
    }).catch(() => {
      if (this.closed) return;
      this.error = new Error('本地人声检测未能运行，录音已保存，请检查安装后重试。'); this.onError(this.error);
    }).finally(() => { this.task = null; this.onChange(); });
    return this.task;
  }
  async drain() {
    while (this.task || this.queue.length) {
      if (this.error) throw this.error;
      await (this.task || this.pump());
    }
    if (this.error) throw this.error;
  }
  async retry() { this.error = null; this.detector = null; await this.drain(); }
  reset() { this.detector?.reset(); }
  close() { this.closed = true; this.queue = []; }
}
