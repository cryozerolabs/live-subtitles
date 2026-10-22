import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BYTES_PER_MS = 32;
const error = (message, status = 503) => Object.assign(new Error(message), { status });
const header = bytes => {
  const b = Buffer.alloc(44);
  b.write('RIFF'); b.writeUInt32LE(bytes + 36, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(bytes, 40);
  return b;
};

// The WAV is synced before its receipt is synced. On recovery, only journaled
// bytes survive. A lost HTTP response can therefore be retried without appending twice.
export class RecordingStore {
  constructor(dir, { partBytes = 115200000 } = {}) {
    this.dir = dir; this.partBytes = partBytes; this.journal = path.join(dir, 'chunks.jsonl');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.recover();
  }
  recover() {
    this.receipts = new Map(); this.parts = []; this.bytes = 0; this.endMs = 0;
    const text = fs.existsSync(this.journal) ? fs.readFileSync(this.journal, 'utf8') : '';
    let valid = 0;
    for (const line of text.split('\n').slice(0, -1)) {
      let r;
      try { r = JSON.parse(line); } catch { break; }
      if (!r.id || !Array.isArray(r.pieces) || !r.pieces.every(p => /^audio-\d{4,}\.wav$/.test(p.file) && fs.existsSync(path.join(this.dir, p.file)) && fs.statSync(path.join(this.dir, p.file)).size >= p.offset + p.bytes)) break;
      this.receipts.set(r.id, r); this.bytes += r.bytes; this.endMs = r.endMs;
      let pieceBytes = 0;
      for (const p of r.pieces) {
        let part = this.parts.find(v => v.file === p.file);
        if (!part) { part = { file: p.file, bytes: 0, offsetMs: (this.bytes - r.bytes + pieceBytes) / BYTES_PER_MS }; this.parts.push(part); }
        part.bytes = p.offset + p.bytes - 44; pieceBytes += p.bytes;
      }
      valid += Buffer.byteLength(line + '\n');
    }
    if (fs.existsSync(this.journal) && fs.statSync(this.journal).size !== valid) fs.truncateSync(this.journal, valid);
    for (const file of fs.readdirSync(this.dir).filter(v => /^audio-\d{4,}\.wav$/.test(v))) {
      const part = this.parts.find(v => v.file === file);
      if (!part) { fs.unlinkSync(path.join(this.dir, file)); continue; }
      const fd = fs.openSync(path.join(this.dir, file), 'r+');
      try { fs.ftruncateSync(fd, part.bytes + 44); fs.writeSync(fd, header(part.bytes), 0, 44, 0); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    }
  }
  append(pcm, { id, startMs, capturedAt = Date.now() - pcm.length / BYTES_PER_MS }) {
    const hash = crypto.createHash('sha256').update(pcm).digest('hex');
    const prior = this.receipts.get(id);
    if (prior) {
      if (prior.hash !== hash || prior.startMs !== startMs) throw error('同一音频编号的内容不一致。', 409);
      return { ...prior, duplicate: true };
    }
    if (startMs < this.endMs) throw error('音频时间重叠，未再次接收。', 409);
    const receipt = { id, hash, startMs, endMs: startMs + pcm.length / BYTES_PER_MS, capturedAt, bytes: pcm.length, pieces: [] };
    try {
      let consumed = 0;
      let part = this.parts.at(-1) ? { ...this.parts.at(-1) } : null;
      while (consumed < pcm.length) {
        if (!part || part.bytes === this.partBytes) {
          const n = part ? Number(/audio-(\d+)/.exec(part.file)[1]) + 1 : 1;
          part = { file: 'audio-' + String(n).padStart(4, '0') + '.wav', bytes: 0 };
        }
        const count = Math.min(pcm.length - consumed, this.partBytes - part.bytes), offset = part.bytes + 44;
        const file = path.join(this.dir, part.file), fd = fs.openSync(file, fs.existsSync(file) ? 'r+' : 'w+', 0o600);
        try {
          let written = 0;
          while (written < count) written += fs.writeSync(fd, pcm, consumed + written, count - written, offset + written);
          fs.writeSync(fd, header(part.bytes + count), 0, 44, 0); fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        receipt.pieces.push({ file: part.file, offset, bytes: count }); part.bytes += count; consumed += count;
      }
      const fd = fs.openSync(this.journal, 'a', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(receipt) + '\n'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    } catch (e) {
      // Repair a partially written WAV or journal line before allowing another append.
      try { this.recover(); } catch {}
      throw error('录音未能保存到本机，请检查磁盘空间后重试。', e.status || 503);
    }
    this.receipts.set(id, receipt); this.bytes += pcm.length; this.endMs = receipt.endMs;
    for (const p of receipt.pieces) {
      let part = this.parts.find(v => v.file === p.file);
      if (!part) { part = { file: p.file, bytes: 0, offsetMs: (this.bytes - pcm.length + receipt.pieces.slice(0, receipt.pieces.indexOf(p)).reduce((n, v) => n + v.bytes, 0)) / BYTES_PER_MS }; this.parts.push(part); }
      part.bytes = p.offset + p.bytes - 44;
    }
    return receipt;
  }
  summary() { return { available: this.bytes > 0, bytes: this.bytes, durationMs: this.bytes / BYTES_PER_MS, parts: this.parts.map(p => ({ ...p, durationMs: p.bytes / BYTES_PER_MS })) }; }
  manifest() { return { format: 'PCM16', sampleRate: 16000, channels: 1, ...this.summary(), chunks: [...this.receipts.values()].map(({ hash: _hash, ...r }) => r) }; }
}
