// Voice-activity and end-of-answer detection. Pure logic with no browser
// dependencies, so it can be unit-tested with `node --test` (see ../test).
//
// The detector is fed one short audio frame at a time (its RMS level and an
// audio-clock timestamp in milliseconds). It keeps:
//   - an adaptive noise floor, first measured during the microphone check;
//   - a speech/pause state with a short onset requirement and a hang-over, so
//     clicks are ignored and the gaps between words are not treated as pauses;
//   - an adaptive silence limit: short for long fluent answers, longer when the
//     student has only just begun, and longer again for a student who is known
//     to pause mid-answer (learned across the session).

export const VAD = {
  absOn: 0.006, // lowest RMS that can ever count as speech (about -44 dBFS)
  onRatio: 3.2, // speech must exceed the noise floor by about 10 dB
  offRatio: 2.0, // and is held until it falls to about 6 dB above it
  onsetMs: 90, // sustained energy needed before speech is accepted
  hangMs: 280, // gap bridged between words and syllables
  cueMs: 900, // pause length at which the "Still listening" cue appears
  minLimitMs: 1300,
  maxLimitMs: 3500,
  danglingMs: 1000, // extra patience when the last words suggest an unfinished sentence
};

// Words that rarely end a sentence. When the latest transcribed segment ends
// with one of them, the student has probably paused mid-thought.
const DANGLING = new Set(
  ("and but or so because since although though while whereas if when which that who whose than then also plus " +
    "the a an to of in on at by for with from into about as is are was were be been being has have had will would " +
    "can could should may might must do does did not like um uh er erm hmm well basically actually").split(" ")
);

export function endsDangling(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/(\.\.\.|…|,|-)$/.test(t)) return true;
  const last = t.replace(/[.?!"')\]]+$/, "").split(/\s+/).pop().toLowerCase().replace(/[^a-z']/g, "");
  return DANGLING.has(last);
}

export class TurnDetector {
  constructor({ noise = 0.004, habitMs = 0 } = {}) {
    this.noise = clamp(noise, 0.0005, 0.05);
    this.habitMs = habitMs; // how long this student tends to pause before carrying on
    this.env = 0;
    this.lastT = null;
    this.buckets = [];
    this.beginTurn(0);
  }

  // Called when the microphone opens for a new answer. The noise floor and the
  // learned pause habit carry over from earlier answers.
  beginTurn(t) {
    this.t0 = t;
    this.inSpeech = false;
    this.onsetMs = 0;
    this.onsetStart = 0;
    this.firstSpeechT = 0;
    this.lastVoiceT = 0;
    this.speechMs = 0;
    this.longPauseSeen = false;
    this.extraMs = 0;
    this.lastT = null;
  }

  get onThreshold() {
    return Math.max(this.noise * VAD.onRatio, VAD.absOn);
  }
  get offThreshold() {
    return Math.max(this.noise * VAD.offRatio, VAD.absOn * 0.7);
  }

  // The silence, in milliseconds, after which the current answer is taken to be finished.
  limitMs() {
    const s = this.speechMs;
    let base = s < 2500 ? 2600 : s < 8000 ? 2000 : s < 15000 ? 1700 : this.longPauseSeen ? 1700 : 1400;
    if (this.habitMs > 0) base = Math.max(base, this.habitMs * 1.25 + 250);
    return clamp(base + this.extraMs, VAD.minLimitMs, VAD.maxLimitMs);
  }

  // The latest transcribed words suggest an unfinished sentence: wait a little longer.
  extendForDangling() {
    if (!this.inSpeech && this.firstSpeechT) this.extraMs = VAD.danglingMs;
  }

  // The student carried on speaking after Sage had taken the answer as finished,
  // so later answers are given more patience.
  noteCutOff() {
    this.habitMs = Math.max(this.habitMs, 2300);
  }

  // Feed one frame. Returns the current state of the turn.
  push(rms, t) {
    const dt = this.lastT == null ? 30 : clamp(t - this.lastT, 1, 250);
    this.lastT = t;
    this.env = rms > this.env ? rms : this.env * 0.6 + rms * 0.4;
    this.trackNoise(rms, t);

    let started = false, resumed = false, paused = false;
    if (!this.inSpeech) {
      if (rms > this.onThreshold) {
        if (!this.onsetMs) this.onsetStart = t - dt;
        this.onsetMs += dt;
        if (this.onsetMs >= VAD.onsetMs) {
          this.inSpeech = true;
          this.onsetMs = 0;
          if (!this.firstSpeechT) {
            this.firstSpeechT = this.onsetStart;
            started = true;
          } else {
            const gap = this.onsetStart - this.lastVoiceT;
            if (gap >= 500) {
              // A pause that was followed by more speech: remember how long it was.
              this.habitMs = gap > this.habitMs ? gap : this.habitMs * 0.7 + gap * 0.3;
              if (gap >= 800) this.longPauseSeen = true;
            }
            resumed = true;
          }
          this.extraMs = 0;
          this.lastVoiceT = t;
          this.speechMs += t - this.onsetStart;
        }
      } else {
        this.onsetMs = Math.max(0, this.onsetMs - dt * 2);
      }
    } else {
      if (this.env > this.offThreshold) {
        this.lastVoiceT = t;
        this.speechMs += dt;
      } else if (t - this.lastVoiceT > VAD.hangMs) {
        this.inSpeech = false;
        paused = true;
      }
    }

    const silenceMs = this.firstSpeechT && !this.inSpeech ? t - this.lastVoiceT : 0;
    const limitMs = this.limitMs();
    return {
      speaking: this.inSpeech,
      hasSpoken: Boolean(this.firstSpeechT),
      started, resumed, paused,
      silenceMs, limitMs,
      cue: silenceMs >= VAD.cueMs,
      ended: Boolean(this.firstSpeechT) && !this.inSpeech && silenceMs >= limitMs,
      level: levelOf(this.env, this.noise),
    };
  }

  // Adaptive noise floor. It falls quickly, rises slowly while nobody is
  // speaking, and also follows the quietest moments of the last few seconds so
  // that a new steady noise (a fan, an air conditioner) is not heard as speech.
  trackNoise(rms, t) {
    if (!this.inSpeech && rms < this.onThreshold) {
      this.noise += (rms - this.noise) * (rms < this.noise ? 0.2 : 0.02);
    }
    const slot = Math.floor(t / 500);
    const b = this.buckets;
    if (!b.length || b[b.length - 1].slot !== slot) {
      b.push({ slot, min: rms });
      if (b.length > 6) b.shift();
      if (b.length === 6) {
        const quietest = Math.min(...b.slice(0, 5).map((x) => x.min));
        if (quietest > this.noise * 2) this.noise = this.noise * 0.85 + quietest * 0.15;
      }
    } else if (rms < b[b.length - 1].min) {
      b[b.length - 1].min = rms;
    }
    this.noise = clamp(this.noise, 0.0005, 0.05);
  }
}

// A 0..1 level for the on-screen meter: 0 at the noise floor, 1 about 36 dB above it.
export function levelOf(rms, noise) {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms / Math.max(noise, 0.0005));
  return clamp(db / 36, 0, 1);
}

// Summarises a microphone check from the frames heard during it.
// Returns { noise, speech, snrDb, verdict } where verdict is one of
// "good", "quiet" (voice too soft), "noisy" (room too loud) or "silent".
export function assessMicCheck(frames) {
  const v = frames.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (v.length < 10) return { noise: 0.004, speech: 0, snrDb: 0, verdict: "silent" };
  const pick = (q) => v[Math.min(v.length - 1, Math.floor(v.length * q))];
  const noise = Math.max(0.0005, pick(0.1));
  const speech = pick(0.9);
  const snrDb = 20 * Math.log10(Math.max(speech, 1e-6) / noise);
  let verdict = "good";
  if (speech < VAD.absOn) verdict = "silent";
  else if (noise > 0.02 || snrDb < 10) verdict = "noisy";
  else if (speech < 0.02) verdict = "quiet";
  return { noise: clamp(noise, 0.0005, 0.05), speech, snrDb, verdict };
}

// Linear-interpolation resampler with a simple averaging pre-filter, used only
// where the browser cannot resample for us.
export function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.max(1, Math.floor(input.length / ratio)));
  const span = Math.max(1, Math.round(ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const a = Math.floor(pos);
    let sum = 0, n = 0;
    for (let k = a; k < a + span && k < input.length; k++) {
      sum += input[k];
      n++;
    }
    out[i] = n ? sum / n : 0;
  }
  return out;
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}
