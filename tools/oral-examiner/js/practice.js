// Student practice flow: join, upload, set up, spoken session, feedback.
import { api, isDemo } from "./api.js";
import { $, el, show, fmtTime, demoBanner, renderReport } from "./ui.js";
import { extractText } from "./extract.js";
import { Recorder, Transcriber, BrowserRecogniser } from "./speech.js";
import { CONFIG } from "./config.js";

demoBanner(isDemo, $("#banner"));

const S = {
  code: "", name: "", id: "", assessment: null, submission: "",
  attemptRef: null, token: null, durationSec: 300, typingAllowed: false,
  startedAt: 0, examiner: null, recorder: null, transcriber: null, browserRec: null,
  stt: "none", avatarReady: false, sttReady: false, busy: false, done: false, pendingAnswer: "",
};

// ------------------------------------------------------------------ steps
function step(name) {
  for (const s of ["join", "work", "setup", "exam", "feedback"]) show($(`#s-${s}`), s === name);
  document.body.classList.toggle("in-exam", name === "exam");
  document.querySelectorAll("#steps span").forEach((sp) => sp.classList.toggle("on", sp.dataset.s === name));
  hideError();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function error(msg) {
  const e = $("#error");
  e.textContent = msg;
  show(e, true);
  e.scrollIntoView({ behavior: "smooth", block: "center" });
}
function hideError() {
  show($("#error"), false);
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
  show(pv, words > 0);
  $("#work-next").disabled = !(words >= 40 && $("#consent").checked);
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
  if (!S.examiner && !S.avatarReady) loadAvatar();
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

// Microphone check
let testing = false;
$("#mic-test").addEventListener("click", async () => {
  if (!S.sttReady) {
    $("#mic-result").textContent = "Please wait until speech recognition has finished loading.";
    return;
  }
  if (S.stt === "typing") {
    $("#mic-result").textContent = "Speech recognition is not available in this browser.";
    return;
  }
  try {
    if (!S.recorder) {
      S.recorder = new Recorder();
      await S.recorder.open();
    }
  } catch (_) {
    $("#mic-result").textContent = "The microphone could not be opened. Please allow microphone access in your browser and try again.";
    return;
  }
  if (!testing) {
    testing = true;
    $("#mic-test").textContent = "Stop test";
    startRecording();
    meterLoop("#test-meter", () => testing);
  } else {
    testing = false;
    $("#mic-test").textContent = "Test microphone";
    $("#mic-result").textContent = "Listening back...";
    const text = await stopRecording();
    $("#mic-result").textContent = text ? `Heard: "${text}"` : "Nothing was heard. Check that the correct microphone is selected and try again.";
  }
});

function meterLoop(sel, active) {
  const bar = $(sel);
  const tick = () => {
    bar.style.width = `${Math.round((S.recorder?.level() || 0) * 100)}%`;
    if (active()) requestAnimationFrame(tick);
    else bar.style.width = "0";
  };
  tick();
}

function startRecording() {
  if (S.stt === "browser") {
    S.browserRec = new BrowserRecogniser();
    S.browserRec.start();
  }
  S.recorder.start();
}

async function stopRecording() {
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
  try {
    if (!S.recorder && S.stt !== "typing") {
      S.recorder = new Recorder();
      await S.recorder.open();
    }
  } catch (_) {
    {
      error("The microphone could not be opened. Please allow microphone access and try again.");
      btn.disabled = false;
      btn.textContent = "Begin practice";
      return;
    }
    S.stt = "typing";
  }
  if (S.examiner) await S.examiner.unlockAudio();
  try {
    const r = await api("POST", `/api/practice/${S.code}/start`, { studentName: S.name, studentId: S.id, submissionText: S.submission });
    Object.assign(S, { attemptRef: r.attemptRef, token: r.token, durationSec: r.durationSec, typingAllowed: r.typingAllowed, attemptsLeft: r.attemptsLeftToday, done: false });
    S.startedAt = Date.now();
    $("#log").textContent = "";
    $("#stage-slot").appendChild($("#avatar-box"));
    step("exam");
    show($("#type-toggle"), S.typingAllowed);
    if (S.stt === "typing") {
      show($("#typed-area"), true);
      event("typed_mode");
    }
    if (S.stt === "browser") event("mic_fallback");
    startTimer();
    await examinerSays(r.opening);
  } catch (err) {
    error(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Begin practice";
  }
});

async function examinerSays(text) {
  setMic("wait");
  $("#sub-who").textContent = "Sage";
  if (S.examiner && S.examiner.engine !== "none") {
    // The words appear only once Sage has finished saying them, so the
    // subtitle never runs ahead of the voice.
    $("#sub-text").textContent = "...";
    try {
      await S.examiner.say(text);
    } catch (err) {
      console.warn(err);
    }
    $("#sub-text").textContent = text;
    addLog("Sage", text);
  } else {
    $("#sub-text").textContent = text;
    addLog("Sage", text);
    await new Promise((r) => setTimeout(r, Math.min(8000, 900 + text.split(/\s+/).length * 280)));
  }
  if (S.done) return;
  if (S.stt === "typing") setMic("typing");
  else startListening(); // the microphone opens the moment Sage stops speaking
}

function setMic(state) {
  const mic = $("#mic");
  mic.classList.toggle("recording", state === "recording");
  mic.disabled = state !== "recording";
  mic.textContent = { wait: "Wait", recording: "I'm done", thinking: "...", typing: "Typing" }[state] || "Wait";
  $("#mic-hint").textContent = {
    wait: "Sage is speaking...",
    recording: "Listening. Start speaking now.",
    thinking: "Sage is thinking...",
    typing: "Type your answer below.",
  }[state] || "";
  S.micState = state;
}

// Automatic turn-taking: listen straight after the question, detect when the
// student starts and stops speaking, and send the answer without a review step.
const VAD = { speech: 0.12, endSilenceMs: 2200, noStartMs: 25000, slowStartMs: 6000 };
let listenLoop = null;
function startListening() {
  startRecording();
  setMic("recording");
  S.examiner?.listening();
  meterLoop("#meter", () => S.micState === "recording");
  const t0 = Date.now();
  let firstSpeech = 0, lastSpeech = 0, flagged = false;
  clearInterval(listenLoop);
  listenLoop = setInterval(() => {
    const now = Date.now();
    const lvl = S.recorder?.level() || 0;
    if (lvl > VAD.speech) {
      if (!firstSpeech) firstSpeech = now;
      lastSpeech = now;
      if (now - firstSpeech > 3000 && Math.random() < 0.02) S.examiner?.nod();
    }
    if (!firstSpeech) {
      const wait = now - t0;
      if (wait > VAD.slowStartMs && !flagged) {
        flagged = true;
        event("slow_start");
      }
      $("#mic-hint").textContent = wait > VAD.slowStartMs ? "Sage is waiting for your answer. Please start speaking." : "Listening. Start speaking now.";
      if (wait > VAD.noStartMs) stopListening(t0, 0);
      return;
    }
    const left = CONFIG.answerSeconds - (now - firstSpeech) / 1000;
    $("#mic-hint").textContent = `Listening. Sage will reply when you pause. ${Math.ceil(left)} s left for this answer.`;
    if (now - lastSpeech > VAD.endSilenceMs || left <= 0) stopListening(t0, firstSpeech);
  }, 100);
}

async function stopListening(t0, firstSpeech) {
  clearInterval(listenLoop);
  if (S.micState !== "recording") return;
  setMic("thinking");
  S.examiner?.thinking();
  $("#mic-hint").textContent = "Transcribing your answer...";
  let text = "";
  try {
    text = await stopRecording();
  } catch (err) {
    console.warn(err);
  }
  const latencyMs = firstSpeech ? firstSpeech - t0 : null;
  sendAnswer(text || "(no answer given)", false, latencyMs);
}

$("#mic").addEventListener("click", () => {
  // Manual "I'm done", for students who pause mid-answer less than expected.
  if (S.micState === "recording") document.dispatchEvent(new Event("sage-stop"));
});
document.addEventListener("sage-stop", () => {
  if (S.micState === "recording") stopListening(Date.now(), Date.now());
});

// Typed answers exist only for students listed by the teacher (adjustments).
$("#type-toggle").addEventListener("click", () => {
  clearInterval(listenLoop);
  if (S.micState === "recording") S.recorder.stop().catch(() => {});
  setMic("typing");
  show($("#typed-area"), true);
  event("typed_mode");
});
$("#typed").addEventListener("paste", (e) => {
  e.preventDefault();
  event("paste_blocked");
  $("#mic-hint").textContent = "Pasting is not allowed. Please type your answer in your own words.";
});
$("#send-typed").addEventListener("click", () => {
  const t = $("#typed").value.trim();
  if (!t) return;
  $("#typed").value = "";
  sendAnswer(t, true, null);
});
$("#end-early").addEventListener("click", () => {
  if (confirm("End the practice session now and get feedback on the answers so far?")) finish();
});

async function sendAnswer(text, typed, latencyMs) {
  if (S.busy || S.done) return;
  S.busy = true;
  setMic("thinking");
  addLog("You", text);
  $("#sub-who").textContent = "You";
  $("#sub-text").textContent = text;
  try {
    const r = await api("POST", `/api/attempt/${S.attemptRef}/turn`, { token: S.token, answer: text, typed, latencyMs });
    $("#q-pill").textContent = `Question ${Math.min(r.questionNumber, r.questionTotal)} of ${r.questionTotal}`;
    S.busy = false;
    if (r.done) {
      S.done = true;
      await examinerSays(r.say);
      finish();
    } else {
      await examinerSays(r.say);
    }
  } catch (err) {
    S.busy = false;
    if (S.stt === "typing") setMic("typing");
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
  if (S.attemptRef && !S.done && !$("#s-exam").classList.contains("hidden")) event(document.hidden ? "tab_hidden" : "tab_visible");
});

// ------------------------------------------------------------------ 5. feedback
async function finish() {
  S.done = true;
  clearInterval(timerHandle);
  clearInterval(listenLoop);
  if (S.micState === "recording") S.recorder?.stop().catch(() => {});
  S.examiner?.stop();
  step("feedback");
  const box = $("#report");
  box.textContent = "";
  box.append(el("p", { class: "muted", text: "Sage is preparing your feedback. This usually takes 10 to 20 seconds..." }));
  for (let i = 0; i < 2; i++) {
    try {
      const r = await api("POST", `/api/attempt/${S.attemptRef}/finish`, { token: S.token });
      box.textContent = "";
      box.append(r.report ? renderReport(r.report) : el("p", { text: r.message || "No feedback was produced." }));
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
  $("#q-pill").textContent = "Question 1";
  step("setup");
  setup();
});

// Loaded lazily so the join form works even if 3D cannot load.
const avatarModule = import("./avatar.js");
avatarModule.catch(() => {});
