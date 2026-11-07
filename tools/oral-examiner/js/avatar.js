// The examiner character: a 3D avatar (TalkingHead, MIT) with lip-sync.
// Voice: Kokoro neural TTS running in the browser via HeadTTS (MIT) when WebGPU
// is available, otherwise the browser's built-in speech synthesis.
import { TalkingHead } from "../vendor/talkinghead/talkinghead.mjs";
import { CONFIG } from "./config.js";


export class Examiner {
  constructor(container, { voice = "bf_emma" } = {}) {
    this.container = container;
    this.voice = voice;
    this.engine = "none";
    this.onWord = null;
  }

  async load(onProgress) {
    this.head = new TalkingHead(this.container, {
      ttsEndpoint: null,
      lipsyncModules: ["en"],
      lipsyncLang: "en",
      cameraView: "upper",
      cameraDistance: -0.35,
      cameraY: 0.05,
      cameraRotateEnable: false,
      cameraZoomEnable: false,
      cameraPanEnable: false,
      avatarIdleEyeContact: 0.6,
      avatarSpeakingEyeContact: 0.85,
      avatarIdleHeadMove: 0.4,
      lightAmbientIntensity: 2.2,
      lightDirectIntensity: 22,
      lightDirectColor: 0xfff2e0,
      modelFPS: 30,
      modelPixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    });
    await this.head.showAvatar(
      { url: CONFIG.avatarUrl, body: "F", avatarMood: "neutral", lipsyncLang: "en" },
      (ev) => {
        if (onProgress && ev.lengthComputable) onProgress(ev.loaded / ev.total);
      }
    );
    this.dressProfessionally();
  }

  // The open (CC0) MakeHuman model wears a printed T-shirt; give Sage a plain
  // forest-green top in the SAGE palette so the examiner looks professional.
  dressProfessionally() {
    try {
      this.head.armature.traverse((o) => {
        if (o.isMesh && /casualsuit|shirt|top/i.test(o.name)) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            m.map = null;
            m.color.set(0x1f3a30);
            m.roughness = 0.85;
            m.needsUpdate = true;
          }
        }
      });
    } catch (err) {
      console.warn(err);
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

  // Attentive listening: steady eye contact, with an occasional small nod
  // while the student is speaking (called from the voice-activity loop).
  listening() {
    try {
      this.head.makeEyeContact(60000);
    } catch (_) {}
  }
  nod() {
    const now = Date.now();
    if (now - (this.lastNod || 0) < 4500) return;
    this.lastNod = now;
    try {
      this.head.playGesture("yes", 1.2);
    } catch (_) {}
  }
  // Thinking: glance up and to the side while the next question is prepared.
  thinking() {
    try {
      const r = this.container.getBoundingClientRect();
      this.head.lookAt(r.left + r.width * 0.15, r.top + r.height * 0.05, 1800);
    } catch (_) {}
  }

  setMood(mood) {
    try {
      this.head.setMood(mood);
    } catch (_) {}
  }

  // Speaks the text with lip-sync and resolves when finished.
  async say(text) {
    if (!text) return;
    if (this.engine === "kokoro") {
      const messages = await this.tts.synthesize({ input: text });
      for (const m of messages) if (m.type === "audio") this.head.speakAudio(m.data, {}, this.onWord);
      await this.untilQuiet();
      return;
    }
    if (this.engine === "browser") return this.sayWithBrowser(text);
    // No audio engine: lip-sync over silence so the character still "speaks" the subtitle.
    this.head.speakAudio(estimateTiming(text, this.head.audioCtx, 1));
    await this.untilQuiet();
  }

  sayWithBrowser(text) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      if (this.browserVoice) u.voice = this.browserVoice;
      u.lang = this.browserVoice?.lang || "en-AU";
      u.rate = 1;
      let started = false;
      const finish = () => resolve();
      u.onstart = () => {
        started = true;
        this.head.speakAudio(estimateTiming(text, this.head.audioCtx, 1));
      };
      u.onend = finish;
      u.onerror = finish;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      // Safety net: some browsers never fire onend.
      setTimeout(() => {
        if (!started) this.head.speakAudio(estimateTiming(text, this.head.audioCtx, 1));
      }, 1200);
      setTimeout(finish, 1500 + text.split(/\s+/).length * 450);
    });
  }

  stop() {
    try {
      speechSynthesis.cancel();
    } catch (_) {}
    try {
      this.head.stopSpeaking();
    } catch (_) {}
  }

  untilQuiet() {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if ((!this.head.isSpeaking && Date.now() - t0 > 300) || Date.now() - t0 > 60000) resolve();
        else setTimeout(tick, 120);
      };
      tick();
    });
  }
}

// Approximate word timings for lip-sync when the audio engine gives none.
function estimateTiming(text, audioCtx, rate) {
  const words = text.split(/\s+/).filter(Boolean);
  const wtimes = [];
  const wdurations = [];
  let t = 0;
  for (const w of words) {
    const d = Math.max(180, w.replace(/[^a-z0-9]/gi, "").length * 62) / rate;
    wtimes.push(t);
    wdurations.push(d);
    t += d + (/[.,;:?!]$/.test(w) ? 260 : 60);
  }
  const sr = audioCtx.sampleRate || 44100;
  const audio = audioCtx.createBuffer(1, Math.max(1, Math.ceil(((t + 200) / 1000) * sr)), sr);
  return { audio, words, wtimes, wdurations };
}

function pickBrowserVoice() {
  return new Promise((resolve) => {
    const choose = () => {
      const vs = speechSynthesis.getVoices();
      const pref = ["en-AU", "en-GB", "en-US"];
      for (const lang of pref) {
        const female = vs.find((v) => v.lang === lang && /female|karen|catherine|serena|libby|sonia|natasha|samantha|zira|aria|jenny/i.test(v.name));
        if (female) return resolve(female);
      }
      resolve(vs.find((v) => v.lang?.startsWith("en")) || null);
    };
    if (speechSynthesis.getVoices().length) choose();
    else {
      speechSynthesis.onvoiceschanged = choose;
      setTimeout(choose, 1500);
    }
  });
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}
