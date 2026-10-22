// Upload PCM promptly. Utterance detection and repeated recognition live on the server.
export class CaptionAudio {
  constructor({ capture, send, onChange = () => {}, onError = () => {}, onVoice = () => {}, onLevel = () => {}, chunkId = () => crypto.randomUUID() }) {
    Object.assign(this, { capture, send, onChange, onError, onVoice, onLevel, chunkId });
    this.queue = []; this.recording = false; this.starting = false; this.sending = false; this.failed = false;
    this.timeMs = 0; this.frames = []; this.frameStart = 0; this.handle = null; this.epoch = 0; this.waiters = [];
    this.stopping = false; this.stopPromise = null;
  }
  get busy() { return this.starting || this.stopping || this.recording || this.sending || this.queue.length > 0; }
  snapshot() { return { recording: this.recording, starting: this.starting, pending: this.queue.length, sending: this.sending, failed: this.failed, timeMs: this.timeMs }; }
  changed() { this.onChange(this.snapshot()); }

  async start() {
    if (this.busy || this.failed) return;
    const epoch = ++this.epoch;
    this.starting = true; this.changed();
    let handle;
    try {
      handle = await this.capture({ source: 'mic', onPcm: buffer => { if (epoch === this.epoch) this.accept(buffer); }, onEnded: () => {
        if (epoch !== this.epoch || !this.recording) return;
        this.stop(); this.onError('麦克风已断开，请重新启用。', 'microphone');
      } });
      if (epoch !== this.epoch) { handle.stop(); return; }
      if (handle.ctx?.state !== 'running') {
        await handle.ctx?.resume();
        if (handle.ctx && handle.ctx.state !== 'running') throw Object.assign(new Error('浏览器需要点击后才能启动音频。'), { name: 'NotAllowedError' });
      }
      if (epoch !== this.epoch) { handle.stop(); return; }
      this.handle = handle; this.wallStart = Date.now() - this.timeMs; this.recording = true;
    } catch (e) { handle?.stop(); throw e; }
    finally { if (epoch === this.epoch) { this.starting = false; this.changed(); } }
  }

  stop() {
    if (this.stopping) return;
    this.recording = false; this.starting = false;
    const handle = this.handle; this.handle = null;
    this.stopping = !!handle;
    this.onLevel(0);
    const finished = () => {
      this.stopping = false; this.epoch++; this.stopPromise = null;
      this.flush(); this.changed();
    };
    const result = handle?.stop();
    if (result?.then) {
      this.stopPromise = Promise.resolve(result).catch(() => this.onError('麦克风尾部音频未能完整读取，请检查设备。', 'microphone')).finally(finished);
      this.changed();
    } else finished();
  }

  pause(message, kind = 'processing') { this.stop(); this.onError(message, kind); }
  retry() { this.failed = false; this.changed(); return this.pump(); }

  accept(buffer) {
    if (!this.recording && !this.stopping) return;
    const start = this.timeMs, duration = buffer.byteLength / 32;
    this.timeMs += duration;
    const samples = new Int16Array(buffer);
    let energy = 0; for (const sample of samples) energy += (sample / 32768) ** 2;
    const level = Math.sqrt(energy / Math.max(1, samples.length));
    if (this.recording) this.onLevel(level, samples);
    const loud = level >= 0.009;
    if (loud) this.onVoice();
    if (!this.frames.length) this.frameStart = start;
    this.frames.push(buffer);
    if (this.frames.reduce((n, f) => n + f.byteLength, 0) >= 6400) this.flush();
  }

  flush() {
    if (!this.frames.length) return;
    // The upload protocol accepts complete 100ms frames. Keep every sample from
    // the worklet's shorter stop tail, padding only its final frame with silence.
    const bytes = this.frames.reduce((n, frame) => n + frame.byteLength, 0), padding = (3200 - bytes % 3200) % 3200;
    if (padding) { this.frames.push(new ArrayBuffer(padding)); this.timeMs += padding / 32; }
    this.queue.push({ body: new Blob(this.frames, { type: 'application/octet-stream' }), startMs: Math.round(this.frameStart), chunkId: this.chunkId(), capturedAt: (this.wallStart || Date.now()) + this.frameStart });
    this.frames = [];
    if (this.recording && this.queue.reduce((n, c) => n + c.body.size / 32, 0) >= 12000) this.pause('音频上传较慢，正在处理已录音频。', 'backpressure');
    this.changed(); void this.pump();
  }

  async drain() {
    if (this.stopPromise) await this.stopPromise;
    if (!this.sending && !this.queue.length) return;
    if (this.failed) throw new Error('音频尚未上传，请重试。');
    await new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async pump() {
    if (this.sending || this.failed) return;
    this.sending = true; this.changed();
    while (this.queue.length && !this.failed) {
      try { await this.send(this.queue[0]); this.queue.shift(); }
      catch (e) {
        this.failed = true; this.stop();
        this.onError(e.message + ' 已保留待处理音频，重试前请勿刷新页面。', 'processing');
      }
      this.changed();
    }
    this.sending = false; this.changed();
    for (const waiter of this.waiters.splice(0)) {
      if (this.failed) waiter.reject(new Error('音频尚未上传，请重试。')); else waiter.resolve();
    }
  }
}
