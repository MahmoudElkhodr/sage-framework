// End-to-end test of the Worker with an in-memory KV and a fake LLM.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

class MemoryKV {
  constructor() { this.m = new Map(); }
  async get(k, type) { const e = this.m.get(k); if (!e) return null; return type === "json" ? JSON.parse(e.v) : e.v; }
  async put(k, v, opts = {}) { this.m.set(k, { v, metadata: opts.metadata }); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix }) {
    const keys = [...this.m.entries()].filter(([k]) => k.startsWith(prefix)).map(([name, e]) => ({ name, metadata: e.metadata }));
    return { keys, list_complete: true };
  }
}

function fakeLLM({ system }) {
  if (system.includes("teacher's question bank")) {
    return { text: JSON.stringify({ summary: "Encryption basics", keyPoints: ["keys"], questions: [{ text: "How would a hospital share records securely?", focus: "x", source: "teacher" }], opening: "Hello Ann. How would a hospital share records securely?" }) };
  }
  if (system.includes("prepare a short practice oral examination plan")) {
    return { text: "```json\n" + JSON.stringify({
      summary: "The student designed a small office network with VLANs.",
      keyPoints: ["Three VLANs", "Chose OSPF"],
      questions: [
        { text: "Why did you separate staff and guest traffic into VLANs?", focus: "segmentation rationale", source: "teacher" },
        { text: "Why OSPF rather than static routes?", focus: "routing trade-offs", source: "ai" },
      ],
      opening: "Hello Sam. This is a five minute practice. Why did you separate staff and guest traffic into VLANs?",
    }) + "\n```", usage: { input_tokens: 10 } };
  }
  if (system.includes("live spoken practice examination")) {
    return { text: JSON.stringify({ action: "followup", say: "Could you name the specific VLAN IDs you used?" }) };
  }
  return { text: JSON.stringify({
    overall: { score: 72, band: "Credit" },
    criteria: [{ criterion: "Understanding", score: 18, max: 25, evidence: "guests cannot reach", comment: "Clear." }],
    strengths: ["Clear rationale"], improvements: ["Quote figures"], studentFeedback: "Good work.",
    authenticity: { level: "consistent", notes: "Matches submission." },
  }) };
}

const env = { ORAL_KV: new MemoryKV(), TEACHER_KEYS: "Mahmoud Elkhodr:secret-key-123", LLM_API_KEY: "x", __fakeLLM: fakeLLM };
const call = async (method, path, body, key) => {
  const res = await worker.fetch(new Request("https://w.example" + path, {
    method,
    headers: { "content-type": "application/json", origin: "https://sage-framework.com", ...(key ? { authorization: "Bearer " + key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  return { status: res.status, data: await res.json(), cors: res.headers.get("access-control-allow-origin") };
};

test("full practice flow", async () => {
  assert.equal((await call("GET", "/api/teacher/me", null, "wrong")).status, 403);
  const me = await call("GET", "/api/teacher/me", null, "secret-key-123");
  assert.equal(me.data.name, "Mahmoud Elkhodr");
  assert.equal(me.cors, "https://sage-framework.com");

  const created = await call("POST", "/api/teacher/assessments", {
    title: "Network design report", unit: "COIT11238",
    spec: "Design a small office network with segmentation and routing, justify every decision.",
    rubric: "Understanding 25, Justification 25, Evidence 25, Communication 25",
    baseQuestions: ["Why did you segment the network?"], dailyAttempts: 2,
  }, "secret-key-123");
  assert.equal(created.status, 200);
  const a = created.data.assessment;
  assert.equal(a.durationMin, 5);
  assert.match(a.code, /^[A-Z0-9]{6}$/);

  const pub = await call("GET", `/api/practice/${a.code.toLowerCase()}`);
  assert.equal(pub.data.assessment.title, "Network design report");
  assert.equal(pub.data.assessment.spec, undefined);

  const submissionText = "My network uses three VLANs. ".repeat(20);
  const start = await call("POST", `/api/practice/${a.code}/start`, { studentName: "Sam Lee", studentId: "s123", submissionText });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  assert.match(start.data.opening, /Hello Sam/);
  const { attemptRef, token } = start.data;

  assert.equal((await call("POST", `/api/attempt/${attemptRef}/turn`, { token: "bad", answer: "x" })).status, 404);

  const t1 = await call("POST", `/api/attempt/${attemptRef}/turn`, { token, answer: "To keep guests away from staff." });
  assert.equal(t1.data.done, false);
  assert.match(t1.data.say, /VLAN IDs/);
  // maxFollowups defaults to 1, so a second follow-up request is converted into the next question.
  const t2 = await call("POST", `/api/attempt/${attemptRef}/turn`, { token, answer: "VLAN 10 and 20." });
  assert.match(t2.data.say, /OSPF/);
  assert.equal(t2.data.questionNumber, 2);
  // Last question: the model asks for a follow-up first, then the plan forces a close.
  await call("POST", `/api/attempt/${attemptRef}/turn`, { token, answer: "It scales." });
  const t4 = await call("POST", `/api/attempt/${attemptRef}/turn`, { token, answer: "Area 0." });
  assert.equal(t4.data.done, true);

  await call("POST", `/api/attempt/${attemptRef}/event`, { token, type: "tab_hidden" });
  const fin = await call("POST", `/api/attempt/${attemptRef}/finish`, { token });
  assert.equal(fin.data.report.overall.score, 72);
  assert.equal(fin.data.report.authenticity, undefined, "authenticity is hidden from students");

  const list = await call("GET", `/api/teacher/assessments/${a.id}/attempts`, null, "secret-key-123");
  assert.equal(list.data.attempts.length, 1);
  assert.equal(list.data.attempts[0].score, 72);
  assert.equal(list.data.attempts[0].tabSwitches, 1);
  const full = await call("GET", `/api/teacher/attempts/${a.id}/${list.data.attempts[0].attemptId}`, null, "secret-key-123");
  assert.equal(full.data.attempt.report.authenticity.level, "consistent");
  assert.equal(full.data.attempt.token, undefined);

  // Daily cap of 2: second start allowed, third refused.
  assert.equal((await call("POST", `/api/practice/${a.code}/start`, { studentName: "Sam Lee", studentId: "S123", submissionText })).status, 200);
  const third = await call("POST", `/api/practice/${a.code}/start`, { studentName: "Sam Lee", studentId: "s123", submissionText });
  assert.equal(third.status, 429);
});

test("question bank mode needs no submission", async () => {
  const created = await call("POST", "/api/teacher/assessments", { title: "Crypto viva", mode: "questions", spec: "Oral questions on symmetric and asymmetric encryption for revision.", baseQuestions: ["Q1", "Q2", "Q3"] }, "secret-key-123");
  const a = created.data.assessment;
  assert.equal(a.mode, "questions");
  assert.equal((await call("GET", `/api/practice/${a.code}`)).data.assessment.mode, "questions");
  const start = await call("POST", `/api/practice/${a.code}/start`, { studentName: "Ann Wu", studentId: "s9", submissionText: "" });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  assert.match(start.data.opening, /hospital/);
});
