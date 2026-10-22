import fs from 'node:fs';
import path from 'node:path';
const validId = id => /^[\da-f-]{36}$/i.test(id);

// A content-free marker prevents interrupted deletion or stale callbacks from
// bringing a meeting back. A retry (including after restart) finishes cleanup.
export class MeetingDeletion {
  constructor(dataDir, io = fs) { this.dir = dataDir; this.io = io; this.markers = path.join(dataDir, 'deleted'); }
  marker(id) {
    id = String(id).toLowerCase();
    if (!validId(id)) throw Object.assign(new Error('找不到这场会议。'), { status: 404 });
    return path.join(this.markers, id + '.json');
  }
  has(id) { return this.io.existsSync(this.marker(id)); }
  mark(id) {
    id = String(id).toLowerCase();
    const target = this.marker(id);
    if (this.io.existsSync(target)) return;
    this.io.mkdirSync(this.markers, { recursive: true, mode: 0o700 });
    this.io.writeFileSync(target + '.tmp', JSON.stringify({ id, deletedAt: new Date().toISOString() }), { mode: 0o600 });
    this.io.renameSync(target + '.tmp', target);
  }
  purge(id) {
    id = String(id).toLowerCase();
    if (!this.has(id)) throw new Error('删除尚未确认。');
    for (const file of [path.join('sessions', id + '.json'), path.join('sessions', id + '.json.tmp'), path.join('recordings', id), path.join('subtitles', id)]) {
      this.io.rmSync(path.join(this.dir, file), { recursive: true, force: true });
    }
    const current = path.join(this.dir, 'current.json');
    if (this.io.existsSync(current) && JSON.parse(this.io.readFileSync(current, 'utf8')).id === id) this.io.rmSync(current, { force: true });
  }
  recover() {
    if (!this.io.existsSync(this.markers)) return;
    for (const file of this.io.readdirSync(this.markers)) {
      const id = file.slice(0, -5);
      if (!file.endsWith('.json') || !validId(id)) continue;
      try { this.purge(id); } catch { /* Keep the marker so explicit retry can finish cleanup. */ }
    }
  }
}
