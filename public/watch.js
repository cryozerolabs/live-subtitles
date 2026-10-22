import { Transcript, languages } from './transcript.js';

const $ = id => document.getElementById(id);
const token = location.pathname.split('/').filter(Boolean).at(-1);
const base = '/api/watch/' + encodeURIComponent(token);
let snapshot, connected = false, catchup = false, deleted = false;
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const value = await response.json(); if (deleted) throw new Error('这场会议已删除。'); if (!response.ok) throw new Error(value.error || '无法读取会议字幕。'); return value;
}
let language = 'zhHans';
try { if (languages[localStorage.getItem('caption-language')]) language = localStorage.getItem('caption-language'); } catch {}
const transcript = new Transcript({ container: $('watch-transcript'), older: $('watch-older'), jump: $('watch-latest'), load: query => get(base + '/captions' + query), language, paired: true });
for (const button of document.querySelectorAll('[data-language]')) {
  button.setAttribute('aria-pressed', String(button.dataset.language === language));
  button.onclick = () => {
    transcript.setLanguage(button.dataset.language);
    for (const other of document.querySelectorAll('[data-language]')) other.setAttribute('aria-pressed', String(other === button));
    try { localStorage.setItem('caption-language', button.dataset.language); } catch {}
  };
}
function render(value) {
  if (deleted) return;
  if (snapshot?.epoch === value.epoch && value.update < snapshot.update) return;
  snapshot = value; document.title = value.title + ' · 同声字幕'; $('watch-title').textContent = value.title;
  transcript.hasBefore ||= value.captionCount > Math.max(60, transcript.rows.length);
  transcript.merge(value.captions, { replacements: value.captionParents || [] });
  $('watch-empty').hidden = transcript.rows.length > 0;
  const state = { ready: '等待开始', recording: '正在收音', paused: '已暂停', finalizing: '正在保存', ended: '已结束', interrupted: '已中断' }[value.status] || '已结束';
  $('watch-state').textContent = connected ? state : '正在重新连接';
  $('watch-empty').textContent = value.status === 'ready' ? '会议尚未开始，请稍候。' : value.status === 'recording' ? '正在收音，等待发言。' : value.status === 'paused' ? '收音已暂停，等待继续。' : value.status === 'finalizing' ? '正在保存会议字幕。' : '本场会议已结束，暂无字幕。';
}
async function recover() {
  if (catchup || !transcript.rows.length) return;
  catchup = true;
  try {
    let after = transcript.rows.at(-1).id;
    for (;;) {
      const page = await get(base + '/captions?after=' + encodeURIComponent(after));
      transcript.merge(page.items);
      if (!page.hasAfter || !page.items.length) break;
      after = page.items.at(-1).id;
    }
  } catch {} finally { catchup = false; }
}
let stream;
async function connect() {
  try {
    const value = await get(base); connected = true; render(value);
    stream = new EventSource(base + '/events');
    stream.onmessage = event => { try { render(JSON.parse(event.data)); } catch {} };
    stream.addEventListener('deleted', () => { deleted = true; stream.close(); connected = false; transcript.clear(); $('watch-older').hidden = true; $('watch-state').textContent = '会议已删除'; $('watch-empty').hidden = false; $('watch-empty').textContent = '这场会议已删除，字幕不再可用。'; });
    stream.onopen = () => { connected = true; if (snapshot) render(snapshot); void recover(); };
    stream.onerror = () => { connected = false; $('watch-state').textContent = '连接中断，自动重连'; };
  } catch (e) {
    $('watch-state').textContent = '无法连接'; $('watch-empty').textContent = e.message;
    const retry = document.createElement('button'); retry.className = 'older-button'; retry.textContent = '重新连接';
    retry.onclick = () => { retry.remove(); void connect(); }; $('watch-transcript').append(retry);
  }
}
window.addEventListener('pagehide', () => { stream?.close(); transcript.destroy(); });
connect();
