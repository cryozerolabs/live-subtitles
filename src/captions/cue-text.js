// Source boundaries are selected once, before translation. Every language receives
// the same cue IDs; independently splitting translated paragraphs loses alignment.
const words = new Intl.Segmenter(undefined, { granularity: 'word' });
const sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' });
const width = text => [...text].reduce((n, c) => n + (/\p{Script=Han}|\p{Extended_Pictographic}/u.test(c) ? 1 : /\s/u.test(c) ? .25 : .4), 0);

export function splitCueText(raw, { limit = 26 } = {}) {
  raw = String(raw);
  if (!raw.trim()) return [];
  const stops = [...sentences.segment(raw)].map(s => s.index + s.segment.length);
  const clauses = [...raw.matchAll(/[，,；;：:、](?!\d)\s*/gu)].map(m => m.index + m[0].length);
  const boundaries = [...words.segment(raw)].map(s => s.index + s.segment.length);
  const cues = [];
  let start = 0;
  while (start < raw.length) {
    const endOfSentence = stops.find(n => n > start) || raw.length;
    let end = endOfSentence;
    if (width(raw.slice(start, end)) > limit) {
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
    if (!c.translations) continue;
    const parts = c.translations.cues;
    if (!parts?.length) {
      rows.push({ id: c.id, raw: c.raw || '', revision: c.revision || 0, final: c.final !== false,
        startMs: c.startMs, endMs: c.endMs, translations: c.translations, timing: c.timing || 'segment' });
      continue;
    }
    for (const part of parts) rows.push({
      id: `${c.id}:${part.id}`, parentId: c.id, revision: c.translatedRevision ?? c.revision ?? 0,
      final: c.final !== false, raw: part.raw, startMs: sourceTime(c, part.start), endMs: sourceTime(c, part.end),
      sourceStart: part.start, sourceEnd: part.end, translations: part.translations, timing: 'estimated',
    });
  }
  return rows;
}
