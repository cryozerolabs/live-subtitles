import { createApp as createService } from '../../src/server.js';
import { pcmRms } from '../../src/audio/pcm.js';

// Existing protocol tests use DC-valued synthetic frames, which are not human
// speech. Keep their provider/scheduler fixtures explicit; speech.test.mjs runs
// the bundled detector against actual speech and high-energy non-speech.
export function createApp(options = {}) {
  return createService({ speechDetectorFactory: async () => ({
    probability: async pcm => pcmRms(pcm) >= .009 ? 1 : pcmRms(pcm) >= .0054 ? .4 : 0,
    reset() {},
  }), ...options });
}
