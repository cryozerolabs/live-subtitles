import { CaptionAudio } from './audio.js';

export class CaptionRuntime {
  constructor({ api, capture, subscribe, onChange = () => {}, onSettings = () => {}, onLevel = () => {} }) {
    Object.assign(this, { api, subscribe, onChange, onSettings });
    this.settings = null; this.session = null; this.disconnect = null;
    this.userStopped = false; this.busy = false; this.error = null; this.errorKind = null; this.lastVoiceAt = 0;
    this.startedHere = false; this.pausing = false; this.pausePromise = null;
    this.state = 'loading'; this.translationFailed = false; this.resumeAfterDrain = false; this.drainPromise = null; this.destroyed = false; this.drainWaiters = []; this.endWaiters = []; this.ending = false; this.endFailed = false;
    this.captureId = crypto.randomUUID(); this.captureOwned = false;
    this.audio = new CaptionAudio({ capture,
      send: chunk => this.api('/api/sessions/' + this.session.id + '/audio?startMs=' + chunk.startMs + '&chunkId=' + chunk.chunkId + '&capturedAt=' + chunk.capturedAt + (this.settings?.captureProtocol ? '&captureId=' + this.captureId : ''), { body: chunk.body }),
      onChange: () => { this.emit(); this.maybeResume(); }, onError: (message, kind) => {
        if (kind === 'backpressure') this.pauseForPressure();
        else { this.setError(message, kind); if (kind === 'microphone') void this.finishCapture(); }
      },
      onVoice: () => { this.lastVoiceAt = Date.now(); }, onLevel,
    });
  }
  emit() { this.onChange(this.snapshot()); }
  snapshot() {
    const audio = this.audio.snapshot();
    let phase;
    if (this.ending || (!this.endFailed && this.session?.status === 'finalizing')) phase = 'finalizing';
    else if (this.error) phase = 'error';
    else if (['ended', 'interrupted'].includes(this.session?.status) && !audio.pending && !audio.sending) phase = 'ended';
    else if (this.pausing) phase = 'draining';
    else if (audio.starting || this.busy) phase = 'starting';
    else if (audio.recording) phase = (this.session?.captions || []).some(c => c.translations) ? 'live' : 'waiting';
    else if (audio.sending || audio.pending || this.drainPromise || this.session?.pendingTranslations || this.session?.draining) phase = 'draining';
    else phase = this.state;
    return { phase, audio, settings: this.settings, session: this.session, error: this.error, errorKind: this.errorKind, userStopped: this.userStopped, ending: this.ending, endFailed: this.endFailed, lastVoiceAt: this.lastVoiceAt, pausing: this.pausing, startedHere: this.startedHere };
  }
  setError(message, kind = 'processing') {
    this.resumeAfterDrain = false; this.error = message; this.errorKind = kind; this.state = 'error';
    for (const waiter of [...this.drainWaiters.splice(0), ...this.endWaiters.splice(0)]) waiter.reject(new Error(message));
    this.emit();
  }
  maybeResume() {
    if (this.destroyed || !this.resumeAfterDrain || this.userStopped || this.error || this.busy || this.drainPromise || this.audio.busy || this.session?.backpressure || this.session?.pendingFinals || this.session?.pendingTranslations || this.session?.draining || this.session?.processing) return;
    this.resumeAfterDrain = false;
    void this.start();
  }

  async init() {
    try {
      this.error = null; this.errorKind = null;
      this.settings = await this.api('/api/settings');
      this.attach(await this.api('/api/sessions/current'));
      this.userStopped = true; this.audio.timeMs = this.session?.ingestEndMs || 0;
      this.state = ['ended', 'interrupted'].includes(this.session?.status) ? 'ended' : 'ready';
      if (!this.settings.configured) { this.state = 'unconfigured'; this.emit(); this.onSettings(); return; }
      this.emit();
    } catch (e) { this.setError(e.message, 'connection'); }
  }

  attach(session) {
    if (!session?.id) return;
    const different = session.id !== this.session?.id;
    this.receive(session);
    if (!different && this.disconnect) return;
    this.disconnect?.();
    const id = session.id;
    this.disconnect = this.subscribe(id, data => { if (this.session?.id === id) this.receive(data); }, connected => {
      if (!connected && this.session?.id === id && !this.destroyed) {
        if (this.audio.recording) { this.audio.stop(); void this.finishCapture(); }
        this.setError('字幕连接已中断，请检查本地服务后重试。', 'connection');
      }
    });
  }

  async createMeeting(title, description = '') {
    if (this.audio.busy || this.busy || this.ending || this.pausing || this.drainPromise || (this.session?.startedAt && !['ended', 'interrupted'].includes(this.session.status))) throw new Error('请先结束当前会议，再开始新会议。');
    this.busy = true; this.emit();
    try {
      const session = await this.api('/api/sessions', { data: { version: 2, draft: true, title: String(title || '').trim(), description: description.trim() } });
      this.userStopped = true; this.startedHere = false; this.audio.timeMs = 0; this.lastVoiceAt = 0;
      this.error = null; this.errorKind = null; this.endFailed = false; this.state = 'ready'; this.attach(session);
      return session;
    } finally { this.busy = false; this.emit(); }
  }

  forgetMeeting(id) {
    if (this.session?.id !== id) return;
    this.disconnect?.(); this.disconnect = null; this.userStopped = true; this.resumeAfterDrain = false;
    if (this.audio.busy || this.ending) { this.setError('本场会议已被删除，待上传音频无法再追加。', 'deleted'); return; }
    this.session = null; this.translationFailed = false; this.startedHere = false; this.audio.timeMs = 0; this.lastVoiceAt = 0;
    this.error = null; this.errorKind = null; this.endFailed = false; this.state = 'ready'; this.emit();
  }

  openMeeting(session) {
    if (this.session?.id === session.id) return;
    if (this.audio.busy || this.ending || this.pausing || this.drainPromise) throw new Error('请先暂停或结束当前收音。');
    this.userStopped = true; this.startedHere = false; this.audio.timeMs = session.ingestEndMs || 0;
    this.lastVoiceAt = 0; this.error = null; this.errorKind = null; this.endFailed = false;
    this.state = ['ended', 'interrupted'].includes(session.status) ? 'ended' : 'ready'; this.attach(session);
  }

  pause() {
    if (this.pausePromise || this.ending) return this.pausePromise || Promise.resolve();
    this.pausing = true;
    this.pausePromise = (async () => {
      await this.stop();
      if (!this.destroyed && !this.ending && this.session && !['ended', 'interrupted'].includes(this.session.status)) this.receive(await this.api('/api/sessions/' + this.session.id + '/pause', { data: {} }));
    })().catch(e => { if (!this.ending) this.setError(e.message); }).finally(() => { this.pausing = false; this.pausePromise = null; this.emit(); });
    return this.pausePromise;
  }

  async ensureSession() {
    if (this.session && !['ended', 'interrupted'].includes(this.session.status)) return;
    const session = await this.api('/api/sessions', { data: { version: 2, draft: true } });
    if (this.session?.id !== session.id) { this.audio.timeMs = 0; this.lastVoiceAt = 0; }
    this.attach(session);
  }

  receive(session) {
    if (session.id === this.session?.id && session.epoch === this.session?.epoch && Number.isFinite(session.update) && session.update < (this.session.update || 0)) return;
    this.session = session;
    if (session.saveError || ['ended', 'interrupted'].includes(session.status)) {
      for (const waiter of this.endWaiters.splice(0)) {
        if (session.saveError) waiter.reject(new Error(session.saveError)); else waiter.resolve();
      }
    }
    if (session.error || (!session.draining && !session.pendingTranslations && !session.processing)) {
      for (const waiter of this.drainWaiters.splice(0)) {
        if (session.error) waiter.reject(new Error(session.error)); else waiter.resolve();
      }
    }
    if (['ended', 'interrupted'].includes(session.status)) {
      if (this.audio.recording || this.audio.starting) this.audio.stop();
      this.resumeAfterDrain = false; this.userStopped = true; this.captureOwned = false;
      if (!this.ending) this.state = 'ended';
      this.emit(); return;
    }
    if (this.ending) { this.emit(); return; }
    if (session.error) { this.audio.stop(); this.setError(session.error); return; }
    if (session.translationErrors) {
      this.translationFailed = true;
      if (this.audio.recording) this.audio.stop();
      const failure = session.translationFailure?.message || (session.captions || []).findLast(s => s.translationError)?.translationError;
      this.setError(failure || '部分字幕翻译未完成，原文已保留，请重试。'); return;
    }
    if (this.translationFailed && !session.pendingTranslations) {
      this.translationFailed = false; this.error = null; this.errorKind = null; this.state = 'stopped';
    }
    if (session.backpressure && this.audio.recording) this.pauseForPressure();
    this.emit(); this.maybeResume();
  }

  async start() {
    if (this.destroyed || this.ending || this.pausing || this.session?.status === 'finalizing' || this.busy || this.drainPromise || this.audio.busy || this.audio.failed) return;
    if (!this.settings?.configured) { this.onSettings(); return; }
    this.userStopped = false; this.error = null; this.errorKind = null; this.busy = true; this.state = 'starting'; this.emit();
    try {
      await this.ensureSession();
      if (this.userStopped || this.destroyed) { this.state = 'stopped'; return; }
      if (this.settings.captureProtocol) {
        const claim = await this.api('/api/sessions/' + this.session.id + '/capture', { data: { captureId: this.captureId } });
        this.captureOwned = true;
        // Only synchronize an empty queue. Never move pending audio forward to
        // conceal a conflict with another microphone's recording.
        this.audio.timeMs = Math.max(this.audio.timeMs, claim.ingestEndMs || 0);
      } else if (this.session.status === 'recording' && !this.startedHere) throw new Error('另一个页面正在收音，请先在该页面暂停。');
      if (this.userStopped || this.destroyed) { this.state = 'stopped'; return; }
      await this.audio.start();
      if (this.audio.recording) { this.startedHere = true; this.receive(await this.api('/api/sessions/' + this.session.id + '/start', { data: this.settings.captureProtocol ? { captureId: this.captureId } : {} })); }
      this.state = this.audio.recording ? 'waiting' : 'ready';
    }
    catch (e) {
      this.audio.stop();
      const microphone = ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'SecurityError'].includes(e.name);
      const message = e.name === 'NotAllowedError' ? e.reason === 'permission-timeout' ? '浏览器尚未返回麦克风授权，请点击“启用麦克风”并完成权限提示。' : e.reason === 'autoplay' ? '浏览器阻止了自动收音，请点击“启用麦克风”。' : '浏览器未允许使用麦克风，请在站点权限中允许后点击“启用麦克风”。' : e.name === 'NotFoundError' ? '没有找到麦克风，请连接设备后启用。' : e.name === 'NotReadableError' ? '无法使用麦克风，请检查设备或其他应用是否占用。' : e.message;
      this.setError(message, microphone ? 'microphone' : 'connection');
    } finally {
      if (!this.audio.busy && this.captureOwned) await this.releaseCapture().catch(e => this.setError(e.message));
      this.busy = false; this.emit();
    }
  }

  async releaseCapture() {
    if (!this.captureOwned) return;
    await this.api('/api/sessions/' + this.session.id + '/capture', { method: 'DELETE', data: { captureId: this.captureId } });
    this.captureOwned = false;
  }

  stop() {
    this.userStopped = true; this.resumeAfterDrain = false; this.state = 'stopped'; this.audio.stop(); this.emit();
    return this.finishCapture();
  }

  async end() {
    if (this.ending) return;
    this.userStopped = true; this.resumeAfterDrain = false; this.ending = true; this.endFailed = false;
    this.error = null; this.errorKind = null; this.audio.stop(); this.emit();
    try {
      await this.audio.drain();
      if (this.pausePromise) await this.pausePromise;
      if (this.drainPromise) await this.drainPromise;
      this.receive(await this.api('/api/sessions/' + this.session.id + '/end', { data: {} }));
      if (this.session.saveError) throw new Error(this.session.saveError);
      if (!['ended', 'interrupted'].includes(this.session.status)) await new Promise((resolve, reject) => this.endWaiters.push({ resolve, reject }));
      this.error = null; this.errorKind = null; this.state = 'ended';
    } catch (e) { this.endFailed = true; this.setError(e.message + ' 请重试保存，暂勿刷新页面。', 'saving'); }
    finally { this.ending = false; this.emit(); }
  }

  pauseForPressure() {
    if (this.destroyed) return;
    this.resumeAfterDrain = !this.userStopped; this.state = 'stopped'; this.audio.stop();
    void this.finishCapture(); this.emit();
  }

  finishCapture() {
    if (this.drainPromise) return this.drainPromise;
    if (!this.session || this.destroyed) return Promise.resolve();
    this.drainPromise = (async () => {
      await this.audio.drain();
      this.receive(await this.api('/api/sessions/' + this.session.id + '/flush', { data: {} }));
      await this.waitForDrain();
      await this.releaseCapture();
    })().catch(e => this.setError(e.message)).finally(() => {
      this.drainPromise = null; this.emit(); this.maybeResume();
    });
    return this.drainPromise;
  }

  waitForDrain() {
    if (this.session?.error) return Promise.reject(new Error(this.session.error));
    if (!this.session?.draining && !this.session?.pendingTranslations && !this.session?.processing) return Promise.resolve();
    return new Promise((resolve, reject) => this.drainWaiters.push({ resolve, reject }));
  }

  async retry() {
    if (!this.settings || !this.session) return this.init();
    if (this.ending || this.busy || this.session?.pendingTranslations) return;
    if (this.endFailed) { if (this.audio.failed) await this.audio.retry(); return this.end(); }
    const resume = !this.userStopped;
    this.busy = true; this.error = null; this.errorKind = null; this.state = 'stopped'; this.emit();
    try {
      if (this.settings.captureProtocol && this.audio.queue.length) {
        await this.api('/api/sessions/' + this.session.id + '/capture', { data: { captureId: this.captureId } });
        this.captureOwned = true;
      }
      if (this.session.translationErrors || this.session.error) this.receive(await this.api('/api/sessions/' + this.session.id + '/retry-translations', { data: {} }));
      await this.waitForDrain();
      await this.audio.retry();
      await this.finishCapture();
    } catch (e) { this.setError(e.message); }
    finally { this.busy = false; this.emit(); }
    if (resume && !this.error) { this.resumeAfterDrain = true; this.maybeResume(); }
  }

  async save(data) {
    const before = this.settings;
    const changingService = ['asr', 'translation'].some(kind => {
      const next = data[kind];
      return next && (['baseURL', 'model', 'useAsrConnection'].some(key => next[key] !== undefined && next[key] !== before?.[kind]?.[key]) || (Object.hasOwn(next, 'apiKey') && (!!next.apiKey || !!before?.[kind]?.hasApiKey)));
    });
    if (changingService) {
      if (this.busy || this.audio.starting || this.ending) throw new Error('麦克风或会议正在准备、保存，请稍后再修改服务。');
      this.userStopped = true; this.resumeAfterDrain = false;
      if (this.audio.recording) await this.pause();
      else if (this.pausePromise) await this.pausePromise;
      else if (this.drainPromise) await this.drainPromise;
      else if (this.audio.busy || this.session?.processing || this.session?.pendingTranslations || this.session?.draining) await this.finishCapture();
      if (this.audio.failed || this.audio.busy) throw new Error('仍有音频未上传，请先重试上传，再保存服务配置。');
    }
    this.settings = await this.api('/api/settings', { method: 'PUT', data });
    this.emit();
    if (this.state === 'unconfigured' && this.settings.configured) { this.state = 'ready'; this.emit(); }
    return this.settings;
  }

  destroy() { this.destroyed = true; this.userStopped = true; this.audio.stop(); this.disconnect?.(); for (const waiter of [...this.drainWaiters.splice(0), ...this.endWaiters.splice(0)]) waiter.resolve(); }
}
