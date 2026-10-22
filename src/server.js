import { cueRows, captionRevision } from './captions/cue-text.js';
import { SubtitleStore, subtitleFiles } from './storage/subtitle-store.js';
// Local caption service; provider connections use OpenAI-compatible HTTP shapes.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import QRCode from 'qrcode';
import { ZipArchive } from 'archiver';
import { RecordingStore } from './storage/recording-store.js';
import { MeetingDeletion } from './storage/meeting-deletion.js';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { recognize, translations } from './providers/openai-compatible.js';
import { SettingsStore, connection, publicSettings as settingsView, settingsReady, updateSettings } from './configuration.js';
import { ModelLane } from './captions/model-lane.js';
import { IncrementalAsr } from './captions/incremental-asr.js';
import { SentenceBuffer } from './captions/sentences.js';
import { createSpeechDetector, SpeechPipeline } from './audio/speech-detector.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const read = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
const write = (file, value) => {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, file);
};
const isMeeting = data => data?.kind === 'meeting' && data.version === 2 && Array.isArray(data.segments) && Array.isArray(data.captions);

export function createApp({ dataDir = path.join(ROOT, 'data'), transport = fetch, disconnectMs = 15000, recordingPartBytes, env = process.env, speechDetectorFactory = createSpeechDetector, captureLeaseMs = 15000, captureNow = Date.now } = {}) {
  const deletion = new MeetingDeletion(dataDir); deletion.recover();
  const sessionDir = path.join(dataDir, 'sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  const store = new SettingsStore(dataDir, env);
  let settings = store.value;
  const sessions = new Map(), recorders = new Map(), subtitleStores = new Map();
  const subtitles = ctx => {
    if (!subtitleStores.has(ctx.data.id)) subtitleStores.set(ctx.data.id, new SubtitleStore(path.join(dataDir, 'subtitles', ctx.data.id)));
    return subtitleStores.get(ctx.data.id);
  };
  const records = ctx => ctx.data.captions;
  const captionParents = ctx => records(ctx).slice(-60).map(c => ({ id: c.id, revision: captionRevision(c), ids: cueRows([c]).map(row => row.id) }));
  const epoch = crypto.randomUUID();
  const currentFile = path.join(dataDir, 'current.json');
  const addresses = () => [...new Set(Object.values(os.networkInterfaces()).flat().filter(v => v && v.family === 'IPv4' && !v.internal && !v.address.startsWith('169.254.')).map(v => v.address))];
  const recorder = ctx => {
    try { if (!recorders.has(ctx.data.id)) recorders.set(ctx.data.id, new RecordingStore(path.join(dataDir, 'recordings', ctx.data.id), { partBytes: recordingPartBytes })); }
    catch { throw fail('录音未能保存到本机，请检查磁盘空间后重试。', 503); }
    return recorders.get(ctx.data.id);
  };
  const summary = ctx => recorders.get(ctx.data.id)?.summary() || ctx.data.recording || { available: false, bytes: 0, durationMs: 0, parts: [] };

  const asrLane = new ModelLane(), translationLane = new ModelLane();
  const publicSettings = () => ({ ...settingsView(settings), networkAddresses: addresses(), captureProtocol: 1 });
  const captureError = (message, code = 'capture_busy') => Object.assign(fail(message, 409), { code });
  const checkCapture = (ctx, req) => {
    const id = req.query.captureId ?? req.body?.captureId;
    if (ctx.captureOwner && id !== ctx.captureOwner) throw captureError('另一个页面正在收音，请先在该页面暂停。');
    if (!ctx.captureOwner && id !== undefined) throw captureError('采音权限已失效，请重新点击开始收音。', 'capture_expired');
    if (ctx.captureOwner) ctx.captureSeenAt = captureNow();
  };
  // Full transcripts stay on disk; a bounded live snapshot keeps long-running pages small.
  const view = ctx => {
    const terminal = ['ended', 'interrupted'].includes(ctx.data.status);
    const records = ctx.data.captions;
    const skipped = records.filter(s => s.translationSkipped || s.skipped);
    const failures = records.filter(s => s.translationError && !s.translationSkipped && !s.skipped);
    const refusals = failures.filter(s => s.translationErrorKind === 'refusal');
    const latest = failures.findLast(s => s.translationErrorKind !== 'refusal') || failures.at(-1);
    return {
      id: ctx.data.id, title: ctx.data.title, createdAt: ctx.data.createdAt,
      createdByUser: !!ctx.data.createdByUser, status: ctx.data.status || 'ended', startedAt: ctx.data.startedAt, endedAt: ctx.data.endedAt,
      recording: summary(ctx), ingestEndMs: ctx.data.ingestEndMs || recorders.get(ctx.data.id)?.endMs || 0, saveError: ctx.saveError || null, epoch,
      update: ctx.update || 0,
      captureActive: !!ctx.captureOwner && captureNow() - ctx.captureSeenAt < captureLeaseMs,
      version: ctx.data.version,
      segments: ctx.data.segments.slice(-60), segmentCount: ctx.data.segments.length,
      captions: captionList(ctx).slice(-60), captionCount: captionList(ctx).length, captionParents: captionParents(ctx), captionSchema: 'cue-v1',
      pendingFinals: (ctx.asr?.pendingFinals || 0) + (ctx.sentences?.pendingFinals || 0),
      backpressure: (ctx.asr?.pendingFinals || 0) + (ctx.sentences?.pendingFinals || 0) >= 12 || ctx.speech?.pendingMs >= 12000,
      draining: !!ctx.draining, metrics: { asr: ctx.asr?.metrics, translation: ctx.sentences?.metrics, vad: ctx.speech?.metrics, providerRequests: ctx.providerRequests },
      processing: !terminal && (!!ctx.asr?.processing || ctx.speech?.pendingMs > 0), pendingTranslations: terminal ? 0 : ctx.sentences?.pending || 0,
      translationErrors: failures.length, translationRefusals: refusals.length, translationSkipped: skipped.length,
      translationFailure: latest ? { segmentId: latest.id, message: latest.translationError, kind: latest.translationErrorKind || 'processing' } : null,
      error: ctx.error || null,
    };
  };
  const persist = ctx => {
    if (ctx.deleted) return;
    ctx.data.recording = summary(ctx); ctx.data.update = ctx.update || 0; ctx.data.cues = cueRows(records(ctx));
    write(path.join(sessionDir, ctx.data.id + '.json'), ctx.data);
    subtitles(ctx).sync(records(ctx));
  };
  const broadcast = ctx => {
    if (ctx.deleted) return;
    ctx.update = (ctx.update || 0) + 1;
    const message = 'data: ' + JSON.stringify(view(ctx)) + '\n\n';
    for (const res of ctx.watchers) res.write(message);
    const publicMessage = 'data: ' + JSON.stringify(watchView(ctx)) + '\n\n';
    for (const res of ctx.viewers) res.write(publicMessage);
  };
  const changed = (ctx, save = true) => {
    if (ctx.closed) return;
    if (save) try { persist(ctx); } catch { ctx.error = '字幕未能保存到本机，请检查磁盘空间。'; }
    broadcast(ctx);
  };
  const context = data => ({
    data, update: data.update || 0, watchers: new Set(), viewers: new Set(), fedChunks: new Set(), error: null,
  });
  const get = id => {
    id = String(id).toLowerCase();
    if (!/^[\da-f-]{36}$/i.test(id) || deletion.has(id)) throw fail('找不到这场字幕。', 404);
    if (!sessions.has(id)) {
      const data = read(path.join(sessionDir, id + '.json'), null);
      if (!isMeeting(data)) throw fail('找不到这场字幕。', 404);
      // Restore display state without rerunning saved audio or text through models.
      for (const c of data.captions) {
        // A saved stream overlay was never validated as a complete response.
        if (c.provisional) { delete c.provisional; c.displayRevision = captionRevision(c) + 1; }
        if (!c.final) c.interrupted = true;
      }
      const ctx = context(data); sessions.set(id, ctx);
      if (fs.existsSync(path.join(dataDir, 'recordings', id))) {
        data.recording = recorder(ctx).summary(); data.ingestEndMs = Math.max(data.ingestEndMs || 0, recorder(ctx).endMs);
      }
      if (['recording', 'finalizing'].includes(data.status) || (data.status === 'ready' && summary(ctx).bytes)) {
        data.startedAt ||= new Date(recorder(ctx).receipts.values().next().value?.capturedAt || Date.parse(data.createdAt)).toISOString();
        data.status = 'interrupted'; data.endedAt = new Date().toISOString(); persist(ctx);
      }

    }
    return sessions.get(id);
  };
  const streaming = ctx => {
    if (ctx.asr) return;
    ctx.providerRequests = { asr: 0, translation: 0 };
    const tracked = kind => (...args) => { ctx.providerRequests[kind]++; return transport(...args); };
    ctx.sentences = new SentenceBuffer({
      captions: ctx.data.captions, lane: translationLane,
      translate: (raw, prior, options) => translations(raw, connection(settings, 'translation'), tracked('translation'), prior, { ...options, priorityLanguage: ctx.captionLanguage || 'zhHans' }),
      asrPending: () => ctx.asr?.pendingFinals > 0 || ctx.speech?.pendingMs > 0, speaking: () => ctx.asr?.speaking,
      onError: e => { ctx.error = e.message; changed(ctx); }, onChange: () => changed(ctx),
    });
    ctx.asr = new IncrementalAsr({
      recognize: (pcm, signal) => recognize(pcm, connection(settings, 'asr'), tracked('asr'), { signal }), lane: asrLane,
      startId: ctx.data.segments.reduce((n, s) => Math.max(n, Number(s.id.slice(1)) || 0), 0),
      suppressed: id => ctx.sentences.suppressed.has(id),
      onVoice: at => ctx.sentences.voice(at),
      onResult: result => {
        const old = ctx.data.segments.find(s => s.id === result.id);
        if (old) Object.assign(old, result); else ctx.data.segments.push(result);
        changed(ctx); // recognition is saved before its text reaches the translator
        ctx.sentences.receive(result);
      },
      onChange: () => { ctx.sentences.notify(); changed(ctx, false); },
      onError: e => { ctx.error = e.message; changed(ctx); },
    });
    ctx.speech = new SpeechPipeline({ factory: speechDetectorFactory,
      onFrame: (pcm, startMs, probability) => ctx.asr.feed(pcm, startMs, [probability]),
      onError: e => { ctx.error = e.message; changed(ctx); }, onChange: () => { ctx.sentences.notify(); changed(ctx, false); },
    });
  };
  const drain = ctx => {
    if (ctx.drainPromise) return ctx.drainPromise;
    streaming(ctx); ctx.draining = true; changed(ctx);
    ctx.drainPromise = (async () => { await ctx.speech.drain(); await ctx.asr.drain(); await ctx.sentences.flush(); ctx.speech.reset(); })()
      .finally(() => { ctx.draining = false; ctx.drainPromise = null; changed(ctx); });
    return ctx.drainPromise;
  };
  const newSession = (makeCurrent = true, title = '未命名会议') => {
    const data = { id: crypto.randomUUID(), version: 2, title, kind: 'meeting',
      status: 'ready', watchToken: crypto.randomBytes(32).toString('base64url'), createdAt: new Date().toISOString(), segments: [],
      captions: [], ingestEndMs: 0, receipts: [] };
    const ctx = context(data); sessions.set(data.id, ctx); persist(ctx);
    if (makeCurrent) write(currentFile, { id: data.id });
    return ctx;
  };
  const allIds = () => fs.readdirSync(sessionDir).filter(v => /^[\da-f-]{36}\.json$/i.test(v))
    .filter(v => !deletion.has(v.slice(0, -5)) && isMeeting(read(path.join(sessionDir, v), {}))).map(v => v.slice(0, -5));
  const current = () => {
    const id = read(currentFile, {}).id;
    if (id) { try { return get(id); } catch (e) { if (e.status !== 404) throw e; } }
    return newSession();
  };
  const publicCaption = c => ({ id: c.id, parentId: c.parentId, timing: c.timing, raw: c.raw || '', revision: c.revision || 0, final: c.final !== false,
    startMs: c.startMs, endMs: c.endMs, translations: { zhHans: c.translations.zhHans || '', en: c.translations.en || '', yue: c.translations.yue || '' } });
  const captionList = ctx => cueRows(records(ctx)).map(publicCaption);
  const watchView = ctx => ({ id: ctx.data.id, title: ctx.data.title,
    status: ctx.data.status || 'ended', update: ctx.update || 0, epoch, captionParents: captionParents(ctx), captionSchema: 'cue-v1', captions: captionList(ctx).slice(-60), captionCount: captionList(ctx).length });
  const byToken = token => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw fail('找不到这场会议。', 404);
    for (const ctx of sessions.values()) if (ctx.data.watchToken === token && !ctx.deleted && !deletion.has(ctx.data.id)) return ctx;
    for (const id of allIds()) if (read(path.join(sessionDir, id + '.json'), {}).watchToken === token) return get(id);
    throw fail('找不到这场会议。', 404);
  };
  const pageCaptions = (ctx, query) => {
    const rows = captionList(ctx), limit = Math.max(1, Math.min(100, Number(query.limit) || 60));
    let first, last = rows.length;
    if (query.before) { last = rows.findIndex(c => c.id === query.before); if (last < 0) throw fail('字幕位置不存在。'); }
    if (query.after) { first = rows.findIndex(c => c.id === query.after) + 1; if (!first) throw fail('字幕位置不存在。'); last = Math.min(last, first + limit); }
    else first = Math.max(0, last - limit);
    return { items: rows.slice(first, last), hasBefore: first > 0, hasAfter: last < rows.length, total: rows.length };
  };
  const end = (ctx, interrupted = false) => {
    if (ctx.endPromise) return ctx.endPromise;
    if (['ended', 'interrupted'].includes(ctx.data.status) && !ctx.saveError) return Promise.resolve();
    clearTimeout(ctx.disconnectTimer); ctx.data.status = 'finalizing'; ctx.saveError = null; changed(ctx);
    ctx.endPromise = (async () => {
      try { await drain(ctx); } catch (e) { ctx.error = e.message; }
      // Audio saving is independent of a provider failure. Preserve incomplete text
      // and its state; an ended meeting is never sent back to the models on read.
      ctx.speech?.close(); ctx.asr?.close(); ctx.sentences?.close(); ctx.fedChunks.clear(); ctx.captureOwner = null;
      ctx.data.status = interrupted ? 'interrupted' : 'ended'; ctx.data.endedAt = new Date().toISOString();
      try { persist(ctx); } catch {
        ctx.data.status = 'finalizing'; ctx.saveError = '会议未全部保存，请检查磁盘空间后重试保存。';
      }
      if (!ctx.saveError) recorders.delete(ctx.data.id);
      broadcast(ctx);
    })().finally(() => { ctx.endPromise = null; });
    return ctx.endPromise;
  };
  const events = (ctx, req, res, viewer = false) => {
    const set = viewer ? ctx.viewers : ctx.watchers;
    if (!viewer) clearTimeout(ctx.disconnectTimer);
    res.set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    set.add(res); res.write('data: ' + JSON.stringify(viewer ? watchView(ctx) : view(ctx)) + '\n\n');
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => {
      clearInterval(heartbeat); set.delete(res);
      if (!viewer && !ctx.closed && !ctx.watchers.size && ctx.data.status === 'recording') {
        ctx.disconnectTimer = setTimeout(() => { if (!ctx.watchers.size) void end(ctx, true); }, disconnectMs);
        ctx.disconnectTimer.unref();
      }
    });
  };
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = (req.hostname || '').toLowerCase();
    if (!['localhost', '127.0.0.1', '[::1]', ...addresses()].includes(host)) return res.status(403).json({ error: '访问地址不受支持。' });
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!local && !/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(peer)) return res.status(403).json({ error: '字幕观看仅向局域网开放。' });
    const viewerPath = /^\/watch\/[A-Za-z0-9_-]{43}$/.test(req.path) || /^\/api\/watch\/[A-Za-z0-9_-]{43}(?:\/(?:events|captions))?$/.test(req.path);
    const viewerAsset = ['/watch.js', '/watch.css', '/transcript.js', '/style.css'].includes(req.path) || req.path.startsWith('/fonts/');
    if (!local && (req.method !== 'GET' || (!viewerPath && !viewerAsset))) return res.status(403).json({ error: '此操作仅允许电脑本机访问，请通过会议二维码观看字幕。' });
    if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) return res.status(403).json({ error: '不接受其他网页发起的请求。' });
    res.set({
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.get('/api/settings', (_req, res) => res.json(publicSettings()));
  app.put('/api/settings', (req, res) => {
    const next = updateSettings(settings, req.body);
    if (next.networkAddress && !addresses().includes(next.networkAddress)) throw fail('请选择本机可用的局域网地址。');
    const serviceChanged = JSON.stringify([settings.asr, settings.translation]) !== JSON.stringify([next.asr, next.translation]);
    const requestsRunning = [asrLane, translationLane].some(lane => lane.active || lane.waiting.length);
    const unsettled = [...sessions.values()].some(ctx => ctx.draining || ctx.endPromise || (!ctx.error && (ctx.data.status === 'recording' || ctx.asr?.processing || ctx.sentences?.pending)));
    if (serviceChanged && (requestsRunning || unsettled)) throw fail('请先暂停收音并等待当前音频处理完成，再修改服务配置。', 409);
    store.write(next); settings = next;
    res.json(publicSettings());
  });
  app.get('/api/sessions/current', (_req, res) => res.json(view(current())));
  app.get('/api/sessions', (req, res) => {
    const before = String(req.query.before || ''), limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30));
    const rows = allIds().map(id => get(id)).filter(ctx => ctx.data.createdByUser || ctx.data.startedAt || ctx.data.segments.length || ctx.data.captions?.length || summary(ctx).bytes)
      .sort((a, b) => b.data.createdAt.localeCompare(a.data.createdAt) || b.data.id.localeCompare(a.data.id));
    const offset = before ? rows.findIndex(ctx => ctx.data.id === before) + 1 : 0;
    const page = rows.slice(offset, offset + limit);
    res.json({ items: page.map(ctx => ({ id: ctx.data.id, title: ctx.data.title, createdAt: ctx.data.createdAt, status: ctx.data.status || 'ended', startedAt: ctx.data.startedAt, endedAt: ctx.data.endedAt, recording: summary(ctx), captionCount: captionList(ctx).length })), next: offset + limit < rows.length ? page.at(-1)?.data.id : null });
  });
  app.post('/api/sessions', (req, res) => {
    if (!req.body?.draft && !settingsReady(settings)) throw fail('请先完成识别与翻译服务设置。');
    if (Object.hasOwn(req.body || {}, 'title') && (typeof req.body.title !== 'string' || req.body.title.trim().length > 120)) throw fail('会议名称最多为 120 个字符。');
    const title = Object.hasOwn(req.body || {}, 'title') ? req.body.title.trim() || '未命名会议' : undefined;
    if (req.body?.version !== undefined && req.body.version !== 2) throw fail('新会议仅支持当前字幕协议。');
    const ctx = newSession(true, title);
    if (title !== undefined) { ctx.data.createdByUser = true; persist(ctx); }
    res.status(201).json(view(ctx));
  });
  app.delete('/api/sessions/:id', (req, res) => {
    const id = req.params.id.toLowerCase();
    if (req.body?.confirm !== true) throw fail('请确认后再删除会议。');
    if (!deletion.has(id)) {
      const ctx = get(id);
      if (!['ended', 'interrupted'].includes(ctx.data.status) || ctx.endPromise || ctx.drainPromise || ctx.asr?.processing || ctx.sentences?.pending) throw fail('请先结束会议并完成保存，再删除。', 409);
      if (ctx.downloads) throw fail('会议文件正在下载，请完成后再删除。', 409);
      try { deletion.mark(id); } catch { throw fail('无法记录删除操作，会议未删除，请检查磁盘权限后重试。', 503); }
      ctx.deleted = true; ctx.closed = true; clearTimeout(ctx.disconnectTimer); ctx.speech?.close(); ctx.asr?.close(); ctx.sentences?.close();
      for (const client of [...ctx.watchers, ...ctx.viewers]) { client.write('event: deleted\ndata: ' + JSON.stringify({ id }) + '\n\n'); client.end(); }
      ctx.watchers.clear(); ctx.viewers.clear(); sessions.delete(id); recorders.delete(id); subtitleStores.delete(id);
    }
    try { deletion.purge(id); } catch { throw fail('会议已停止共享，但部分文件尚未删除，请重试删除。', 503); }
    res.json({ deleted: true, id });
  });
  app.get('/api/sessions/:id', (req, res) => res.json(view(get(req.params.id))));
  app.get('/api/sessions/:id/captions', (req, res) => res.json(pageCaptions(get(req.params.id), req.query)));
  app.get('/api/sessions/:id/events', (req, res) => events(get(req.params.id), req, res));
  app.post('/api/sessions/:id/capture', (req, res) => {
    const ctx = get(req.params.id), id = req.body?.captureId;
    if (typeof id !== 'string' || !/^[\w-]{10,80}$/.test(id)) throw fail('采音页面编号无效。');
    if (['ended', 'interrupted', 'finalizing'].includes(ctx.data.status)) throw fail('本场会议已结束。', 409);
    if (ctx.draining) throw captureError('上一轮音频仍在排空，请稍后继续。');
    const held = ctx.captureOwner && captureNow() - ctx.captureSeenAt < captureLeaseMs;
    if ((held && ctx.captureOwner !== id) || (!ctx.captureOwner && ctx.data.status === 'recording')) throw captureError('另一个页面正在收音，请先在该页面暂停。');
    // Reserve before requesting microphone permission. Audio uploads renew the
    // lease; an abandoned permission prompt or closed tab expires automatically.
    ctx.captureOwner = id; ctx.captureSeenAt = captureNow();
    res.json({ ingestEndMs: Math.max(ctx.data.ingestEndMs || 0, recorders.get(ctx.data.id)?.endMs || 0) });
  });
  app.delete('/api/sessions/:id/capture', (req, res) => {
    const ctx = get(req.params.id);
    if (ctx.captureOwner) checkCapture(ctx, req);
    if (ctx.draining || ctx.speech?.pendingMs || ctx.asr?.processing || ctx.sentences?.pending) throw captureError('音频尚未处理完成，请稍后暂停。');
    ctx.captureOwner = null;
    if (ctx.data.status === 'recording') ctx.data.status = 'paused';
    changed(ctx); res.json({ released: true });
  });
  app.post('/api/sessions/:id/preferred-language', (req, res) => {
    const ctx = get(req.params.id), language = req.body?.language;
    if (!['zhHans', 'en', 'yue'].includes(language)) throw fail('请选择中文、English 或粵語。');
    if (['ended', 'interrupted', 'finalizing'].includes(ctx.data.status)) throw fail('本场会议已结束。', 409);
    // Scheduling preference only: all languages remain in each translation. Do
    // not restart a request or microphone when the host switches the display.
    ctx.captionLanguage = language; res.json({ language });
  });
  app.post('/api/sessions/:id/start', (req, res) => {
    const ctx = get(req.params.id);
    checkCapture(ctx, req);
    if (!settingsReady(settings)) throw fail('请先完成识别与翻译服务设置。');
    if (['ended', 'interrupted', 'finalizing'].includes(ctx.data.status)) throw fail('本场会议已结束，请开始新会议。', 409);
    ctx.data.status = 'recording'; ctx.data.startedAt ||= new Date().toISOString(); changed(ctx); res.json(view(ctx));
  });
  app.post('/api/sessions/:id/pause', (req, res) => {
    const ctx = get(req.params.id);
    if (!['recording', 'paused'].includes(ctx.data.status)) throw fail('当前会议不能暂停。', 409);
    ctx.data.status = 'paused'; changed(ctx); res.json(view(ctx));
  });
  app.post('/api/sessions/:id/end', (req, res) => {
    const ctx = get(req.params.id);
    void end(ctx).catch(e => { ctx.saveError = e.message; broadcast(ctx); }); res.status(202).json(view(ctx));
  });
  app.post('/api/sessions/:id/interrupt', (req, res) => {
    const ctx = get(req.params.id);
    if (ctx.data.status === 'recording') void end(ctx, true);
    res.status(202).json(view(ctx));
  });
  app.get('/api/sessions/:id/share', async (req, res) => {
    const ctx = get(req.params.id);
    if (!ctx.data.watchToken) { ctx.data.watchToken = crypto.randomBytes(32).toString('base64url'); persist(ctx); }
    const address = addresses().includes(settings.networkAddress) ? settings.networkAddress : addresses()[0];
    if (!address) return res.json({ url: null, qr: null, message: '连接 Wi-Fi 后即可生成手机观看二维码。' });
    const url = 'http://' + address + ':' + req.socket.localPort + '/watch/' + ctx.data.watchToken;
    res.json({ url, qr: await QRCode.toDataURL(url, { width: 240, margin: 3, errorCorrectionLevel: 'M' }) });
  });
  app.get('/api/sessions/:id/subtitles/:language', (req, res) => {
    const ctx = get(req.params.id), file = Object.hasOwn(subtitleFiles, req.params.language) ? subtitleFiles[req.params.language] : null;
    if (!file) throw fail('字幕语言不存在。', 404);
    subtitles(ctx).sync(records(ctx));
    ctx.downloads = (ctx.downloads || 0) + 1; res.once('close', () => { ctx.downloads--; });
    res.download(path.join(dataDir, 'subtitles', ctx.data.id, file), file);
  });
  app.get('/api/sessions/:id/download', (req, res) => {
    const ctx = get(req.params.id);
    if (['ready', 'recording', 'paused', 'finalizing'].includes(ctx.data.status)) throw fail('请结束会议并保存后再下载。', 409);
    const savedAudio = fs.existsSync(path.join(dataDir, 'recordings', ctx.data.id)) ? recorder(ctx) : null;
    ctx.downloads = (ctx.downloads || 0) + 1; res.once('close', () => { ctx.downloads--; });
    res.attachment('meeting-' + ctx.data.id + '.zip');
    const zip = new ZipArchive({ zlib: { level: 1 } });
    zip.on('error', e => res.destroy(e)); res.on('close', () => zip.abort()); zip.pipe(res);
    subtitles(ctx).sync(records(ctx));
    for (const file of Object.values(subtitleFiles)) zip.file(path.join(dataDir, 'subtitles', ctx.data.id, file), { name: file });
    if (savedAudio) {
      for (const part of savedAudio.parts) zip.file(path.join(savedAudio.dir, part.file), { name: part.file });
    }
    void zip.finalize();
  });
  app.get('/watch/:token', (req, res) => { byToken(req.params.token); res.set('Cache-Control', 'no-store').sendFile(path.join(ROOT, 'public', 'watch.html')); });
  app.get('/api/watch/:token', (req, res) => res.json(watchView(byToken(req.params.token))));
  app.get('/api/watch/:token/captions', (req, res) => res.json(pageCaptions(byToken(req.params.token), req.query)));
  app.get('/api/watch/:token/events', (req, res) => events(byToken(req.params.token), req, res, true));
  app.post('/api/sessions/:id/retry-translations', (req, res) => {
    const ctx = get(req.params.id);
    if (['ended', 'interrupted'].includes(ctx.data.status)) throw fail('已保存会议不会重新调用服务。', 409);
    if (ctx.drainPromise) return res.status(202).json(view(ctx));
    streaming(ctx); ctx.error = null;
    ctx.draining = true;
    ctx.drainPromise = (async () => { await ctx.speech.retry(); await ctx.asr.retry(); await ctx.sentences.retry(); ctx.speech.reset(); })()
      .catch(e => { ctx.error = e.message; }).finally(() => { ctx.draining = false; ctx.drainPromise = null; changed(ctx); });
    changed(ctx); res.status(202).json(view(ctx));
  });
  app.post('/api/sessions/:id/flush', (req, res) => {
    const ctx = get(req.params.id);
    if (['ended', 'interrupted'].includes(ctx.data.status)) throw fail('已保存会议不会重新调用服务。', 409);
    void drain(ctx).catch(e => { ctx.error = e.message; changed(ctx); });
    res.status(202).json(view(ctx));
  });
  app.post('/api/sessions/:id/audio', express.raw({ type: 'application/octet-stream', limit: '400kb' }), async (req, res) => {
    const ctx = get(req.params.id);
    checkCapture(ctx, req);
    if (['ended', 'interrupted', 'finalizing'].includes(ctx.data.status)) throw fail('本场会议已结束，无法追加录音。', 409);
    if (!Buffer.isBuffer(req.body) || !req.body.length || req.body.length % 2 || req.body.length > 32000 * 12) throw fail('音频须为不超过 12 秒的 16 kHz 单声道 PCM16。');
    const startMs = Number(req.query.startMs), durationMs = req.body.length / 32;
    if (!Number.isSafeInteger(startMs) || startMs < 0 || startMs > Number.MAX_SAFE_INTEGER - durationMs) throw fail('音频时间无效。');
    const chunkId = String(req.query.chunkId || '');
    if (chunkId && !/^[\w-]{1,80}$/.test(chunkId)) throw fail('音频片段编号无效。');
    if (!chunkId || req.body.length % 3200) throw fail('请提交带编号的完整 100ms PCM 音频帧。');
    const store = recorder(ctx);
    const receipt = store.receipts.get(chunkId);
    if (receipt) {
      store.append(req.body, { id: chunkId, startMs });
      if (!ctx.fedChunks.has(chunkId)) {
        ctx.data.ingestEndMs = Math.max(ctx.data.ingestEndMs || 0, receipt.endMs);
        ctx.data.status = 'recording'; ctx.data.startedAt ||= new Date().toISOString();
        if (!ctx.audioMetadataSaved) { persist(ctx); ctx.audioMetadataSaved = true; }
        streaming(ctx); ctx.fedChunks.add(chunkId); ctx.speech.feed(req.body, startMs); }
      return res.json({ accepted: true, endMs: receipt.endMs });
    }
    if (startMs < ctx.data.ingestEndMs) throw fail('音频时间重叠，未再次接收。', 409);
    if (ctx.draining) throw fail('上一轮音频仍在排空。', 409);
    if (ctx.error) throw fail(ctx.error, 503);
    const accepted = store.append(req.body, { id: chunkId, startMs, capturedAt: Number(req.query.capturedAt) || undefined });
    ctx.data.status = 'recording'; ctx.data.startedAt ||= new Date().toISOString();
    ctx.data.recording = store.summary();
    if (!ctx.audioMetadataSaved) { persist(ctx); ctx.audioMetadataSaved = true; }
    streaming(ctx);
    ctx.data.ingestEndMs = startMs + durationMs;
    ctx.data.receipts.push({ id: chunkId, endMs: ctx.data.ingestEndMs });
    if (ctx.data.receipts.length > 300) ctx.data.receipts.shift();
    ctx.fedChunks.add(chunkId); ctx.speech.feed(req.body, startMs); changed(ctx, false);
    if (!accepted) throw fail('录音未能确认保存。', 503);
    return res.json({ accepted: true, endMs: ctx.data.ingestEndMs });
  });
  app.use(express.static(path.join(ROOT, 'public')));
  app.use((err, _req, res, _next) => {
    const message = err.name === 'TimeoutError' ? '服务响应超时，请重试。' : err.message === 'fetch failed' ? '无法连接服务，请检查设置。' : err.type === 'entity.too.large' ? '音频片段过大。' : err.message;
    res.status(err.status || 502).json({ error: message || '处理失败，请重试。', ...(['capture_busy', 'capture_expired'].includes(err.code) ? { code: err.code } : {}) });
  });
  return { app, close: () => {
    for (const ctx of sessions.values()) {
      clearTimeout(ctx.disconnectTimer);
      if (ctx.data.status === 'recording' || ctx.data.status === 'finalizing') { ctx.data.status = 'interrupted'; ctx.data.endedAt = new Date().toISOString(); try { persist(ctx); } catch {} }
      ctx.closed = true; ctx.speech?.close(); ctx.asr?.close(); ctx.sentences?.close();
      for (const res of [...ctx.watchers, ...ctx.viewers]) res.end();
    }
  } };
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = createApp({ dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data') }), port = Number(process.env.PORT || 8090);
  const server = service.app.listen(port, '0.0.0.0', () => console.log('字幕服务：http://localhost:' + port));
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? '端口 ' + port + ' 已占用。' : e.message); process.exit(1); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { service.close(); server.close(() => process.exit(0)); });
}
