# SAGE Defend Practice: AI oral examiner

A practice tool for the Defend step of the SAGE Framework. Students upload their assignment and hold a short spoken conversation with **Sage**, a 3D AI examiner, who asks the teacher's base questions (rephrased around the student's own work) plus adaptive follow-ups. Students receive an indicative AI mark and feedback immediately and may practise again. Teachers review every attempt, including the transcript and an authenticity indicator.

Live at: `https://sage-framework.com/tools/oral-examiner/`

## Architecture

| Part | Where it runs | Technology |
|---|---|---|
| Teacher and student pages | GitHub Pages (this folder) | Plain HTML, CSS and JavaScript modules, no build step |
| Examiner character | Student's browser | TalkingHead (MIT) + three.js; CC0 MakeHuman avatar (`assets/examiner.glb`) |
| Examiner voice | Student's browser | Kokoro neural TTS via HeadTTS (MIT) on WebGPU devices, otherwise the browser's own voice |
| Speech recognition | Student's browser | Whisper base.en via transformers.js; audio never leaves the device |
| Questioning and marking | Cloudflare Worker (`/workers/oral-examiner`) | Claude or OpenAI API, key held only on the server |
| Storage | Cloudflare KV | Assessments and attempts; attempts expire after 180 days by default |

Until `apiBase` is set in `js/config.js`, the pages run in **demo mode**: data stays in the browser, the examiner follows a fixed script, and marks are simulated. Teacher key `demo`, access code `DEMO01`.

## Going live (about 15 minutes)

1. **Get an API key.** Create a key at console.anthropic.com (or platform.openai.com) and add a small amount of credit.
2. **Create a free Cloudflare account** at dash.cloudflare.com.
3. **Deploy the Worker** from a computer with Node.js:
   ```bash
   cd workers/oral-examiner
   npm install
   npx wrangler login
   npx wrangler kv namespace create ORAL_KV      # paste the printed id into wrangler.toml
   npx wrangler secret put LLM_API_KEY           # paste the API key
   npx wrangler secret put TEACHER_KEYS          # e.g.  Mahmoud Elkhodr:a-long-random-phrase
   npx wrangler deploy
   ```
   Wrangler prints the Worker URL, for example `https://sage-oral-examiner.example.workers.dev`.
4. **Connect the pages**: set `apiBase` in `tools/oral-examiner/js/config.js` to that URL and push.
5. **Check**: open `<worker URL>/api/health`; it should report `"configured": true`.

To use OpenAI instead of Claude, set `LLM_PROVIDER = "openai"` in `wrangler.toml` and redeploy.

## How the spoken interaction works

- **Turn-taking** (`js/vad.js`, `js/speech.js`, `js/mic-worklet.js`). The microphone is read in frames of about 30 ms through an audio worklet. The background noise of the room is measured during the microphone check and tracked throughout the session, so speech is detected relative to the room and not against a fixed level. The silence that ends an answer adapts between about 1.3 and 3.5 seconds: it is short after a long, fluent answer, longer when the student has only just begun, and longer again for a student who has already paused mid-answer and carried on. While a pause is running, "Still listening" is shown with a bar that fills until the answer is taken as finished. The "I'm done" button and the Enter key end an answer at once.
- **Latency**. When an answer ends, Sage nods and gives a short spoken acknowledgement immediately, and then looks aside while the reply is prepared. During the answer, the audio is passed to Whisper in segments at natural pauses, so little remains to transcribe at the end. With the neural voice, each sentence is played as soon as it has been synthesised. Set `spokenAcknowledgement: false` in `js/config.js` for a nod without the spoken acknowledgement.
- **Recorded timings**. Time to first speech is measured on the audio clock from the moment the microphone opens to the detected start of speech, including when the student presses "I'm done".
- **Browser-voice fallback**. Text is spoken one sentence at a time. Where the voice reports word boundaries, the lips follow them; otherwise word timings are estimated and corrected against the measured speaking rate of the voice.
- **Accessibility**. Steps move keyboard focus, the answer button keeps focus between turns, status changes are announced to screen readers without repeating Sage's spoken words, microphone errors state the cause and the remedy, and the system "reduce motion" setting is respected. The 3D rendering resolution and frame rate are reduced automatically on slow devices.

## Replacing the avatar

`assets/examiner.glb` is the MakeHuman/MPFB sample avatar distributed with TalkingHead (CC0), compressed with meshopt and WebP. A different outfit or character has to be prepared in Blender on a desktop computer; it cannot be built in the browser or in a cloud workspace, because the MakeHuman asset packs and the Mixamo rigging service are needed.

- **MakeHuman/MPFB (CC0)**: follow `blender/MPFB/MPFB.md` in the TalkingHead repository. Choose a business outfit (for example "female elegantsuit01" from the MakeHuman system assets), add the "Visemes 02" and "Faceunits 01" packs, use the TalkingHead rig and export to GLB.
- **Microsoft Rocketbox (MIT)**: use a "facial" business avatar, re-rig it in Mixamo and rename the shape keys with `blender/rename-rocketbox-shapekeys.py` from the TalkingHead repository.

Compress the export before committing it, and keep it under about 5 MB:

```bash
npx @gltf-transform/cli optimize avatar.glb examiner.glb --compress meshopt --texture-compress webp --texture-size 1024
```

`refineAppearance()` in `js/avatar.js` recolours the top and softens the brows, lashes and eyes by mesh name; review it when the model changes.

## Tests

```bash
node --test tools/oral-examiner/test/vad.test.mjs   # turn-taking logic
cd workers/oral-examiner && npm test                # Worker
```

## Cost controls

- Live turns use the fast, low-cost model (default Claude Haiku 5.5); planning and marking use the stronger model (default Claude Sonnet 5.5). Both can be changed with `LLM_MODEL_FAST` and `LLM_MODEL_SMART`.
- The submission is read once at the start and summarised, so later turns send only the summary.
- Sessions default to 5 minutes, with a hard cap on examiner turns.
- Attempts per student per day are set per assessment (default 3).
- `MAX_SESSIONS_PER_DAY` caps all sessions across the service (default 300).

## Privacy and integrity notes

- Students consent before starting. Audio is transcribed on the device; only text is sent to the AI provider.
- Student submissions are wrapped as data in every prompt so that instructions hidden in a submission are ignored.
- The authenticity indicator is shown to teachers only. Tab switches and typed answers are logged.
- Before use with real student work, institutional approval for the AI provider, data location and retention should be obtained.

## Licences

Code: CC BY 4.0, as for the SAGE Framework site. Third-party components keep their own licences: TalkingHead and HeadTTS (MIT, `vendor/`), three.js (MIT), transformers.js (Apache 2.0), Whisper (MIT), Kokoro-82M (Apache 2.0), MakeHuman/MPFB avatar (CC0), pdf.js (Apache 2.0), mammoth (BSD-2).
