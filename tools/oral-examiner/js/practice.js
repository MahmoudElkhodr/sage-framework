// Student practice flow: join, upload, set up, spoken session, feedback.
import { api, isDemo } from "./api.js";
import { $, el, show, fmtTime, demoBanner, renderReport } from "./ui.js";
import { extractText } from "./extract.js";
import { Recorder, Transcriber, BrowserRecogniser, micErrorMessage } from "./speech.js";
import { TurnDetector, assessMicCheck, endsDangling } from "./vad.js";
import { CONFIG } from "./config.js";

demoBanner(isDemo, $("#banner"));

const REDUCED_MOTION = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const S = {
  code: "", name: "", id: "", assessment: null, submission: "",
  attemptRef: null, token: null, durationSec: 300, typingAllowed: false,
  startedAt: 0, examiner: null, recorder: null, transcriber: null, browserRec: null,
  stt: "none", avatarReady: false, sttReady: false, busy: false, done: false,
  detector: null, micState: "wait", typedMode: false,
};

// ------------------------------------------------------------------ steps
function step(name) {
  for (const s of ["join", "work", "setup", "exam", "feedback"]) show($(`#s-${s}`), s === name);
  document.body.classList.toggle("in-exam", name === "exam");
  document.querySelectorAll("#steps li").forEach((sp) => {
    const on = sp.dataset.s === name;
    sp.classList.toggle("on", on);
    if (on) sp.setAttribute("aria-current", "step");
    else sp.removeAttribute("aria-current");
  });
  hideError();
  window.scrollTo({ top: 0, behavior: REDUCED_MOTION ? "auto" : "smooth" });
  // Move keyboard and screen-reader focus to the new step.
  const target = name === "exam" ? $("#mic") : $(`#s-${name}`).querySelector("h1, h2");
  if (target) {
    if (!target.hasAttribute("tabindex") && target.tagName !== "BUTTON") target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }
}
// Shows an error. An optional action adds a button (for example to reconnect the microphone).
function error(msg, action) {
  const e = $("#error");
  e.textContent = msg;
  if (action) e.append(" ", el("button", { class: "btn small secondary", type: "button", text: action.label, onclick: action.run }));
  show(e, true);
  e.scrollIntoView({ behavior: REDUCED_MOTION ? "auto" : "smooth", block: "center" });
}
function hideError() {
  show($("#error"), false);
}
// A short message for screen-reader users (not shown on screen).
function announce(msg) {
  $("#sr-status").textContent = msg;
}
document.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", () => step(b.dataset.back)));

// ------------------------------------------------------------------ 1. join
const params = new URLSearchParams(location.search);
if (params.get("code")) $("#code").value = params.get("code").toUpperCase();
try {
  const saved = JSON.parse(sessionStorage.getItem("sage-oral-student") || "null");
  if (saved) {
    $("#sname").value = saved.name || "";
    $("#sid").value = saved.id || "";
  }
} catch (_) {}

$("#join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  S.code = $("#code").value.trim().toUpperCase();
  S.name = $("#sname").value.trim();
  S.id = $("#sid").value.trim();
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const { assessment } = await api("GET", `/api/practice/${encodeURIComponent(S.code)}`);
    S.assessment = assessment;
    try {
      sessionStorage.setItem("sage-oral-student", JSON.stringify({ name: S.name, id: S.id }));
    } catch (_) {}
    $("#a-title").textContent = assessment.title;
    const bank = assessment.mode === "questions";
    show($("#upload-block"), !bank);
    show($("#bank-note"), bank);
    if (bank) $("#consent-text").textContent = "I understand that this is a practice session. My answers (as text, not audio) will be processed by an AI service and saved so that my teacher can review my practice.";
    $("#a-meta").textContent = `${assessment.unit ? assessment.unit + " · " : ""}${assessment.durationMin}-minute spoken practice · up to ${assessment.dailyAttempts} attempts per day`;
    step("work");
  } catch (err) {
    error(err.message);
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------------ 2. work
function updateWorkState() {
  const t = S.submission;
  const words = t ? t.split(/\s+/).filter(Boolean).length : 0;
  const pv = $("#work-preview");
  if (words) {
    pv.textContent = "";
    pv.append(el("strong", { text: `${words.toLocaleString()} words read. ` }), el("span", { class: "muted", text: `Begins: "${t.slice(0, 180).replace(/\s+/g, " ")}..."` }));
  }
  show(pv, words > 0 && S.assessment?.mode !== "questions");
  const bank = S.assessment?.mode === "questions";
  $("#work-next").disabled = !((bank || words >= 40) && $("#consent").checked);
}
$("#file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  hideError();
  $("#work-preview").textContent = "Reading your file...";
  show($("#work-preview"), true);
  try {
    S.submission = await extractText(f);
  } catch (err) {
    S.submission = "";
    error(err.message);
  }
  updateWorkState();
});
$("#paste-toggle").addEventListener("click", () => show($("#paste"), true));
$("#paste").addEventListener("input", (e) => {
  S.submission = e.target.value.trim();
  updateWorkState();
});
$("#consent").addEventListener("change", updateWorkState);
$("#work-next").addEventListener("click", () => {
  step("setup");
  setup();
});

// ------------------------------------------------------------------ 3. setup
async function setup() {
  $("#setup-slot").appendChild($("#avatar-box"));
  setStateChip("");
  if (!S.examiner && !S.avatarReady) loadAvatar();
  else S.examiner?.idle();
  if (!S.transcriber && S.stt === "none") {
    try {
      S.transcriber = new Transcriber();
      const files = {};
      S.transcriber.onProgress = (m) => {
        files[m.file] = m.ratio;
        const vals = Object.values(files);
        $("#load-stt").style.width = `${Math.round((vals.reduce((a, b) => a + b, 0) / Math.max(3, vals.length)) * 100)}%`;
      };
      await S.transcriber.load();
      S.stt = "whisper";
      $("#load-stt").style.width = "100%";
      $("#load-stt-label").textContent = "Speech recognition: ready (runs privately on this device)";
    } catch (err) {
      console.warn("Whisper unavailable", err);
      S.transcriber = null;
      if (BrowserRecogniser.supported()) {
        S.stt = "browser";
        $("#load-stt-label").textContent = "Speech recognition: using your browser's built-in service";
      } else {
        S.stt = "typing";
        $("#load-stt-label").textContent = "Speech recognition is not available in this browser. Please use Chrome or Edge, or ask your teacher to enable typed answers.";
      }
      $("#load-stt").style.width = "100%";
    }
  }
  S.sttReady = true;
  checkReady();
}

async function loadAvatar() {
  const failed = (err) => {
    console.error(err);
    $("#load-avatar-label").textContent = "The 3D examiner could not be shown on this device. The session will continue with voice and subtitles.";
    show($("#avatar-loading"), false);
    S.examiner = null;
    S.avatarReady = true;
    $("#sub-box").setAttribute("aria-live", "polite"); // without a voice, the subtitle is the question
    checkReady();
  };
  let Examiner;
  try {
    ({ Examiner } = await avatarModule);
  } catch (err) {
    return failed(err);
  }
  S.examiner = new Examiner($("#avatar"), { voice: S.assessment.voice });
  try {
    await S.examiner.load((r) => ($("#load-avatar").style.width = `${Math.round(r * 100)}%`));
    $("#load-avatar").style.width = "100%";
    $("#load-avatar-label").textContent = "Examiner character: ready";
    show($("#avatar-loading"), false);
    const engine = await S.examiner.prepareVoice((m) => ($("#voice-status").textContent = m));
    $("#voice-status").textContent = engine === "kokoro" ? "Examiner voice: ready (neural voice on this device)" : engine === "browser" ? "Examiner voice: ready (browser voice)" : "No voice is available in this browser; Sage's words will appear as subtitles.";
    if (engine === "none") $("#sub-box").setAttribute("aria-live", "polite");
    S.avatarReady = true;
    checkReady();
  } catch (err) {
    failed(err);
  }
}

function checkReady() {
  const canAnswer = S.stt === "whisper" || S.stt === "browser";
  $("#begin").disabled = !(S.avatarReady && S.sttReady && canAnswer);
}

// Opens the microphone if it is not already open. Throws the browser's error on failure.
async function ensureMic() {
  if (!S.detector) S.detector = new TurnDetector();
  if (S.recorder?.isOpen) {
    S.recorder.resume();
    return;
  }
  S.recorder?.close();
  S.recorder = new Recorder();
  await S.recorder.open();
  S.recorder.onLost = micLost;
}

// Microphone check: records one sentence, plays back what was understood, and
// measures the room's background noise so that Sage can tell speech from silence.
let testing = null;
$("#mic-test").addEventListener("click", async () => {
  if (testing) return stopMicTest();
  if (!S.sttReady) {
    $("#mic-result").textContent = "Please wait until speech recognition has finished loading.";
    return;
  }
  if (S.stt === "typing") {
    $("#mic-result").textContent = "Speech recognition is not available in this browser.";
    return;
  }
  $("#mic-test").disabled = true;
  try {
    await ensureMic();
  } catch (err) {
    $("#mic-result").textContent = micErrorMessage(err);
    return;
  } finally {
    $("#mic-test").disabled = false;
  }
  if (testing || $("#s-setup").classList.contains("hidden")) return; // the session began meanwhile
  const rec = S.recorder;
  const det = new TurnDetector({ noise: S.detector.noise });
  const t0 = rec.now();
  det.beginTurn(t0);
  testing = { frames: [] };
  $("#mic-test").textContent = "Stop test";
  $("#mic-result").textContent = "Listening. Please say a sentence now; the test stops when you pause.";
  beginCapture();
  rec.onFrame = (rms, t) => {
    if (!testing) return;
    testing.frames.push(rms);
    const st = det.push(rms, t);
    setMeter("#test-meter", st.level);
    if (st.ended || t - t0 > 15000) stopMicTest();
  };
});

async function stopMicTest() {
  const tst = testing;
  if (!tst) return;
  testing = null;
  S.recorder.onFrame = null;
  setMeter("#test-meter", 0);
  $("#mic-test").textContent = "Test microphone";
  $("#mic-result").textContent = "Listening back...";
  let text = "";
  try {
    text = await endCapture();
  } catch (err) {
    console.warn(err);
  }
  const a = assessMicCheck(tst.frames);
  if (a.verdict !== "silent") S.detector.noise = a.noise;
  const heard = text ? `Heard: "${text}". ` : "";
  $("#mic-result").textContent =
    a.verdict === "silent" ? "Nothing was heard. Please check that the correct microphone is selected and not muted, and then try again."
    : a.verdict === "noisy" ? `${heard}There is a lot of background noise. A quieter room or a headset will help Sage to hear when you have finished speaking.`
    : a.verdict === "quiet" ? `${heard}Your voice is quite soft. Please move closer to the microphone or speak a little louder.`
    : text ? `${heard}Your microphone level is good.`
    : "Your voice was heard, but the words were not recognised. Please try again, speaking clearly.";
}

function setMeter(sel, level) {
  $(sel).style.width = `${Math.round(Math.max(0, Math.min(1, level)) * 100)}%`;
}

function beginCapture() {
  if (S.stt === "browser") {
    S.browserRec = new BrowserRecogniser();
    S.browserRec.start();
  }
  S.recorder.start();
}

// Ends a simple capture (the microphone check) and returns the recognised text.
async function endCapture() {
  const samples = await S.recorder.stop();
  if (S.stt === "whisper") return S.transcriber.transcribe(samples);
  if (S.stt === "browser" && S.browserRec) return S.browserRec.stop();
  return "";
}

// ------------------------------------------------------------------ 4. exam
$("#begin").addEventListener("click", async () => {
  const btn = $("#begin");
  btn.disabled = true;
  btn.textContent = "Starting...";
  if (testing) await stopMicTest();
  try {
    if (S.stt !== "typing") await ensureMic();
  } catch (err) {
    error(micErrorMessage(err));
    btn.disabled = false;
    btn.textContent = "Begin practice";
    return;
  }
  if (S.examiner) await S.examiner.unlockAudio();
  try {
    const r = await api("POST", `/api/practice/${S.code}/start`, { studentName: S.name, studentId: S.id, submissionText: S.submission });
    Object.assign(S, { attemptRef: r.attemptRef, token: r.token, durationSec: r.durationSec, typingAllowed: r.typingAllowed, attemptsLeft: r.attemptsLeftToday, done: false, busy: false });
    S.startedAt = Date.now();
    $("#log").textContent = "";
    $("#stage-slot").appendChild($("#avatar-box"));
    step("exam");
    show($("#type-toggle"), S.typingAllowed);
    S.typedMode = S.stt === "typing";
    show($("#typed-area"), S.typedMode);
    if (S.typedMode) event("typed_mode");
    if (S.stt === "browser") event("mic_fallback");
    startTimer();
    await examinerSays(r.opening, { warm: true });
  } catch (err) {
    error(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Begin practice";
  }
});

async function examinerSays(text, { warm = false } = {}) {
  if (S.recorder) S.recorder.onFrame = null;
  setMic("wait");
  $("#sub-who").textContent = "Sage";
  if (S.examiner && S.examiner.engine !== "none") {
    // The words appear only once Sage has finished saying them, so the
    // subtitle never runs ahead of the voice.
    $("#sub-text").textContent = "...";
    try {
      await S.examiner.say(text, { warm });
    } catch (err) {
      console.warn(err);
    }
    $("#sub-text").textContent = text;
    addLog("Sage", text);
  } else {
    $("#sub-text").textContent = text;
    addLog("Sage", text);
    S.examiner?.say(text, { warm }).catch(() => {});
    await sleep(Math.min(8000, 900 + text.split(/\s+/).length * 280));
  }
  if (S.done) return;
  if (S.typedMode) setMic("typing");
  else startListening(); // the microphone opens the moment Sage stops speaking
}

const MIC_LABEL = { wait: "Wait", recording: "I'm done", thinking: "...", typing: "Typing" };
const MIC_HINT = {
  wait: "Sage is speaking...",
  recording: "Listening. Start speaking now.",
  thinking: "Sage is thinking...",
  typing: "Type your answer below.",
};
const CHIP = { wait: "Speaking", recording: "Listening", thinking: "Thinking", typing: "" };
function setMic(state) {
  const mic = $("#mic");
  mic.classList.toggle("recording", state === "recording");
  // aria-disabled (rather than disabled) keeps keyboard focus on the button between turns.
  mic.setAttribute("aria-disabled", state === "recording" ? "false" : "true");
  mic.textContent = MIC_LABEL[state] || "Wait";
  mic.setAttribute("aria-label", state === "recording" ? "I'm done: finish my answer" : state === "thinking" ? "Sage is thinking" : state === "typing" ? "Typing mode" : "Please wait: Sage is speaking");
  setHint(MIC_HINT[state] || "");
  setStateChip(CHIP[state] || "");
  showPauseCue(false);
  if (state !== "recording") setMeter("#meter", 0);
  S.micState = state;
}
let lastHint = "";
function setHint(text) {
  if (text === lastHint) return;
  lastHint = text;
  $("#mic-hint").textContent = text;
}
function setStateChip(text) {
  const chip = $("#avatar-state");
  chip.textContent = text;
  chip.dataset.state = text.toLowerCase().replace(/\s+/g, "-");
  show(chip, Boolean(text));
}
function showPauseCue(on, ratio = 0) {
  $("#pause-cue").classList.toggle("on", on);
  $("#pause-bar").style.width = on ? `${Math.round(Math.min(1, ratio) * 100)}%` : "0";
}

// Automatic turn-taking: listen straight after the question, detect when the
// student starts and stops speaking, and send the answer without a review step.
// The silence that ends an answer adapts to the student (see vad.js); while it
// runs, a "Still listening" cue shows that there is time to carry on.
const TURN = { noStartMs: 25000, slowStartMs: 6000, segmentMinMs: 4000, segmentPauseMs: 650, tailMs: 350 };
let turn = null;

function startListening() {
  if (S.done) return;
  const rec = S.recorder;
  if (!rec?.isOpen) return micLost();
  rec.resume();
  const t0 = rec.now();
  S.detector.beginTurn(t0);
  turn = { t0, first: 0, parts: [], segStart: t0, cutThisPause: false, slow: false, ending: false };
  beginCapture();
  setMic("recording");
  S.examiner?.listening();
  announce("Sage has finished speaking. Listening now.");
  rec.onFrame = onListenFrame;
  // Watchdog: if the browser stops delivering audio (a suspended audio context
  // or a stalled device), try to resume and then ask the student to reconnect.
  const tn = turn;
  const dog = setInterval(() => {
    if (turn !== tn || tn.ending) return clearInterval(dog);
    if (tn.frames > 0) {
      tn.frames = 0;
      tn.stalls = 0;
      return;
    }
    tn.stalls = (tn.stalls || 0) + 1;
    rec.resume();
    if (tn.stalls >= 4) {
      clearInterval(dog);
      micLost();
    }
  }, 1000);
}

function onListenFrame(rms, t) {
  const tn = turn;
  if (!tn || tn.ending) return;
  tn.frames = (tn.frames || 0) + 1;
  const det = S.detector;
  const st = det.push(rms, t);
  setMeter("#meter", st.level);

  if (!st.hasSpoken) {
    const wait = t - tn.t0;
    if (wait > TURN.slowStartMs && !tn.slow) {
      tn.slow = true;
      event("slow_start");
    }
    setHint(tn.slow ? "Sage is waiting for your answer. Please start speaking." : "Listening. Start speaking now.");
    if (wait > TURN.noStartMs) endAnswer();
    return;
  }

  if (st.started) {
    tn.first = det.firstSpeechT;
    // Drop the wait before the student began, keeping a short lead-in.
    S.recorder.trimStart(tn.first - TURN.tailMs);
    tn.segStart = tn.first;
  }
  if (st.speaking) tn.cutThisPause = false;
  if (st.paused && det.speechMs > 3500) S.examiner?.backchannel();

  // At a natural pause, hand the audio so far to the speech recogniser so that
  // little remains to transcribe when the answer ends.
  if (S.stt === "whisper" && !st.speaking && !tn.cutThisPause && st.silenceMs >= TURN.segmentPauseMs && det.lastVoiceT - tn.segStart >= TURN.segmentMinMs) {
    tn.cutThisPause = true;
    const until = det.lastVoiceT + TURN.tailMs;
    tn.segStart = until;
    const index = tn.parts.length;
    const part = S.recorder.take(until).then((samples) => S.transcriber.transcribe(samples));
    tn.parts.push(part);
    part.then((text) => {
      // If the words so far stop mid-sentence, allow a longer pause.
      if (turn === tn && !tn.ending && index === tn.parts.length - 1 && endsDangling(text)) det.extendForDangling();
    }).catch(() => {});
  }

  const left = CONFIG.answerSeconds - (t - tn.first) / 1000;
  if (st.cue) {
    showPauseCue(true, st.silenceMs / st.limitMs);
    setStateChip("Still listening");
    setHint("Still listening. Carry on when you are ready, or stay silent to finish.");
  } else {
    showPauseCue(false);
    setStateChip("Listening");
    setHint(left <= 15 ? `Listening. ${Math.max(0, Math.ceil(left))} s left for this answer.` : "Listening. Sage will reply when you pause.");
  }
  if (st.ended || left <= 0) endAnswer();
}

// The answer is over (silence, the time limit, or the "I'm done" button).
// Sage acknowledges at once; transcription of the last part and the AI call follow.
async function endAnswer({ manual = false } = {}) {
  const tn = turn;
  if (!tn || tn.ending) return;
  tn.ending = true;
  const rec = S.recorder;
  const det = S.detector;
  const spoke = Boolean(det.firstSpeechT);
  const latencyMs = spoke ? Math.max(0, Math.round(det.firstSpeechT - tn.t0)) : null;
  setMic("thinking");
  announce("Answer received. Sage is thinking.");
  S.examiner?.acknowledge({ spoken: spoke });
  S.examiner?.thinking();
  watchForCutOff();
  let text = "";
  try {
    if (S.stt === "whisper") {
      // Pressing the button with no speech detected still transcribes what was
      // recorded, in case a very soft voice was missed.
      if (spoke || manual) tn.parts.push(rec.stop(spoke ? det.lastVoiceT + TURN.tailMs : Infinity).then((s) => S.transcriber.transcribe(s)));
      else await rec.stop(0);
      const texts = await Promise.all(tn.parts.map((p) => p.catch(() => "")));
      text = texts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    } else {
      await rec.stop(0);
      text = S.browserRec ? await S.browserRec.stop() : "";
    }
  } catch (err) {
    console.warn(err);
  }
  if (turn === tn) turn = null;
  if (S.done) return;
  sendAnswer(text || "(no answer given)", false, latencyMs, spoke);
}

// If the student carries on speaking just after Sage took the answer as
// finished, later answers are given a longer pause before Sage replies.
function watchForCutOff() {
  const rec = S.recorder;
  const det = S.detector;
  const until = rec.now() + 2600;
  let voiced = 0, last = rec.now();
  rec.onFrame = (rms, t) => {
    const dt = t - last;
    last = t;
    if (t > until) return (rec.onFrame = null);
    if (S.examiner?.isSpeaking) return; // ignore Sage's own acknowledgement
    if (rms > det.onThreshold * 1.5) voiced += dt;
    if (voiced >= 450) {
      det.noteCutOff();
      rec.onFrame = null;
    }
  };
}

function micLost() {
  if (S.done || $("#s-exam").classList.contains("hidden")) return;
  if (turn) turn.ending = true;
  turn = null;
  if (S.recorder) S.recorder.onFrame = null;
  setMic("wait");
  setHint("The microphone is not available.");
  setStateChip("");
  error("The microphone was disconnected or stopped. Please reconnect it and then continue.", {
    label: "Reconnect microphone",
    run: async () => {
      try {
        S.recorder?.close();
        S.recorder = null;
        await ensureMic();
        hideError();
        if (!S.busy && !S.done) startListening();
      } catch (err) {
        error(micErrorMessage(err), { label: "Try again", run: micLost });
      }
    },
  });
}

$("#mic").addEventListener("click", () => {
  // Manual "I'm done", for students who would rather not wait for the pause.
  if (S.micState === "recording") endAnswer({ manual: true });
});
// The Enter key also finishes the answer, wherever the keyboard focus is.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.repeat || S.micState !== "recording") return;
  if (e.target instanceof Element && e.target.closest("button, a, input, textarea, select, summary")) return;
  e.preventDefault();
  endAnswer({ manual: true });
});

// Typed answers exist only for students listed by the teacher (adjustments).
$("#type-toggle").addEventListener("click", () => {
  if (turn) turn.ending = true;
  turn = null;
  if (S.recorder) {
    S.recorder.onFrame = null;
    S.recorder.stop(0).catch(() => {});
  }
  S.browserRec?.stop().catch(() => {});
  S.typedMode = true;
  setMic("typing");
  show($("#typed-area"), true);
  $("#typed").focus();
  event("typed_mode");
});
$("#typed").addEventListener("paste", (e) => {
  e.preventDefault();
  event("paste_blocked");
  setHint("Pasting is not allowed. Please type your answer in your own words.");
});
$("#send-typed").addEventListener("click", () => {
  const t = $("#typed").value.trim();
  if (!t) return;
  $("#typed").value = "";
  sendAnswer(t, true, null, false);
});
$("#end-early").addEventListener("click", () => {
  if (confirm("End the practice session now and get feedback on the answers so far?")) finish();
});

async function sendAnswer(text, typed, latencyMs, acknowledged = false) {
  if (S.busy || S.done) return;
  S.busy = true;
  if (!S.typedMode) setMic("thinking");
  else S.examiner?.thinking();
  addLog("You", text);
  $("#sub-who").textContent = "You";
  $("#sub-text").textContent = text;
  try {
    // A short beat lets the acknowledgement finish, so Sage never replies unnaturally fast.
    const [r] = await Promise.all([
      api("POST", `/api/attempt/${S.attemptRef}/turn`, { token: S.token, answer: text, typed, latencyMs }),
      sleep(acknowledged ? 700 : 350),
    ]);
    $("#q-pill").textContent = `Question ${Math.min(r.questionNumber, r.questionTotal)} of ${r.questionTotal}`;
    S.busy = false;
    if (r.done) {
      S.done = true;
      await examinerSays(r.say, { warm: true });
      finish();
    } else {
      await examinerSays(r.say);
    }
  } catch (err) {
    S.busy = false;
    S.examiner?.idle();
    if (S.typedMode) setMic("typing");
    else startListening();
    error(err.message);
  }
}

let timerHandle = null;
function startTimer() {
  clearInterval(timerHandle);
  timerHandle = setInterval(() => {
    const left = S.durationSec - (Date.now() - S.startedAt) / 1000;
    const t = $("#timer");
    t.textContent = fmtTime(left);
    t.classList.toggle("low", left < 45);
    if (left <= -40 && !S.done && !S.busy) finish(); // the server closes the session; this is a safety net
  }, 500);
}

function addLog(who, text) {
  $("#log").append(el("p", {}, el("b", { text: who + ": " }), text));
}

function event(type) {
  if (!S.attemptRef) return;
  api("POST", `/api/attempt/${S.attemptRef}/event`, { token: S.token, type }).catch(() => {});
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) S.recorder?.resume(); // browsers suspend audio in background tabs
  if (S.attemptRef && !S.done && !$("#s-exam").classList.contains("hidden")) event(document.hidden ? "tab_hidden" : "tab_visible");
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------------ 5. feedback
async function finish() {
  S.done = true;
  clearInterval(timerHandle);
  if (turn) turn.ending = true;
  turn = null;
  // Release the microphone as soon as the session ends.
  S.browserRec?.stop().catch(() => {});
  S.recorder?.close();
  S.recorder = null;
  S.examiner?.stop();
  S.examiner?.idle();
  setMic("wait");
  setStateChip("");
  step("feedback");
  const box = $("#report");
  box.textContent = "";
  box.append(el("p", { class: "muted", text: "Sage is preparing your feedback. This usually takes 10 to 20 seconds..." }));
  for (let i = 0; i < 2; i++) {
    try {
      const r = await api("POST", `/api/attempt/${S.attemptRef}/finish`, { token: S.token });
      box.textContent = "";
      box.append(r.report ? renderReport(r.report) : el("p", { text: r.message || "No feedback was produced." }));
      announce("Your practice feedback is ready.");
      break;
    } catch (err) {
      if (i === 1) {
        box.textContent = "";
        box.append(el("p", { class: "error", text: err.message }), el("button", { class: "btn", text: "Try again", onclick: finish }));
      }
    }
  }
  $("#attempts-left").textContent = S.attemptsLeft > 0 ? `You have ${S.attemptsLeft} practice attempt${S.attemptsLeft === 1 ? "" : "s"} left today.` : "You have used all of today's practice attempts.";
  $("#again").disabled = !(S.attemptsLeft > 0);
}

$("#again").addEventListener("click", () => {
  S.attemptRef = null;
  S.token = null;
  S.done = false;
  S.micState = "wait";
  $("#q-pill").textContent = "Question 1";
  $("#mic-result").textContent = "";
  step("setup");
  setup();
});

// Loaded lazily so the join form works even if 3D cannot load.
const avatarModule = import("./avatar.js");
avatarModule.catch(() => {});
