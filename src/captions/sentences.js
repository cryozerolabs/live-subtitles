import { sourceTime } from './cue-text.js';
// Each source revision replaces one utterance in the current sentence. All
// translated languages share that sentence's ID, revision and finalization state.
const words = new Intl.Segmenter(undefined, { granularity: 'word' });
const points = text => [...text].length;
const skippable = e => ['refusal', 'format'].includes(e.kind);

export function composeSources(entries) {
  let raw = '';
  const spans = [];
  entries.forEach((entry, index) => {
    let text = entry.raw.slice(entry.offset);
    // A recognizer often supplies a period at the end of every WAV. If we are joining
    // the next fragment into the same sentence, that period is not a sentence boundary.
    if (index < entries.length - 1 && entry.joinIncomplete) text = text.replace(/[。.!?？！…]+\s*$/u, '');
    if (raw && /[\p{L}\p{N}]$/u.test(raw) && /^[\p{L}\p{N}]/u.test(text) && (/[\p{Script=Latin}\p{N}]$/u.test(raw) || /^[\p{Script=Latin}\p{N}]/u.test(text))) raw += ' ';
    const start = raw.length; raw += text;
    spans.push({ entry, start, end: raw.length });
  });
  return { raw, spans };
}

// UTF-16 offset into the source string, at a Unicode/word boundary. Decimal points
// are not sentence stops. Keep the unchanged source offsets for split attribution.
export function sentenceCut(text) {
  const window = [...text].slice(0, 200).join('');
  const min = [...text].slice(0, 60).join('').length;
  let cut = -1;
  for (const match of window.matchAll(/[。！？!?；;，,]|\.(?=\s|$)/gu)) if (match.index >= min) cut = match.index + match[0].length;
  if (cut > 0) return cut;
  for (const unit of words.segment(window)) if (unit.index >= min) cut = unit.index;
  return cut > 0 ? cut : window.length;
}

export class SentenceBuffer {
  constructor({ captions, lane, translate, onChange = () => {}, onError = () => {}, asrPending = () => false, speaking = () => false,
    now = Date.now, partialMs = 1500, idleMs = 6000 }) {
    Object.assign(this, { captions, lane, translate, onChange, onError, asrPending, speaking, now, partialMs, idleMs });
    this.entries = []; this.current = null; this.seq = captions.reduce((n, c) => Math.max(n, Number(c.id.slice(1)) || 0), 0);
    this.suppressed = new Set(); this.consumed = new Set(); this.jobs = new Set(); this.finalJobs = new Set();
    this.lastVoiceAt = 0; this.lastPartialAt = -Infinity; this.attempted = ''; this.closed = false;
    this.timer = null; this.idleTimer = null;
    this.metrics = { requests: 0, partials: 0, finals: 0, stale: 0, skipped: 0 };
  }

  get pendingFinals() { return this.finalJobs.size; }
  get pending() { return this.jobs.size + (this.current ? 1 : 0); }

  voice(at) {
    this.lastVoiceAt = at; clearTimeout(this.idleTimer);
    this.armIdle();
  }

  receive(result) {
    if (this.closed || this.suppressed.has(result.id) || this.consumed.has(result.id)) return;
    // Start translation with the stable prefix; retain uncertain tails until the
    // recognizer either confirms them or supplies a final result.
    const raw = result.final ? (result.text ?? result.raw) : (result.stable ?? result.raw);
    if (!raw && !result.final) return;
    result = { ...result, raw };
    let entry = this.entries.find(e => e.id === result.id);
    if (!entry && !result.raw) return;
    if (entry) Object.assign(entry, result);
    else {
      const previous = this.entries.at(-1), c = this.current;
      if (previous && c?.translations && c.translatedRevision === c.revision && c.complete === false) previous.joinIncomplete = true;
      entry = { ...result, offset: 0 }; this.entries.push(entry);
    }
    this.refresh();
  }

  refresh() {
    const { raw } = composeSources(this.entries);
    if (!raw.trim()) return;
    if (!this.current) {
      this.current = { id: 'c' + ++this.seq, revision: 0, raw: '', final: false, translations: null, createdAt: this.now() };
      this.captions.push(this.current); this.attempted = '';
    }
    const c = this.current;
    if (c.raw !== raw) { c.raw = raw; c.revision++; }
    c.sources = this.sources(raw.length); this.updateTimes(c);
    // Do not freeze part of an ASR hypothesis that a final pass can still rewrite.
    if (points(raw) > 220 && this.entries.every(e => e.final)) {
      this.seal(sentenceCut(raw), 'length');
      this.refresh();
      return;
    }
    const candidate = this.naturalEnd();
    if (candidate && c.translations && c.translatedRevision === c.revision && c.complete) { this.finish(c); return; }
    this.schedule(candidate); this.armIdle(); this.onChange();
  }

  sources(cut) {
    return composeSources(this.entries).spans.filter(s => s.start < cut).map(s => ({
      id: s.entry.id, start: s.entry.offset,
      end: cut >= s.end ? s.entry.raw.length : s.entry.offset + cut - s.start,
    }));
  }

  updateTimes(c) {
    const first = c.sources[0], last = c.sources.at(-1);
    if (first && last) {
      c.startMs = sourceTime(this.entries.find(e => e.id === first.id), first.start);
      c.endMs = sourceTime(this.entries.find(e => e.id === last.id), last.end);
      c.timing = 'estimated';
    }
  }

  consume(cut) {
    const { spans } = composeSources(this.entries);
    for (const span of spans) {
      if (cut >= span.end) { this.consumed.add(span.entry.id); span.entry.offset = span.entry.raw.length; }
      else if (cut > span.start) span.entry.offset += cut - span.start;
    }
    this.entries = this.entries.filter(e => e.offset < e.raw.length);
  }

  naturalEnd() {
    return this.entries.length > 0 && this.entries.every(e => e.final) && this.entries.at(-1).cutReason === 'pause' && !this.asrPending() && !this.speaking();
  }

  schedule(candidate = false) {
    clearTimeout(this.timer);
    const c = this.current;
    if (!c || c.skipped || c.sealed || this.closed) return;
    if (!candidate && points(c.raw.trim()) < 6) return;
    const key = `${c.id}:${c.revision}:${candidate}`;
    if (this.attempted === key) return;
    const delay = candidate ? 0 : Math.max(0, this.partialMs - (this.now() - this.lastPartialAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.current !== c || c.final || c.sealed || this.closed) return;
      const submitted = this.request(c, candidate, false);
      if (submitted) { this.attempted = key; if (!candidate) this.lastPartialAt = this.now(); }
      else { this.timer = setTimeout(() => this.schedule(this.naturalEnd()), 100); this.timer.unref?.(); }
    }, delay);
    this.timer.unref?.();
  }

  request(c, priority, sealed) {
    if (this.closed || c.skipped) return false;
    const revision = c.revision, raw = c.raw, fragments = c.fragments || (c.sources || []).map(s => {
      const e = this.entries.find(e => e.id === s.id);
      return e ? e.raw.slice(s.start, s.end) : raw;
    });
    const prior = () => this.captions.filter(p => p !== c && p.final && !p.skipped && p.translations).slice(-2).map(p => p.raw);
    const promise = this.lane.run(signal => {
      if (this.closed || c.skipped || (!sealed && (this.current !== c || c.revision !== revision))) return null;
      this.metrics.requests++; this.metrics[priority ? 'finals' : 'partials']++;
      return this.translate(raw, prior(), { signal, partial: !priority, fragments });
    }, { final: priority, owner: this });
    if (!promise) return false;
    this.jobs.add(promise); if (priority) this.finalJobs.add(promise);
    promise.then(out => {
      if (!out || this.closed || c.skipped) return;
      if (c.final || c.revision !== revision || (!sealed && this.current !== c)) { this.metrics.stale++; return; }
      c.translations = out; c.complete = out.complete; c.translatedRevision = revision;
      c.firstReadyAt ||= this.now(); c.readyAt = this.now(); delete c.translationError; delete c.translationErrorKind;
      if (sealed) { c.final = true; c.finalReadyAt = this.now(); }
      else if (out.complete && this.naturalEnd()) this.finish(c);
      this.onChange();
    }).catch(e => {
      if (this.closed || e.name === 'AbortError') return;
      if (skippable(e)) this.skip(c, e);
      else if (priority) { c.translationError = e.message; c.translationErrorKind = e.kind || 'processing'; this.onError(e); }
    }).finally(() => {
      this.jobs.delete(promise); this.finalJobs.delete(promise);
      if (!this.closed) { this.schedule(this.naturalEnd()); this.armIdle(); this.onChange(); }
    });
    return true;
  }

  finish(c) {
    if (this.current !== c || c.final) return;
    clearTimeout(this.timer); clearTimeout(this.idleTimer);
    c.final = true; c.finalReadyAt = this.now(); this.consume(c.raw.length); this.current = null; this.attempted = '';
    this.onChange();
  }

  seal(cut, reason) {
    const c = this.current; if (!c) return;
    clearTimeout(this.timer); clearTimeout(this.idleTimer);
    c.raw = c.raw.slice(0, cut); c.sources = this.sources(cut);
    this.updateTimes(c);
    c.fragments = c.sources.map(s => this.entries.find(e => e.id === s.id).raw.slice(s.start, s.end));
    c.revision++; c.sealed = true; c.closeReason = reason;
    this.consume(cut); this.current = null; this.attempted = '';
    this.request(c, true, true); this.onChange();
  }

  skip(c, error) {
    if (c.skipped) return;
    c.skipped = true; c.final = true; c.finalReadyAt = this.now();
    c.translationError = error.message; c.translationErrorKind = error.kind;
    for (const source of c.sources || []) this.suppressed.add(source.id);
    if (this.current === c) {
      clearTimeout(this.timer); clearTimeout(this.idleTimer);
      this.consume(c.raw.length); this.current = null; this.attempted = '';
    }
    this.entries = this.entries.filter(e => !this.suppressed.has(e.id));
    this.metrics.skipped++; this.onChange();
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    if (this.closed || !this.current) return;
    const delay = Math.max(0, this.idleMs - (this.now() - this.lastVoiceAt));
    this.idleTimer = setTimeout(() => {
      if (this.closed || !this.current) return;
      if (this.asrPending() || this.speaking()) {
        this.idleTimer = setTimeout(() => this.armIdle(), 100); this.idleTimer.unref?.(); return;
      }
      this.seal(this.current.raw.length, 'idle');
    }, delay);
    this.idleTimer.unref?.();
  }

  notify() {
    if (!this.current) return;
    const c = this.current;
    if (this.naturalEnd() && c.translations && c.translatedRevision === c.revision && c.complete) this.finish(c);
    else { this.schedule(this.naturalEnd()); this.armIdle(); }
  }

  async flush() {
    clearTimeout(this.timer); clearTimeout(this.idleTimer);
    if (this.current) this.seal(this.current.raw.length, 'stop');
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
    const failed = this.captions.find(c => c.translationError && !c.skipped && !c.final);
    if (failed) throw new Error(failed.translationError);
  }

  async retry() {
    for (const c of this.captions) if (c.translationError && !c.skipped && !c.final) {
      delete c.translationError; delete c.translationErrorKind;
      if (this.current === c) this.seal(c.raw.length, 'retry');
      else this.request(c, true, true);
    }
    await this.flush();
  }

  close() { this.closed = true; clearTimeout(this.timer); clearTimeout(this.idleTimer); this.lane.cancel(this); this.entries = []; }
}
