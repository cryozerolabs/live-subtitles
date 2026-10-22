# Live Subtitles

[简体中文](README.md) · **English** · [繁體中文（香港）](README.zh-HK.md)

**Start live subtitles from one computer. Let your audience scan a QR code and follow in their own language.**

A CryoZeroLabs project · [Follow @cryozerolabs on X](https://x.com/cryozerolabs)

Great ideas deserve to cross language barriers.

When speakers and listeners use different languages, the audience needs to keep up while the speaker keeps the conversation moving. Live Subtitles brings original speech and live translations to the screen, sentence by sentence, so everyone can follow the same conversation on their phone.

From the room’s shared screen to each listener’s phone, from live subtitles to recordings and SRT files, the conversation becomes something people can follow, take away and use again.

<p>
  <img src="docs/assets/live-desktop.png" width="78%" alt="Desktop subtitles for a community talk, showing English speech and Chinese translations sentence by sentence, alongside a QR code for phone viewing">
  <img src="docs/assets/live-mobile.png" width="20%" alt="Phone view of the same talk, with Cantonese selected alongside the original English speech">
</p>

*One conversation, on the shared screen and on your phone. Each listener chooses their language. Screens show example content.*

## Keep the conversation moving across languages

The speaker has moved on, but a listener may still be working through the last sentence. Miss one detail and the context, questions and decisions that follow become harder to understand. Listening to a recording later can recover the words, but the chance to ask a question or clarify a point in the room has already passed.

Live Subtitles gives the conversation a continuous text companion. Original text preserves what was said; translations help listeners understand it. Sentences scroll upward as the speaker continues, letting people compare the two, revisit the context and return to the latest words while the discussion is still happening.

Bring subtitles to technical talks, community events and multilingual meetings, so people who speak different languages can take part in the same discussion.

## One event, two ways to follow

| The organiser’s computer | The audience’s phones |
| --- | --- |
| Show original text and a selected translation; connect a projector or shared display for the room | Scan the meeting’s QR code to open the viewing page in a browser |
| Start the microphone manually, then pause, resume or end as the event progresses | Switch directly between Chinese, English and Cantonese |
| Follow sentence pairs as they scroll upward, with provisional text revised in place | Choose a language independently, revisit earlier text or jump back to the latest sentence |

The organiser sets up the meeting; listeners follow on their own screens. Connect phones and the computer to the same local network, then scan the QR code to join.

## Keep using the content after the event

When the meeting ends, the conversation becomes material you can work with.

- **Revisit the discussion:** browse meeting history with original text and translations side by side, preserving the wording and its context.
- **Take the material with you:** download a meeting bundle containing the WAV recording and four SRT files: original text, Chinese, English and Cantonese.
- **Create what comes next:** use the recording and subtitles for reviews, editing and caption production, turning one talk into more useful content.

Meeting records, recordings and subtitles are stored on the computer running the service. Browse, download or delete them from meeting history.

## Your models, your meeting

Live Subtitles connects to speech recognition and text translation services through OpenAI-compatible APIs. Choose a model for each task, or share one service connection, to suit your languages, events and workflow.

The current version supports Chinese, English and Cantonese. To add other languages, adapt the translation prompts, language options and subtitle outputs, and choose models that support your target languages.

Configure the **Base URL, API Key and model** for each service in Settings. Translation can also reuse the speech recognition service’s address and key. Keys are managed by the local backend, with service settings stored separately from meeting content. Change models while keeping the same subtitle experience.

## Bring it to your next event

Prepare Node.js 20+, a modern browser with microphone and AudioWorklet support, and speech recognition and text translation services. Download the source, open the project directory and run:

```sh
npm ci
npm start
```

Open **[localhost:8090](http://localhost:8090)** and:

1. Open Settings and enter the Base URL, API Key and model for speech recognition and translation.
2. Create a meeting, give it a name and open the subtitle page.
3. Start the microphone and allow microphone access. Pause or resume as needed.
4. Ask listeners to join the same Wi-Fi, scan the QR code and choose their subtitle language.
5. When the event ends, confirm to finish and save. Revisit the meeting or download the recording and SRT files from history.

## Documentation and open source

Technical documentation in Simplified Chinese: [Service configuration](docs/configuration.md) · [Architecture](docs/architecture.md) · [API reference](docs/api.md)

Live Subtitles is released under the MIT licence. Use it at your events, and build on it for the conversations you want to bring together.

[MIT licence](LICENSE) · [Third-party licences](NOTICE.md)
