# 服务配置

识别与翻译分别使用 OpenAI 兼容接口。设置以能力命名，与具体厂商无关；默认不指定服务商、模型或 Key。

## 字段

| 字段 | 语音识别 `asr` | 字幕翻译 `translation` |
| --- | --- | --- |
| `baseURL` | 识别服务的基础地址 | 翻译服务的基础地址 |
| `apiKey` | 识别服务 Key，可为空 | 翻译服务 Key，可为空 |
| `model` | 支持音频转写的模型名 | 支持文本翻译与 JSON 输出的模型名 |
| `useAsrConnection` | 不适用 | 为 `true` 时复用识别服务的 `baseURL` 和 Key |

复用连接只影响请求使用的地址和 Key，翻译模型仍需独立填写。翻译的独立连接配置会保留，关闭复用后继续使用。读取设置返回各组保存的配置与 `hasApiKey`，不会把复用后的地址或 Key 写回翻译的独立配置。

Base URL 使用完整的 `http://` 或 `https://` 地址，包含服务要求的路径。例如：

```text
Base URL: https://api.example.com/v1
识别请求: https://api.example.com/v1/audio/transcriptions
翻译请求: https://api.example.com/v1/chat/completions
```

应用不自动增加 `/v1`。本地服务的 Base URL 可以是 `http://localhost:8000/v1`，也可以使用该服务实际提供的其他路径。地址不接受内嵌用户名、密码、查询参数或片段。

## 每场会议的主题与描述

创建会议时填写名称与可选描述，描述可以包含分享提纲、讲者、产品名、人名或专业术语。例如：

```text
会议名称：AI 编程工具分享
会议描述：介绍 Claude Code、Codex，以及通过 MCP 连接工具的实际用法。
```

应用自动将本场会议名称与描述组成上下文，识别请求通过标准 multipart `prompt` 字段发送；翻译请求将同一内容作为独立的 `background` 数据参考。每场会议单独保存，后续会议不会沿用上一场的描述。描述最多接受 4000 个 UTF-16 码元，建议简短、相关，不自动截断。

描述留空时只参考会议名称；名称为空时显示“未命名会议”。未命名且没有描述时不发送 ASR `prompt`。上下文本身不作为发言写入字幕，描述不出现在手机观看接口中。历史读取不会重新识别或翻译。

## Key 的保存与更新

- Key 只发送给本地后端，由后端调用服务。读取设置返回 `hasApiKey`，不返回 Key 原文。
- 密码框以掩码表示已保存的 Key，未编辑时保留；直接输入替换，删空后保存即移除。
- API 更新时省略 `apiKey` 保留原值；传入空字符串清除，非空字符串替换。掩码不会作为 Key 提交。
- 更换来源，即协议、主机或端口发生变化时，不自动把旧 Key 发给新来源；需要重新填写。
- 无需鉴权的本地服务可以不配置 Key；请求不会发送空的 Bearer 凭据。
- Key 须为无空格的可打印 ASCII 字符；配置校验和连接错误不回显凭据。
- `data/settings.json` 是本机保存文件，包含实际 Key。不要提交、共享或作为会议包分发。备份时也需保护此文件。

## 环境变量

复制根目录的 `.env.example` 为 `.env` 后填写。服务始终读取项目根目录的 `.env`。环境变量提供初始值，应用保存的本地设置覆盖初始值；修改 `.env` 不会覆盖已经保存的设置。

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `ASR_BASE_URL` | 识别 Base URL | 空 |
| `ASR_API_KEY` | 识别 Key | 空 |
| `ASR_MODEL` | 识别模型 | 空 |
| `TRANSLATION_BASE_URL` | 翻译 Base URL | 空 |
| `TRANSLATION_API_KEY` | 翻译 Key | 空 |
| `TRANSLATION_MODEL` | 翻译模型 | 空 |
| `PORT` | HTTP 服务端口 | `8090` |
| `DATA_DIR` | 数据目录 | 项目下的 `data/` |

部署时也可以直接设置上表中的进程环境变量。配置只使用 `asr` 和 `translation` 两组字段；读取配置不会改写本地文件。

## 服务端接口要求

两项能力需要分别兼容以下接口。只兼容聊天接口的服务不能直接承担语音识别；翻译采用文本输入，不要求音频理解模型。`model` 必须填写服务商实际提供的模型 ID，不能填写 speech model、text model 这类能力名称。

| 用途 | OpenAI 兼容接口 | 输入 | 输出 |
| --- | --- | --- | --- |
| 语音识别 | `POST /audio/transcriptions` | WAV 文件与识别模型 ID | JSON 字符串字段 `text` |
| 文本翻译 | `POST /chat/completions` | 识别文本与翻译模型 ID | 结构化 JSON 字幕；可通过 SSE 流式返回 |


识别服务必须接受 `POST <baseURL>/audio/transcriptions` 的 multipart 请求：

- `file`：16 kHz、单声道、PCM16 WAV。
- `model`：所配置的模型名。
- `response_format=json`、`temperature=0`。
- 会议有名称或描述时，增加标准 `prompt` 字段作为本场识别背景。
- 返回 JSON，至少包含字符串 `text`。

识别不固定 `language`，便于处理中英粤混合发言。服务或模型本身仍须支持所需语言。

翻译服务使用 `POST <baseURL>/chat/completions`，接收 `model`、`messages`，默认请求 `stream: true`。SSE 的 `choices[0].delta.content` 承载逐步生成的 JSON 文本；完整短字幕条目到达后即可显示，整份响应校验通过后定稿。服务直接返回普通 JSON 时也可读取 `choices[0].message.content`。明确以 HTTP 400 报告不支持 `stream` 时，应用改用非流式请求。

应用请求中、英、粤字幕及表达完整性判断。每条输出包含对应的 `id`、`source`、`zhHans`、`en`、`yue`，整个对象含布尔字段 `complete`。`source` 用于核对编号与原文，不能把相邻条目的内容移入当前条目。省略 `source` 的响应等待完整条目后校验；只有一条字幕时，也可读取扁平的三语 JSON 对象。

请求默认使用 `response_format: {"type":"json_object"}`、`temperature: 0` 与 `max_completion_tokens`。明确报告参数不兼容的 HTTP 400 响应可触发有限降级：移除不支持的参数，或改用 `max_tokens`。格式或分条异常自动重试一次；失败尝试的流式临时字幕会撤回，已校验字幕继续保留。

## 已验证配置示例

以下组合已经实际调用验证，作为可选配置示例；应用首次启动时不预填服务商和模型：

| 配置 | 值 |
| --- | --- |
| Base URL | `https://api.ant-ling.com/v1` |
| 语音识别 Model ID | `Ming-3.0-asr-tiny` |
| 文本翻译 Model ID | `Ming-3.0-audio-flash` |

这套示例可勾选共用 Base URL 和 API Key；两个 Model ID 分别填写。Ming audio-flash 在本应用中接收的是识别后的文本。

其他兼容服务需验证音频格式、所需语言、响应字段、结构化翻译和请求限制。请求量、模型费用与延迟由实际服务决定。
