// Microphone capture, voice-activity frames and transcription.
// Primary: Whisper in a Web Worker (private, on-device).
// Fallback: the browser's own speech recognition (Chrome and Edge send audio to their vendor).
import { resampleLinear } from "./vad.js";

const TARGET_RATE = 16000; // Whisper expects 16 kHz mono

// Turns a getUserMedia failure into a message the student can act on.
export function micErrorMessage(err) {
  const name = err?.name || "";
  if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
    return "This browser cannot use the microphone on this page. Please open the page in a current version of Chrome, Edge, Safari or Firefox.";
  }
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return "Microphone access is blocked. Select the padlock or site-settings icon beside the address bar, allow the microphone for this site, and then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") {
    return "No microphone was found. Please connect a microphone or headset and try again.";
  }
  if (name === "NotReadableError" || name === "AbortError" || name === "TrackStartError") {
    return "The microphone could not be started. It may be in use by another application (such as Zoom or Teams). Please close that application and try again.";
  }
  return "The microphone could not be opened. Please check that a microphone is connected and allowed for this site, and then try again.";
}

export class Recorder {
  constructor() {
    this.onFrame = null; // (rms, tMs) for every frame while the microphone is open
    this.onLost = null; // the microphone was unplugged or stopped by the system
    this.capturing = false;
    this.chunks = [];
    this.samplesSeen = 0;
    this.rms = 0;
  }

  async open() {
    this.close();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.rate = this.ctx.sampleRate;
    this.samplesSeen = 0;
    const src = this.ctx.createMediaStreamSource(this.stream);
    const frameSize = Math.max(128, Math.round((this.rate * 0.03) / 128) * 128); // about 30 ms
    const sink = this.ctx.createGain();
    sink.gain.value = 0; // keeps the graph running without playing the microphone back
    sink.connect(this.ctx.destination);
    try {
      await this.ctx.audioWorklet.addModule(new URL("./mic-worklet.js", import.meta.url));
      this.node = new AudioWorkletNode(this.ctx, "mic-frames", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, processorOptions: { frameSize } });
      this.node.port.onmessage = (e) => this.handleFrame(e.data);
    } catch (err) {
      // Older browsers without AudioWorklet.
      const size = [256, 512, 1024, 2048].find((s) => s >= frameSize) || 2048;
      this.node = this.ctx.createScriptProcessor(size, 1, 1);
      this.node.onaudioprocess = (e) => this.handleFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
    }
    src.connect(this.node);
    this.node.connect(sink);
    const track = this.stream.getAudioTracks()[0];
    if (track) track.onended = () => this.onLost?.();
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
  }

  get isOpen() {
    return Boolean(this.stream && this.stream.getAudioTracks().some((t) => t.readyState === "live"));
  }

  // Audio-clock time in milliseconds since the microphone was opened.
  now() {
    return (this.samplesSeen / (this.rate || 48000)) * 1000;
  }

  // Browsers suspend audio in background tabs; call this when the page returns.
  resume() {
    if (this.ctx?.state === "suspended") this.ctx.resume().catch(() => {});
  }

  handleFrame(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    this.rms = Math.sqrt(sum / frame.length);
    const t0 = this.now();
    this.samplesSeen += frame.length;
    if (this.capturing) this.chunks.push({ t0, data: frame });
    this.onFrame?.(this.rms, this.now());
  }

  // Latest raw level (RMS, 0..1).
  level() {
    return this.rms;
  }

  // Begin keeping audio for transcription.
  start() {
    this.chunks = [];
    this.capturing = true;
  }

  // Discard audio captured before tMs (for example the wait before the student begins).
  trimStart(tMs) {
    let i = 0;
    while (i < this.chunks.length && this.chunks[i].t0 + this.frameMs(this.chunks[i]) <= tMs) i++;
    if (i) this.chunks.splice(0, i);
  }

  frameMs(c) {
    return (c.data.length / this.rate) * 1000;
  }

  // Remove and return (as 16 kHz samples) everything captured up to tMs; capture continues.
  async take(tMs = Infinity) {
    let i = 0;
    while (i < this.chunks.length && this.chunks[i].t0 < tMs) i++;
    const part = this.chunks.splice(0, i);
    return this.to16k(part);
  }

  // Stop capturing and return what is left, up to tMs.
  async stop(tMs = Infinity) {
    this.capturing = false;
    const out = await this.take(tMs);
    this.chunks = [];
    return out;
  }

  async to16k(part) {
    const n = part.reduce((a, c) => a + c.data.length, 0);
    if (!n) return new Float32Array(0);
    const joined = new Float32Array(n);
    let o = 0;
    for (const c of part) {
      joined.set(c.data, o);
      o += c.data.length;
    }
    if (this.rate === TARGET_RATE) return joined;
    try {
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const off = new OAC(1, Math.max(1, Math.ceil((n * TARGET_RATE) / this.rate)), TARGET_RATE);
      const buf = off.createBuffer(1, n, this.rate);
      buf.getChannelData(0).set(joined);
      const s = off.createBufferSource();
      s.buffer = buf;
      s.connect(off.destination);
      s.start();
      const rendered = await off.startRendering();
      return rendered.getChannelData(0);
    } catch (_) {
      return resampleLinear(joined, this.rate, TARGET_RATE);
    }
  }

  close() {
    this.capturing = false;
    try {
      this.node?.disconnect();
    } catch (_) {}
    this.stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    this.ctx?.close().catch(() => {});
    this.stream = this.ctx = this.node = null;
  }
}

export class Transcriber {
  constructor() {
    this.worker = new Worker(new URL("./stt-worker.js", import.meta.url), { type: "module" });
    this.pending = new Map();
    this.seq = 0;
    this.onProgress = null;
    this.queue = Promise.resolve(); // one transcription at a time, in order
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") return this.onProgress?.(m);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.type === "error" ? p.reject(new Error(m.error)) : p.resolve(m);
    };
    // A failed module import inside the worker surfaces here, not as a message.
    this.worker.onerror = (e) => {
      e.preventDefault?.();
      for (const p of this.pending.values()) p.reject(new Error(e.message || "Speech recognition failed to load."));
      this.pending.clear();
    };
  }

  send(msg, transfer) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer || []);
    });
  }

  load(timeoutMs = 300000) {
    return Promise.race([
      this.send({ type: "load", webgpu: Boolean(navigator.gpu) }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Speech recognition took too long to load.")), timeoutMs)),
    ]);
  }

  // Transcribes 16 kHz samples. Calls are queued so that segments of one answer
  // are processed in order and never overlap inside the model.
  transcribe(samples) {
    if (!samples || samples.length < TARGET_RATE * 0.4) return Promise.resolve("");
    const job = this.queue.then(async () => {
      const r = await this.send({ type: "transcribe", audio: samples }, [samples.buffer]);
      return cleanTranscript(r.text);
    });
    this.queue = job.catch(() => {});
    return job;
  }
}

// Whisper sometimes emits markers such as [BLANK_AUDIO] or (music) for silence.
function cleanTranscript(t) {
  return (t || "").replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

// Browser speech recognition, used only if Whisper cannot load.
export class BrowserRecogniser {
  static supported() {
    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }
  start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.text = "";
    this.r = new SR();
    this.r.lang = "en-AU";
    this.r.continuous = true;
    this.r.interimResults = false;
    this.r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) this.text += " " + e.results[i][0].transcript;
    };
    this.r.onerror = () => {};
    try {
      this.r.start();
    } catch (_) {}
  }
  stop() {
    return new Promise((resolve) => {
      if (!this.r) return resolve("");
      this.r.onend = () => resolve(this.text.trim());
      try {
        this.r.stop();
      } catch (_) {
        resolve(this.text.trim());
      }
      setTimeout(() => resolve(this.text.trim()), 2500);
    });
  }
}
