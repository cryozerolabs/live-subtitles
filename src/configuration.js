import fs from 'node:fs';
import path from 'node:path';

const invalid = message => Object.assign(new Error(message), { status: 400 });
const own = (object, key) => Object.hasOwn(object, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, name, max = 200) => {
  if (typeof value !== 'string' || value.length > max) throw invalid(name + '格式不正确。');
  return value.trim();
};
function apiKey(value) {
  const key = text(value, 'API Key', 8192);
  if (!/^[\x21-\x7e]*$/.test(key)) throw invalid('API Key 只能包含无空格的可打印 ASCII 字符。');
  return key;
}

export function baseURL(value) {
  const input = text(value, 'Base URL', 2000);
  if (!input) return '';
  let url;
  try { url = new URL(input); } catch { throw invalid('请填写完整的 http:// 或 https:// Base URL。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid('Base URL 不接受用户名、密码、查询参数或片段。');
  return url.toString().replace(/\/+$/, '');
}

export function endpoint(value, kind) {
  const url = baseURL(value);
  if (!url) return '';
  const suffix = kind === 'asr' ? '/audio/transcriptions' : '/chat/completions';
  return url.endsWith(suffix) ? url : url + suffix;
}

function legacyBaseURL(value) {
  return baseURL(value || '').replace(/\/(?:audio\/transcriptions|chat\/completions)$/, '');
}
const sameOrigin = (a, b) => !!a && !!b && new URL(a).origin === new URL(b).origin;
export function connection(settings, kind) {
  const service = settings[kind];
  const source = kind === 'translation' && service.useAsrConnection ? settings.asr : service;
  return { baseURL: source.baseURL, apiKey: source.apiKey, model: service.model };
}
export const settingsReady = settings => ['asr', 'translation'].every(kind => {
  const service = connection(settings, kind);
  return !!(service.baseURL && service.model);
});
export function publicSettings(settings) {
  const publicService = service => ({ baseURL: service.baseURL, model: service.model, hasApiKey: !!service.apiKey });
  return { asr: publicService(settings.asr), translation: { ...publicService(settings.translation), useAsrConnection: settings.translation.useAsrConnection }, networkAddress: settings.networkAddress, configured: settingsReady(settings) };
}

function updateService(previous, patch, kind) {
  if (!object(patch)) throw invalid('服务配置格式不正确。');
  const allowed = ['baseURL', 'apiKey', 'model', 'clearApiKey', ...(kind === 'translation' ? ['useAsrConnection'] : [])];
  if (Object.keys(patch).some(key => !allowed.includes(key))) throw invalid('服务配置包含不支持的字段。');
  const result = { ...previous };
  if (own(patch, 'baseURL')) result.baseURL = baseURL(patch.baseURL);
  if (own(patch, 'model')) result.model = text(patch.model, '模型名');
  for (const key of ['clearApiKey', 'useAsrConnection']) if (own(patch, key) && typeof patch[key] !== 'boolean') throw invalid(key + ' 必须为布尔值。');
  if (kind === 'translation' && own(patch, 'useAsrConnection')) result.useAsrConnection = patch.useAsrConnection;
  const fresh = own(patch, 'apiKey') ? apiKey(patch.apiKey) : '';
  if (patch.clearApiKey && fresh) throw invalid('请勿同时填写和清除 API Key。');
  result.apiKey = patch.clearApiKey ? '' : fresh || (previous.baseURL === result.baseURL || sameOrigin(previous.baseURL, result.baseURL) ? previous.apiKey : '');
  return result;
}

export function updateSettings(previous, patch) {
  if (!object(patch) || Object.keys(patch).some(key => !['asr', 'translation', 'networkAddress'].includes(key))) throw invalid('设置包含不支持的字段。');
  const next = { version: 2, asr: { ...previous.asr }, translation: { ...previous.translation }, networkAddress: previous.networkAddress };
  for (const kind of ['asr', 'translation']) if (own(patch, kind)) next[kind] = updateService(previous[kind], patch[kind], kind);
  if (own(patch, 'networkAddress')) next.networkAddress = text(patch.networkAddress, '局域网地址', 50);
  if (next.asr.baseURL && !next.asr.model) throw invalid('请填写识别模型名。');
  if (connection(next, 'translation').baseURL && !next.translation.model) throw invalid('请填写翻译模型名。');
  return next;
}

function fromEnvironment(env) {
  // Old variable names are read only during upgrades. New installations use the
  // two protocol-neutral service groups documented in .env.example.
  const legacyURL = value => {
    const url = legacyBaseURL(value);
    return !url || /\/(?:audio\/transcriptions|chat\/completions)\/?$/.test(value) || url.endsWith('/v1') ? url : url + '/v1';
  };
  const asr = { baseURL: env.ASR_BASE_URL !== undefined ? baseURL(env.ASR_BASE_URL) : legacyURL(env.MING_ASR_URL || ''), apiKey: apiKey(env.ASR_API_KEY ?? env.MING_API_KEY ?? ''), model: text(env.ASR_MODEL ?? env.MING_ASR_MODEL ?? '', '识别模型名') };
  const translation = { baseURL: env.TRANSLATION_BASE_URL !== undefined ? baseURL(env.TRANSLATION_BASE_URL) : legacyURL(env.DEMO_LLM_URL || ''), apiKey: apiKey(env.TRANSLATION_API_KEY ?? env.DEMO_LLM_KEY ?? ''), model: text(env.TRANSLATION_MODEL ?? env.DEMO_LLM_MODEL ?? '', '翻译模型名'), useAsrConnection: false };
  if (!translation.apiKey && env.MING_API_KEY && env.ASR_API_KEY === undefined && env.TRANSLATION_API_KEY === undefined && env.DEMO_LLM_KEY === undefined && sameOrigin(asr.baseURL, translation.baseURL)) translation.apiKey = asr.apiKey;
  return { version: 2, asr, translation, networkAddress: '' };
}

function normalizeSaved(saved, defaults) {
  const legacy = saved.version !== 2;
  const groups = legacy ? {
    asr: { baseURL: legacyBaseURL(saved.asrEndpoint ?? defaults.asr.baseURL), model: saved.asrModel ?? defaults.asr.model, ...(own(saved, 'asrKey') ? { apiKey: saved.asrKey } : {}) },
    translation: { baseURL: legacyBaseURL(saved.llmEndpoint ?? defaults.translation.baseURL), model: saved.llmModel ?? defaults.translation.model, ...(own(saved, 'llmKey') ? { apiKey: saved.llmKey } : {}) },
  } : saved;
  const result = { version: 2, networkAddress: text(saved.networkAddress ?? '', '局域网地址', 50) };
  for (const kind of ['asr', 'translation']) {
    if (!object(groups[kind])) throw invalid('本机服务配置格式不正确。');
    const service = groups[kind], fallback = defaults[kind];
    const url = baseURL(service.baseURL ?? fallback.baseURL);
    result[kind] = { baseURL: url, model: text(service.model ?? fallback.model, '模型名'), apiKey: apiKey(service.apiKey ?? (sameOrigin(url, fallback.baseURL) ? fallback.apiKey : '')) };
  }
  result.translation.useAsrConnection = legacy ? !!result.asr.baseURL && result.asr.baseURL === result.translation.baseURL && result.asr.apiKey === result.translation.apiKey : saved.translation.useAsrConnection === true;
  return result;
}

export class SettingsStore {
  constructor(dataDir, env = process.env) {
    this.file = path.join(dataDir, 'settings.json');
    const defaults = fromEnvironment(env);
    this.value = defaults;
    if (fs.existsSync(this.file)) {
      let saved;
      try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { throw new Error('无法读取本机服务配置，请检查 settings.json 格式。'); }
      if (!object(saved)) throw invalid('本机服务配置格式不正确。');
      this.value = normalizeSaved(saved, defaults);
      if (saved.version !== 2) this.write(this.value);
    }
  }
  write(value) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.file);
    this.value = value;
  }
}
