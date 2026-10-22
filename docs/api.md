# 本地 API

这些接口由同一服务提供给本地控制页面和局域网只读观看页面。默认地址为 `http://localhost:8090`。JSON 请求使用 `Content-Type: application/json`，错误响应为 `{"error":"说明"}`。

控制、配置、历史和下载接口仅允许回环连接，并校验 Host 与 Origin。该限制不等同于主持人身份认证；本机程序也能调用接口。局域网客户端只允许使用带令牌的观看接口及必要静态资源，不支持公网部署。

## 设置

`GET /api/settings` 返回各组保存的连接配置。以下示例的翻译独立连接尚未设置，实际请求因 `useAsrConnection: true` 而使用识别连接：

```json
{
  "asr": {
    "baseURL": "https://api.example.com/v1",
    "model": "speech-model",
    "prompt": "本次介绍 Claude Code、Codex 与 MCP。",
    "hasApiKey": true
  },
  "translation": {
    "baseURL": "",
    "model": "text-model",
    "hasApiKey": false,
    "useAsrConnection": true
  },
  "configured": true,
  "networkAddress": "",
  "networkAddresses": [],
  "captureProtocol": 1
}
```

`PUT /api/settings` 更新对应分组。可写字段为 `baseURL`、`model`、`apiKey`、`clearApiKey`，以及识别分组的 `prompt`、翻译分组的 `useAsrConnection`；`networkAddress` 用于选择二维码中的局域网地址。示例：

```json
{
  "asr": {
    "baseURL": "https://api.example.com/v1",
    "model": "speech-model",
    "prompt": "本次介绍 Claude Code、Codex 与 MCP。"
  },
  "translation": {
    "model": "text-model",
    "useAsrConnection": true
  }
}
```

未传 Key 或空白 Key 保留原值；`clearApiKey: true` 显式清除。更换来源不保留旧 Key。响应结构与 GET 相同，不回传密钥。连接和环境变量行为见 [服务配置](configuration.md)。

`asr.prompt` 为全局上下文，所有会议共用，翻译同步参考。未传保持原值，空字符串清除；接受字符串，最多 4000 个 UTF-16 码元，超限返回 400。只读观看接口不返回此项。设置变更须等待已有识别与翻译处理完成；控制页面在修改服务或上下文时先暂停并排空，不自动恢复收音。

## 会议

| 方法与路径 | 行为 |
| --- | --- |
| `POST /api/sessions` | 创建会议，正文可传 `title`、`draft: true`；创建本身不启动浏览器麦克风 |
| `GET /api/sessions/current` | 获取或准备当前会议，不采音 |
| `GET /api/sessions?before=<id>&limit=30` | 按时间倒序分页，返回 `items` 与 `next` |
| `GET /api/sessions/:id` | 当前会议快照 |
| `POST /api/sessions/:id/capture` | 正文 `{"captureId":"页面唯一编号"}`，预留本场采音权限，返回权威 `ingestEndMs`；不启用麦克风、不标记开始 |
| `DELETE /api/sessions/:id/capture` | 正文同上，在音频上传与处理排空后释放采音权限 |
| `POST /api/sessions/:id/start` | 开始或继续；浏览器仍需单独启用麦克风 |
| `POST /api/sessions/:id/flush` | 排空识别与翻译，返回 202 |
| `POST /api/sessions/:id/pause` | 标记暂停，调用方应先停止采音并排空 |
| `POST /api/sessions/:id/end` | 异步结束并保存，返回 202；通过 SSE 等待完成 |
| `GET /api/sessions/:id/events` | SSE 状态与字幕流 |
| `POST /api/sessions/:id/preferred-language` | 正文 `{"language":"zhHans"}`，也支持 `en`、`yue`；设置下一次翻译优先输出的语言，不启动收音、不重发当前请求 |
| `GET /api/sessions/:id/captions` | 完整历史的字幕分页 |
| `GET /api/sessions/:id/share` | 获取本场观看 URL 与二维码 data URL |
| `GET /api/sessions/:id/download` | 下载只含 SRT 和 WAV 的会议包 ZIP |
| `GET /api/sessions/:id/subtitles/:language` | 下载当前已定稿 SRT |
| `DELETE /api/sessions/:id` | 正文必须为 `{"confirm":true}`，永久删除本场数据 |

会议状态为 `ready`、`recording`、`paused`、`finalizing`、`ended` 或 `interrupted`。结束操作需由界面确认后发起，API 本身不展示确认框。已保存会议不会在读取或下载时重新调用模型。

支持 `captureProtocol: 1` 的客户端每页生成一个 `captureId`（10–80 个字母、数字、下划线或连字符）。先预留权限，再请求麦克风；`/start` 的正文和 `/audio` 的查询参数须携带相同编号。音频上传续期，15 秒无请求后其他页面可以接管。冲突返回 409，`code` 为 `capture_busy`；权限失效为 `capture_expired`。这用于防止多个页面同时采音，不是主持人身份认证。新一轮开始时仅在浏览器没有待上传音频的情况下同步 `ingestEndMs`；重试保留原音频编号、时间和内容。

删除只允许已结束或已中断且处理完成的会议。仍在处理、保存或下载文件时返回 409；删除可幂等重试。成功删除使原观看令牌失效，已下载的文件不受影响。

字幕分页支持 `before=<字幕ID>` 或 `after=<字幕ID>`，每次选择一种方向，`limit` 为 1–100，默认 60。返回 `items`、`hasBefore`、`hasAfter`、`total`。SRT 语言路径值为 `original`、`zhHans`、`en`、`yue`。

## 音频与增量字幕

`POST /api/sessions/:id/audio?startMs=<毫秒>&chunkId=<唯一编号>&captureId=<页面编号>` 使用 `application/octet-stream` 上传 16 kHz、单声道、little-endian PCM16 原始数据。当前协议按完整的 100 ms 帧接收，单次不超过 12 秒；浏览器通常每 200 ms 提交一次，停止时将不足 100 ms 的尾帧补静音。音频与编号索引落盘后即确认上传，不等待本地人声检测或远程模型完成。同一片段重试必须使用相同编号和内容，避免重复写入与识别。

SSE 默认消息为 JSON 快照，包含：

- `captions`：最近 60 条字幕，含固定 `id`、`revision`、`final`、`raw`、`translations`、`startMs`、`endMs`；译文键为 `zhHans`、`en`、`yue`。
- `captionParents`：同一识别修订对应的有效条目，用于收回被替换的临时尾部。
- `status`、`draining`、`pendingFinals`、错误等运行信息。
- `captureActive`：是否有尚未过期的采音预留；不返回页面编号。`metrics.vad` 记录本地人声检测帧数与耗时。
- `update`：当前服务进程内递增版本；`epoch`：区分服务重启。

识别结果到达后先发布原文，此时 `translations` 的各语言值可以为空。完整语言字段从模型流中返回后逐个补入同一条字幕，原文修订时只保留源文本及偏移完全一致的译文。临时原文可随识别更正，翻译使用连续识别确认的稳定前缀，最终识别可更正当前未定稿句。

客户端按 ID 更新字幕，忽略迟到的旧修订，已定稿内容保持稳定。`revision` 是递增的显示版本；原文修订与各语言流式更新都会推进该版本。提前显示的原文和译文均为 `final: false`，只有全部三语、条目对齐、整份响应与结束信号校验通过后才定稿并写入 SRT。主持端语言偏好只影响下一次请求的字段顺序；手机端独立选择显示语言，三语始终生成。

失败或取消的临时译文通过更高版本的字幕快照撤回，识别原文保留；可恢复上次已校验且与当前原文匹配的译文。客户端须同时处理 `captionParents.ids`，移除被替换的未定稿尾部，不能仅追加 `captions`。不要把累计识别文本逐次追加。完整历史通过分页获取。

删除时发送命名 SSE 事件 `deleted`，正文为 `{"id":"会议ID"}`，随后关闭连接。

## 只读观看

| 路径 | 行为 |
| --- | --- |
| `/watch/:token` | 手机观看页面 |
| `/api/watch/:token` | 本场公开快照 |
| `/api/watch/:token/events` | 本场只读 SSE |
| `/api/watch/:token/captions` | 本场字幕分页，与本地分页参数相同 |

令牌仅授予一场会议的字幕读取权限。观看响应不包含服务设置、音频识别内部记录或录音。持有链接者可以读取该场字幕；没有额外密码或参与者身份校验。
