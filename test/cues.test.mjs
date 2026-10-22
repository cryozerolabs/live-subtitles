import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitCueText, cueRows } from '../src/captions/cue-text.js';
import { SubtitleStore, serializeSrt, srtTime, subtitleFiles } from '../src/storage/subtitle-store.js';
import { translations } from '../src/providers/openai-compatible.js';
import { SentenceBuffer, sentenceCut } from '../src/captions/sentences.js';
import { ModelLane } from '../src/captions/model-lane.js';
import { createApp } from '../src/server.js';

const settings = { baseURL: 'http://model/v1', model: 'translator' };
const json = value => new Response(JSON.stringify(value));
const response = value => json({ choices: [{ message: { content: JSON.stringify(value) } }] });
const languages = raw => ({ zhHans: raw, en: raw, yue: raw });
const tick = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let n = 0; n < 300; n++) { if (await fn()) return; await tick(5); } throw new Error('condition not reached'); }

test('short source cues preserve every character, Unicode, decimal numbers and word boundaries', () => {
  for (const raw of [
    '我们先明确能不能做。预算十五万元，尚未批准。只有审批通过才发布；如果延迟，先保留现有版本。',
    'The budget of 150,000.50 has not been approved. Launch only after approval. If delayed, keep the current version.',
    '我哋而家仲未批預算。如果遲咗批，就先保留而家個版本。',
    'Friday 10:30 先交预览 👩🏽‍💻。正式发布要等审批，日期未定。',
    '连续讲话没有标点也应在词边界分成短字幕'.repeat(12),
  ]) {
    const cues = splitCueText(raw);
    assert.ok(cues.length > 1); assert.equal(cues.map(c => c.raw).join(''), raw);
    assert.ok(cues.every(c => c.raw.trim() && c.raw === raw.slice(c.start, c.end)));
    for (const c of cues) { assert.equal(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(c.raw), false); }
  }
  const amounts = splitCueText('Budget 150,000.50 is still pending approval. '.repeat(5));
  assert.equal(amounts.filter(c => c.raw.includes('150,000.50')).length, 5);
});

test('lowercase ASR sentences keep their meaning and spaced thousands stay in one cue', () => {
  const raw = 'we will deliver only the demo on friday. the launch must wait for customer exceptions and the date is not confirmed. the budget is $12 500 and has not been approved.';
  const cues = splitCueText(raw);
  assert.deepEqual(cues.map(c => c.raw.trim()), [
    'we will deliver only the demo on friday.',
    'the launch must wait for customer exceptions and the date is not confirmed.',
    'the budget is $12 500 and has not been approved.',
  ]);
  assert.equal(cues.map(c => c.raw).join(''), raw);
  for (const amount of ['HK$12 500.50', '€12\u202f500.50', '$150,000.50', '￥１２５００', '10:30', '2026-10-22']) {
    const sentence = `the revised budget is ${amount} and still needs acceptance.`;
    for (const limit of [5, 10, 18, 26]) {
      const parts = splitCueText(sentence, { limit });
      assert.equal(parts.map(c => c.raw).join(''), sentence);
      assert.equal(parts.filter(c => c.raw.includes(amount)).length, 1, `${amount}, width ${limit}`);
    }
  }
});

test('long sentence fallback cannot split the grouping comma in a currency amount', () => {
  const raw = 'keep the source characters and offsets stable while the meeting continues and the pending budget is HK$12,500 and its approval is still required before the official launch can happen at the confirmed date. '.repeat(2);
  const cut = sentenceCut(raw), amountStart = raw.indexOf('HK$12,500');
  assert.ok(cut <= amountStart || cut >= amountStart + 'HK$12,500'.length);
  assert.equal(raw.slice(0, cut) + raw.slice(cut), raw);
});

test('lowercase fallback does not turn English abbreviations or decimals into separate sentences', () => {
  const raw = 'dr. smith is in the U.S. office. the budget is $12 500.50. do not launch yet.';
  const cues = splitCueText(raw);
  assert.equal(cues.map(c => c.raw).join(''), raw);
  assert.ok(cues[0].raw.includes('dr. smith') && cues[0].raw.includes('U.S. office.'));
  assert.ok(cues.some(c => c.raw.trim() === 'the budget is $12 500.50.'));
});

test('amounts copied from another English cue are rejected and corrected by the single format retry', async () => {
  const raw = 'the launch needs acceptance. the budget is $12 500 and has not been approved.';
  let calls = 0;
  const out = await translations(raw, settings, async (_url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    calls++;
    return response({ complete: true, cues: input.cues.map(c => ({ id: c.id, source: c.source,
      zhHans: calls === 1 || c.id === 2 ? '预算为12500元，尚未批准。' : '上线须等待验收。',
      en: calls === 1 || c.id === 2 ? 'The budget is $12,500 and has not been approved.' : 'The launch needs acceptance.',
      yue: calls === 1 || c.id === 2 ? '預算係12500元，仲未批。' : '推出要等驗收先得。',
    })) });
  });
  assert.equal(calls, 2); assert.equal(out.cues.length, 2);
  assert.doesNotMatch(out.cues[0].translations.en, /12/);
  assert.equal(out.cues.filter(c => /12,500/.test(c.translations.en)).length, 1);
});

test('source echoes must match their ID and repeated speech is not deduplicated', async () => {
  let calls = 0;
  await assert.rejects(translations('launch after acceptance. budget is $12 500.', settings, async (_url, options) => {
    calls++; const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    return response({ complete: true, cues: input.cues.map(c => ({ id: c.id, source: 'a different sentence', zhHans: '原文被调换。', en: 'Different.', yue: '原文調轉咗。' })) });
  }), e => e.kind === 'format');
  assert.equal(calls, 2);
  const repeated = await translations('the budget is $12 500. the budget is $12 500.', settings, async (_url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    return response({ complete: true, cues: input.cues.map(c => ({ id: c.id, source: c.source, zhHans: '预算为12500元。', en: 'The budget is $12,500.', yue: '預算係12500元。' })) });
  });
  assert.equal(repeated.cues.length, 2);
});

test('one translation request aligns all cue languages by ID even if provider reorders its answer', async () => {
  const raw = '预算尚未批准。审批通过后才发布。如果审批延迟，先保留现有版本。';
  let calls = 0;
  const out = await translations(raw, settings, async (_url, options) => {
    calls++; const payload = JSON.parse(options.body), input = JSON.parse(payload.messages[1].content);
    assert.equal(payload.max_completion_tokens, 4096);
    assert.equal(input.cues.map(c => c.source).join(''), raw);
    return response({ complete: true, cues: input.cues.map(c => ({ id: c.id, zhHans: c.source, en: 'English ' + c.id, yue: '仲未批 ' + c.id })).reverse() });
  }, [], { sentence: true, cues: true });
  assert.equal(calls, 1); assert.equal(out.cues.length, 3);
  assert.equal(out.cues.map(c => c.raw).join(''), raw);
  assert.equal(out.cues[0].translations.en, 'English 1'); assert.equal(out.cues[2].translations.en, 'English 3');
  assert.equal(out.complete, true);
});

test('missing, duplicate or invented cue IDs retry once and never pair with the wrong source', async () => {
  for (const ids of [[1], [1, 1], [1, 99]]) {
    let calls = 0;
    await assert.rejects(translations('预算未批准。日期还未定。', settings, async () => {
      calls++; return response({ complete: true, cues: ids.map(id => ({ id, ...languages('不得错配') })) });
    }, [], { sentence: true, cues: true }), e => e.kind === 'format');
    assert.equal(calls, 2);
  }
});

test('a one-cue legacy response remains aligned; an unfinished cue stays unfinished', async () => {
  const out = await translations('And we’re', settings, async () => response({ ...languages('And we’re…'), complete: false }), [], { sentence: true, cues: true });
  assert.equal(out.cues[0].raw, 'And we’re'); assert.equal(out.complete, false);
});

test('copying an English sentence into Chinese or Cantonese triggers the bounded format retry', async () => {
  let calls = 0;
  const raw = 'The budget is still pending approval.';
  const out = await translations(raw, settings, async () => {
    calls++;
    return response({ complete: true, cues: [{ id: 1, en: raw,
      zhHans: calls === 1 ? raw : '预算尚未批准。', yue: calls === 1 ? raw : '預算仲未批。' }] });
  }, [], { sentence: true, cues: true });
  assert.equal(calls, 2); assert.equal(out.cues[0].translations.yue, '預算仲未批。');
});

test('public cues use the matching translated source revision, with one shared estimated time axis', () => {
  const raw = '预算尚未批准。审批通过后才发布。';
  const parts = splitCueText(raw).map(c => ({ ...c, translations: languages(c.raw) }));
  const c = { id: 'c1', raw: raw + '后文到了。', revision: 5, translatedRevision: 4, final: false, startMs: 1000, endMs: 5000, translations: { cues: parts } };
  const rows = cueRows([c]);
  assert.equal(rows.length, 2); assert.equal(rows.map(r => r.raw).join(''), raw);
  assert.ok(rows.every(r => r.revision === 4 && !r.final && r.timing === 'estimated'));
  assert.equal(rows[0].endMs, rows[1].startMs); assert.equal(rows[0].id, 'c1:1');
});

test('long context splits advance the audio start of the next source span', async t => {
  const captions = [], raw = '预算尚未批准，正式发布要等审批通过。'.repeat(20);
  const buffer = new SentenceBuffer({ captions, lane: new ModelLane(), translate: async text => ({ ...languages(text), complete: false }) });
  t.after(() => buffer.close()); buffer.voice(Date.now());
  buffer.receive({ id: 'u1', raw, startMs: 1000, endMs: 13000, final: true, cutReason: 'limit' });
  await buffer.flush();
  assert.ok(captions.length > 1); assert.equal(captions.map(c => c.raw).join(''), raw);
  assert.ok(captions[1].startMs > captions[0].startMs);
  for (let n = 1; n < captions.length; n++) assert.equal(captions[n - 1].endMs, captions[n].startMs);
  assert.equal(captions.at(-1).endMs, 13000);
});

test('SRT saves only the finalized contiguous prefix, remains idempotent, and shares timing across languages', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-prefix-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new SubtitleStore(dir);
  const a = { id: 'c1', raw: '尚未批准。', final: false, startMs: 0, endMs: 2000, translations: languages('尚未批准。') };
  const b = { id: 'c2', raw: '日期未定。', final: true, startMs: 2000, endMs: 4000, translations: languages('日期未定。') };
  store.sync([a, b]); assert.equal(fs.readFileSync(path.join(dir, subtitleFiles.original), 'utf8'), '');
  a.final = true; store.sync([a, b]); store.sync([a, b]);
  const originals = fs.readFileSync(path.join(dir, subtitleFiles.original), 'utf8');
  assert.equal(originals.match(/ --> /g).length, 2); assert.match(originals, /^1\n00:00:00,000 --> 00:00:02,000/);
  const times = text => text.split('\n').filter(line => line.includes(' --> '));
  for (const file of Object.values(subtitleFiles)) assert.deepEqual(times(fs.readFileSync(path.join(dir, file), 'utf8')), times(originals));
  const recovered = new SubtitleStore(dir); recovered.sync([a, b]); assert.equal(fs.readFileSync(path.join(dir, subtitleFiles.original), 'utf8'), originals);
});

test('explicit skipped content does not block later SRT, and temporary or missing translations cannot leak into it', () => {
  const c = { id: 'c1', raw: '被跳过', skipped: true, final: true };
  const b = { id: 'c2', raw: '原文', final: true, startMs: 500, endMs: 1000, translations: languages('译文') };
  const rows = cueRows([c, b, { id: 'c3', raw: '临时', final: false }], { finalizedPrefix: true });
  assert.equal(rows.length, 1); assert.equal(rows[0].id, 'c2');
  assert.match(serializeSrt(rows, 'original'), /原文/); assert.doesNotMatch(serializeSrt(rows, 'original'), /临时|被跳过/);
});

test('SRT timestamps are locale-independent, monotonic and escape embedded blank blocks', () => {
  assert.equal(srtTime(3600123), '01:00:00,123');
  const rows = [{ id: 'a', raw: '第一行\r\n\n第二行', startMs: 0, endMs: 0 }, { id: 'b', raw: '后续', startMs: 0, endMs: 500 }];
  const srt = serializeSrt(rows, 'original');
  assert.match(srt, /00:00:00,000 --> 00:00:00,001/); assert.match(srt, /00:00:00,001 --> 00:00:00,500/);
  assert.match(srt, /第一行\n第二行/);
});

test('HTTP live snapshots and saved SRT contain short paired cues before the meeting ends', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-service-'));
  const raw = '预算十五万元，尚未批准。审批通过后才发布。如果审批延迟，先保留现有版本。';
  const service = createApp({ env: {}, dataDir: dir, transport: async (url, options) => {
    if (String(url).endsWith('/audio/transcriptions')) return json({ text: raw });
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    return response({ complete: true, cues: input.cues.map(c => ({ id: c.id, ...languages(c.source) })) });
  } });
  const listener = await new Promise(resolve => { const server = service.app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(async () => { service.close(); listener.closeAllConnections(); await new Promise(r => listener.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + listener.address().port;
  const api = async (route, data, method = data ? 'POST' : 'GET') => {
    const r = await fetch(base + route, { method, headers: { 'content-type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
    assert.ok(r.ok, route); return r.json();
  };
  await api('/api/settings', { asr: { baseURL: 'http://localhost:8000', model: 'asr' }, translation: { baseURL: 'http://localhost:8000', model: 'translator' } }, 'PUT');
  let s = await api('/api/sessions/current');
  const input = Buffer.concat([Buffer.from(new Int16Array(16000).fill(2500).buffer), Buffer.alloc(22400)]);
  const uploaded = await fetch(base + '/api/sessions/' + s.id + '/audio?startMs=0&chunkId=one', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: input });
  assert.ok(uploaded.ok);
  await until(async () => { s = await api('/api/sessions/' + s.id); return s.captions.length === 3 && s.captions.every(c => c.final); });
  assert.equal(s.status, 'recording'); assert.equal(s.captions.map(c => c.raw).join(''), raw);
  assert.equal(s.captionParents[0].ids.length, 3);
  const file = path.join(dir, 'subtitles', s.id, subtitleFiles.original);
  assert.equal(fs.readFileSync(file, 'utf8').match(/ --> /g).length, 3);
  const download = await fetch(base + '/api/sessions/' + s.id + '/subtitles/original'); assert.ok(download.ok);
  assert.equal(await download.text(), fs.readFileSync(file, 'utf8'));
  assert.equal((await fetch(base + '/api/sessions/' + s.id + '/subtitles/constructor')).status, 404);
  const share = await api('/api/sessions/' + s.id + '/share'), token = new URL(share.url).pathname.split('/').at(-1);
  const phone = await api('/api/watch/' + token); assert.deepEqual(phone.captions.map(c => c.raw), s.captions.map(c => c.raw));
  assert.doesNotMatch(JSON.stringify(phone), /apiKey|llmEndpoint|asrEndpoint/);
  await api('/api/sessions/' + s.id + '/end', {});
  await until(async () => (await api('/api/sessions/' + s.id)).status === 'ended');
  const zip = await fetch(base + '/api/sessions/' + s.id + '/download');
  const bytes = Buffer.from(await zip.arrayBuffer());
  for (const file of Object.values(subtitleFiles)) assert.ok(bytes.includes(Buffer.from(file)), file);
  assert.equal(bytes.includes(Buffer.from('cues.json')), false);
});
