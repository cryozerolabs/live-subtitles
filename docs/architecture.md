# 数据流与代码结构

浏览器负责采音与显示，本地 Node.js 服务负责保存音频、调度识别和翻译、输出 SSE 和会议包。API Key 只在后端使用。

```text
麦克风 → AudioWorklet → 16 kHz PCM16 → 本地音频上传与 WAV 保存
                                            ↓
                                    分段与累计 WAV 识别
                                            ↓
                                    句子缓冲与短字幕切分
                                            ↓
                                       三语翻译
                                            ↓
                                 同 ID 修订 → SSE → 浏览器
                                            ↓
                                    定稿 SRT / 会议记录
```

## 代码入口

业务源码集中在 `src/`，前端静态文件、测试和文档分别保留在独立目录：

```text
src/
  server.js
  configuration.js
  audio/
    pcm.js
  providers/
    chat-stream.js
    openai-compatible.js
  captions/
    incremental-asr.js
    model-lane.js
    sentences.js
    cue-text.js
  storage/
    recording-store.js
    subtitle-store.js
    meeting-deletion.js
public/
  pcm-encoder.js
  pcm-worklet.js
  fonts/
test/
docs/
```

`npm start` 从 `src/server.js` 启动。默认数据目录和 `.env`、`public/` 均按项目根目录定位，不随源码目录层级变化。

| 文件或目录 | 职责 |
| --- | --- |
| `src/server.js` | HTTP、SSE、会话状态、历史、分享和下载 |
| `src/providers/openai-compatible.js` | OpenAI 兼容的音频转写与文本翻译请求、响应校验 |
| `src/providers/chat-stream.js` | SSE 解码、完整 JSON 字幕条目解析、结束与取消校验 |
| `src/configuration.js` | 独立服务配置、Key 更新规则、环境变量和旧设置迁移 |
| `src/captions/incremental-asr.js` | 音频分段、累计识别、稳定前缀与临时结果 |
| `src/captions/model-lane.js` | 单路模型调度，最终任务优先 |
| `src/captions/sentences.js`、`src/captions/cue-text.js` | 跨段句子、修订、短字幕及时间估算 |
| `src/storage/recording-store.js` | WAV、上传编号索引和重启恢复 |
| `src/storage/subtitle-store.js` | 定稿字幕、四种语言 SRT 和原子写入 |
| `src/storage/meeting-deletion.js` | 删除标记、关联文件清理和失败重试 |
| `public/` | 本地工作区、采音状态机、字幕渲染和只读观看页 |
| `src/audio/pcm.js` | PCM16 小端音频的音量计算 |
| `public/pcm-encoder.js`、`public/pcm-worklet.js` | 单声道混音、16 kHz 重采样和 PCM 编码 |
| `public/fonts/` | 直接引入的开源字体、各自许可和来源记录 |
| `test/` | 使用隔离存储和模拟模型的自动化测试 |

## 音频和模型调度

浏览器重采样先经过 Blackman 窗 sinc FIR 低通滤波，再按相位系数转换为 16 kHz。降采样截止频率为 7.2 kHz；滤波前视约 3 ms，时间位置使用整数计算以避免累计漂移。暂停和结束时排空滤波器及尾包，仅为整数毫秒时间轴补齐不足 1 ms 的静音。

浏览器每 200 ms 上传 PCM，后端按 100 ms 帧分析。分段保留约 300 ms 前置音频，约 700 ms 静音后结束，连续讲话最长约 12 秒，并在尾部较安静的位置寻找切点。

一段音频累计至少 1 秒后尝试临时识别，后续更新间隔至少 1 秒。每次发送当前段的累计 WAV，因此这是应用层增量识别，不依赖服务商原生流式接口。连续两次识别的一致前缀用于稳定临时文本；服务忙时可跳过中间轮次，最终识别优先，不丢弃最终音频。

翻译使用当前未定稿句子的完整文本和受限上下文，一次返回中、英、粤字幕。临时请求只保留最新版本；已定稿句子不被迟到的旧结果覆盖。音频段结束不等于句子完成，句子可跨停顿，长句拆为短字幕后按同一 ID 与时间轴修订。

英文小写识别结果按句末标点补齐自然句界，适度放宽完整英文句子的短字幕宽度。金额中的空格分组、货币符号和小数位作为同一单位保留，例如 `$12 500.50` 不会被切到两条。原文字符与偏移不改写。

翻译默认使用模型 SSE 流式响应，`eventsource-parser` 处理网络分帧，`@streamparser/json` 只在根 `cues` 数组内完整对象闭合后输出条目。三语字段齐全、编号及原文匹配的连续前缀可作为临时字幕显示，整份 JSON 与模型结束信号通过校验后才定稿。显式金额移入其他条目或带不同金额的条目返回同一组三语译文，会触发一次格式重试。

流式临时条目与已校验译文分开保存。失败、取消或过期结果不能晋升为定稿；撤回临时条目时，显示版本也递增，使电脑与手机都能移除失败尾部。识别原文版本与字幕显示版本分别维护，字幕时间使用对应翻译源的快照。服务重启时撤去未完成的流式临时结果，不重跑模型。

积压达到阈值时暂停采音，待排空后恢复；手动暂停、设备或配置故障阻止自动恢复。暂停和结束均需先停止采音、上传余量、排空识别翻译，再完成相应状态。前端结束需确认。

## 持久化与恢复

音频和幂等编号写入成功后才确认上传。录音包含采集期间的静音，按小时分卷为 WAV。JSON 会话记录保存识别、修订、字幕与状态；SRT 只写连续的定稿前缀，采用临时文件与原子替换。SRT 条目时间按音频和文本位置估算。

读取历史不重跑模型。服务重启修复已落盘的未完成音频尾部，异常中断会议保留已保存内容；尚未上传的浏览器内存音频无法恢复。删除先写只含会议 ID 和时间的标记，再移除本场文件，重启可继续完成中断的删除。

## 静态资源

音频采集使用项目内的 AudioWorklet 和 PCM 编码器，暂停或结束时先释放麦克风，再取出编码器尾部音频、完成上传。字幕由 `public/transcript.js` 按固定 ID 渲染和滚动。

字体从 Google Fonts 官方仓库直接引入，保留字体作者的 OFL 许可，浏览器从本机加载。具体文件见 [第三方许可](../NOTICE.md)。
