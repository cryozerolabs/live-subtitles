export const languages = { zhHans: '中文', en: 'English', yue: '粵語' };

// Shared by the read-only phone page and the local archive. Revisions change the
// same paragraph, and its viewport anchor survives language changes and edits.
export class Transcript {
  constructor({ container, feed = container, older, jump, load, language = 'zhHans', paired = false, animate = false }) {
    Object.assign(this, { container, feed, older, jump, load, language, paired, animate });
    this.rows = []; this.nodes = new Map(); this.parentVersions = new Map(); this.following = true; this.hasBefore = false; this.loading = false;
    this.userScrollingUntil = 0;
    this.onIntent = event => {
      if (event.type === 'keydown' && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
      this.userScrollingUntil = Date.now() + 1200;
    };
    this.onScroll = () => {
      if (Date.now() > this.userScrollingUntil) return;
      this.following = container.scrollHeight - container.clientHeight - container.scrollTop < 80;
      container.classList.toggle('is-browsing', !this.following);
      if (jump) jump.hidden = this.following || !this.rows.length;
    };
    container.addEventListener('scroll', this.onScroll, { passive: true });
    for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown']) container.addEventListener(type, this.onIntent, { passive: true });
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (this.following) this.bottom(); }) : null;
    this.resizeObserver?.observe(feed);
    if (older) older.onclick = () => this.loadOlder();
    if (jump) jump.onclick = () => { this.following = true; this.bottom(); };
  }
  anchor() {
    const top = this.container.getBoundingClientRect().top;
    for (const node of this.container.querySelectorAll('.transcript-line')) if (node.getBoundingClientRect().bottom > top) return { id: node.dataset.id, offset: node.getBoundingClientRect().top - top };
    return null;
  }
  restore(anchor) {
    const node = anchor && this.nodes.get(anchor.id);
    if (node) this.container.scrollTop += node.getBoundingClientRect().top - this.container.getBoundingClientRect().top - anchor.offset;
  }
  bottom() { this.userScrollingUntil = 0; this.container.classList.remove('is-browsing'); this.container.scrollTop = this.container.scrollHeight; if (this.jump) this.jump.hidden = true; }
  merge(items, { history = false, replacements = [] } = {}) {
    const anchor = this.anchor(), following = this.following && !history;
    const positions = this.animate && following ? new Map([...this.nodes].map(([id, node]) => [id, node.getBoundingClientRect().top])) : null;
    for (const parent of replacements) {
      const prior = this.parentVersions.get(parent.id);
      if (!prior || parent.revision >= prior.revision) this.parentVersions.set(parent.id, parent);
    }
    const parents = this.parentVersions;
    const rows = new Map(this.rows.filter(row => {
      const parent = parents.get(row.parentId);
      return !parent || row.final || parent.revision < (row.revision || 0) || parent.ids.includes(row.id);
    }).map(r => [r.id, r]));
    for (const item of items) {
      const parent = parents.get(item.parentId);
      if (parent && (parent.revision > (item.revision || 0) || (parent.revision === (item.revision || 0) && !parent.ids.includes(item.id)))) continue;
      const previous = rows.get(item.id);
      if (previous && (previous.final || (previous.revision || 0) > (item.revision || 0))) continue;
      rows.set(item.id, item);
    }
    this.rows = [...rows.values()].sort((a, b) => (a.startMs || 0) - (b.startMs || 0) || a.id.localeCompare(b.id, undefined, { numeric: true }));
    if (following && this.rows.length > 300) { this.rows = this.rows.slice(-300); this.hasBefore = true; }
    if (this.parentVersions.size > 600) {
      const retained = new Set([...this.rows.map(r => r.parentId), ...replacements.map(p => p.id)]);
      for (const id of this.parentVersions.keys()) if (!retained.has(id)) this.parentVersions.delete(id);
    }
    this.paint();
    if (following) this.bottom(); else this.restore(anchor);
    this.following = following;
    this.container.classList.toggle('is-browsing', !following);
    if (positions && !matchMedia('(prefers-reduced-motion: reduce)').matches) for (const [id, node] of this.nodes) {
      const previous = positions.get(id), offset = previous === undefined ? 16 : previous - node.getBoundingClientRect().top;
      if (Math.abs(offset) > 1) node.animate([{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }], { duration: 240, easing: 'ease-out' });
    }
    if (this.jump) this.jump.hidden = following || !this.rows.length;
  }
  paint() {
    const wanted = new Set(this.rows.map(r => r.id));
    for (const [id, node] of this.nodes) if (!wanted.has(id)) { node.remove(); this.nodes.delete(id); }
    let cursor = this.feed.querySelector('.transcript-line');
    for (const row of this.rows) {
      let node = this.nodes.get(row.id);
      if (!node) {
        node = document.createElement(this.paired ? 'article' : 'p');
        node.className = this.paired ? 'transcript-line caption-pair' : 'transcript-line'; node.dataset.id = row.id;
        if (this.paired) {
          const source = document.createElement('p'), translation = document.createElement('p');
          source.className = 'source'; source.dir = 'auto'; translation.className = 'translation'; node.append(source, translation);
        }
        this.nodes.set(row.id, node);
      }
      const text = row.translations?.[this.language] || '';
      if (this.paired) {
        const [source, translation] = node.children;
        if (source.textContent !== (row.raw || '')) source.textContent = row.raw || '';
        source.hidden = !row.raw;
        if (translation.textContent !== text) translation.textContent = text;
        translation.lang = { zhHans: 'zh-CN', en: 'en', yue: 'yue-Hant' }[this.language];
      } else if (node.textContent !== text) node.textContent = text;
      const changed = node.dataset.revision !== String(row.revision || 0) || node.dataset.final !== String(row.final !== false);
      node.dataset.revision = String(row.revision || 0); node.dataset.final = String(row.final !== false);
      if (changed) {
        node.dataset.renderedAt ||= String(Date.now()); node.dataset.updatedAt = String(Date.now());
        if (row.final !== false) node.dataset.finalAt ||= String(Date.now());
      }
      if (node !== cursor) this.feed.insertBefore(node, cursor); else cursor = cursor.nextElementSibling;
    }
    if (!this.paired) this.container.lang = { zhHans: 'zh-CN', en: 'en', yue: 'yue-Hant' }[this.language];
    if (this.older) this.older.hidden = !this.hasBefore;
  }
  setLanguage(language) {
    if (!languages[language]) return;
    const anchor = this.anchor(); this.language = language; this.paint();
    if (this.following) this.bottom(); else this.restore(anchor);
  }
  async loadOlder() {
    if (this.loading || !this.hasBefore || !this.rows.length) return;
    this.loading = true;
    if (this.older) { this.older.disabled = true; this.older.textContent = '正在加载…'; }
    try {
      const page = await this.load('?before=' + encodeURIComponent(this.rows[0].id));
      this.hasBefore = page.hasBefore; this.merge(page.items, { history: true });
    } catch {
      if (this.older) this.older.textContent = '加载失败，点击重试';
    } finally {
      this.loading = false;
      if (this.older) { this.older.disabled = false; if (this.older.textContent === '正在加载…') this.older.textContent = '加载更早字幕'; }
    }
  }
  clear() { for (const node of this.nodes.values()) node.remove(); this.nodes.clear(); this.parentVersions.clear(); this.rows = []; this.following = true; this.hasBefore = false; this.bottom(); }
  destroy() {
    this.container.removeEventListener('scroll', this.onScroll);
    for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown']) this.container.removeEventListener(type, this.onIntent);
    this.resizeObserver?.disconnect();
  }
}
