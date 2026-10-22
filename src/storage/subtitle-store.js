import fs from 'node:fs';
import path from 'node:path';
import { cueRows } from '../captions/cue-text.js';

export const subtitleFiles = { original: '原文.srt', zhHans: '中文.srt', en: 'English.srt', yue: '粵語.srt' };
export function srtTime(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':') + ',' + String(ms % 1000).padStart(3, '0');
}
export function timedCues(rows) {
  let end = 0;
  return rows.map((row, index) => {
    const startMs = Math.max(end, Math.round(Number(row.startMs) || 0));
    const endMs = Math.max(startMs + 1, Math.round(Number(row.endMs) || startMs + 1));
    end = endMs;
    return { ...row, index: index + 1, startMs, endMs };
  });
}
export function serializeSrt(rows, language) {
  return timedCues(rows).map(c => {
    const text = String(language === 'original' ? c.raw : c.translations?.[language] || '').replace(/\r/g, '').replace(/\n\s*\n/g, '\n').trim();
    return `${c.index}\n${srtTime(c.startMs)} --> ${srtTime(c.endMs)}\n${text}\n`;
  }).join('\n');
}

// JSON remains the recoverable source of truth. SRT files are atomic materialized
// views of the finalized prefix, so a late earlier result cannot renumber an
// already written later cue. Skipped content is explicit in session JSON.
export class SubtitleStore {
  constructor(dir) { this.dir = dir; this.signature = null; }
  sync(records) {
    const rows = timedCues(cueRows(records, { finalizedPrefix: true }));
    const signature = JSON.stringify(rows);
    if (signature === this.signature) return rows;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const write = (file, text) => {
      const target = path.join(this.dir, file), temp = target + '.tmp';
      fs.writeFileSync(temp, text, { mode: 0o600 }); fs.renameSync(temp, target);
    };
    for (const [language, file] of Object.entries(subtitleFiles)) write(file, serializeSrt(rows, language));
    write('cues.json', JSON.stringify({ version: 1, timing: 'estimated within ASR audio segments; no word timestamps', cues: rows }, null, 2));
    this.signature = signature;
    return rows;
  }
}
