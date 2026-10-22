const OUTPUT_RATE = 16000;
const gcd = (a, b) => b ? gcd(b, a % b) : a;

// A symmetric, Blackman-windowed sinc low-pass precedes rate conversion. Phase
// coefficients are prepared once, not calculated on the audio render path.
function filterBank(rate, radius, phases) {
  const cutoff = .45 * Math.min(rate, OUTPUT_RATE) / rate;
  return Array.from({ length: phases }, (_, phase) => {
    const taps = new Float64Array(2 * radius + 1);
    const fraction = phase / phases;
    let total = 0;
    for (let k = -radius; k <= radius; k++) {
      const distance = k - fraction;
      if (Math.abs(distance) > radius) continue;
      const argument = 2 * cutoff * Math.PI * distance;
      const sinc = argument ? Math.sin(argument) / argument : 1;
      const window = .42 + .5 * Math.cos(Math.PI * distance / radius) + .08 * Math.cos(2 * Math.PI * distance / radius);
      const coefficient = 2 * cutoff * sinc * window;
      taps[k + radius] = coefficient; total += coefficient;
    }
    return taps.map(coefficient => coefficient / total);
  });
}

export class Pcm16Encoder {
  constructor(inputRate, emit) {
    if (!Number.isInteger(inputRate) || inputRate <= 0) throw new RangeError('Invalid input sample rate');
    this.inputRate = inputRate;
    this.emit = emit;
    this.received = 0;
    this.produced = 0;
    this.finished = false;
    this.packet = new DataView(new ArrayBuffer(3200));
    this.written = 0;
    this.radius = Math.ceil(.003 * inputRate);
    this.phases = Math.min(512, OUTPUT_RATE / gcd(inputRate, OUTPUT_RATE));
    if (inputRate !== OUTPUT_RATE) {
      this.filters = filterBank(inputRate, this.radius, this.phases);
      const capacity = 2 ** Math.ceil(Math.log2(2 * this.radius + 4));
      this.history = new Float64Array(capacity);
      this.mask = capacity - 1;
    }
  }

  push(channels) {
    if (this.finished || !channels.length) return;
    for (let index = 0; index < channels[0].length; index++) {
      let mono = 0;
      for (const channel of channels) mono += Number.isFinite(channel[index]) ? channel[index] : 0;
      mono /= channels.length;
      if (!this.filters) { this.received++; this.write(mono); continue; }
      this.history[this.received & this.mask] = mono;
      this.received++;
      this.resample(false);
    }
  }

  resample(flush) {
    const target = Math.ceil(this.received * OUTPUT_RATE / this.inputRate);
    while (this.produced < target) {
      // Integer time positions prevent cumulative drift at fractional sample rates.
      const numerator = this.produced * this.inputRate;
      let center = Math.floor(numerator / OUTPUT_RATE);
      let phase = Math.round((numerator % OUTPUT_RATE) * this.phases / OUTPUT_RATE);
      if (phase === this.phases) { center++; phase = 0; }
      if (!flush && center + this.radius >= this.received) break;
      const taps = this.filters[phase];
      let sample = 0;
      for (let tap = 0; tap < taps.length; tap++) {
        const input = center + tap - this.radius;
        if (input >= 0 && input < this.received) sample += this.history[input & this.mask] * taps[tap];
      }
      this.write(sample);
    }
  }

  write(sample) {
    const value = Math.max(-32768, Math.min(32767, Math.round(sample * 32768)));
    this.packet.setInt16(this.written * 2, value, true);
    this.written++; this.produced++;
    if (this.written === 1600) this.send();
  }

  send() {
    if (!this.written) return;
    this.emit(this.packet.buffer.slice(0, this.written * 2));
    this.written = 0;
  }

  flush() {
    if (this.finished) return;
    this.finished = true;
    if (this.filters) this.resample(true);
    // Flush the filter's lookahead before padding at most 15 samples for the
    // whole-millisecond upload timeline. No source audio is dropped at stop.
    while (this.written % 16) this.write(0);
    this.send();
  }
}
