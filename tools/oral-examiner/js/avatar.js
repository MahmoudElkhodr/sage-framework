// The examiner character: a 3D avatar (TalkingHead, MIT) with lip-sync.
// Voice: Kokoro neural TTS running in the browser via HeadTTS (MIT) when WebGPU
// is available, otherwise the browser's built-in speech synthesis.
//
// Sage has four behaviours, driven from the practice flow:
//   idle       calm, seated-examiner posture with a faint smile
//   listening  steady eye contact, a slight attentive lean, small nods at pauses
//   thinking   gaze turned aside, as a person does while composing a reply
//   speaking   eye contact with natural head movement and lip-sync
import { TalkingHead } from "../vendor/talkinghead/talkinghead.mjs";
import { CONFIG } from "./config.js";

const REDUCED_MOTION = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const ACK_NEURAL = ["Mhm.", "Okay.", "Right."];
const ACK_BROWSER = ["Okay.", "Right.", "I see."];

export class Examiner {
  constructor(container, { voice = "bf_emma" } = {}) {
    this.container = container;
    this.voice = voice;
    this.engine = "none";
    this.onWord = null;
    this.acks = [];
    this.boundary = null; // whether the browser voice reports word boundaries (unknown at first)
    this.rateScale = 1; // learned ratio of real to estimated speaking time for the browser voice
    this.thinkTimer = null;
    this.ackUntil = 0;
    this.browserSpeaking = false;
  }

  async load(onProgress) {
    const dpr = window.devicePixelRatio || 1;
    // TalkingHead multiplies this by the device pixel ratio, so pass a ratio
    // that caps the real rendering scale at 2 (and lower on weak devices).
    this.scale = Math.min(dpr, 2);
    this.head = new TalkingHead(this.container, {
      ttsEndpoint: null,
      lipsyncModules: ["en"],
      lipsyncLang: "en",
      cameraView: "head",
      cameraDistance: 1.1, // head and shoulders, as across a desk
      cameraY: 0.6,
      cameraRotateEnable: false,
      cameraZoomEnable: false,
      cameraPanEnable: false,
      avatarIdleEyeContact: 0.7,
      avatarSpeakingEyeContact: 0.85,
      avatarIdleHeadMove: REDUCED_MOTION ? 0 : 0.3,
      avatarSpeakingHeadMove: REDUCED_MOTION ? 0.1 : 0.5,
      // Three-point lighting: a warm key light from the window side in front of
      // Sage, low ambient fill, and a cool rim light from behind the opposite
      // shoulder so the figure separates from the backdrop.
      lightAmbientColor: 0xfff6ea,
      lightAmbientIntensity: 0.5,
      lightDirectColor: 0xfff0dc,
      lightDirectIntensity: 2.6,
      lightDirectPhi: 1.1,
      lightDirectTheta: 0.7,
      lightSpotColor: 0xcfe0ff,
      lightSpotIntensity: 14,
      lightSpotPhi: 0.9,
      lightSpotTheta: 3.9,
      lightSpotDispersion: 1.2,
      modelFPS: 30,
      modelPixelRatio: this.scale / dpr,
      update: (dt) => this.watchPerformance(dt),
    });
    // TalkingHead also lights the scene with a bright studio environment map,
    // which washed the face out; keep a little of it for soft reflections only.
    if (this.head.scene) this.head.scene.environmentIntensity = 0.35;
    this.defineBehaviours();
    await this.head.showAvatar(
      { url: CONFIG.avatarUrl, body: "F", avatarMood: "sage", lipsyncLang: "en" },
      (ev) => {
        if (onProgress && ev.lengthComputable) onProgress(ev.loaded / ev.total);
      }
    );
    this.refineAppearance();
    this.idle();
  }

  // Custom moods built on TalkingHead's neutral mood. The stock idle cycles
  // through standing poses (hand on hip, weight on one leg) and wide body
  // turns, which suit a presenter but not an examiner across a desk.
  defineBehaviours() {
    const h = this.head;
    const base = h.animMoods.neutral;
    const keep = (name) => base.anims.find((a) => a.name === name);
    const k = REDUCED_MOTION ? 0.4 : 1;
    const pose = { name: "pose", alt: [{ delay: [30000, 90000], vs: { pose: ["straight"] } }] };
    const sway = (x, y, z, dt) => ({
      name: "head",
      idle: { delay: [0, 1000], dt: [dt], vs: { bodyRotateX: [x.map((v) => v * k)], bodyRotateY: [y.map((v) => v * k)], bodyRotateZ: [z.map((v) => v * k)] } },
      speaking: { dt: [[0, 1000, 0]], vs: { bodyRotateX: [[-0.04 * k, 0.12 * k, 1, 2]], bodyRotateY: [[-0.07 * k, 0.07 * k]], bodyRotateZ: [[-0.06 * k, 0.06 * k]] } },
    });
    const face = { name: "misc", delay: [500, 6000], dt: [[200, 600], [1500, 5000, 2]], vs: { eyeSquintLeft: [[0, 0.2, 2]], eyeSquintRight: [[0, 0.2, 2]], browInnerUp: [[0, 0.2, 2]], browOuterUpLeft: [[0, 0.15, 2]], browOuterUpRight: [[0, 0.15, 2]] } };
    // Gaze: mostly on the student, with short, small glances away. The stock
    // idle gaze looks away for several seconds at wide angles, which reads as inattention.
    const gaze = (contact, hold, spread) => ({
      name: "eyes",
      idle: { alt: [
        { p: contact, delay: [0, 300], dt: [0, hold], vs: { eyeContact: [1], headMove: [REDUCED_MOTION ? 0 : 0.3] } },
        { delay: [0, 300], dt: [[150, 260], [500, 1300]], vs: { eyesRotateY: [[-spread, spread]], eyesRotateX: [[-0.05, 0.2]] } },
      ] },
      speaking: h.animTemplateEyes.speaking,
    });
    const mood = (baseline, head, eyes) => ({
      baseline,
      speech: base.speech,
      anims: [keep("breathing"), pose, head, eyes, h.animTemplateBlink, face].filter(Boolean),
    });
    h.animMoods.sage = mood({ eyesLookDown: 0.05, mouthSmileLeft: 0.12, mouthSmileRight: 0.12 }, sway([-0.02, 0.06], [-0.08, 0.08], [-0.03, 0.03], [600, 5000]), gaze(0.75, [3000, 7000], 0.35));
    h.animMoods.sagelistening = mood(
      { eyesLookDown: 0.03, mouthSmileLeft: 0.16, mouthSmileRight: 0.16, browInnerUp: 0.1, eyeWideLeft: 0.05, eyeWideRight: 0.05 },
      sway([0.03, 0.08], [-0.04, 0.04], [-0.05, 0.05], [2000, 7000]),
      gaze(0.9, [4000, 9000], 0.22)
    );
    h.animMoods.sagethinking = mood(
      { mouthPressLeft: 0.1, mouthPressRight: 0.1, mouthSmileLeft: 0.06, mouthSmileRight: 0.06, browDownLeft: 0.06, browDownRight: 0.06, eyeSquintLeft: 0.08, eyeSquintRight: 0.08 },
      sway([-0.05, 0.0], [-0.05, 0.05], [-0.04, 0.04], [800, 3000]),
      gaze(0.15, [800, 1500], 0.4)
    );
  }

  // The open (CC0) MakeHuman model wears a printed T-shirt, and its brows and
  // lashes are fine strand geometry in pure black, which looks harsh. Give Sage
  // a plain top in the SAGE palette and soften the hair, brows and eyes in code
  // rather than shipping new assets.
  refineAppearance() {
    try {
      const canvas = this.container.querySelector("canvas");
      if (canvas) canvas.setAttribute("aria-hidden", "true");
      this.head.armature.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (/casualsuit|shirt|top/i.test(o.name)) {
            m.map = null;
            m.color.set(0x1d3a31);
            m.roughness = 0.9;
            m.metalness = 0;
          } else if (/eyebrow/i.test(o.name)) {
            m.color.set(0x3b2a20);
            m.roughness = 1;
          } else if (/eyelash/i.test(o.name)) {
            m.color.set(0x2a1d16);
            m.roughness = 1;
          } else if (/ponytail|hair/i.test(o.name)) {
            m.alphaToCoverage = true; // smoother hair edges where multisampling is available
          } else if (/high-poly|eye/i.test(o.name)) {
            m.color.set(0xd3ddd8); // the iris texture is slightly red under warm light
          } else if (/body|skin/i.test(m.name || "")) {
            m.roughness = 0.62;
          }
          m.needsUpdate = true;
        }
      });
    } catch (err) {
      console.warn(err);
    }
  }

  // Lowers the rendering resolution, then the frame rate, on devices that
  // cannot keep up, so speech and the rest of the page stay responsive.
  watchPerformance(dt) {
    if (this.perfDone || !this.head?.renderer) return;
    this.perfN = (this.perfN || 0) + 1;
    if (this.perfN <= 30) return; // ignore start-up frames
    this.perfSum = (this.perfSum || 0) + dt;
    if (this.perfN < 120) return;
    const avg = this.perfSum / (this.perfN - 30);
    this.perfN = 0;
    this.perfSum = 0;
    if (avg < 55) {
      this.perfDone = true;
    } else if (this.scale > 0.75) {
      this.scale = Math.max(0.75, this.scale * 0.7);
      this.head.renderer.setPixelRatio(this.scale);
      this.head.onResize();
    } else {
      this.head.opt.modelFPS = 20;
      this.head.animFrameDur = 1000 / 20;
      this.perfDone = true;
    }
  }

  // Must be called from a user gesture (a click) because of browser audio rules.
  async unlockAudio() {
    try {
      await this.head.audioCtx.resume();
    } catch (_) {}
    if (this.engine === "browser") {
      // Prime speech synthesis inside the gesture so later utterances are allowed.
      try {
        speechSynthesis.speak(new SpeechSynthesisUtterance(" "));
      } catch (_) {}
    }
  }

  // Loads the neural voice if the device supports it; can run before any gesture.
  async prepareVoice(onStatus = () => {}) {
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
    if (adapter) {
      try {
        onStatus("Loading the examiner's voice (first time only, about 1 minute)...");
        const { HeadTTS } = await import("../vendor/headtts/modules/headtts.mjs");
        this.tts = new HeadTTS({
          endpoints: ["webgpu"],
          audioCtx: this.head.audioCtx,
          languages: ["en-us"],
          voices: [this.voice],
          defaultVoice: this.voice,
        });
        const progress = (ev) => {
          if (ev && ev.lengthComputable) onStatus(`Loading the examiner's voice: ${Math.round((ev.loaded / ev.total) * 100)}%`);
        };
        await withTimeout(this.tts.connect(null, progress), 240000);
        this.tts.setup({ voice: this.voice, language: "en-us", speed: 1, audioEncoding: "wav" });
        this.engine = "kokoro";
        this.warmAcknowledgements();
        return this.engine;
      } catch (err) {
        console.warn("Neural voice unavailable, using browser voice.", err);
      }
    }
    if ("speechSynthesis" in window) {
      this.engine = "browser";
      this.browserVoice = await pickBrowserVoice();
      return this.engine;
    }
    this.engine = "none";
    return this.engine;
  }

  // Synthesises the short acknowledgements once, in the background, so they
  // can be played the instant an answer ends. This also warms the voice model,
  // which makes Sage's first sentence start sooner.
  async warmAcknowledgements() {
    for (const word of ACK_NEURAL) {
      try {
        const messages = await this.tts.synthesize({ input: word });
        const m = (messages || []).find((x) => x && x.type === "audio");
        if (m) this.acks.push(m.data);
      } catch (_) {}
    }
  }

  get isSpeaking() {
    return Boolean(this.head?.isSpeaking || this.browserSpeaking || Date.now() < this.ackUntil);
  }

  // ---------------------------------------------------------------- behaviour
  setMood(mood) {
    try {
      if (this.head.moodName !== mood) this.head.setMood(mood);
    } catch (_) {}
  }
  clearGaze() {
    clearTimeout(this.thinkTimer);
    this.thinkTimer = null;
    try {
      this.head.animQueue = this.head.animQueue.filter((x) => x.template.name !== "eyecontact" && x.template.name !== "lookat");
    } catch (_) {}
  }

  idle() {
    this.clearGaze();
    this.setMood("sage");
    this.head.opt.avatarIdleEyeContact = 0.7;
  }

  // Attentive listening: steady eye contact and a slight lean towards the student.
  listening() {
    this.clearGaze();
    this.setMood("sagelistening");
    this.head.opt.avatarIdleEyeContact = 0.95;
    try {
      this.head.makeEyeContact(8000);
    } catch (_) {}
  }

  // A small nod while the student is speaking, as a listener does at a pause.
  backchannel() {
    if (REDUCED_MOTION) return;
    const now = Date.now();
    if (now - (this.lastNod || 0) < 5000) return;
    this.lastNod = now;
    this.nod(0.07, 1);
  }

  nod(depth = 0.12, dips = 2) {
    try {
      const h = this.head;
      const dt = [], x = [];
      for (let i = 0; i < dips; i++) {
        dt.push([170, 240], [170, 260]);
        x.push(depth * (i ? 0.7 : 1), 0.01);
      }
      dt.push([150, 250]);
      x.push(0);
      h.animQueue.push(h.animFactory({ name: "nod", dt, vs: { headMove: [0], headRotateX: x } }));
    } catch (_) {}
  }

  // The answer has been received: nod at once and, if the student spoke, give
  // a brief spoken acknowledgement while transcription and the AI call run.
  acknowledge({ spoken = true } = {}) {
    this.lastNod = Date.now();
    this.nod(REDUCED_MOTION ? 0.06 : 0.13, 2);
    if (!spoken || CONFIG.spokenAcknowledgement === false) return;
    try {
      if (this.engine === "kokoro" && this.acks.length) {
        const a = this.acks[Math.floor(Math.random() * this.acks.length)];
        this.ackUntil = Date.now() + (a.audio?.duration || 0.6) * 1000 + 250;
        this.head.speakAudio(a, { isRaw: false });
      } else if (this.engine === "browser") {
        const word = ACK_BROWSER[Math.floor(Math.random() * ACK_BROWSER.length)];
        this.ackUntil = Date.now() + 1100;
        this.speakOne(word, { ack: true }).catch(() => {});
      }
    } catch (_) {}
  }

  // Thinking: look away while the reply is prepared, glancing back now and then.
  thinking() {
    this.clearGaze();
    this.setMood("sagethinking");
    this.head.opt.avatarIdleEyeContact = 0.15;
    let side = Math.random() < 0.5 ? -1 : 1;
    const glance = () => {
      try {
        const r = this.container.getBoundingClientRect();
        const eyes = this.eyesOnScreen(r);
        const ms = 1500 + Math.random() * 1500;
        // Up and to one side, by a modest angle, as people do when composing a reply.
        this.head.lookAt(eyes.x + side * r.width * (0.09 + Math.random() * 0.06), eyes.y - r.height * (0.03 + Math.random() * 0.06), ms);
        if (Math.random() < 0.3) side = -side;
        this.thinkTimer = setTimeout(glance, ms + 400 + Math.random() * 900);
      } catch (_) {}
    };
    this.thinkTimer = setTimeout(glance, 450); // after the acknowledging nod
  }

  // Where Sage's eyes are in the viewport (falls back to an estimate).
  eyesOnScreen(r) {
    try {
      const h = this.head;
      const v = h.camera.position.clone().setFromMatrixPosition(h.objectLeftEye.matrixWorld);
      const w = h.camera.position.clone().setFromMatrixPosition(h.objectRightEye.matrixWorld);
      v.add(w).multiplyScalar(0.5).project(h.camera);
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    } catch (_) {
      return { x: r.left + r.width / 2, y: r.top + r.height * 0.42 };
    }
  }

  // A warmer expression for a few seconds, used for the greeting and the close.
  smile(ms = 3500) {
    try {
      const h = this.head;
      h.animQueue.push(h.animFactory({ name: "smile", dt: [500, ms, 1200], vs: { mouthSmileLeft: [0.35, 0.35, 0], mouthSmileRight: [0.35, 0.35, 0], cheekSquintLeft: [0.25, 0.25, 0], cheekSquintRight: [0.25, 0.25, 0], browInnerUp: [0.15, 0.15, 0] } }));
    } catch (_) {}
  }

  // ---------------------------------------------------------------- speech
  // Speaks the text with lip-sync and resolves when finished.
  async say(text, { warm = false } = {}) {
    if (!text) return;
    this.stopped = false;
    this.clearGaze();
    this.setMood("sage");
    this.head.opt.avatarIdleEyeContact = 0.7;
    if (warm) this.smile(Math.min(6000, 1200 + text.length * 30));
    if (this.engine === "kokoro") {
      let spoke = false;
      try {
        // Each sentence is queued for playback as soon as it is ready, so Sage
        // starts speaking while the rest of the reply is still being synthesised.
        await this.tts.synthesize({ input: text }, (m) => {
          if (m && m.type === "audio" && !this.stopped) {
            spoke = true;
            this.head.speakAudio(m.data, {}, this.onWord);
          }
        });
      } catch (err) {
        console.warn("Neural voice failed for this reply.", err);
      }
      if (spoke) return this.untilQuiet();
      if (!("speechSynthesis" in window)) return this.sayAsSubtitle(text);
      if (!this.browserVoice) this.browserVoice = await pickBrowserVoice();
      return this.sayWithBrowser(text);
    }
    if (this.engine === "browser") return this.sayWithBrowser(text);
    return this.sayAsSubtitle(text);
  }

  // No audio engine: lip-sync over silence so the character still "speaks" the subtitle.
  async sayAsSubtitle(text) {
    this.head.speakAudio(estimateTiming(text, this.head.audioCtx, 1));
    await this.untilQuiet();
  }

  // Browser voice. The text is spoken one sentence at a time: each sentence
  // gives a fresh synchronisation point for the lips, and short utterances
  // avoid the cut-off that some browsers apply to long ones.
  async sayWithBrowser(text) {
    const wait = this.ackUntil - Date.now();
    if (wait > 0) await sleep(Math.min(wait, 1500));
    try {
      speechSynthesis.cancel(); // clears a stuck queue, a known browser fault
    } catch (_) {}
    for (const sentence of splitSentences(text)) {
      if (this.stopped) break;
      await this.speakOne(sentence);
    }
    this.setBrowserSpeaking(false);
  }

  setBrowserSpeaking(on) {
    this.browserSpeaking = on;
    try {
      this.head.stateName = on ? "speaking" : "idle";
      this.head.isSpeaking = on;
      if (!on) this.head.resetLips();
    } catch (_) {}
  }

  speakOne(sentence, { ack = false } = {}) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(sentence);
      if (this.browserVoice) u.voice = this.browserVoice;
      u.lang = this.browserVoice?.lang || "en-AU";
      u.rate = 1;
      const words = wordsOf(sentence);
      const est = estimateWords(words);
      let started = false, finished = false, t0 = 0, sawBoundary = false, lastK = -1;
      const timers = [];
      const scheduleRest = (elapsed) => {
        for (let k = lastK + 1; k < words.length; k++) {
          const at = est.starts[k] * this.rateScale - elapsed;
          if (at + est.durs[k] * this.rateScale > 0) this.mouthWord(words[k].w, Math.max(0, at), est.durs[k] * this.rateScale);
        }
      };
      const begin = () => {
        if (started || finished) return;
        started = true;
        t0 = performance.now();
        this.setBrowserSpeaking(true);
        if (this.boundary === false) scheduleRest(0);
        else if (this.boundary === null) {
          // Unknown voice: give it a moment to report a word boundary, then fall back to estimates.
          timers.push(setTimeout(() => {
            if (!sawBoundary && !finished) {
              this.boundary = false;
              scheduleRest(performance.now() - t0);
            }
          }, 280));
        }
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        timers.forEach(clearTimeout);
        if (started && !sawBoundary && words.length >= 4) {
          // Learn how fast this voice really speaks, for better estimates next time.
          const ratio = (performance.now() - t0) / Math.max(300, est.total);
          if (ratio > 0.4 && ratio < 2.5) this.rateScale = clamp(this.rateScale * 0.5 + ratio * 0.5, 0.6, 1.8);
        }
        if (ack) this.setBrowserSpeaking(false);
        resolve();
      };
      u.onstart = begin;
      u.onboundary = (e) => {
        if (e.name && e.name !== "word") return;
        if (!started) begin();
        sawBoundary = true;
        this.boundary = true;
        let k = words.findIndex((w) => e.charIndex >= w.i && e.charIndex < w.i + w.w.length);
        if (k < 0) k = words.findIndex((w) => w.i >= e.charIndex);
        if (k < 0 || k <= lastK) return;
        lastK = k;
        this.mouthWord(words[k].w, 0, est.durs[k] * this.rateScale);
      };
      u.onend = finish;
      u.onerror = finish;
      try {
        speechSynthesis.speak(u);
      } catch (_) {
        return finish();
      }
      // Safety nets: some browsers never fire onstart or onend.
      timers.push(setTimeout(begin, 1200));
      timers.push(setTimeout(finish, 2500 + est.total * 2));
    });
  }

  // Moves the mouth for one word, starting delayMs from now and lasting about durMs.
  mouthWord(word, delayMs, durMs) {
    try {
      const h = this.head;
      const val = h.lipsyncWordsToVisemes(h.lipsyncPreProcessText(word, "en"), "en");
      const n = val?.visemes?.length || 0;
      if (!n) return;
      const total = val.times[n - 1] + val.durations[n - 1];
      const dur = Math.min(durMs, n * 190);
      for (let j = 0; j < n; j++) {
        const t = h.animClock + delayMs + (val.times[j] / total) * dur;
        const d = (val.durations[j] / total) * dur;
        const v = val.visemes[j];
        h.animQueue.push({
          template: { name: "viseme" },
          ts: [t - Math.min(60, (2 * d) / 3), t + d / 2, t + d + d / 2],
          vs: { ["viseme_" + v]: [null, v === "PP" || v === "FF" ? 0.9 : 0.6, 0] },
        });
      }
    } catch (_) {}
  }

  stop() {
    this.stopped = true;
    this.clearGaze();
    try {
      speechSynthesis.cancel();
    } catch (_) {}
    try {
      this.head.stopSpeaking();
    } catch (_) {}
    this.browserSpeaking = false;
  }

  untilQuiet() {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const quiet = !this.head.isSpeaking && !this.head.speechQueue?.length;
        if ((quiet && Date.now() - t0 > 300) || this.stopped || Date.now() - t0 > 90000) resolve();
        else setTimeout(tick, 100);
      };
      tick();
    });
  }
}

// ------------------------------------------------------------------ helpers
function splitSentences(text) {
  const parts = String(text).match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [String(text)];
  // Join very short fragments (such as "Thank you.") to the next sentence so the voice does not sound clipped.
  const out = [];
  for (const p of parts) {
    if (out.length && out[out.length - 1].trim().split(/\s+/).length < 3) out[out.length - 1] += p;
    else out.push(p);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

function wordsOf(sentence) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(sentence))) out.push({ w: m[0], i: m.index });
  return out;
}

// Approximate word timings (milliseconds) for lip-sync when the voice gives none.
function estimateWords(words) {
  const starts = [], durs = [];
  let t = 0;
  for (const { w } of words) {
    const d = Math.max(170, w.replace(/[^a-z0-9]/gi, "").length * 62);
    starts.push(t);
    durs.push(d);
    t += d + (/[.,;:?!]$/.test(w) ? 260 : 55);
  }
  return { starts, durs, total: t };
}

function estimateTiming(text, audioCtx, rate) {
  const ws = wordsOf(text);
  const est = estimateWords(ws);
  const sr = audioCtx.sampleRate || 44100;
  const audio = audioCtx.createBuffer(1, Math.max(1, Math.ceil(((est.total / rate + 200) / 1000) * sr)), sr);
  return { audio, words: ws.map((x) => x.w), wtimes: est.starts.map((x) => x / rate), wdurations: est.durs.map((x) => x / rate) };
}

function pickBrowserVoice() {
  return new Promise((resolve) => {
    let done = false;
    const choose = () => {
      if (done) return;
      const vs = speechSynthesis.getVoices();
      if (!vs.length) return;
      done = true;
      const female = /female|karen|catherine|serena|libby|sonia|natasha|samantha|zira|aria|jenny|hazel|susan|moira|tessa|fiona|emma|olivia|maisie/i;
      const male = /\bmale\b|david|mark|james|daniel|george|ryan|william|\bguy\b|\blee\b|rishi|oliver|thomas|aaron|arthur|fred|gordon|darren|duncan|liam|noah/i;
      // Sage is female, so the voice must match first; then prefer natural-sounding
      // voices, then Australian and British English.
      const score = (v) =>
        (female.test(v.name) ? 9 : male.test(v.name) ? -9 : 0) +
        (/natural|neural|enhanced|premium|online/i.test(v.name) ? 6 : 0) +
        (v.lang === "en-AU" ? 4 : v.lang === "en-GB" ? 3 : v.lang?.startsWith("en") ? 2 : -100) +
        (v.localService ? 1 : 0);
      const best = vs.filter((v) => v.lang?.startsWith("en")).sort((a, b) => score(b) - score(a))[0];
      resolve(best || null);
    };
    choose();
    if (!done) {
      speechSynthesis.addEventListener?.("voiceschanged", choose);
      setTimeout(() => {
        choose();
        if (!done) {
          done = true;
          resolve(null);
        }
      }, 1500);
    }
  });
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}
