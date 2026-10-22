import { Transcript, languages } from './transcript.js';
import { openMicrophone } from './microphone.js';
import { CaptionRuntime } from './runtime.js';
import { VoiceMeter } from './waveform.js';

const $ = id => document.getElementById(id);
async function api(url, { method, data, body } = {}) {
  let response;
  try {
    response = await fetch(url, { method: method || (data !== undefined || body ? 'POST' : 'GET'),
      headers: data !== undefined ? { 'content-type': 'application/json' } : body ? { 'content-type': 'application/octet-stream' } : {},
      body: data !== undefined ? JSON.stringify(data) : body, signal: AbortSignal.timeout(50000) });
  } catch (e) { throw new Error(e.name === 'TimeoutError' ? '本地服务响应超时，请稍后重试。' : '无法连接本地服务，请确认服务正在运行。', { cause: e }); }
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.error || '请求失败，请重试。'), { status: response.status, code: value.code });
  return value;
}
const terminal = session => ['ended', 'interrupted'].includes(session?.status);
const statusName = status => ({ ready: '未开始', recording: '收音中', paused: '已暂停', finalizing: '保存中', ended: '已保存', interrupted: '已中断' }[status] || '已保存');
const dateLabel = date => new Date(date).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
let language = 'zhHans';
try { if (languages[localStorage.getItem('caption-language')]) language = localStorage.getItem('caption-language'); } catch {}
const transcript = new Transcript({ container: $('caption-scroll'), feed: $('caption-feed'), jump: $('back-latest'), language, paired: true, animate: true });
const meter = new VoiceMeter($('capture-meter'));
const list = new Map(), deletedMeetings = new Set();
let snapshot, initialized = false, generation = 0, route = { type: 'new' }, listNext = null, listLoading = false;
let listSignature = '', listStatus = '', lastCaptionSignature = '', renderedSession = null, shareSignature = '';
let historyTranscript, historyItem, deleteTarget, meetingCreating = false, meetingDeleting = false;
let preferredLanguageKey = '', languageSync = Promise.resolve();
const runtime = new CaptionRuntime({ api, capture: openMicrophone, onLevel: (level, samples) => meter.update(level, samples), onChange: render,
  onSettings: () => navigate('settings'),
  subscribe(id, receive, connection) {
    const stream = new EventSource('/api/sessions/' + id + '/events');
    stream.onmessage = event => { try { receive(JSON.parse(event.data)); } catch {} };
    stream.addEventListener('deleted', () => { stream.close(); forgetMeeting(id); });
    stream.onopen = () => connection(true); stream.onerror = () => connection(false);
    return () => stream.close();
  },
});
function readRoute() {
  const hash = location.hash.slice(1), match = /^(live|history)\/([\da-f-]{36})$/i.exec(hash);
  return match ? { type: match[1], id: match[2] } : { type: hash === 'settings' ? 'settings' : 'new' };
}
function navigate(type, id) {
  const hash = '#' + type + (id ? '/' + id : '');
  if (location.hash === hash) void applyRoute(); else location.hash = hash;
}
function setLanguage(key) {
  if (!languages[key]) return;
  language = key; transcript.setLanguage(key); historyTranscript?.setLanguage(key);
  for (const nav of [$('caption-languages'), $('history-languages')]) for (const button of nav.children) button.setAttribute('aria-pressed', String(button.dataset.language === key));
  try { localStorage.setItem('caption-language', key); } catch {}
  syncLanguage(runtime.session);
}
function syncLanguage(session) {
  if (!session || terminal(session) || session.status === 'finalizing') return;
  const key = session.id + ':' + language, selected = language;
  if (key === preferredLanguageKey) return;
  preferredLanguageKey = key;
  // Serialize rapid clicks and coalesce unsent selections; an older request
  // cannot arrive after and undo the host's latest preference.
  languageSync = languageSync.then(() => {
    if (preferredLanguageKey !== key) return;
    return api('/api/sessions/' + session.id + '/preferred-language', { data: { language: selected } });
  }).catch(() => { if (preferredLanguageKey === key) preferredLanguageKey = ''; });
}
for (const nav of [$('caption-languages'), $('history-languages')]) for (const button of nav.children) button.onclick = () => setLanguage(button.dataset.language);
setLanguage(language);

function render(value) {
  snapshot = value;
  if (value.session && !deletedMeetings.has(value.session.id) && (list.has(value.session.id) || value.session.createdByUser || value.session.startedAt)) list.set(value.session.id, { ...list.get(value.session.id), ...value.session });
  renderList(); renderLive(value);
  if (initialized && route.type === 'live' && value.session?.id === route.id && terminal(value.session) && !value.ending && !value.endFailed) navigate('history', route.id);
  const status = value.session?.id + ':' + value.session?.status;
  if (initialized && status !== listStatus) { listStatus = status; void loadMeetings(true); }
}
function renderLive(value) {
  const session = value.session;
  if (route.type === 'live') syncLanguage(session);
  $('meeting-title').textContent = session?.title || '未命名会议';
  if (session) document.querySelector('.captions').dataset.session = session.id;
  if (renderedSession !== session?.id) { renderedSession = session?.id; lastCaptionSignature = ''; transcript.clear(); }
  const rows = (session?.captions || session?.segments || []).filter(c => c.translations && !c.skipped && !c.translationSkipped);
  const signature = JSON.stringify([rows, session?.captionParents]);
  if (signature !== lastCaptionSignature) { transcript.merge(rows, { replacements: session?.captionParents || [] }); lastCaptionSignature = signature; }
  const { phase, audio } = value, active = audio.recording;
  meter.state(active ? 'recording' : value.error ? 'error' : ['starting', 'draining', 'finalizing'].includes(phase) ? 'processing' : session?.startedAt ? 'paused' : 'ready');
  document.body.classList.toggle('is-running', active);
  $('empty-status').hidden = transcript.rows.length > 0 || active || ['starting', 'draining', 'finalizing'].includes(phase);
  $('empty-status').textContent = value.error ? '收音已暂停' : session?.startedAt ? '已暂停收音' : '点击下方「开始收音」';
  const toggle = $('toggle-capture');
  toggle.hidden = terminal(session) || value.endFailed;
  toggle.disabled = !session || ['loading', 'starting', 'draining', 'finalizing'].includes(phase) || value.pausing;
  toggle.textContent = active ? '暂停' : value.errorKind === 'microphone' ? '启用麦克风' : value.error ? '重试' : session?.startedAt ? '继续收音' : '开始收音';
  $('end-meeting').disabled = !session || value.ending || phase === 'loading';
  $('end-meeting').textContent = value.ending ? '保存中' : value.endFailed ? '重试保存' : '结束';
  $('capture-error').hidden = !value.error; $('capture-error').textContent = value.error || '';
  const share = session?.id + '|' + value.settings?.networkAddress;
  if (route.type === 'live' && session && share !== shareSignature) { shareSignature = share; void refreshShare(session.id); }
}
function renderList() {
  const rows = [...list.values()].filter(item => !deletedMeetings.has(item.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const signature = JSON.stringify([route, rows.map(r => [r.id, r.title, r.status, r.createdAt])]);
  if (signature === listSignature) return;
  listSignature = signature;
  $('meeting-list').replaceChildren();
  for (const item of rows) {
    const button = document.createElement('button'); button.className = 'meeting-row'; button.dataset.status = item.status || 'ended'; button.dataset.id = item.id;
    if (route.id === item.id) button.setAttribute('aria-current', 'page');
    const title = document.createElement('span'), detail = document.createElement('span'), date = document.createElement('span'), state = document.createElement('span');
    title.className = 'meeting-row-title'; title.textContent = item.title || '未命名会议';
    detail.className = 'meeting-row-detail'; date.textContent = dateLabel(item.createdAt); state.className = 'meeting-row-state'; state.textContent = statusName(item.status);
    detail.append(date, state); button.append(title, detail);
    button.onclick = () => navigate(terminal(item) ? 'history' : 'live', item.id); $('meeting-list').append(button);
  }
  $('settings-open').setAttribute('aria-current', route.type === 'settings' ? 'page' : 'false');
  if (!listLoading) { $('list-message').hidden = rows.length > 0; $('list-message').textContent = '暂无会议记录'; }
}
async function loadMeetings(reset = false) {
  if (listLoading) return;
  listLoading = true; $('meetings-more').disabled = true;
  try {
    const page = await api('/api/sessions' + (!reset && listNext ? '?before=' + encodeURIComponent(listNext) : ''));
    if (reset) list.clear();
    for (const item of page.items) if (!deletedMeetings.has(item.id)) list.set(item.id, item);
    if (snapshot?.session && !deletedMeetings.has(snapshot.session.id) && (snapshot.session.createdByUser || snapshot.session.startedAt)) list.set(snapshot.session.id, { ...list.get(snapshot.session.id), ...snapshot.session });
    listNext = page.next; $('meetings-more').hidden = !listNext; $('meetings-more').textContent = '加载更多';
    listLoading = false; listSignature = ''; renderList();
  } catch (e) { $('list-message').hidden = false; $('list-message').textContent = e.message; $('meetings-more').hidden = false; $('meetings-more').textContent = '重新加载'; }
  finally { listLoading = false; $('meetings-more').disabled = false; }
}
$('meetings-more').onclick = () => loadMeetings(!listNext);
$('new-meeting').onclick = () => navigate('new');
$('settings-open').onclick = () => navigate('settings');
window.addEventListener('hashchange', () => { void applyRoute(); });
async function applyRoute() {
  if (!initialized) return;
  const version = ++generation; route = readRoute();
  historyTranscript?.destroy(); historyTranscript = null; historyItem = null;
  if ($('delete-dialog').open && !meetingDeleting) $('delete-dialog').close();
  for (const kind of ['asr', 'translation']) $(kind + '-api-key').value = '';
  $('settings-saved').hidden = true;
  const live = route.type === 'live'; $('workspace').hidden = live; $('live-screen').hidden = !live;
  for (const kind of ['new', 'settings', 'history']) $(kind + '-panel').hidden = route.type !== kind;
  renderList();
  if (route.type === 'settings') { fillSettings(); return; }
  if (route.type === 'new') { $('new-error').hidden = true; return; }
  try {
    if (route.type === 'history') { await openHistory(route.id, version); return; }
    const session = runtime.session?.id === route.id ? runtime.session : await api('/api/sessions/' + route.id);
    if (version !== generation) return;
    if (terminal(session)) { navigate('history', session.id); return; }
    runtime.openMeeting(session); renderLive(runtime.snapshot());
    if (transcript.following) requestAnimationFrame(() => transcript.bottom());
  } catch (e) {
    if (version !== generation) return;
    if (route.type === 'live') { $('capture-error').textContent = e.message; $('capture-error').hidden = false; $('toggle-capture').disabled = true; }
    else { $('history-empty').textContent = e.message; $('history-empty').hidden = false; }
  }
}
$('new-meeting-form').onsubmit = async event => {
  event.preventDefault(); if (meetingCreating) return;
  meetingCreating = true; $('create-meeting').disabled = true; $('new-error').hidden = true;
  try {
    const session = await runtime.createMeeting($('new-title').value);
    $('new-title').value = ''; list.set(session.id, session); listSignature = ''; renderList(); navigate('live', session.id); void loadMeetings(true);
  } catch (e) { $('new-error').textContent = e.message; $('new-error').hidden = false; }
  finally { meetingCreating = false; $('create-meeting').disabled = false; }
};
$('toggle-capture').onclick = () => {
  if (runtime.audio.recording) return runtime.pause();
  if (runtime.error && runtime.errorKind !== 'microphone') return runtime.retry();
  return runtime.start();
};
$('end-meeting').onclick = () => {
  if (runtime.endFailed) { void runtime.retry(); return; }
  if (runtime.session && !$('end-dialog').open && !runtime.ending) $('end-dialog').showModal();
};
$('end-cancel').onclick = () => $('end-dialog').close();
$('end-confirm').onclick = () => { $('end-dialog').close(); void runtime.end(); };
async function refreshShare(id) {
  try {
    const share = await api('/api/sessions/' + id + '/share');
    if (runtime.session?.id !== id) return;
    $('meeting-qr').hidden = !share.qr; $('qr-empty').hidden = !!share.qr;
    if (share.qr) $('meeting-qr').src = share.qr;
    $('qr-empty').textContent = share.message || '暂时无法生成二维码';
    if (share.url) $('meeting-share').href = share.url; else $('meeting-share').removeAttribute('href');
  } catch (e) { $('qr-empty').textContent = e.message; $('meeting-qr').hidden = true; $('qr-empty').hidden = false; }
}
function fillSettings() {
  const settings = runtime.settings;
  if (!settings) return;
  for (const kind of ['asr', 'translation']) {
    $(kind + '-base-url').value = settings[kind]?.baseURL || '';
    $(kind + '-model').value = settings[kind]?.model || '';
    $(kind + '-api-key').value = ''; $(kind + '-clear-key').checked = false;
    updateKeyField(kind);
  }
  $('asr-prompt').value = settings.asr?.prompt || '';
  $('translation-use-asr').checked = !!settings.translation?.useAsrConnection; updateTranslationConnection();
  $('network-address').replaceChildren(new Option('自动选择', ''));
  for (const address of settings.networkAddresses || []) $('network-address').add(new Option(address, address));
  $('network-address').value = settings.networkAddress || ''; $('settings-error').hidden = true;
}
function serviceOrigin(value) { try { return new URL(value).origin; } catch { return null; } }
function updateKeyField(kind) {
  const saved = runtime.settings?.[kind];
  const sameOrigin = !!saved?.baseURL && serviceOrigin(saved.baseURL) === serviceOrigin($(kind + '-base-url').value.trim());
  const hasKey = sameOrigin && saved?.hasApiKey;
  const clear = $(kind + '-clear-key');
  clear.disabled = !hasKey;
  if (!hasKey) clear.checked = false;
  $(kind + '-api-key').disabled = clear.checked;
  $(kind + '-api-key').placeholder = clear.checked ? '保存后清除密钥' : hasKey ? '已保存，留空保留' : '未配置，可按服务要求填写';
  $(kind + '-key-help').textContent = !sameOrigin && saved?.baseURL ? '更换服务来源后，旧密钥不会带到新服务。' : '留空保留已保存的密钥；无需密钥的本地服务可留空。';
}
function updateTranslationConnection() {
  const shared = $('translation-use-asr').checked;
  $('translation-connection').hidden = shared;
  for (const id of ['translation-base-url', 'translation-api-key', 'translation-clear-key']) $(id).disabled = shared;
  if (!shared) updateKeyField('translation');
}
for (const kind of ['asr', 'translation']) {
  $(kind + '-base-url').addEventListener('input', () => updateKeyField(kind));
  $(kind + '-clear-key').addEventListener('change', () => updateKeyField(kind));
}
$('translation-use-asr').addEventListener('change', updateTranslationConnection);
$('settings-form').onsubmit = async event => {
  event.preventDefault(); $('settings-save').disabled = true; $('settings-error').hidden = true; $('settings-saved').hidden = true;
  try {
    const connection = kind => ({ baseURL: $(kind + '-base-url').value.trim(), model: $(kind + '-model').value.trim(),
      ...($(kind + '-clear-key').checked ? { clearApiKey: true } : $(kind + '-api-key').value.trim() ? { apiKey: $(kind + '-api-key').value.trim() } : {}) });
    await runtime.save({ asr: { ...connection('asr'), prompt: $('asr-prompt').value.trim() }, translation: $('translation-use-asr').checked ? { model: $('translation-model').value.trim(), useAsrConnection: true } : { ...connection('translation'), useAsrConnection: false }, networkAddress: $('network-address').value });
    fillSettings();
    $('settings-saved').hidden = false;
  } catch (e) { $('settings-error').textContent = e.message; $('settings-error').hidden = false; }
  finally { for (const kind of ['asr', 'translation']) $(kind + '-api-key').value = ''; $('settings-save').disabled = false; }
};
async function openHistory(id, version) {
  $('history-heading').textContent = '会议记录'; $('history-recording').textContent = ''; $('history-empty').textContent = '正在读取…'; $('history-empty').hidden = false;
  for (const node of $('history-transcript').querySelectorAll('.transcript-line')) node.remove();
  $('history-older').hidden = true; $('history-download').removeAttribute('href'); $('history-delete').hidden = true;
  const [item, page] = await Promise.all([api('/api/sessions/' + id), api('/api/sessions/' + id + '/captions')]);
  if (version !== generation) return;
  historyItem = item; $('history-heading').textContent = item.title; $('history-delete').hidden = !terminal(item);
  const recorded = item.recording?.available ? Math.floor(item.recording.durationMs / 60000) + ' 分 ' + Math.round(item.recording.durationMs / 1000) % 60 + ' 秒录音' : '无录音';
  $('history-recording').textContent = dateLabel(item.startedAt || item.createdAt) + ' · ' + statusName(item.status) + ' · ' + recorded;
  if (terminal(item)) $('history-download').href = '/api/sessions/' + id + '/download';
  historyTranscript = new Transcript({ container: $('history-transcript'), older: $('history-older'), language, paired: true, load: query => api('/api/sessions/' + id + '/captions' + query) });
  historyTranscript.hasBefore = page.hasBefore; historyTranscript.merge(page.items); $('history-empty').hidden = page.items.length > 0; $('history-empty').textContent = '本场暂无字幕。';
}
function forgetMeeting(id) {
  deletedMeetings.add(id); list.delete(id); listSignature = ''; runtime.forgetMeeting(id); renderList();
  if (!meetingDeleting && route.id === id) navigate('new');
}
$('history-delete').onclick = () => {
  if (!historyItem || !terminal(historyItem) || meetingDeleting) return;
  deleteTarget = { id: historyItem.id, title: historyItem.title };
  $('delete-copy').textContent = '将永久删除「' + deleteTarget.title + '」的录音、字幕和会议记录。';
  $('delete-error').hidden = true; $('delete-dialog').showModal();
};
$('delete-cancel').onclick = () => $('delete-dialog').close();
$('delete-dialog').addEventListener('cancel', event => { if (meetingDeleting) event.preventDefault(); });
$('delete-confirm').onclick = async () => {
  if (!deleteTarget || meetingDeleting) return;
  const id = deleteTarget.id; meetingDeleting = true;
  $('delete-confirm').disabled = true; $('delete-cancel').disabled = true; $('delete-confirm').textContent = '正在删除…'; $('delete-error').hidden = true;
  try {
    await api('/api/sessions/' + id, { method: 'DELETE', data: { confirm: true } });
    forgetMeeting(id); $('delete-dialog').close(); deleteTarget = null;
    if (route.id === id) navigate('new'); void loadMeetings(true);
  } catch (e) { $('delete-error').textContent = e.message; $('delete-error').hidden = false; }
  finally { meetingDeleting = false; $('delete-confirm').disabled = false; $('delete-cancel').disabled = false; $('delete-confirm').textContent = '删除会议'; }
};
function updateClock() {
  const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if ($('clock').textContent !== time) $('clock').textContent = time;
}
const clockTimer = setInterval(updateClock, 1000); updateClock();
const shareTimer = setInterval(() => { if (route.type === 'live' && runtime.session) void refreshShare(runtime.session.id); }, 30000);
window.addEventListener('resize', () => { if (transcript.following) transcript.bottom(); });
window.addEventListener('beforeunload', event => { if (runtime.audio.recording || runtime.audio.queue.length || runtime.ending) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => {
  clearInterval(clockTimer); clearInterval(shareTimer);
  if (runtime.startedHere && runtime.session?.status === 'recording' && !runtime.ending) navigator.sendBeacon('/api/sessions/' + runtime.session.id + '/interrupt', new Blob(['{}'], { type: 'application/json' }));
  runtime.destroy(); transcript.destroy(); historyTranscript?.destroy();
});
await runtime.init(); initialized = true; await Promise.all([loadMeetings(true), applyRoute()]);
