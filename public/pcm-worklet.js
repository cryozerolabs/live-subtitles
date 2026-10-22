import { Pcm16Encoder } from './pcm-encoder.js';

class MicrophoneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.finished = false;
    this.encoder = new Pcm16Encoder(sampleRate, buffer => this.port.postMessage(buffer, [buffer]));
    this.port.onmessage = ({ data }) => {
      if (data?.type !== 'flush' || this.finished) return;
      this.finished = true;
      this.encoder.flush();
      this.port.postMessage({ type: 'flushed' });
    };
  }

  process(inputs) {
    if (!this.finished && inputs[0]?.length) this.encoder.push(inputs[0]);
    return !this.finished;
  }
}

registerProcessor('live-subtitles-microphone', MicrophoneProcessor);
