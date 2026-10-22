// Segment speech locally and revise each utterance from cumulative ASR results.
import { pcmRms } from '../audio/pcm.js';

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const normalized = text => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const scriptDrop = (prior, current) => {
  const han = text => [...text.matchAll(/\p{Script=Han}/gu)].length;
  const latin = text => [...text.matchAll(/\p{Script=Latin}/gu)].length;
  return (han(prior) >= 4 && latin(prior) === 0 && han(current) === 0 && latin(current) >= 8)
    || (latin(prior) >= 12 && han(prior) === 0 && latin(current) === 0 && han(current) >= 4);
};

// Keep offsets in the original text: joining words with spaces corrupts CJK captions.
export function agreedPrefix(previous, current) {
  const units = text => [...wordSegmenter.segment(text)].filter(s => normalized(s.segment));
  const a = units(previous), b = units(current);
  let n = 0;
  while (n < a.length && n < b.length && normalized(a[n].segment) === normalized(b[n].segment)) n++;
  return n ? current.slice(0, b[n - 1].index + b[n - 1].segment.length) : '';
}

// A final decode occasionally drops the beginning of the same audio and returns
// only an exact suffix. Preserve that earlier hypothesis when the shared suffix
// is substantial. Never borrow words from audio beyond a forced-cut boundary.
export function restorePrefix(previous, current) {
  const units = text => [...wordSegmenter.segment(text)].filter(s => normalized(s.segment));
  const a = units(previous), b = units(current);
  if (b.length < 3) return current;
  if (a.length >= 3 && b.slice(0, 3).every((word, i) => normalized(word.segment) === normalized(a[i].segment))) return current;
  for (let at = 1; at <= a.length - 3; at++) {
    const tail = a.slice(at);
    if (tail.length > b.length || !tail.every((word, i) => normalized(word.segment) === normalized(b[i].segment))) continue;
    return previous.slice(0, a[at].index) + current;
  }
  return current;
}

export class IncrementalAsr {
  constructor({ recognize, lane, onResult, onVoice = () => {}, onChange = () => {}, onError = () => {}, suppressed = () => false, startId = 0, now = Date.now }) {
    Object.assign(this, { recognize, lane, onResult, onVoice, onChange, onError, suppressed, now });
    this.seq = startId; this.pre = []; this.current = null; this.pending = new Map();
    this.closed = false; this.lastVoiceAt = 0; this.error = null; this.idleTimer = null;
    this.metrics = { requests: 0, partials: 0, finals: 0, audioMs: 0, skipped: 0, errors: 0, passes: [] };
  }

  get pendingFinals() { return [...this.pending.values()].filter(u => !u.done).length; }
  get processing() { return !!this.current || this.pendingFinals > 0; }
  get speaking() { return !!this.current && this.current.silence < 700; }

  make(frames = []) {
    return { id: 'u' + ++this.seq, frames, voiced: frames.filter(f => f.level >= 0.009 * 0.6).length * 100,
      silence: 0, step: 0, previous: '', best: '', hypotheses: [], revision: 0, ended: false, done: false };
  }

  feed(pcm, startMs) {
    if (this.closed) return;
    clearTimeout(this.idleTimer);
    for (let offset = 0; offset < pcm.length; offset += 3200) {
      const buffer = Buffer.from(pcm.subarray(offset, offset + 3200));
      const frame = { buffer, start: startMs + offset / 32, level: pcmRms(buffer) };
      if (frame.level >= 0.009 * (this.current ? 0.6 : 1)) {
        this.lastVoiceAt = this.now(); this.onVoice(this.lastVoiceAt);
      }
      if (!this.current) {
        if (frame.level < 0.009) { this.pre.push(frame); if (this.pre.length > 3) this.pre.shift(); continue; }
        this.current = this.make([...this.pre, frame]); this.pre = [];
      } else {
        const u = this.current;
        u.frames.push(frame); u.step += 100;
        if (frame.level >= 0.009 * 0.6) { u.voiced += 100; u.silence = 0; } else u.silence += 100;
      }
      const u = this.current;
      if (u.silence >= 700) this.end('pause');
      else if (u.frames.length >= 120) this.cut();
      else if (u.frames.length >= 10 && u.voiced >= 500 && u.step >= 1000) {
        u.step = 0; this.partial(u);
      }
    }
    if (this.current) {
      this.idleTimer = setTimeout(() => this.end('interrupted'), 1500);
      this.idleTimer.unref?.();
    }
    this.onChange();
  }

  end(reason) {
    clearTimeout(this.idleTimer);
    const u = this.current; this.current = null; this.pre = [];
    if (!u) return;
    const extra = Math.max(0, Math.floor(u.silence / 100) - 3);
    if (extra) u.frames.splice(-extra);
    if (u.voiced < 300) return;
    this.final(u, reason);
  }

  cut() {
    const u = this.current, n = u.frames.length;
    let cut = n - 1, min = Infinity;
    for (let i = Math.max(Math.floor(n / 2), n - 30); i < n - 1; i++) {
      if (u.frames[i].level < min) { min = u.frames[i].level; cut = i; }
    }
    this.current = this.make(u.frames.slice(cut + 1));
    u.frames = u.frames.slice(0, cut + 1);
    this.final(u, 'limit');
  }

  partial(u) {
    if (this.error || this.suppressed(u.id)) return;
    const pcm = Buffer.concat(u.frames.map(f => f.buffer)), endMs = u.frames.at(-1).start + 100;
    const request = this.lane.run(signal => this.pass(u, pcm, false, signal, endMs), { owner: this });
    if (!request) { this.metrics.skipped++; return; }
    request.then(raw => {
      if (this.closed || u.ended || !raw) return;
      // A short failed decode must not erase a much longer provisional hypothesis.
      if ([...u.best].length >= 18 && [...raw].length < [...u.best].length / 3) return;
      const stable = agreedPrefix(u.previous, raw);
      if (stable) u.agreement = { raw: stable, endMs };
      u.previous = raw; if (raw.length >= u.best.length) u.best = raw;
      u.hypotheses.push({ raw, endMs }); if (u.hypotheses.length > 3) u.hypotheses.shift();
      this.publish(u, raw, false, endMs, stable);
    }).catch(e => {
      if (e.name !== 'AbortError' && e.name !== 'TimeoutError') this.metrics.errors++;
    }).finally(() => this.onChange());
  }

  final(u, reason) {
    u.ended = true; u.reason = reason; this.pending.set(u.id, u);
    this.submitFinal(u); this.onChange();
  }

  submitFinal(u) {
    if (u.promise || this.closed) return;
    const pcm = Buffer.concat(u.frames.map(f => f.buffer)), endMs = u.frames.at(-1).start + 100;
    u.promise = this.lane.run(async signal => {
      const raw = await this.pass(u, pcm, true, signal, endMs);
      const prior = u.hypotheses.findLast(h => h.endMs <= endMs);
      const restored = prior ? restorePrefix(prior.raw, raw) : raw;
      const missing = restored.slice(0, restored.length - raw.length);
      let text = missing && u.agreement?.endMs <= endMs && normalized(u.agreement.raw).startsWith(normalized(missing)) ? restored : raw;
      // A language switch can make the final batch ASR return only the later language.
      // Confirm the earlier prefix with a second decode of that same shorter audio;
      // only an agreeing decode may restore it. The literal final response stays raw.
      const dropped = u.hypotheses.findLast(h => h.endMs < endMs && scriptDrop(h.raw, raw));
      if (dropped && text === raw) {
        const prefix = pcm.subarray(0, (dropped.endMs - u.frames[0].start) * 32);
        const confirmation = await this.pass(u, prefix, true, signal, dropped.endMs);
        u.prefixCheck = { raw: confirmation, endMs: dropped.endMs };
        if (normalized(dropped.raw) === normalized(confirmation)) text = dropped.raw + (/\s$/.test(dropped.raw) ? '' : ' ') + raw;
      }
      return { raw, text };
    }, { final: true, owner: this })
      .then(({ raw, text }) => {
        if (this.closed) return;
        u.done = true; this.pending.delete(u.id);
        this.publish(u, raw, true, endMs, text, text);
        u.frames = [];
      }).catch(e => {
        if (this.closed || e.name === 'AbortError') return;
        this.metrics.errors++; this.error = e; this.onError(e);
      }).finally(() => { u.promise = null; this.onChange(); });
  }

  async pass(u, pcm, final, signal, endMs) {
    if (this.error) throw this.error;
    const requestedAt = this.now();
    this.metrics.requests++; this.metrics[final ? 'finals' : 'partials']++; this.metrics.audioMs += pcm.length / 32;
    try { return await this.recognize(pcm, signal); }
    finally {
      this.metrics.passes.push({ id: u.id, final, startMs: u.frames[0]?.start, endMs, audioMs: pcm.length / 32, requestedAt, elapsedMs: this.now() - requestedAt, aborted: signal.aborted });
      if (this.metrics.passes.length > 80) this.metrics.passes.shift();
    }
  }

  publish(u, raw, final, endMs, stable, text = raw) {
    this.onResult({ id: u.id, raw, text, stable, hypotheses: [...u.hypotheses], ...(u.prefixCheck ? { prefixCheck: u.prefixCheck } : {}), retainedPrefix: raw !== text, final, revision: ++u.revision, cutReason: final ? u.reason : null,
      startMs: u.frames[0].start, endMs, readyAt: this.now() });
  }

  async drain() {
    this.end('stop');
    while ([...this.pending.values()].some(u => u.promise)) await Promise.all([...this.pending.values()].map(u => u.promise));
    if (this.error) throw this.error;
  }

  async retry() {
    this.error = null;
    for (const u of this.pending.values()) if (!u.promise) this.submitFinal(u);
    await this.drain();
  }

  close() { this.closed = true; clearTimeout(this.idleTimer); this.lane.cancel(this); this.current = null; this.pre = []; this.pending.clear(); }
}
