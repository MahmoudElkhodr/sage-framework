// SAGE Defend Practice: Cloudflare Worker backend for the AI oral examiner.
// Storage: one KV namespace bound as ORAL_KV. Secrets: LLM_API_KEY, TEACHER_KEYS.
// See README.md in this folder for deployment steps.

import { callLLM, parseJSON, HttpError, modelFor } from "./llm.js";
import { planPrompt, bankPrompt, turnPrompt, markPrompt } from "./prompts.js";

const LIMITS = {
  submissionChars: 40000,
  specChars: 20000,
  rubricChars: 10000,
  answerChars: 3000,
  baseQuestions: 15,
  questionChars: 400,
};

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(request, env);
      return json(res, 200, cors);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return json({ error: status === 500 ? "Unexpected server error." : err.message }, status, cors);
    }
  },
};

// ---------------------------------------------------------------- routing

async function route(request, env) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean); // ["api", ...]
  const m = request.method;
  if (p[0] !== "api") throw new HttpError(404, "Not found.");

  if (p[1] === "health") {
    return { ok: true, provider: env.LLM_PROVIDER || "anthropic", configured: Boolean(env.LLM_API_KEY), models: { fast: modelFor(env, "fast"), smart: modelFor(env, "smart") } };
  }

  if (p[1] === "teacher") {
    const teacher = authTeacher(request, env);
    if (p[2] === "me" && m === "GET") return { name: teacher.name };
    if (p[2] === "assessments" && !p[3] && m === "GET") return listAssessments(env, teacher);
    if (p[2] === "assessments" && !p[3] && m === "POST") return saveAssessment(env, teacher, null, await body(request));
    if (p[2] === "assessments" && p[3] && !p[4] && m === "GET") return getOwnedAssessment(env, teacher, p[3]);
    if (p[2] === "assessments" && p[3] && !p[4] && m === "PUT") return saveAssessment(env, teacher, p[3], await body(request));
    if (p[2] === "assessments" && p[3] && !p[4] && m === "DELETE") return deleteAssessment(env, teacher, p[3]);
    if (p[2] === "assessments" && p[3] && p[4] === "attempts" && m === "GET") return listAttempts(env, teacher, p[3]);
    if (p[2] === "attempts" && p[3] && p[4] && m === "GET") return getAttemptForTeacher(env, teacher, p[3], p[4]);
  }

  if (p[1] === "practice" && p[2]) {
    if (!p[3] && m === "GET") return publicAssessment(env, p[2]);
    if (p[3] === "start" && m === "POST") return startAttempt(env, p[2], await body(request));
  }

  if (p[1] === "attempt" && p[2] && p[3]) {
    const [assessId, attemptId] = splitAttemptRef(p[2]);
    if (p[3] === "turn" && m === "POST") return takeTurn(env, assessId, attemptId, await body(request));
    if (p[3] === "event" && m === "POST") return logEvent(env, assessId, attemptId, await body(request));
    if (p[3] === "finish" && m === "POST") return finishAttempt(env, assessId, attemptId, await body(request));
  }

  throw new HttpError(404, "Not found.");
}

// ---------------------------------------------------------------- teacher

// TEACHER_KEYS format: "Name One:key-one,Name Two:key-two"
function authTeacher(request, env) {
  const header = request.headers.get("authorization") || "";
  const key = header.replace(/^Bearer\s+/i, "").trim();
  if (!key) throw new HttpError(401, "Teacher key required.");
  const entries = (env.TEACHER_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const e of entries) {
    const i = e.lastIndexOf(":");
    const name = i > 0 ? e.slice(0, i).trim() : "Teacher";
    const k = i > 0 ? e.slice(i + 1).trim() : e;
    if (k && safeEqual(k, key)) return { name, id: slug(name) };
  }
  throw new HttpError(403, "Teacher key not recognised.");
}

async function listAssessments(env, teacher) {
  const out = [];
  let cursor;
  do {
    const page = await env.ORAL_KV.list({ prefix: "assess:", cursor });
    for (const k of page.keys) if (k.metadata?.owner === teacher.id) out.push({ id: k.name.slice(7), ...k.metadata });
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  out.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return { assessments: out };
}

async function getOwnedAssessment(env, teacher, id) {
  const a = await env.ORAL_KV.get(`assess:${id}`, "json");
  if (!a || a.owner !== teacher.id) throw new HttpError(404, "Assessment not found.");
  return { assessment: a };
}

async function saveAssessment(env, teacher, id, input) {
  let existing = null;
  if (id) {
    existing = await env.ORAL_KV.get(`assess:${id}`, "json");
    if (!existing || existing.owner !== teacher.id) throw new HttpError(404, "Assessment not found.");
  }
  const title = str(input.title, 200).trim();
  if (!title) throw new HttpError(400, "A title is required.");
  const spec = str(input.spec, LIMITS.specChars);
  const topics = str(input.topics, 2000).trim();
  const isBank = input.mode === "questions";
  if (isBank) {
    const hasQ = Array.isArray(input.baseQuestions) && input.baseQuestions.some((q) => String(q || "").trim());
    if (!topics && !hasQ) throw new HttpError(400, "Please enter at least one key topic or question.");
  } else if (spec.trim().length < 30) throw new HttpError(400, "Please provide the assessment specification (at least a few sentences).");

  const a = {
    id: existing?.id || randomId(10),
    code: existing?.code || (await uniqueCode(env)),
    owner: teacher.id,
    ownerName: teacher.name,
    title,
    topics,
    unit: str(input.unit, 100),
    spec,
    rubric: str(input.rubric, LIMITS.rubricChars),
    baseQuestions: (Array.isArray(input.baseQuestions) ? input.baseQuestions : [])
      .map((q) => str(q, LIMITS.questionChars).trim())
      .filter(Boolean)
      .slice(0, LIMITS.baseQuestions),
    mode: input.mode === "questions" ? "questions" : "submission",
    durationMin: clampInt(input.durationMin, 3, 15, 5),
    maxFollowups: clampInt(input.maxFollowups, 0, 3, 1),
    dailyAttempts: clampInt(input.dailyAttempts, 1, 20, 3),
    allowTyping: Boolean(input.allowTyping),
    typingExemptIds: (Array.isArray(input.typingExemptIds) ? input.typingExemptIds : String(input.typingExemptIds || "").split(/[\s,;]+/))
      .map((s) => normaliseId(s))
      .filter(Boolean)
      .slice(0, 500),
    voice: ["bf_emma", "bf_isabella", "af_heart", "af_bella"].includes(input.voice) ? input.voice : "bf_emma",
    open: input.open === undefined ? true : Boolean(input.open),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await env.ORAL_KV.put(`assess:${a.id}`, JSON.stringify(a), {
    metadata: { title: a.title, unit: a.unit, code: a.code, owner: a.owner, createdAt: a.createdAt, open: a.open },
  });
  await env.ORAL_KV.put(`code:${a.code}`, a.id);
  return { assessment: a };
}

async function deleteAssessment(env, teacher, id) {
  const a = await env.ORAL_KV.get(`assess:${id}`, "json");
  if (!a || a.owner !== teacher.id) throw new HttpError(404, "Assessment not found.");
  await env.ORAL_KV.delete(`assess:${id}`);
  await env.ORAL_KV.delete(`code:${a.code}`);
  return { deleted: true };
}

async function listAttempts(env, teacher, assessId) {
  await getOwnedAssessment(env, teacher, assessId);
  const out = [];
  let cursor;
  do {
    const page = await env.ORAL_KV.list({ prefix: `attempt:${assessId}:`, cursor });
    for (const k of page.keys) out.push({ attemptId: k.name.split(":")[2], ...k.metadata });
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  out.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  return { attempts: out };
}

async function getAttemptForTeacher(env, teacher, assessId, attemptId) {
  await getOwnedAssessment(env, teacher, assessId);
  const at = await env.ORAL_KV.get(`attempt:${assessId}:${attemptId}`, "json");
  if (!at) throw new HttpError(404, "Attempt not found.");
  delete at.token;
  return { attempt: at };
}

// ---------------------------------------------------------------- student

async function assessmentByCode(env, code) {
  const c = normaliseCode(code);
  const id = c && (await env.ORAL_KV.get(`code:${c}`));
  const a = id && (await env.ORAL_KV.get(`assess:${id}`, "json"));
  if (!a) throw new HttpError(404, "That access code was not found. Please check it with your teacher.");
  if (!a.open) throw new HttpError(403, "This practice session is currently closed by your teacher.");
  return a;
}

async function publicAssessment(env, code) {
  const a = await assessmentByCode(env, code);
  return {
    assessment: {
      title: a.title,
      unit: a.unit,
      durationMin: a.durationMin,
      allowTyping: a.allowTyping,
      voice: a.voice,
      dailyAttempts: a.dailyAttempts,
      questionCount: a.baseQuestions.length,
      mode: a.mode || "submission",
    },
  };
}

async function startAttempt(env, code, input) {
  const a = await assessmentByCode(env, code);
  const studentName = str(input.studentName, 100).trim();
  const studentId = normaliseId(input.studentId);
  const submission = str(input.submissionText, LIMITS.submissionChars).trim();
  if (!studentName || !studentId) throw new HttpError(400, "Please enter your name and student ID.");
  const questionMode = a.mode === "questions";
  if (!questionMode && submission.length < 200) throw new HttpError(400, "The submission text is too short to examine. Please upload your full assignment.");
  if (questionMode && !a.baseQuestions.length && !a.topics) throw new HttpError(409, "This practice has no questions set yet. Please tell your teacher.");

  // Cost guards: attempts per student per day, and a global daily ceiling.
  const day = new Date().toISOString().slice(0, 10);
  const rateKey = `rate:${a.id}:${studentId}:${day}`;
  const used = parseInt((await env.ORAL_KV.get(rateKey)) || "0", 10);
  if (used >= a.dailyAttempts) throw new HttpError(429, `You have used all ${a.dailyAttempts} practice attempts for today. Please try again tomorrow.`);
  const budgetKey = `budget:${day}`;
  const globalUsed = parseInt((await env.ORAL_KV.get(budgetKey)) || "0", 10);
  const globalCap = parseInt(env.MAX_SESSIONS_PER_DAY || "300", 10);
  if (globalUsed >= globalCap) throw new HttpError(429, "The practice service has reached its daily limit. Please try again tomorrow.");

  const targetQuestions = Math.max(2, Math.min(6, Math.round(a.durationMin * 0.6)));
  const firstName = studentName.split(/\s+/)[0];
  const { system, user } = questionMode
    ? bankPrompt({ assessment: { ...a, __studentFirstName: firstName }, targetQuestions })
    : planPrompt({ assessment: { ...a, __studentFirstName: firstName }, submission, targetQuestions });
  const r = await callLLM(env, { tier: "smart", system, user, maxTokens: 1400 });
  let plan;
  try {
    plan = parseJSON(r.text);
  } catch (_) {
    throw new HttpError(502, "The examiner could not prepare questions. Please try again.");
  }
  plan.questions = (plan.questions || []).filter((q) => q && q.text).slice(0, questionMode ? targetQuestions : Math.max(targetQuestions, a.baseQuestions.length));
  if (!plan.questions.length) throw new HttpError(502, "The examiner could not prepare questions. Please try again.");
  const opening = str(plan.opening, 600) || `Hello ${firstName}. ${plan.questions[0].text}`;

  const typingAllowed = a.allowTyping || a.typingExemptIds.includes(studentId);
  const now = new Date();
  const attempt = {
    id: randomId(12),
    assessId: a.id,
    token: randomId(24),
    studentName,
    studentId,
    mode: a.mode || "submission",
    submissionChars: submission.length,
    submissionExcerpt: submission.slice(0, 1500),
    plan: { summary: str(plan.summary, 1500), keyPoints: (plan.keyPoints || []).slice(0, 8).map((k) => str(k, 300)), questions: plan.questions },
    qIndex: 0,
    followupsOnCurrent: 0,
    transcript: [{ role: "examiner", text: opening, t: 0 }],
    events: [],
    typingAllowed,
    typedCount: 0,
    startedAt: now.toISOString(),
    durationSec: a.durationMin * 60,
    status: "in_progress",
    usage: [r.usage],
  };
  await saveAttempt(env, attempt);
  await env.ORAL_KV.put(rateKey, String(used + 1), { expirationTtl: 60 * 60 * 48 });
  await env.ORAL_KV.put(budgetKey, String(globalUsed + 1), { expirationTtl: 60 * 60 * 48 });

  return {
    attemptRef: `${a.id}.${attempt.id}`,
    token: attempt.token,
    opening,
    durationSec: attempt.durationSec,
    typingAllowed,
    attemptsLeftToday: a.dailyAttempts - used - 1,
    voice: a.voice,
  };
}

async function loadAttempt(env, assessId, attemptId, token) {
  const at = await env.ORAL_KV.get(`attempt:${assessId}:${attemptId}`, "json");
  if (!at || !token || !safeEqual(at.token, String(token))) throw new HttpError(404, "Practice session not found.");
  return at;
}

async function takeTurn(env, assessId, attemptId, input) {
  const at = await loadAttempt(env, assessId, attemptId, input.token);
  if (at.status !== "in_progress") throw new HttpError(409, "This practice session has already ended.");
  const a = await env.ORAL_KV.get(`assess:${assessId}`, "json");
  if (!a) throw new HttpError(404, "Assessment not found.");

  const answer = str(input.answer, LIMITS.answerChars).trim() || "(no answer given)";
  const typed = Boolean(input.typed) && at.typingAllowed;
  const elapsed = (Date.now() - Date.parse(at.startedAt)) / 1000;
  const remainingSec = at.durationSec - elapsed;
  const latencyMs = Number.isFinite(input.latencyMs) ? Math.max(0, Math.min(120000, Math.round(input.latencyMs))) : null;
  at.transcript.push({ role: "student", text: answer, t: Math.round(elapsed), typed, latencyMs });
  if (typed) at.typedCount++;

  const questionsLeft = at.plan.questions.length - at.qIndex - 1;
  const examinerTurns = at.transcript.filter((t) => t.role === "examiner").length;
  const maxTurns = Math.ceil(a.durationMin * 2.2);

  let action, say;
  if (remainingSec <= 15 || examinerTurns >= maxTurns) {
    action = "close";
    say = "Thank you, that brings us to the end of our time. Well done for practising. Your feedback is being prepared now.";
  } else {
    const { system, user } = turnPrompt({ attempt: at, assessment: a, answer, remainingSec, questionsLeft });
    try {
      const r = await callLLM(env, { tier: "fast", system, user, maxTokens: 220 });
      const out = parseJSON(r.text);
      at.usage.push(r.usage);
      action = ["followup", "next", "close"].includes(out.action) ? out.action : "next";
      say = str(out.say, 600).trim();
    } catch (err) {
      if (err instanceof HttpError && err.status === 503) throw err;
      action = "next";
      say = "";
    }
    // Enforce the plan regardless of what the model chose. When the action is
    // overridden, the model's wording no longer fits, so planned wording is used.
    const chosen = action;
    if (action === "followup" && at.followupsOnCurrent >= a.maxFollowups) action = "next";
    if (action === "next" && questionsLeft <= 0) action = "close";
    if (action === "close" && questionsLeft > 0 && remainingSec > 45) action = "next";
    if (action !== chosen) say = "";
    if (action === "next" && (!say || !say.includes("?"))) {
      say = `Thank you. ${at.plan.questions[at.qIndex + 1].text}`;
    }
    if (action === "close" && !say) say = "Thank you for working through those questions with me. Your feedback is being prepared now.";
    if (action === "followup" && !say) say = "Could you give me a specific example from your submission to illustrate that?";
  }

  if (action === "followup") at.followupsOnCurrent++;
  if (action === "next") {
    at.qIndex++;
    at.followupsOnCurrent = 0;
  }
  at.transcript.push({ role: "examiner", text: say, t: Math.round(elapsed) });
  const done = action === "close";
  if (done) at.status = "awaiting_feedback";
  await saveAttempt(env, at);
  return { say, done, questionNumber: at.qIndex + 1, questionTotal: at.plan.questions.length };
}

async function logEvent(env, assessId, attemptId, input) {
  const at = await loadAttempt(env, assessId, attemptId, input.token);
  const type = str(input.type, 40);
  if (!["tab_hidden", "tab_visible", "window_blur", "mic_fallback", "typed_mode", "slow_start", "paste_blocked"].includes(type)) throw new HttpError(400, "Unknown event.");
  if (at.events.length < 200) {
    at.events.push({ type, t: Math.round((Date.now() - Date.parse(at.startedAt)) / 1000) });
    await saveAttempt(env, at);
  }
  return { ok: true };
}

async function finishAttempt(env, assessId, attemptId, input) {
  const at = await loadAttempt(env, assessId, attemptId, input.token);
  if (at.report) return { report: studentReport(at.report) };
  const a = await env.ORAL_KV.get(`assess:${assessId}`, "json");
  if (!a) throw new HttpError(404, "Assessment not found.");
  const answers = at.transcript.filter((t) => t.role === "student");
  if (!answers.length) {
    at.status = "abandoned";
    await saveAttempt(env, at);
    return { report: null, message: "No answers were recorded, so no feedback could be prepared." };
  }

  const { system, user } = markPrompt({ attempt: at, assessment: a });
  const r = await callLLM(env, { tier: "smart", system, user, maxTokens: 1400 });
  let report;
  try {
    report = parseJSON(r.text);
  } catch (_) {
    throw new HttpError(502, "Feedback could not be prepared. Please press the button to try again.");
  }
  report.overall = report.overall || {};
  report.overall.score = clampInt(report.overall.score, 0, 100, 0);
  report.generatedAt = new Date().toISOString();
  at.usage.push(r.usage);
  at.report = report;
  at.status = "completed";
  at.endedAt = new Date().toISOString();
  await saveAttempt(env, at);
  return { report: studentReport(report) };
}

// The authenticity note is for the teacher only.
function studentReport(report) {
  const { authenticity, ...rest } = report;
  return rest;
}

async function saveAttempt(env, at) {
  const tabSwitches = at.events.filter((e) => e.type === "tab_hidden").length;
  await env.ORAL_KV.put(`attempt:${at.assessId}:${at.id}`, JSON.stringify(at), {
    expirationTtl: 60 * 60 * 24 * parseInt(env.RETENTION_DAYS || "180", 10),
    metadata: {
      studentName: at.studentName.slice(0, 80),
      studentId: at.studentId,
      startedAt: at.startedAt,
      status: at.status,
      score: at.report?.overall?.score ?? null,
      band: at.report?.overall?.band ?? null,
      authenticity: at.report?.authenticity?.level ?? null,
      tabSwitches,
      slowStarts: at.events.filter((e) => e.type === "slow_start").length,
      typed: at.typedCount,
    },
  });
}

// ---------------------------------------------------------------- helpers

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "https://sage-framework.com,http://localhost:8080,http://127.0.0.1:8080").split(",").map((s) => s.trim());
  return {
    "access-control-allow-origin": allowed.includes(origin) ? origin : allowed[0],
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
}

async function body(request) {
  const len = parseInt(request.headers.get("content-length") || "0", 10);
  if (len > 300000) throw new HttpError(413, "Request too large.");
  try {
    return await request.json();
  } catch (_) {
    throw new HttpError(400, "Invalid JSON body.");
  }
}

function splitAttemptRef(ref) {
  const [a, b] = String(ref).split(".");
  if (!a || !b) throw new HttpError(404, "Practice session not found.");
  return [a, b];
}

async function uniqueCode(env) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let i = 0; i < 10; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
    if (!(await env.ORAL_KV.get(`code:${code}`))) return code;
  }
  throw new HttpError(500, "Could not allocate an access code.");
}

function randomId(n) {
  const alphabet = "abcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const str = (v, n) => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, n);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "teacher";
const normaliseId = (s) => str(s, 40).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
const normaliseCode = (s) => str(s, 12).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
