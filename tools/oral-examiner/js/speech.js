// Microphone recording and transcription.
// Primary: Whisper in a Web Worker (private, on-device).
// Fallback: the browser's own speech recognition (Chrome and Edge send audio to their vendor).

export class Recorder {
  async open() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    src.connect(this.analyser);
  }

  level() {
    if (!this.analyser) return 0;
    const buf = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += (v - 128) * (v - 128);
    return Math.min(1, Math.sqrt(sum / buf.length) / 40);
  }

  start() {
    this.chunks = [];
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported?.(m)) || "";
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(250);
  }

  // Resolves with 16 kHz mono Float32 samples, as Whisper expects.
  stop() {
    return new Promise((resolve, reject) => {
      if (!this.rec || this.rec.state === "inactive") return resolve(new Float32Array(0));
      this.rec.onstop = async () => {
        try {
          const blob = new Blob(this.chunks, { type: this.rec.mimeType });
          const decoded = await this.ctx.decodeAudioData(await blob.arrayBuffer());
          const frames = Math.ceil(decoded.duration * 16000);
          const off = new OfflineAudioContext(1, Math.max(1, frames), 16000);
          const s = off.createBufferSource();
          s.buffer = decoded;
          s.connect(off.destination);
          s.start();
          const rendered = await off.startRendering();
          resolve(rendered.getChannelData(0));
        } catch (err) {
          reject(err);
        }
      };
      this.rec.stop();
    });
  }

  close() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
  }
}

export class Transcriber {
  constructor() {
    this.worker = new Worker(new URL("./stt-worker.js", import.meta.url), { type: "module" });
    this.pending = new Map();
    this.seq = 0;
    this.onProgress = null;
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

  async transcribe(samples) {
    if (!samples.length || samples.length < 16000 * 0.4) return "";
    const r = await this.send({ type: "transcribe", audio: samples }, [samples.buffer]);
    return cleanTranscript(r.text);
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
    this.r.start();
  }
  stop() {
    return new Promise((resolve) => {
      if (!this.r) return resolve("");
      this.r.onend = () => resolve(this.text.trim());
      this.r.stop();
      setTimeout(() => resolve(this.text.trim()), 2500);
    });
  }
}
