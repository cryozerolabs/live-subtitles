// Seven samples of recent microphone loudness. No oscillator or preset pattern.
export const levelHeight = rms => Math.min(1, Math.sqrt(Math.max(0, (Number(rms) || 0) - .004)) * 3);
export class VoiceMeter {
  constructor(element) { this.element = element; this.bars = [...element.children]; this.active = false; this.levels = Array(this.bars.length).fill(0); }
  state(state) {
    this.active = state === 'recording';
    if (this.element.dataset.state !== state) {
      this.element.dataset.state = state;
      this.element.setAttribute('aria-label', { recording: '麦克风实时音量', paused: '收音已暂停', processing: '正在处理剩余字幕', error: '收音已暂停，请检查提示', ready: '麦克风未启用' }[state] || '麦克风未启用');
    }
    if (!this.active) this.update(0);
  }
  update(rms, samples) {
    if (this.active && samples?.length) { this.levels.shift(); this.levels.push(levelHeight(rms)); }
    else this.levels.fill(0);
    this.bars.forEach((bar, i) => { bar.style.transform = `scaleY(${.125 + this.levels[i] * .875})`; });
  }
}
