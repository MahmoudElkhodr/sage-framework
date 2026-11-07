// API client. Uses the Cloudflare Worker when CONFIG.apiBase is set,
// otherwise a local demo backend that mimics the same endpoints.
import { CONFIG } from "./config.js";

export const isDemo = !CONFIG.apiBase;

export async function api(method, path, body, teacherKey) {
  if (isDemo) return demo(method, path, body, teacherKey);
  const res = await fetch(CONFIG.apiBase.replace(/\/$/, "") + path, {
    method,
    headers: { "content-type": "application/json", ...(teacherKey ? { authorization: `Bearer ${teacherKey}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status}).`);
  return data;
}

// ------------------------------------------------------------- demo backend

const DEMO_KEY = "demo";
const store = {
  get(k) {
    try {
      return JSON.parse(localStorage.getItem("sage-oral:" + k));
    } catch (_) {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem("sage-oral:" + k, JSON.stringify(v));
    } catch (_) {}
  },
};
const rid = (n = 10) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");

function demoSeed() {
  let list = store.get("assessments");
  if (list && list.length) return list;
  list = [
    {
      id: "demo1",
      code: "DEMO01",
      owner: "demo",
      title: "Sample: Small office network design report",
      unit: "COIT11238",
      spec: "Students design a network for a 20-person office. The report must justify the topology, IP addressing plan, VLAN segmentation, routing choice and at least two security controls, citing evidence.",
      rubric: "Understanding of design (25), Justification of decisions (25), Use of evidence (25), Communication (25)",
      baseQuestions: ["Walk me through the single most important design decision in your report and why you made it.", "If the office doubled in size next year, what in your design would need to change first?"],
      durationMin: 5,
      maxFollowups: 1,
      dailyAttempts: 3,
      allowTyping: true,
      typingExemptIds: [],
      voice: "bf_emma",
      open: true,
      createdAt: new Date().toISOString(),
    },
  ];
  store.set("assessments", list);
  return list;
}

async function demo(method, path, body, key) {
  await new Promise((r) => setTimeout(r, 350));
  const p = path.split("/").filter(Boolean);
  const list = demoSeed();
  const err = (m) => {
    throw new Error(m);
  };

  if (p[1] === "teacher") {
    if (key !== DEMO_KEY) err('In demo mode the teacher key is "demo".');
    if (p[2] === "me") return { name: "Demo teacher" };
    if (p[2] === "assessments" && !p[3] && method === "GET") return { assessments: list };
    if (p[2] === "assessments" && method === "POST") {
      const a = { ...normalise(body), id: rid(), code: rid(6).toUpperCase(), owner: "demo", createdAt: new Date().toISOString() };
      list.unshift(a);
      store.set("assessments", list);
      return { assessment: a };
    }
    const a = list.find((x) => x.id === p[3]);
    if (!a) err("Assessment not found.");
    if (!p[4] && method === "GET") return { assessment: a };
    if (!p[4] && method === "PUT") {
      Object.assign(a, normalise(body), { updatedAt: new Date().toISOString() });
      store.set("assessments", list);
      return { assessment: a };
    }
    if (!p[4] && method === "DELETE") {
      store.set("assessments", list.filter((x) => x.id !== a.id));
      return { deleted: true };
    }
    if (p[4] === "attempts") {
      const atts = (store.get("attempts") || []).filter((x) => x.assessId === a.id);
      return { attempts: atts.map((x) => ({ attemptId: x.id, studentName: x.studentName, studentId: x.studentId, startedAt: x.startedAt, status: x.status, score: x.report?.overall?.score ?? null, band: x.report?.overall?.band ?? null, authenticity: x.report?.authenticity?.level ?? null, tabSwitches: x.events.filter((e) => e.type === "tab_hidden").length, typed: x.typedCount })) };
    }
  }
  if (p[1] === "teacher" && p[2] === "attempts") {
    // handled above via p[3] lookup failing; kept for clarity
  }
  if (p[1] === "practice") {
    const a = list.find((x) => x.code === String(p[2]).toUpperCase());
    if (!a) err('Access code not found. In demo mode try "DEMO01".');
    if (!p[3]) return { assessment: { title: a.title, unit: a.unit, durationMin: a.durationMin, allowTyping: a.allowTyping, voice: a.voice, dailyAttempts: a.dailyAttempts, questionCount: a.baseQuestions.length, mode: a.mode || "submission" } };
    if (p[3] === "start") {
      if (!body.studentName || !body.studentId) err("Please enter your name and student ID.");
      if (a.mode !== "questions" && (body.submissionText || "").length < 200) err("The submission text is too short to examine. Please upload your full assignment.");
      const first = body.studentName.split(/\s+/)[0];
      const questions = [...a.baseQuestions, "Which source or piece of evidence in your work are you most confident about, and why?", "What is one limitation of your work that you would address with more time?"].slice(0, Math.max(3, a.baseQuestions.length));
      const at = {
        id: rid(12), assessId: a.id, token: rid(20), studentName: body.studentName, studentId: body.studentId,
        questions, qIndex: 0, followups: 0, transcript: [], events: [], typedCount: 0,
        startedAt: new Date().toISOString(), durationSec: a.durationMin * 60, status: "in_progress",
      };
      const opening = `Hello ${first}. I am Sage. This is a ${a.durationMin} minute practice session about your work, and there are no wrong answers in practice. ${questions[0]}`;
      at.transcript.push({ role: "examiner", text: opening, t: 0 });
      saveDemoAttempt(at);
      return { attemptRef: `${a.id}.${at.id}`, token: at.token, opening, durationSec: at.durationSec, typingAllowed: a.allowTyping, attemptsLeftToday: a.dailyAttempts - 1, voice: a.voice };
    }
  }
  if (p[1] === "attempt") {
    const id = p[2].split(".")[1];
    const atts = store.get("attempts") || [];
    const at = atts.find((x) => x.id === id && x.token === body.token);
    if (!at) err("Practice session not found.");
    const elapsed = (Date.now() - Date.parse(at.startedAt)) / 1000;
    if (p[3] === "event") {
      at.events.push({ type: body.type, t: Math.round(elapsed) });
      saveDemoAttempt(at);
      return { ok: true };
    }
    if (p[3] === "turn") {
      const answer = (body.answer || "").trim() || "(no answer given)";
      at.transcript.push({ role: "student", text: answer, t: Math.round(elapsed), typed: !!body.typed });
      if (body.typed) at.typedCount++;
      let say, done = false;
      const words = answer.split(/\s+/).length;
      if (elapsed > at.durationSec - 15 || at.qIndex >= at.questions.length - 1 && (at.followups >= 1 || words > 25)) {
        say = "Thank you, that is the end of our practice session. Your feedback is being prepared now.";
        done = true;
        at.status = "awaiting_feedback";
      } else if (words < 25 && at.followups < 1) {
        at.followups++;
        say = "Thank you. Could you expand on that with a specific example from your own submission?";
      } else {
        at.qIndex++;
        at.followups = 0;
        say = `Thank you. ${at.questions[at.qIndex]}`;
      }
      at.transcript.push({ role: "examiner", text: say, t: Math.round(elapsed) });
      saveDemoAttempt(at);
      return { say, done, questionNumber: at.qIndex + 1, questionTotal: at.questions.length };
    }
    if (p[3] === "finish") {
      const answers = at.transcript.filter((t) => t.role === "student").map((t) => t.text);
      const total = answers.join(" ").split(/\s+/).filter(Boolean).length;
      const score = Math.max(35, Math.min(88, 40 + Math.round(total / 6)));
      const band = score >= 85 ? "High Distinction" : score >= 75 ? "Distinction" : score >= 65 ? "Credit" : score >= 50 ? "Pass" : "Fail";
      const longest = answers.slice().sort((x, y) => y.length - x.length)[0] || "";
      at.report = {
        overall: { score, band },
        criteria: ["Understanding", "Justification", "Use of evidence", "Communication"].map((c, i) => ({ criterion: c, score: Math.round((score / 100) * 25 - (i % 2)), max: 25, evidence: longest.slice(0, 90), comment: "Simulated comment: in the live version this is written by the AI marker from your answers." })),
        strengths: ["You engaged with every question."],
        improvements: ["Refer to specific figures, sources or decisions in your submission.", "Explain the reason behind each choice, not only what you did."],
        studentFeedback: "This is DEMO feedback, simulated from the length of your answers rather than their content. Connect the tool to the AI service to receive genuine feedback.",
        authenticity: { level: "consistent", notes: "Demo mode: no authenticity analysis performed." },
        generatedAt: new Date().toISOString(),
      };
      at.status = "completed";
      saveDemoAttempt(at);
      const { authenticity, ...student } = at.report;
      return { report: student };
    }
  }
  err("Not available in demo mode.");
}

export async function demoAttemptDetail(assessId, attemptId) {
  const at = (store.get("attempts") || []).find((x) => x.id === attemptId && x.assessId === assessId);
  if (!at) throw new Error("Attempt not found.");
  return { attempt: { ...at, token: undefined, plan: { summary: "(Demo mode: no AI summary.)", questions: at.questions.map((q) => ({ text: q })) } } };
}

function saveDemoAttempt(at) {
  const atts = (store.get("attempts") || []).filter((x) => x.id !== at.id);
  atts.unshift(at);
  store.set("attempts", atts.slice(0, 100));
}

function normalise(b) {
  return {
    mode: b.mode === "questions" ? "questions" : "submission",
    title: String(b.title || "").slice(0, 200),
    unit: String(b.unit || "").slice(0, 100),
    spec: String(b.spec || ""),
    rubric: String(b.rubric || ""),
    baseQuestions: (b.baseQuestions || []).filter(Boolean).slice(0, 8),
    durationMin: Math.min(15, Math.max(3, parseInt(b.durationMin, 10) || 5)),
    maxFollowups: Math.min(3, Math.max(0, parseInt(b.maxFollowups, 10) || 0)),
    dailyAttempts: Math.min(20, Math.max(1, parseInt(b.dailyAttempts, 10) || 3)),
    allowTyping: !!b.allowTyping,
    typingExemptIds: String(b.typingExemptIds || "").split(/[\s,;]+/).filter(Boolean),
    voice: b.voice || "bf_emma",
    open: b.open !== false,
  };
}

export async function teacherAttempt(assessId, attemptId, key) {
  if (isDemo) return demoAttemptDetail(assessId, attemptId);
  return api("GET", `/api/teacher/attempts/${assessId}/${attemptId}`, null, key);
}
