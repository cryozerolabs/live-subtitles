import { createParser } from 'eventsource-parser';
import { JSONParser } from '@streamparser/json';

const formatError = () => Object.assign(new Error('翻译服务返回格式异常，原文已保留，请重试。'), { kind: 'format' });
export function checkChoice(choice) {
  if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal || choice?.delta?.refusal) {
    throw Object.assign(new Error('翻译服务拒绝了这段内容，原文已保留。'), { kind: 'refusal' });
  }
  if (choice?.finish_reason === 'length') throw Object.assign(new Error('译文输出不完整，原文已保留，请重试。'), { kind: 'format' });
}

// A JSON parser emits only closed elements of the root cues array. Braces in
// quoted text, nested objects and arbitrary UTF-8/token boundaries stay data.
export function cueReader(onCue) {
  const parser = new JSONParser({ paths: ['$.cues.*'], keepStack: false });
  let disabled = false, failure;
  parser.onError = () => { disabled = true; };
  parser.onValue = ({ value }) => { try { onCue(value); } catch (error) { failure = error; } };
  return chunk => {
    // Fenced/legacy JSON can still be accepted by the full-response parser.
    if (!disabled) parser.write(chunk);
    if (failure) throw failure;
  };
}

export async function readChatResponse(response, { signal, onContent } = {}) {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    try { return await response.json(); }
    catch (error) { if (signal?.aborted) signal.throwIfAborted(); if (['AbortError', 'TimeoutError'].includes(error.name)) throw error; throw formatError(); }
  }
  if (!response.body) throw formatError();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let content = '', finishReason = null, done = false, usage;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const parser = createParser({
    maxBufferSize: 1024 * 1024,
    onError: error => { if (error.type === 'max-buffer-size-exceeded') throw formatError(); },
    onEvent: event => {
      if (done) return;
      if (event.event === 'error') throw new Error('翻译服务流式连接异常，原文已保留，请重试。');
      if (!event.data.trim()) return;
      if (event.data.trim() === '[DONE]') { done = true; return; }
      let value;
      try { value = JSON.parse(event.data); } catch { throw formatError(); }
      if (!value || typeof value !== 'object' || Array.isArray(value) || (value.choices !== undefined && !Array.isArray(value.choices))) throw formatError();
      // Never surface provider error bodies, which can echo request credentials.
      if (value.error) throw new Error('翻译服务流式连接异常，原文已保留，请重试。');
      if (value.usage) usage = value.usage;
      const choice = value.choices?.find(row => row && (row.index === undefined || row.index === 0));
      checkChoice(choice);
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta?.content;
      if (typeof delta === 'string' && delta) {
        content += delta;
        if (content.length > 1024 * 1024) throw formatError();
        onContent?.(delta);
      }
    },
  });
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    while (!done) {
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) { parser.feed(decoder.decode()); break; }
      parser.feed(decoder.decode(chunk.value, { stream: true }));
    }
    // An abruptly closed stream is not a successful final translation, even if
    // the last received content happens to be valid JSON.
    if (!done && !finishReason) throw formatError();
    return { choices: [{ finish_reason: finishReason, message: { content } }], usage };
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (error.kind || ['AbortError', 'TimeoutError'].includes(error.name)) throw error;
    // Parser/transport exception messages may contain provider-controlled data.
    // eslint-disable-next-line preserve-caught-error -- Provider errors may contain credentials.
    throw new Error('翻译服务流式连接中断，原文已保留，请重试。');
  } finally {
    signal?.removeEventListener('abort', cancel); cancel(); reader.releaseLock();
  }
}
