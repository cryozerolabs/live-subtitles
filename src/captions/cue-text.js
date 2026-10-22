// Source boundaries are selected once, before translation. Every language receives
// the same cue IDs; independently splitting translated paragraphs loses alignment.
const words = new Intl.Segmenter(undefined, { granularity: 'word' });
const sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' });
const width = text => [...text].reduce((n, c) => n + (/\p{Script=Han}|\p{Extended_Pictographic}/u.test(c) ? 1 : /\s/u.test(c) ? .25 : .4), 0);

// ASR can spell thousands with spaces. Keep currency signs, grouping separators
// and decimal digits in one source atom without rewriting the recognized text.
const numericSpans = raw => [...raw.matchAll(/(?:(?:[A-Z]{2,3}\$|\p{Sc})\s*)?[+-]?\p{N}+(?:[.,:：/\u0020\u00a0\u202f-]\p{N}+)*(?:[%‰])?/gu)]
  .map(match => ({ start: match.index, end: match.index + match[0].length }));
const inside = (offset, spans) => spans.some(span => span.start < offset && offset < span.end);
export function wordCuts(raw) {
  const spans = numericSpans(raw);
  return [...words.segment(raw)].map(unit => unit.index + unit.segment.length).filter(offset => !inside(offset, spans));
}

function sentenceStops(raw) {
  const spans = numericSpans(raw);
  const stops = [...sentences.segment(raw)].map(unit => unit.index + unit.segment.length);
  // Intl.Segmenter intentionally treats many lowercase ASR sentences as one.
  for (const match of raw.matchAll(/[。！？!?]["'”’»）)\]]*\s*|\.["'”’»）)\]]*\s+/gu)) stops.push(match.index + match[0].length);
  const abbreviation = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|No|Fig)|\b(?:[A-Za-z]\.)+[A-Za-z])\.$/i;
  return [...new Set(stops)].filter(end => end === raw.length || (!inside(end, spans)
    && !abbreviation.test(raw.slice(0, end).trimEnd().replace(/["'”’»）)\]]+$/u, '')))).sort((a, b) => a - b);
}

export function splitCueText(raw, { limit = 26 } = {}) {
  raw = String(raw);
  if (!raw.trim()) return [];
  const stops = sentenceStops(raw), spans = numericSpans(raw);
  const clauses = [...raw.matchAll(/[，,；;：:、]\s*/gu)].map(m => m.index + m[0].length).filter(offset => !inside(offset, spans));
  const boundaries = wordCuts(raw);
  const cues = [];
  let start = 0;
  while (start < raw.length) {
    const endOfSentence = stops.find(n => n > start) || raw.length;
    let end = endOfSentence;
    const sentence = raw.slice(start, end);
    // A moderately longer Latin sentence is safer than a forced split through
    // its predicate. It still wraps normally in the caption viewport.
    const softLimit = !/\p{Script=Han}/u.test(sentence) && /\p{Script=Latin}/u.test(sentence) ? limit * 1.5 : limit;
    if (width(sentence) > softLimit) {
      const fits = boundaries.filter(n => n > start && n <= endOfSentence && width(raw.slice(start, n)) <= limit);
      const preferred = clauses.filter(n => n > start && n <= (fits.at(-1) || start) && width(raw.slice(start, n)) >= limit * .45);
      end = preferred.at(-1) || fits.at(-1) || boundaries.find(n => n > start) || endOfSentence;
    }
    // Keep whitespace with its preceding phrase. Concatenation exactly reproduces
    // ASR text, including decimal numbers, mixed scripts and surrogate pairs.
    while (end < raw.length && /\s/u.test(raw[end])) end++;
    if (!raw.slice(start, end).trim() && cues.length) {
      cues.at(-1).raw += raw.slice(start, end); cues.at(-1).end = end;
    } else cues.push({ id: cues.length + 1, raw: raw.slice(start, end), start, end });
    start = end;
  }
  return cues;
}

export const captionRevision = c => c.displayRevision ?? c.translatedRevision ?? c.revision ?? 0;

const position = (raw, offset) => [...raw.slice(0, offset)].length / Math.max(1, [...raw].length);
export function sourceTime(entry, offset) {
  const start = Number.isFinite(entry.startMs) ? entry.startMs : 0;
  const end = Number.isFinite(entry.endMs) ? Math.max(start, entry.endMs) : start;
  return Math.round(start + (end - start) * position(entry.raw, offset));
}

export function cueRows(records, { finalizedPrefix = false } = {}) {
  const rows = [];
  for (const c of records) {
    if (c.skipped || c.translationSkipped) continue;
    if (finalizedPrefix && (c.final === false || !c.translations)) break;
    const draft = finalizedPrefix ? null : c.provisional;
    const translated = draft?.translations || c.translations;
    // Live source revisions have their own display clock. Keep translations only
    // on exactly matching source spans, never beside a corrected ASR hypothesis.
    if (!finalizedPrefix && c.final === false) {
      const source = c.sourcePreview || c;
      const translatedSource = draft || c.translatedSource || c;
      const raw = source.raw || '', anchored = [];
      let offset = 0;
      // A stable translated prefix may end before the growing ASR tail. Preserve
      // its exact boundaries instead of stretching the row and hiding its text.
      for (let id = 1; ; id++) {
        const match = [draft?.translations, c.translations].flatMap(t => t?.cues || []).find(p => p.id === id && p.start === offset && raw.slice(p.start, p.end) === p.raw && p.end > offset);
        if (!match) break;
        anchored.push(match); offset = match.end;
      }
      const parts = [...anchored, ...splitCueText(raw.slice(offset)).map((part, index) => ({ ...part, id: anchored.length + index + 1, start: offset + part.start, end: offset + part.end }))];
      for (const part of parts) {
        const matches = [c.translations, draft?.translations].flatMap(t => t?.cues || []).filter(p => p.id === part.id && p.start === part.start && p.end === part.end && p.raw === part.raw);
        const matched = matches.length ? Object.assign({}, ...matches.map(p => p.translations)) : null;
        const flat = !translated?.cues && translatedSource.raw === source.raw && part.raw === source.raw ? translated : null;
        rows.push({ id: `${c.id}:${part.id}`, parentId: c.id, revision: captionRevision(c), final: false,
          raw: part.raw, startMs: sourceTime(source, part.start), endMs: sourceTime(source, part.end),
          sourceStart: part.start, sourceEnd: part.end, translations: matched || flat || {}, timing: 'estimated' });
      }
      continue;
    }
    if (!translated) continue;
    const parts = translated.cues, timing = draft || c.translatedSource || c;
    if (!parts?.length) {
      rows.push({ id: c.id, raw: timing.raw || '', revision: captionRevision(c), final: !draft && c.final !== false,
        startMs: timing.startMs, endMs: timing.endMs, translations: translated, timing: c.timing || 'segment' });
      continue;
    }
    for (const part of parts) rows.push({
      id: `${c.id}:${part.id}`, parentId: c.id, revision: captionRevision(c),
      final: !draft && c.final !== false, raw: part.raw, startMs: sourceTime(timing, part.start), endMs: sourceTime(timing, part.end),
      sourceStart: part.start, sourceEnd: part.end, translations: part.translations, timing: 'estimated',
    });
  }
  return rows;
}
