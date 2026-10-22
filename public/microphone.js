const microphoneError = (message, reason) => Object.assign(new Error(message), { name: 'NotAllowedError', reason });
async function deadline(promise, milliseconds, error) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(error), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

export async function openMicrophone({ onPcm, onEnded }) {
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') {
    throw Object.assign(new Error('当前浏览器无法使用麦克风，请使用本机地址打开。'), { name: 'SecurityError' });
  }
  const context = new AudioContext({ latencyHint: 'interactive' });
  // Invoke resume during the click gesture, before waiting for device permission.
  const resumed = context.resume().then(() => null, error => error);
  let stream, processor, source, silent, stopping = false, stopTask, flushed, flushTimer;
  const stop = () => {
    if (stopTask) return stopTask;
    stopping = true;
    stream?.getTracks().forEach(track => track.stop());
    const tail = new Promise(resolve => {
      if (!processor || context.state !== 'running') { resolve(); return; }
      flushed = resolve;
      flushTimer = setTimeout(resolve, 1200);
      processor.port.postMessage({ type: 'flush' });
    });
    stopTask = tail.finally(async () => {
      clearTimeout(flushTimer);
      if (processor) {
        processor.port.onmessage = null;
        processor.onprocessorerror = null;
        processor.port.close();
      }
      for (const node of [source, processor, silent]) {
        try { node?.disconnect(); } catch {}
      }
      if (context.state !== 'closed') await context.close().catch(() => {});
    });
    return stopTask;
  };
  try {
    const permission = navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // A permission prompt can outlive our deadline; release any late-granted device.
    permission.then(value => { if (stopping) value.getTracks().forEach(track => track.stop()); }).catch(() => {});
    stream = await deadline(permission, 10000, microphoneError('麦克风授权尚未完成。', 'permission-timeout'));
    const resumeError = await deadline(resumed, 1800, microphoneError('浏览器需要点击后才能启动音频。', 'autoplay'));
    if (resumeError) throw resumeError;
    if (context.state !== 'running') throw microphoneError('音频尚未启动，请点击启用麦克风。', 'autoplay');
    await context.audioWorklet.addModule('/pcm-worklet.js');
    processor = new AudioWorkletNode(context, 'live-subtitles-microphone', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    processor.port.onmessage = ({ data }) => {
      if (data?.type === 'flushed') flushed?.();
      else if (data instanceof ArrayBuffer) onPcm(data);
    };
    processor.onprocessorerror = () => { if (!stopping) onEnded?.(); };
    for (const track of stream.getAudioTracks()) track.onended = () => { if (!stopping) onEnded?.(); };
    source = context.createMediaStreamSource(stream);
    silent = context.createGain(); silent.gain.value = 0;
    source.connect(processor); processor.connect(silent); silent.connect(context.destination);
    return { ctx: context, stream, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
