import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore, updateSettings, publicSettings, connection, settingsReady, endpoint } from '../src/configuration.js';

const ASR_KEY = 'fixture-asr-key';
const TRANSLATION_KEY = 'fixture-translation-key';
const env = {
  ASR_BASE_URL: 'https://speech.example/custom/v2', ASR_API_KEY: ASR_KEY, ASR_MODEL: 'speech-fixture',
  TRANSLATION_BASE_URL: 'https://text.example/gateway', TRANSLATION_API_KEY: TRANSLATION_KEY, TRANSLATION_MODEL: 'text-fixture',
};

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitles-settings-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const fixture = t => new SettingsStore(directory(t), env);
function rejectsWithoutEcho(run, forbidden) {
  assert.throws(run, error => {
    assert.equal(error.status, 400);
    for (const value of forbidden) assert.equal(error.message.includes(value), false);
    return true;
  });
}

test('unconfigured settings have no provider, model or credentials by default', t => {
  const store = new SettingsStore(directory(t), {});
  assert.deepEqual(store.value, {
    version: 2,
    asr: { baseURL: '', apiKey: '', model: '', prompt: '' },
    translation: { baseURL: '', apiKey: '', model: '', useAsrConnection: false },
    networkAddress: '',
  });
  assert.equal(settingsReady(store.value), false);
  assert.equal(fs.existsSync(store.file), false);
  assert.deepEqual(publicSettings(store.value), {
    asr: { baseURL: '', model: '', hasApiKey: false, prompt: '' },
    translation: { baseURL: '', model: '', hasApiKey: false, useAsrConnection: false },
    networkAddress: '', configured: false,
  });
});

test('protocol-neutral environment groups are independent and saved settings override initial values', t => {
  const dir = directory(t), store = new SettingsStore(dir, env);
  assert.deepEqual(connection(store.value, 'asr'), { baseURL: env.ASR_BASE_URL, apiKey: ASR_KEY, model: env.ASR_MODEL });
  assert.deepEqual(connection(store.value, 'translation'), { baseURL: env.TRANSLATION_BASE_URL, apiKey: TRANSLATION_KEY, model: env.TRANSLATION_MODEL });
  const next = updateSettings(store.value, {
    asr: { baseURL: 'http://localhost:8000/custom', apiKey: 'fixture-local-key', model: 'saved-speech' },
    translation: { baseURL: 'http://localhost:9000/text', apiKey: 'fixture-other-key', model: 'saved-text' },
    networkAddress: '192.168.1.8',
  });
  store.write(next);
  const reopened = new SettingsStore(dir, { ...env, ASR_API_KEY: 'fixture-replaced-env-key', TRANSLATION_MODEL: 'replaced-env-model' });
  assert.deepEqual(reopened.value, next);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(store.file + '.tmp'), false);
});

test('global ASR context persists, stays separate from connection reuse and can be cleared', t => {
  const dir = directory(t), initial = '本次介绍 Claude Code 与 MCP。';
  const store = new SettingsStore(dir, { ...env, ASR_PROMPT: initial });
  assert.equal(connection(store.value, 'asr').prompt, initial);
  assert.equal(publicSettings(store.value).asr.prompt, initial);
  const prompt = '  分享主题：Claude Code 与 Codex。\n术语：MCP、Cloud Code。  ';
  store.write(updateSettings(store.value, { asr: { prompt }, translation: { useAsrConnection: true } }));
  const reopened = new SettingsStore(dir, { ...env, ASR_PROMPT: '环境变量不会覆盖已保存内容' });
  assert.equal(reopened.value.asr.prompt, prompt.trim());
  assert.equal(reopened.value.asr.apiKey, ASR_KEY);
  assert.equal(reopened.value.asr.model, env.ASR_MODEL);
  assert.equal(Object.hasOwn(connection(reopened.value, 'translation'), 'prompt'), false);
  const retained = updateSettings(reopened.value, { asr: { model: 'renamed-speech' } });
  assert.equal(retained.asr.prompt, prompt.trim());
  const cleared = updateSettings(retained, { asr: { prompt: '   ' } });
  store.write(cleared);
  assert.equal(new SettingsStore(dir, env).value.asr.prompt, '');
  assert.equal(Object.hasOwn(connection(cleared, 'asr'), 'prompt'), false);
});

test('global context accepts more than 60 characters and rejects oversized or non-text input without echo', t => {
  const previous = fixture(t).value;
  for (const length of [300, 4000]) assert.equal(updateSettings(previous, { asr: { prompt: '术'.repeat(length) } }).asr.prompt.length, length);
  for (const prompt of ['private-context'.repeat(400), { context: 'private-context' }, null]) {
    rejectsWithoutEcho(() => updateSettings(previous, { asr: { prompt } }), ['private-context']);
  }
  assert.equal(previous.asr.prompt, '');
  rejectsWithoutEcho(() => updateSettings(previous, { translation: { prompt: 'private-context' } }), ['private-context']);
});

test('same-origin new environment groups do not implicitly copy the recognition key', t => {
  const store = new SettingsStore(directory(t), { ...env, TRANSLATION_BASE_URL: env.ASR_BASE_URL, TRANSLATION_API_KEY: undefined });
  assert.equal(store.value.translation.useAsrConnection, false);
  assert.equal(store.value.translation.apiKey, '');
  assert.equal(connection(store.value, 'translation').apiKey, '');
});

test('loading saved service groups preserves the file and never publishes credentials', t => {
  const dir = directory(t), initial = new SettingsStore(dir, env);
  initial.write(initial.value);
  const disk = fs.readFileSync(initial.file, 'utf8'), store = new SettingsStore(dir, {});
  assert.deepEqual(store.value, initial.value);
  assert.equal(fs.readFileSync(initial.file, 'utf8'), disk);
  const visible = publicSettings(store.value), serialized = JSON.stringify(visible);
  assert.equal(visible.asr.hasApiKey, true);
  assert.equal(visible.translation.hasApiKey, true);
  assert.equal(Object.hasOwn(visible.asr, 'apiKey'), false);
  assert.equal(Object.hasOwn(visible.translation, 'apiKey'), false);
  assert.equal(serialized.includes(ASR_KEY), false);
  assert.equal(serialized.includes(TRANSLATION_KEY), false);
});

test('unsupported saved configuration shapes fail without rewriting the file or echoing keys', t => {
  const dir = directory(t), file = path.join(dir, 'settings.json'), valid = fixture(t).value;
  for (const saved of [
    { version: 0, token: ASR_KEY },
    { ...valid, asr: undefined },
    { ...valid, token: ASR_KEY },
    { ...valid, asr: { ...valid.asr, token: ASR_KEY } },
    { ...valid, translation: { ...valid.translation, useAsrConnection: 'true' } },
  ]) {
    const disk = JSON.stringify(saved); fs.writeFileSync(file, disk);
    rejectsWithoutEcho(() => new SettingsStore(dir, env), [ASR_KEY, TRANSLATION_KEY]);
    assert.equal(fs.readFileSync(file, 'utf8'), disk);
  }
});

test('Base URL environment fields keep custom paths without adding v1', t => {
  const store = new SettingsStore(directory(t), env);
  assert.equal(store.value.asr.baseURL, env.ASR_BASE_URL);
  assert.equal(store.value.translation.baseURL, env.TRANSLATION_BASE_URL);
  assert.equal(store.value.asr.model, env.ASR_MODEL);
  assert.equal(store.value.translation.model, env.TRANSLATION_MODEL);
  assert.equal(endpoint(store.value.asr.baseURL, 'asr'), env.ASR_BASE_URL + '/audio/transcriptions');
  assert.equal(endpoint(store.value.translation.baseURL, 'translation'), env.TRANSLATION_BASE_URL + '/chat/completions');
  assert.equal(endpoint('https://fixture.example', 'asr'), 'https://fixture.example/audio/transcriptions');
  assert.equal(endpoint('https://fixture.example/custom/chat/completions/', 'translation'), 'https://fixture.example/custom/chat/completions');
  assert.equal(endpoint('', 'asr'), '');
});

test('blank or omitted keys preserve credentials, explicit clear removes them and a new key replaces them', t => {
  const previous = fixture(t).value;
  for (const patch of [{ model: 'renamed' }, { apiKey: '' }, { apiKey: '   ' }]) {
    const next = updateSettings(previous, { asr: patch, translation: patch });
    assert.equal(next.asr.apiKey, ASR_KEY);
    assert.equal(next.translation.apiKey, TRANSLATION_KEY);
  }
  const cleared = updateSettings(previous, { asr: { clearApiKey: true }, translation: { clearApiKey: true } });
  assert.equal(cleared.asr.apiKey, '');
  assert.equal(cleared.translation.apiKey, '');
  const replaced = updateSettings(previous, { asr: { apiKey: 'fixture-next-asr-key' } });
  assert.equal(replaced.asr.apiKey, 'fixture-next-asr-key');
  assert.equal(previous.asr.apiKey, ASR_KEY);
  rejectsWithoutEcho(() => updateSettings(previous, { asr: { apiKey: ASR_KEY, clearApiKey: true } }), [ASR_KEY]);
});

test('origin changes do not carry old keys while path changes retain same-origin credentials', t => {
  const previous = fixture(t).value;
  for (const baseURL of ['https://other.example/v1', 'http://speech.example/custom/v2', 'https://speech.example:9443/custom/v2']) {
    assert.equal(updateSettings(previous, { asr: { baseURL } }).asr.apiKey, '');
  }
  assert.equal(updateSettings(previous, { asr: { baseURL: 'https://speech.example/another/path' } }).asr.apiKey, ASR_KEY);
  assert.equal(updateSettings(previous, { translation: { baseURL: 'https://other.example/v1' } }).translation.apiKey, '');
  const fresh = updateSettings(previous, { asr: { baseURL: 'https://other.example/v1', apiKey: 'fixture-new-origin-key' } });
  assert.equal(fresh.asr.apiKey, 'fixture-new-origin-key');
});

test('explicit connection reuse keeps independent translation settings and its own model', t => {
  const previous = fixture(t).value;
  const shared = updateSettings(previous, { translation: { useAsrConnection: true, model: 'shared-text-model' } });
  assert.deepEqual(connection(shared, 'translation'), { baseURL: env.ASR_BASE_URL, apiKey: ASR_KEY, model: 'shared-text-model' });
  assert.equal(shared.translation.baseURL, env.TRANSLATION_BASE_URL);
  assert.equal(shared.translation.apiKey, TRANSLATION_KEY);
  assert.equal(shared.asr.model, env.ASR_MODEL);
  const visible = publicSettings(shared);
  assert.equal(visible.translation.baseURL, env.TRANSLATION_BASE_URL);
  assert.equal(visible.translation.hasApiKey, true);
  const independent = updateSettings(shared, { translation: { useAsrConnection: false } });
  assert.deepEqual(connection(independent, 'translation'), { baseURL: env.TRANSLATION_BASE_URL, apiKey: TRANSLATION_KEY, model: 'shared-text-model' });
});

test('keyless compatible services can be configured and shared without inventing credentials', t => {
  const blank = new SettingsStore(directory(t), {}).value;
  const independent = updateSettings(blank, {
    asr: { baseURL: 'http://localhost:8000/v1', model: 'local-speech' },
    translation: { baseURL: 'http://localhost:9000/v1', model: 'local-text' },
  });
  assert.equal(settingsReady(independent), true);
  assert.equal(publicSettings(independent).asr.hasApiKey, false);
  assert.equal(publicSettings(independent).translation.hasApiKey, false);
  const shared = updateSettings(blank, {
    asr: { baseURL: 'http://localhost:8000/v1', model: 'local-speech' },
    translation: { useAsrConnection: true, model: 'local-text' },
  });
  assert.equal(settingsReady(shared), true);
  assert.equal(connection(shared, 'translation').apiKey, '');
  assert.equal(publicSettings(shared).translation.baseURL, '');
});

test('invalid key characters are rejected without echoing submitted credentials', t => {
  const previous = fixture(t).value;
  for (const secret of ['fixture\nprivate', 'fixture\rprivate', 'fixture\u0000private', 'fixture\u007fprivate', 'fixture private', 'fixture-秘密', 'fixture-é']) {
    rejectsWithoutEcho(() => updateSettings(previous, { asr: { apiKey: secret } }), [secret, 'private', '秘密']);
    rejectsWithoutEcho(() => new SettingsStore(directory(t), { ...env, TRANSLATION_API_KEY: secret }), [secret, 'private', '秘密']);
  }
  rejectsWithoutEcho(() => updateSettings(previous, { translation: { apiKey: { secret: 'fixture-value' } } }), ['fixture-value']);
});

test('credential-bearing and non-HTTP URLs are rejected without exposing their contents', t => {
  const previous = fixture(t).value;
  for (const baseURL of [
    'https://fixture-user:fixture-private@service.example/v1',
    'https://service.example/v1?key=fixture-private',
    'https://service.example/v1#fixture-private',
    'ftp://service.example/fixture-private',
    'fixture-private',
  ]) {
    rejectsWithoutEcho(() => endpoint(baseURL, 'asr'), ['fixture-private', 'fixture-user']);
    rejectsWithoutEcho(() => updateSettings(previous, { translation: { baseURL } }), ['fixture-private', 'fixture-user']);
  }
});

test('failed multi-group updates leave the previous value and saved file unchanged', t => {
  const store = fixture(t);
  store.write(store.value);
  const previous = store.value, snapshot = structuredClone(previous), disk = fs.readFileSync(store.file, 'utf8');
  Object.freeze(previous.asr); Object.freeze(previous.translation); Object.freeze(previous);
  assert.throws(() => store.write(updateSettings(previous, {
    asr: { model: 'would-change', apiKey: 'fixture-uncommitted-key' }, translation: { model: '' },
  })), /翻译模型名/);
  assert.equal(store.value, previous);
  assert.deepEqual(store.value, snapshot);
  assert.equal(fs.readFileSync(store.file, 'utf8'), disk);
  assert.throws(() => updateSettings(previous, { asr: { model: '' } }), /识别模型名/);
  assert.throws(() => updateSettings(previous, { translation: { useAsrConnection: 'true' } }), /布尔值/);
  assert.throws(() => updateSettings(previous, { apiKey: 'fixture-unknown-key' }), /不支持的字段/);
  assert.equal(fs.existsSync(store.file + '.tmp'), false);
});
