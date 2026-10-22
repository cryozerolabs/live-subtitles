import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { translations } from '../src/providers/openai-compatible.js';
import { SentenceBuffer } from '../src/captions/sentences.js';
import { ModelLane } from '../src/captions/model-lane.js';
import { splitCueText, cueRows, captionRevision } from '../src/captions/cue-text.js';
import { SubtitleStore, subtitleFiles } from '../src/storage/subtitle-store.js';
import { Transcript } from '../public/transcript.js';
import { createApp } from './helpers/service.mjs';

const settings = { baseURL: 'http://provider/v1', model: 'translator', apiKey: 'synthetic-test-key' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(fn) { for (let n = 0; n < 300; n++) { if (fn()) return; await sleep(5); } throw new Error('condition not reached'); }
const trio = text => ({ zhHans: text, en: text, yue: text });
const rowsFor = raw => splitCueText(raw).map(c => ({ id: c.id, source: c.raw, ...trio(c.raw) }));
const valueFor = raw => ({ cues: rowsFor(raw), complete: true });
const jsonResponse = value => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
const complete = raw => ({ ...trio(raw), cues: splitCueText(raw).map(c => ({ ...c, translations: trio(c.raw) })), complete: true });

function sse({ bytes = false } = {}) {
  let controller, cancelled = false;
  const stream = new ReadableStream({ start(value) { controller = value; }, cancel() { cancelled = true; } });
  const emit = text => {
    const encoded = new TextEncoder().encode(text);
    if (bytes) for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(encoded);
  };
  const event = value => emit('data: ' + JSON.stringify(value) + '\r\n\r\n');
  return {
    response: new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    content: text => event({ choices: [{ index: 0, delta: { content: text } }] }),
    finish(reason = 'stop') { event({ choices: [{ index: 0, delta: {}, finish_reason: reason }] }); emit('data: [DONE]\r\n\r\n'); controller.close(); },
    emit, event, close: () => controller.close(), get cancelled() { return cancelled; },
  };
}

test('streamed translation publishes each closed language before the cue closes, never partial strings', async () => {
  const raw = '预算尚未批准。日期还没有确定。', stream = sse({ bytes: true }), updates = [];
  const value = valueFor(raw), text = JSON.stringify(value);
  const firstEnd = '{"cues":['.length + JSON.stringify(value.cues[0]).length;
  let requested = false, settled = false;
  const pending = translations(raw, settings, async (_url, options) => {
    requested = true; assert.equal(JSON.parse(options.body).stream, true); return stream.response;
  }, [], { onProgress: out => updates.push(out) }).then(out => { settled = true; return out; });
  await until(() => requested);
  const firstLanguageEnd = text.indexOf(',"en"');
  stream.emit(': keepalive\r\n\r\n'); stream.content(text.slice(0, firstLanguageEnd - 1)); await sleep(10);
  assert.equal(updates.length, 0);
  stream.content(text.slice(firstLanguageEnd - 1, firstLanguageEnd)); await until(() => updates.length === 1);
  assert.equal(updates[0].cues.length, 1); assert.equal(updates[0].complete, false); assert.equal(settled, false);
  assert.deepEqual(updates[0].cues[0].translations, { zhHans: value.cues[0].zhHans });
  stream.content(text.slice(firstLanguageEnd, firstEnd - 1)); await until(() => updates.length === 3);
  assert.deepEqual(updates[2].cues[0].translations, { zhHans: '预算尚未批准。', en: '预算尚未批准。', yue: '預算尚未批准。' });
  stream.content(text.slice(firstEnd - 1)); await until(() => updates.at(-1)?.cues.length === 2);
  assert.equal(settled, false);
  stream.finish(); const out = await pending;
  assert.equal(out.complete, true); assert.equal(out.cues.map(c => c.raw).join(''), raw);
});

test('stream parser handles quotes, nested braces, emoji and UTF-8 split between network bytes', async () => {
  const raw = '他说“继续”。', row = { id: 1, source: raw, zhHans: '他说“继续 {下一步} 🚀”。', en: 'He said "go {next} 🚀".', yue: '佢話「繼續 🚀」。' };
  const stream = sse({ bytes: true }), updates = [];
  const pending = translations(raw, settings, async () => stream.response, [], { onProgress: out => updates.push(out) });
  stream.content(JSON.stringify({ metadata: { cues: [row] }, cues: [row], complete: true })); stream.finish();
  const out = await pending;
  assert.equal(updates.length, 3); assert.equal(out.cues[0].translations.en, row.en);
  assert.deepEqual(Object.keys(updates[0].cues[0].translations), ['zhHans']);
  assert.equal(out.cues[0].translations.zhHans, row.zhHans);
});

test('the selected language is requested first and can display while other languages are still missing', async () => {
  const raw = '预算未批。', stream = sse(), updates = [];
  const pending = translations(raw, settings, async (_url, options) => {
    const system = JSON.parse(options.body).messages[0].content;
    const schema = JSON.parse(system.split('\n')[1].slice('只返回 JSON：'.length, -1));
    assert.deepEqual(Object.keys(schema.cues[0]), ['id', 'source', 'yue', 'zhHans', 'en']);
    return stream.response;
  }, [], { priorityLanguage: 'yue', onProgress: out => updates.push(out) });
  stream.content('{"cues":[{"id":1,"source":"预算未批。","yue":"預算仲未批。"');
  await until(() => updates.length === 1);
  assert.deepEqual(updates[0].cues[0].translations, { yue: '預算仲未批。' });
  stream.content(',"zhHans":"预算未批。","en":"The budget is pending approval."}],"complete":true}'); stream.finish();
  const out = await pending;
  assert.ok(out.cues[0].translations.zhHans); assert.ok(out.cues[0].translations.en); assert.equal(out.complete, true);
});

test('early language fields require an exact source echo; invalid or duplicate cue IDs retract the attempt', async () => {
  const raw = '预算未批。日期未定。';
  for (const invalid of ['source', 'duplicate']) {
    const updates = []; let calls = 0;
    const out = await translations(raw, settings, async () => {
      if (++calls === 2) return jsonResponse(valueFor(raw));
      const stream = sse(), rows = rowsFor(raw);
      if (invalid === 'source') stream.content('{"cues":[{"id":1,"source":"预算已批。","yue":"預算批咗。"');
      else stream.content('{"cues":[' + JSON.stringify(rows[0]) + ',' + JSON.stringify(rows[0]));
      stream.finish(); return stream.response;
    }, [], { onProgress: out => updates.push(out) });
    assert.equal(calls, 2); assert.equal(out.complete, true); assert.equal(updates.at(-1), null);
    if (invalid === 'source') assert.ok(updates.every(value => value === null));
  }
  const stream = sse(), updates = [];
  const pending = translations('预算未批。', settings, async () => stream.response, [], { onProgress: out => updates.push(out) });
  stream.content('{"cues":[{"id":1,"zhHans":"预算未批。","en":"Pending.","yue":"仲未批。"'); await sleep(10);
  assert.equal(updates.length, 0);
  stream.content('}],"complete":true}'); stream.finish(); assert.equal((await pending).complete, true);
  assert.equal(updates.length, 1);
});

test('the first ASR hypothesis displays without translation and later corrections replace it in place', async t => {
  const captions = [], calls = [];
  const buffer = new SentenceBuffer({ captions, lane: new ModelLane(), partialMs: 0,
    translate: async raw => { calls.push(raw); return complete(raw); },
  });
  t.after(() => buffer.close()); buffer.voice(Date.now());
  buffer.receive({ id: 'u1', revision: 1, raw: '預算批咗。', stable: '', final: false, startMs: 300, endMs: 1300 });
  assert.equal(cueRows(captions)[0].raw, '預算批咗。'); assert.deepEqual(cueRows(captions)[0].translations, {});
  await sleep(10); assert.equal(calls.length, 0); assert.deepEqual(cueRows(captions, { finalizedPrefix: true }), []);
  const first = cueRows(captions)[0];
  buffer.receive({ id: 'u1', revision: 2, raw: '預算仲未批，要等驗收。', stable: '預算仲未批，', final: false, startMs: 300, endMs: 2300 });
  assert.equal(cueRows(captions)[0].id, first.id); assert.ok(cueRows(captions)[0].revision > first.revision);
  assert.equal(cueRows(captions).map(c => c.raw).join(''), '預算仲未批，要等驗收。');
  await until(() => calls.length === 1); assert.equal(calls[0], '預算仲未批，');
  await until(() => cueRows(captions)[0]?.translations.en);
  assert.equal(cueRows(captions)[0].raw, '預算仲未批，');
  assert.ok(cueRows(captions).at(-1).raw.includes('要等驗收'));
  assert.deepEqual(cueRows(captions).at(-1).translations, {});
  buffer.receive({ id: 'u1', revision: 3, raw: '預算仲未批，要等驗收。', final: true, cutReason: 'pause', startMs: 300, endMs: 2700 });
  await until(() => captions[0].final);
  assert.equal(cueRows(captions).map(c => c.raw).join(''), '預算仲未批，要等驗收。');
  assert.ok(cueRows(captions).every(c => c.final && c.translations.yue));
});

test('a stale translation format error cannot suppress corrected speech', async t => {
  const gate = deferred(), captions = []; let started = false;
  const buffer = new SentenceBuffer({ captions, lane: new ModelLane(), partialMs: 0,
    translate: async raw => {
      if (!started) { started = true; await gate.promise; throw Object.assign(new Error('bad old response'), { kind: 'format' }); }
      return complete(raw);
    },
  });
  t.after(() => buffer.close()); buffer.voice(Date.now());
  buffer.receive({ id: 'u1', revision: 1, raw: '预算已经批准。', final: false }); await until(() => started);
  buffer.receive({ id: 'u1', revision: 2, raw: '预算还没有批准。', final: true, cutReason: 'pause' }); gate.resolve();
  await until(() => captions[0].final);
  assert.equal(captions[0].skipped, undefined); assert.equal(buffer.suppressed.has('u1'), false);
  assert.equal(cueRows(captions)[0].raw, '预算还没有批准。');
});

test('a final non-speech result withdraws only its tentative source and does not block later speech', async t => {
  const captions = [], calls = [];
  const buffer = new SentenceBuffer({ captions, lane: new ModelLane(), partialMs: 0,
    translate: async raw => { calls.push(raw); return complete(raw); },
  });
  t.after(() => buffer.close()); buffer.voice(Date.now());
  buffer.receive({ id: 'u1', revision: 1, raw: '似乎有人讲话。', stable: '', final: false });
  const revision = captionRevision(captions[0]); assert.equal(cueRows(captions).length, 1);
  buffer.receive({ id: 'u1', revision: 2, raw: '', final: true, cutReason: 'pause' });
  assert.deepEqual(cueRows(captions), []); assert.equal(buffer.current, null);
  assert.ok(captionRevision(captions[0]) > revision); assert.equal(calls.length, 0);
  buffer.receive({ id: 'u2', revision: 1, raw: '预算尚未批准。', final: true, cutReason: 'pause' });
  await until(() => captions[1].final);
  assert.equal(cueRows(captions)[0].raw, '预算尚未批准。');
});

test('out-of-order cue rows wait for their missing prefix and retain source order', async () => {
  const raw = '预算未批。日期未定。', value = valueFor(raw), stream = sse(), updates = [];
  const pending = translations(raw, settings, async () => stream.response, [], { onProgress: out => updates.push(out) });
  stream.content('{"cues":[' + JSON.stringify(value.cues[1]) + ','); await sleep(10); assert.equal(updates.length, 0);
  stream.content(JSON.stringify(value.cues[0]) + '],"complete":true}'); stream.finish();
  const out = await pending;
  assert.deepEqual(updates[0].cues.map(c => c.id), [1, 2]); assert.equal(out.cues.map(c => c.raw).join(''), raw);
});

test('unsupported streaming falls back only on the explicit parameter error and keeps the same connection', async () => {
  let count = 0;
  const out = await translations('预算未批。', settings, async (url, options) => {
    count++; assert.equal(url, 'http://provider/v1/chat/completions'); assert.equal(options.headers.authorization, 'Bearer synthetic-test-key');
    assert.equal(JSON.parse(options.body).stream, count === 1);
    return count === 1 ? new Response('stream is not supported', { status: 400 }) : jsonResponse(valueFor('预算未批。'));
  });
  assert.equal(count, 2); assert.equal(out.complete, true);
  for (const status of [401, 429, 503]) {
    let requests = 0;
    await assert.rejects(translations('预算未批。', settings, async () => { requests++; return new Response('stream is not supported', { status }); }));
    assert.equal(requests, 1);
  }
});

test('an abruptly ended stream is retried once and its temporary prefix is withdrawn', async () => {
  const raw = '预算未批。日期未定。', updates = []; let requests = 0;
  const out = await translations(raw, settings, async () => {
    if (++requests === 2) return jsonResponse(valueFor(raw));
    const stream = sse(); stream.content(JSON.stringify(valueFor(raw))); stream.close(); return stream.response;
  }, [], { onProgress: out => updates.push(out) });
  assert.equal(requests, 2); assert.equal(out.complete, true); assert.ok(updates.some(update => update === null));
  assert.equal(updates.at(-1), null);
});

test('refusal and stream error bodies never leak provider credentials or become final captions', async () => {
  const raw = '预算未批。'; let calls = 0;
  const updates = [];
  await assert.rejects(translations(raw, settings, async () => {
    calls++; const stream = sse(); stream.content('{"cues":[' + JSON.stringify(rowsFor(raw)[0]) + ']'); stream.finish('content_filter'); return stream.response;
  }, [], { onProgress: out => updates.push(out) }), error => error.kind === 'refusal');
  assert.equal(calls, 1); assert.equal(updates.at(-1), null);
  await assert.rejects(translations(raw, settings, async () => {
    const stream = sse(); stream.event({ error: { message: 'Bearer synthetic-test-key' } }); stream.close(); return stream.response;
  }), error => !error.message.includes('synthetic-test-key') && !error.kind);
});

test('aborting a stalled body cancels the reader and does not start a format retry', async () => {
  const controller = new AbortController(), stream = sse(); let calls = 0;
  const pending = translations('预算未批。', settings, async () => { calls++; return stream.response; }, [], { signal: controller.signal });
  await sleep(5); controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(stream.cancelled, true); assert.equal(calls, 1);
});

test('malformed SSE objects, truncated generations and oversized events use the bounded format retry', async () => {
  const raw = '预算未批。';
  for (const mode of ['null', 'bad-choices', 'length', 'oversized']) {
    let calls = 0;
    const out = await translations(raw, settings, async () => {
      if (++calls === 2) return jsonResponse(valueFor(raw));
      const stream = sse();
      if (mode === 'null') { stream.emit('data: null\n\n'); stream.close(); }
      else if (mode === 'bad-choices') { stream.event({ choices: {} }); stream.close(); }
      else if (mode === 'oversized') { stream.emit('data: ' + 'x'.repeat(1024 * 1024 + 1)); stream.close(); }
      else { stream.content(JSON.stringify(valueFor(raw))); stream.finish('length'); }
      return stream.response;
    });
    assert.equal(calls, 2, mode); assert.equal(out.complete, true);
  }
});

test('SSE can carry flat or fenced JSON without publishing guessed partial fields', async () => {
  const raw = '预算未批。';
  for (const content of [JSON.stringify({ ...trio(raw), complete: true }), '```json\n' + JSON.stringify(valueFor(raw)) + '\n```']) {
    const updates = [];
    const out = await translations(raw, settings, async () => {
      const stream = sse(); stream.content(content); stream.finish(); return stream.response;
    }, [], { onProgress: value => updates.push(value) });
    assert.equal(updates.length, 0); assert.equal(out.complete, true); assert.equal(out.cues[0].raw, raw);
  }
});

test('streamed captions remain provisional in snapshots and SRT until the complete response is validated', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-srt-')), store = new SubtitleStore(dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const raw = '预算未批。日期未定。', stream = sse(), captions = [];
  const buffer = new SentenceBuffer({ captions, lane: new ModelLane(), partialMs: 0,
    translate: (raw, prior, options) => translations(raw, settings, async () => stream.response, prior, options),
  });
  t.after(() => buffer.close());
  buffer.voice(Date.now()); buffer.receive({ id: 'u1', raw, final: true, cutReason: 'pause', startMs: 0, endMs: 2000 });
  await until(() => buffer.metrics.requests === 1);
  assert.equal(cueRows(captions).map(c => c.raw).join(''), raw);
  assert.ok(cueRows(captions).every(c => !Object.keys(c.translations).length));
  stream.content('{"cues":[' + JSON.stringify(rowsFor(raw)[0]) + ','); await until(() => cueRows(captions)[0]?.translations.en);
  assert.equal(cueRows(captions).length, 2); assert.deepEqual(cueRows(captions)[1].translations, {});
  assert.equal(captions[0].translations, null); assert.equal(captions[0].final, false);
  assert.equal(cueRows(captions)[0].final, false); store.sync(captions);
  assert.equal(fs.readFileSync(path.join(dir, subtitleFiles.original), 'utf8'), '');
  const firstRevision = captionRevision(captions[0]);
  stream.content(JSON.stringify(rowsFor(raw)[1]) + '],"complete":true}'); stream.finish();
  await until(() => captions[0].final); store.sync(captions);
  assert.equal(captions[0].provisional, undefined); assert.ok(captionRevision(captions[0]) > firstRevision);
  assert.equal(fs.readFileSync(path.join(dir, subtitleFiles.original), 'utf8').match(/ --> /g).length, 2);
});

function browserRows() {
  return Object.assign(Object.create(Transcript.prototype), {
    rows: [], nodes: new Map(), parentVersions: new Map(), following: false, animate: false,
    container: { classList: { toggle() {} } }, anchor: () => null, restore() {}, paint() {},
  });
}

test('rollback advances display revisions, removes invalid stream tails on desktop/phone and rejects delayed events', async t => {
  const raw = '预算未批。日期未定。', gate = deferred(), captions = [], browser = browserRows(); let options;
  const buffer = new SentenceBuffer({ captions, lane: new ModelLane(), partialMs: 0,
    translate: async (_raw, _prior, value) => { options = value; await gate.promise; throw new Error('outage'); },
    onChange: () => {
      const items = cueRows(captions);
      browser.merge(items, { replacements: captions.map(c => ({ id: c.id, revision: captionRevision(c), ids: items.filter(r => r.parentId === c.id).map(r => r.id) })) });
    },
  });
  t.after(() => buffer.close()); buffer.voice(Date.now());
  buffer.receive({ id: 'u1', raw, final: false, startMs: 0, endMs: 2000 }); await until(() => options);
  options.onProgress(complete(raw));
  const stale = structuredClone(cueRows(captions)); assert.equal(browser.rows.length, 2);
  const revision = captionRevision(captions[0]);
  gate.resolve(); await until(() => !buffer.jobs.size);
  assert.equal(browser.rows.map(c => c.raw).join(''), raw); assert.ok(browser.rows.every(c => !Object.keys(c.translations).length));
  assert.ok(captionRevision(captions[0]) > revision);
  const restored = structuredClone(browser.rows);
  browser.merge(stale); assert.deepEqual(browser.rows, restored);
  options.onProgress(complete(raw)); assert.deepEqual(browser.rows, restored);
});

test('old source progress and late completions cannot overwrite a corrected final sentence', async t => {
  const gate = deferred(), captions = []; let firstOptions, calls = 0;
  const buffer = new SentenceBuffer({ captions, lane: new ModelLane(), partialMs: 0,
    translate: async (raw, _prior, options) => {
      if (++calls === 1) { firstOptions = options; await gate.promise; }
      return complete(raw);
    },
  });
  t.after(() => buffer.close()); buffer.voice(Date.now());
  buffer.receive({ id: 'u1', raw: '预算已经批准。', final: false, startMs: 0, endMs: 1000 }); await until(() => firstOptions);
  firstOptions.onProgress(complete('预算已经批准。'));
  buffer.receive({ id: 'u1', raw: '预算还没有批准。', final: true, cutReason: 'pause', startMs: 0, endMs: 2000 });
  firstOptions.onProgress(complete('预算已经批准。')); gate.resolve();
  await until(() => captions[0].final);
  const saved = structuredClone(captions[0]); firstOptions.onProgress(complete('错误的迟到字幕。'));
  assert.deepEqual(captions[0], saved); assert.equal(cueRows(captions)[0].raw, '预算还没有批准。');
});

test('stop drains an identical in-flight final stream without submitting a duplicate translation', async t => {
  const raw = '预算未批。日期未定。', gate = deferred(), captions = []; let options, calls = 0;
  const buffer = new SentenceBuffer({ captions, lane: new ModelLane(), partialMs: 0,
    translate: async (raw, _prior, value) => { calls++; options = value; await gate.promise; return complete(raw); },
  });
  t.after(() => buffer.close()); buffer.voice(Date.now());
  buffer.receive({ id: 'u1', raw, final: true, cutReason: 'pause', startMs: 0, endMs: 2000 }); await until(() => options);
  options.onProgress(complete(raw));
  const flush = buffer.flush(); await sleep(10);
  assert.equal(calls, 1); assert.equal(captions[0].final, false);
  gate.resolve(); await flush;
  assert.equal(calls, 1); assert.equal(captions[0].final, true); assert.equal(buffer.pending, 0);
  assert.equal(cueRows(captions).length, 2); assert.equal(captions[0].provisional, undefined);
});

test('desktop and phone snapshots share streamed groups; end waits for validation before writing SRT', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-stream-cues-'));
  const raw = '预算未批。日期未定。', stream = sse(); let requests = 0;
  const service = createApp({ env: {}, dataDir: dir, transport: async (url, options) => {
    if (String(url).endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: raw }));
    const schema = JSON.parse(JSON.parse(options.body).messages[0].content.split('\n')[1].slice('只返回 JSON：'.length, -1));
    assert.equal(Object.keys(schema.cues[0])[2], 'yue');
    requests++; return stream.response;
  } });
  const server = await new Promise(resolve => { const listener = service.app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(async () => { service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const api = async (route, data, method = data === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    assert.ok(response.ok, route); return response.json();
  };
  await api('/api/settings', { asr: { baseURL: 'http://provider/v1', model: 'asr' }, translation: { model: 'translator', useAsrConnection: true } }, 'PUT');
  const session = await api('/api/sessions', { title: 'Stream regression' });
  await api('/api/sessions/' + session.id + '/preferred-language', { language: 'yue' });
  assert.equal((await api('/api/sessions/' + session.id)).status, 'ready'); assert.equal(requests, 0);
  const invalidPreference = await fetch(base + '/api/sessions/' + session.id + '/preferred-language', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"language":"invalid"}' });
  assert.equal(invalidPreference.status, 400);
  const share = await api('/api/sessions/' + session.id + '/share'), token = new URL(share.url).pathname.split('/').at(-1);
  const pcm = Buffer.concat([Buffer.from(new Int16Array(9600).fill(2400).buffer), Buffer.alloc(22400)]);
  const ack = await fetch(base + '/api/sessions/' + session.id + '/audio?startMs=0&chunkId=one', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm });
  assert.ok(ack.ok); await until(() => requests === 1);
  const before = await api('/api/sessions/' + session.id);
  assert.equal(before.captions.map(c => c.raw).join(''), raw); assert.ok(before.captions.every(c => !c.translations.en));
  stream.content('{"cues":[' + JSON.stringify(rowsFor(raw)[0]) + ',');
  let snapshot;
  for (let n = 0; n < 100; n++) { snapshot = await api('/api/sessions/' + session.id); if (snapshot.captions[0]?.translations.en) break; await sleep(5); }
  assert.equal(snapshot.captions.length, 2); assert.equal(snapshot.captions[0].final, false);
  assert.equal(snapshot.captions[1].translations.en, '');
  const phone = await api('/api/watch/' + token); assert.deepEqual(phone.captions, snapshot.captions);
  assert.deepEqual(snapshot.captionParents[0].ids, snapshot.captions.map(c => c.id));
  assert.equal(await (await fetch(base + '/api/sessions/' + session.id + '/subtitles/original')).text(), '');
  await api('/api/sessions/' + session.id + '/end', {}); await sleep(10);
  assert.equal(requests, 1); assert.equal((await api('/api/sessions/' + session.id)).status, 'finalizing');
  stream.content(JSON.stringify(rowsFor(raw)[1]) + '],"complete":true}'); stream.finish();
  for (let n = 0; n < 100; n++) { snapshot = await api('/api/sessions/' + session.id); if (snapshot.status === 'ended') break; await sleep(5); }
  assert.equal(snapshot.status, 'ended'); assert.equal(requests, 1);
  const endedPreference = await fetch(base + '/api/sessions/' + session.id + '/preferred-language', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"language":"en"}' });
  assert.equal(endedPreference.status, 409);
  assert.equal(snapshot.captions.length, 2); assert.ok(snapshot.captions.every(c => c.final));
  const saved = await (await fetch(base + '/api/sessions/' + session.id + '/subtitles/original')).text();
  assert.equal(saved.match(/ --> /g).length, 2); assert.match(saved, /预算未批。/); assert.match(saved, /日期未定。/);
});
