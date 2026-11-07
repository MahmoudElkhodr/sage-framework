// Teacher section: sign in, create and edit assessments, share links, review attempts.
import { api, isDemo, teacherAttempt } from "./api.js";
import { $, el, show, copy, demoBanner, renderReport, fmtTime, toast } from "./ui.js";
import { extractText } from "./extract.js";

demoBanner(isDemo, $("#banner"));

let key = sessionStorage.getItem("sage-oral-teacher") || "";
let current = null; // assessment being edited or reviewed
let attemptsCache = [];

function view(name) {
  for (const v of ["login", "list", "edit", "results"]) show($(`#v-${v}`), v === name);
  show($("#error"), false);
  window.scrollTo({ top: 0 });
}
function error(msg) {
  const e = $("#error");
  e.textContent = msg;
  show(e, true);
  window.scrollTo({ top: 0, behavior: "smooth" });
}
document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => loadList()));

const practiceLink = (code) => new URL(`practice.html?code=${code}`, location.href).href;

// ---------------------------------------------------------------- sign in
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  key = $("#tkey").value.trim();
  await signIn();
});
async function signIn() {
  try {
    const me = await api("GET", "/api/teacher/me", null, key);
    sessionStorage.setItem("sage-oral-teacher", key);
    $("#who").textContent = `Signed in as ${me.name}`;
    await loadList();
  } catch (err) {
    sessionStorage.removeItem("sage-oral-teacher");
    view("login");
    error(err.message);
  }
}
$("#logout").addEventListener("click", () => {
  sessionStorage.removeItem("sage-oral-teacher");
  key = "";
  view("login");
});

// ---------------------------------------------------------------- list
async function loadList() {
  try {
    const { assessments } = await api("GET", "/api/teacher/assessments", null, key);
    const box = $("#list");
    box.textContent = "";
    if (!assessments.length) {
      box.append(el("p", { class: "muted", text: "No practice assessments yet. Create one to get a link for your students." }));
    } else {
      box.append(
        el("table", {},
          el("thead", {}, el("tr", {}, el("th", { text: "Assessment" }), el("th", { text: "Access code" }), el("th", { text: "Status" }), el("th", { text: "" }))),
          el("tbody", {}, assessments.map((a) =>
            el("tr", {},
              el("td", {}, el("strong", { text: a.title }), el("div", { class: "small muted", text: [a.unit, a.mode === "questions" ? "Question bank" : "Own work"].filter(Boolean).join(" · ") })),
              el("td", {}, el("code", { text: a.code })),
              el("td", { text: a.open === false ? "Closed" : "Open" }),
              el("td", { style: "white-space:nowrap" },
                el("button", { class: "btn small", type: "button", text: "Results", onclick: () => openResults(a.id) }), " ",
                el("button", { class: "btn small secondary", type: "button", text: "Edit", onclick: () => openEditor(a.id) }), " ",
                el("button", { class: "btn small secondary", type: "button", text: "Copy link", onclick: () => copy(practiceLink(a.code)) })
              )
            )
          ))
        )
      );
    }
    view("list");
  } catch (err) {
    error(err.message);
  }
}

// ---------------------------------------------------------------- editor
function addQuestion(text = "") {
  const row = el("div", { class: "q-item" },
    el("input", { type: "text", maxlength: "400", value: text, placeholder: "e.g. Explain the most important decision in your work and why you made it." }),
    el("button", { class: "btn small secondary", type: "button", text: "Remove", onclick: () => row.remove() })
  );
  $("#q-list").append(row);
}
$("#add-q").addEventListener("click", () => addQuestion());
function modeText() {
  const bank = $("#f-mode").value === "questions";
  show($("#topics-block"), bank);
  $("#details-summary").textContent = bank ? "Optional: specification, rubric and your own questions" : "Specification, rubric and questions";
  if (bank && !$("#f-spec").value && !document.querySelector("#q-list input")?.value) $("#details-block").open = false;
  else $("#details-block").open = true;
  $("#q-hint").textContent = bank
    ? "(your question bank, up to 15; each student gets a random selection, reworded with a different scenario or angle)"
    : "(asked of every student, rephrased around each student's own submission; for a 5-minute session, 2 or 3 work best)";
  $("#q-note").textContent = bank
    ? "About 3 questions are asked in a 5-minute session, so a bank of 6 or more gives students different questions on each attempt."
    : "Sage fills any remaining time with adaptive questions about the student's own work.";
}
$("#f-mode").addEventListener("change", modeText);
$("#new").addEventListener("click", () => openEditor(null));
$("#quick").addEventListener("click", async () => {
  await openEditor(null, { mode: "questions", durationMin: 5, maxFollowups: 1, dailyAttempts: 5, voice: "bf_emma", open: true, baseQuestions: [] });
  $("#edit-title").textContent = "Quick practice";
  $("#f-title").focus();
});
$("#cancel").addEventListener("click", () => loadList());

for (const [fileSel, areaSel] of [["#f-spec-file", "#f-spec"], ["#f-rubric-file", "#f-rubric"]]) {
  $(fileSel).addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      $(areaSel).value = await extractText(f);
      toast("File read");
    } catch (err) {
      error(err.message);
    }
  });
}

async function openEditor(id, preset = null) {
  current = null;
  $("#edit-form").reset();
  $("#q-list").textContent = "";
  if (id) {
    try {
      current = (await api("GET", `/api/teacher/assessments/${id}`, null, key)).assessment;
    } catch (err) {
      return error(err.message);
    }
  }
  const a = current || preset || { durationMin: 5, maxFollowups: 1, dailyAttempts: 3, voice: "bf_emma", open: true, baseQuestions: ["", ""] };
  $("#edit-title").textContent = current ? `Edit: ${current.title}` : "New practice assessment";
  $("#f-mode").value = a.mode || "submission";
  $("#f-topics").value = a.topics || "";
  modeText();
  $("#f-title").value = a.title || "";
  $("#f-unit").value = a.unit || "";
  $("#f-spec").value = a.spec || "";
  $("#f-rubric").value = a.rubric || "";
  $("#f-dur").value = String(a.durationMin);
  $("#f-fu").value = String(a.maxFollowups);
  $("#f-att").value = String(a.dailyAttempts);
  $("#f-voice").value = a.voice;
  $("#f-exempt").value = (a.typingExemptIds || []).join(", ");
  $("#f-open").checked = a.open !== false;
  (a.baseQuestions.length ? a.baseQuestions : [""]).forEach(addQuestion);
  modeText();
  show($("#delete"), !!current);
  view("edit");
}

$("#edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    mode: $("#f-mode").value,
    topics: $("#f-topics").value,
    title: $("#f-title").value,
    unit: $("#f-unit").value,
    spec: $("#f-spec").value,
    rubric: $("#f-rubric").value,
    baseQuestions: [...document.querySelectorAll("#q-list input")].map((i) => i.value.trim()).filter(Boolean),
    durationMin: $("#f-dur").value,
    maxFollowups: $("#f-fu").value,
    dailyAttempts: $("#f-att").value,
    voice: $("#f-voice").value,
    allowTyping: false,
    typingExemptIds: $("#f-exempt").value,
    open: $("#f-open").checked,
  };
  try {
    const r = current
      ? await api("PUT", `/api/teacher/assessments/${current.id}`, body, key)
      : await api("POST", "/api/teacher/assessments", body, key);
    toast("Saved");
    openResults(r.assessment.id);
  } catch (err) {
    error(err.message);
  }
});

$("#delete").addEventListener("click", async () => {
  if (!current || !confirm(`Delete "${current.title}"? Students will no longer be able to use its access code.`)) return;
  try {
    await api("DELETE", `/api/teacher/assessments/${current.id}`, null, key);
    toast("Deleted");
    loadList();
  } catch (err) {
    error(err.message);
  }
});

// ---------------------------------------------------------------- results
async function openResults(id) {
  try {
    current = (await api("GET", `/api/teacher/assessments/${id}`, null, key)).assessment;
    const { attempts } = await api("GET", `/api/teacher/assessments/${id}/attempts`, null, key);
    attemptsCache = attempts;
  } catch (err) {
    return error(err.message);
  }
  $("#r-title").textContent = current.title;
  const link = practiceLink(current.code);
  const share = $("#r-share");
  share.textContent = "";
  share.append(
    el("span", {}, "Access code ", el("span", { class: "code-big", text: current.code })),
    el("code", { text: link }),
    el("button", { class: "btn small", type: "button", text: "Copy link", onclick: () => copy(link) }),
    el("button", { class: "btn small secondary", type: "button", text: "Edit settings", onclick: () => openEditor(current.id) })
  );
  const box = $("#attempts");
  box.textContent = "";
  show($("#detail"), false);
  const attempts = attemptsCache;
  if (!attempts.length) {
    box.append(el("p", { class: "muted", text: "No attempts yet. Share the link or access code with your students." }));
  } else {
    box.append(
      el("table", {},
        el("thead", {}, el("tr", {}, ["Student", "ID", "Started", "Status", "AI mark", "Authenticity", "Tab switches", "Slow starts", "Typed"].map((h) => el("th", { text: h })))),
        el("tbody", {}, attempts.map((a) =>
          el("tr", { class: "clickable", onclick: () => openAttempt(a.attemptId) },
            el("td", { text: a.studentName }),
            el("td", { text: a.studentId }),
            el("td", { text: new Date(a.startedAt).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" }) }),
            el("td", { text: (a.status || "").replace(/_/g, " ") }),
            el("td", { text: a.score == null ? "" : `${a.score} (${a.band || ""})` }),
            el("td", { text: a.authenticity || "" }),
            el("td", { text: String(a.tabSwitches ?? 0) }),
            el("td", { text: String(a.slowStarts ?? 0) }),
            el("td", { text: String(a.typed ?? 0) })
          )
        ))
      )
    );
  }
  view("results");
}

async function openAttempt(attemptId) {
  const box = $("#detail");
  box.textContent = "Loading...";
  show(box, true);
  try {
    const { attempt: at } = await teacherAttempt(current.id, attemptId, key);
    box.textContent = "";
    box.append(
      el("h2", { text: `${at.studentName} (${at.studentId})` }),
      el("p", { class: "muted small", text: `Started ${new Date(at.startedAt).toLocaleString("en-AU")} · ${(at.status || "").replace(/_/g, " ")} · ${at.events.filter((e) => e.type === "tab_hidden").length} tab switches · ${at.typedCount || 0} typed answers` }),
      el("h3", { text: "AI feedback" }),
      renderReport(at.report, { teacher: true }),
      el("h3", { text: "Transcript" }),
      el("div", { class: "log", style: "max-height:none" }, at.transcript.map((t) => el("p", {}, el("b", { text: `${t.role === "examiner" ? "Sage" : "Student"}${t.typed ? " (typed)" : ""} [${fmtTime(t.t || 0)}]${t.latencyMs != null ? ` (began after ${(t.latencyMs / 1000).toFixed(1)} s)` : ""}: ` }), t.text))),
      at.plan?.summary ? el("div", {}, el("h3", { text: "Sage's reading of the submission" }), el("p", { text: at.plan.summary })) : null,
      at.plan?.questions ? el("div", {}, el("h3", { text: "Question plan" }), el("ol", {}, at.plan.questions.map((q) => el("li", { text: `${q.text}${q.source ? ` (${q.source})` : ""}` })))) : null,
      at.events.length ? el("div", {}, el("h3", { text: "Session events" }), el("p", { class: "small", text: at.events.map((e) => `${e.type.replace(/_/g, " ")} at ${fmtTime(e.t)}`).join("; ") })) : null
    );
    box.scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    box.textContent = err.message;
  }
}

$("#csv").addEventListener("click", () => {
  const rows = [["Student", "Student ID", "Started", "Status", "AI mark", "Band", "Authenticity", "Tab switches", "Typed answers"]];
  for (const a of attemptsCache) rows.push([a.studentName, a.studentId, a.startedAt, a.status, a.score ?? "", a.band ?? "", a.authenticity ?? "", a.tabSwitches ?? 0, a.typed ?? 0]);
  const cell = (v) => {
    let t = String(v);
    if (/^[=+\-@]/.test(t)) t = "'" + t; // avoid spreadsheet formula injection
    return `"${t.replace(/"/g, '""')}"`;
  };
  const csv = rows.map((r) => r.map(cell).join(",")).join("\n");
  const a = el("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: `${current.title.replace(/[^a-z0-9]+/gi, "-")}-attempts.csv` });
  document.body.append(a);
  a.click();
  a.remove();
});

if (key) signIn();
else view("login");
