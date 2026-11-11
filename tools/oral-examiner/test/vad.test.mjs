// Unit tests for the turn-taking logic. Run with:  node --test tools/oral-examiner/test
import test from "node:test";
import assert from "node:assert/strict";
import { TurnDetector, endsDangling, assessMicCheck, resampleLinear, VAD } from "../js/vad.js";

const FRAME = 30;
// Feeds a script of [durationMs, level] pairs; returns the time at which the answer ended (or null).
function run(det, script, { t = 0, onState } = {}) {
  det.beginTurn(t);
  let ended = null;
  for (const [ms, level] of script) {
    for (let k = 0; k < ms / FRAME; k++) {
      t += FRAME;
      const jitter = 1 + 0.3 * Math.sin(t / 37);
      const st = det.push(level * jitter, t);
      onState?.(st, t);
      if (st.ended && ended == null) ended = t;
    }
  }
  return { ended, t };
}
const NOISE = 0.003, VOICE = 0.08;

test("silence alone never ends an answer or counts as speech", () => {
  const det = new TurnDetector({ noise: NOISE });
  const r = run(det, [[8000, NOISE]]);
  assert.equal(r.ended, null);
  assert.equal(det.firstSpeechT, 0);
});

test("a short click is ignored", () => {
  const det = new TurnDetector({ noise: NOISE });
  run(det, [[1000, NOISE], [60, 0.3], [3000, NOISE]]);
  assert.equal(det.firstSpeechT, 0);
});

test("time to first speech is measured from the start of the turn", () => {
  const det = new TurnDetector({ noise: NOISE });
  run(det, [[2400, NOISE], [3000, VOICE], [4000, NOISE]], { t: 5000 });
  const latency = det.firstSpeechT - det.t0;
  assert.ok(latency > 2300 && latency < 2600, `latency ${latency}`);
});

test("a long fluent answer ends quickly after the student stops", () => {
  const det = new TurnDetector({ noise: NOISE });
  const r = run(det, [[500, NOISE], [16000, VOICE], [5000, NOISE]]);
  const wait = r.ended - 16500;
  assert.ok(wait >= VAD.minLimitMs && wait <= 1800, `waited ${wait}`);
});

test("a student who has only just begun is given longer", () => {
  const det = new TurnDetector({ noise: NOISE });
  const r = run(det, [[500, NOISE], [1200, VOICE], [5000, NOISE]]);
  const wait = r.ended - 1700;
  assert.ok(wait >= 2500 && wait <= 3000, `waited ${wait}`);
});

test("a mid-sentence pause does not end the answer, and patience grows afterwards", () => {
  const det = new TurnDetector({ noise: NOISE });
  const r = run(det, [[300, NOISE], [4000, VOICE], [1800, NOISE], [4000, VOICE], [6000, NOISE]]);
  const stopAt = 300 + 4000 + 1800 + 4000;
  assert.ok(r.ended > stopAt, "must not end during the 1.8 s pause");
  const wait = r.ended - stopAt;
  assert.ok(wait >= 2300 && wait <= VAD.maxLimitMs + 100, `waited ${wait} after a hesitant answer`);
  assert.ok(det.habitMs >= 1500);
});

test("gaps between words are not reported as pauses", () => {
  const det = new TurnDetector({ noise: NOISE });
  let pauses = 0;
  const words = [];
  for (let i = 0; i < 20; i++) words.push([300, VOICE], [150, NOISE]);
  run(det, [[300, NOISE], ...words], { onState: (s) => s.paused && pauses++ });
  assert.equal(pauses, 0);
});

test("the still-listening cue appears before the answer ends", () => {
  const det = new TurnDetector({ noise: NOISE });
  let cueAt = null;
  const r = run(det, [[300, NOISE], [5000, VOICE], [4000, NOISE]], { onState: (s, t) => s.cue && cueAt == null && (cueAt = t) });
  assert.ok(cueAt && cueAt < r.ended);
});

test("an unfinished sentence earns extra time, within the cap", () => {
  const a = new TurnDetector({ noise: NOISE });
  const b = new TurnDetector({ noise: NOISE });
  const script = [[300, NOISE], [5000, VOICE], [1000, NOISE]];
  run(a, script);
  run(b, script);
  b.extendForDangling();
  assert.equal(b.limitMs() - a.limitMs(), VAD.danglingMs);
  assert.ok(b.limitMs() <= VAD.maxLimitMs);
});

test("being cut off raises patience for later answers", () => {
  const det = new TurnDetector({ noise: NOISE });
  run(det, [[300, NOISE], [9000, VOICE], [3000, NOISE]]);
  const before = det.limitMs();
  det.noteCutOff();
  assert.ok(det.limitMs() > before);
});

test("a new steady noise is absorbed into the noise floor", () => {
  const det = new TurnDetector({ noise: NOISE });
  run(det, [[2000, NOISE]]);
  det.beginTurn(100000);
  let t = 100000, speakingAtEnd = true;
  for (let k = 0; k < 20000 / FRAME; k++) {
    t += FRAME;
    speakingAtEnd = det.push(0.02, t).speaking; // a fan switches on: constant, no dips
  }
  assert.equal(speakingAtEnd, false);
});

test("quiet speech in a quiet room is still detected", () => {
  const det = new TurnDetector({ noise: 0.001 });
  run(det, [[500, 0.001], [3000, 0.012], [500, 0.001]]);
  assert.ok(det.firstSpeechT > 0);
});

test("endsDangling recognises unfinished sentences", () => {
  assert.equal(endsDangling("The firewall filters traffic because"), true);
  assert.equal(endsDangling("I would use AES and"), true);
  assert.equal(endsDangling("it depends on the, um"), true);
  assert.equal(endsDangling("That is why I chose AES."), false);
  assert.equal(endsDangling(""), false);
});

test("the microphone check classifies the room and the voice", () => {
  const quiet = [...Array(60).fill(0.002), ...Array(60).fill(0.09)];
  assert.equal(assessMicCheck(quiet).verdict, "good");
  assert.equal(assessMicCheck(Array(120).fill(0.002)).verdict, "silent");
  assert.equal(assessMicCheck([...Array(60).fill(0.03), ...Array(60).fill(0.06)]).verdict, "noisy");
  assert.equal(assessMicCheck([...Array(60).fill(0.001), ...Array(60).fill(0.012)]).verdict, "quiet");
});

test("the fallback resampler produces the expected length and preserves level", () => {
  const input = new Float32Array(48000).fill(0.5);
  const out = resampleLinear(input, 48000, 16000);
  assert.equal(out.length, 16000);
  assert.ok(Math.abs(out[8000] - 0.5) < 1e-6);
});
