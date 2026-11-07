// Small DOM helpers. All user and AI text is inserted with textContent, never innerHTML.
export const $ = (sel, root = document) => root.querySelector(sel);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  return node;
}

export function show(node, on = true) {
  node.classList.toggle("hidden", !on);
}

export function toast(msg, ms = 2600) {
  const t = el("div", { class: "toast", role: "status", text: msg });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch (_) {
    prompt("Copy this:", text);
  }
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

export function demoBanner(isDemo, root) {
  if (!isDemo) return;
  root.prepend(
    el("div", { class: "demo-banner" },
      el("strong", { text: "Demo mode. " }),
      "The AI service is not connected yet, so the examiner follows a fixed script and the mark is simulated. Data is stored only in this browser. Teacher key: ",
      el("code", { text: "demo" }), ". Student access code: ", el("code", { text: "DEMO01" }), "."
    )
  );
}

// Renders an AI feedback report (shared by the student and teacher views).
export function renderReport(report, { teacher = false } = {}) {
  const box = el("div");
  if (!report) return el("p", { class: "muted", text: "No feedback was produced for this attempt." });
  const o = report.overall || {};
  box.append(
    el("div", { class: "score" }, el("strong", { text: `${o.score ?? "?"}` }), el("span", { class: "muted", text: "/ 100" }), el("span", { class: "band", text: o.band || "" })),
    el("div", { class: "disclaimer" },
      el("strong", { text: "AI-generated practice mark. " }),
      "This mark and feedback were produced automatically to help you prepare. They are indicative only, are not an official result, and a human marker may assess your work differently."
    )
  );
  if (report.studentFeedback) box.append(el("p", { text: report.studentFeedback }));
  if (Array.isArray(report.criteria) && report.criteria.length) {
    box.append(
      el("h3", { text: "By criterion" }),
      el("table", {},
        el("thead", {}, el("tr", {}, el("th", { text: "Criterion" }), el("th", { text: "Score" }), el("th", { text: "Evidence and comment" }))),
        el("tbody", {}, report.criteria.map((c) =>
          el("tr", {},
            el("td", { text: c.criterion || "" }),
            el("td", { text: `${c.score ?? ""}${c.max ? " / " + c.max : ""}` }),
            el("td", {}, c.evidence ? el("div", { class: "muted small", text: `"${c.evidence}"` }) : null, el("div", { text: c.comment || "" }))
          )
        ))
      )
    );
  }
  const list = (title, items) => (items && items.length ? [el("h3", { text: title }), el("ul", { class: "tight" }, items.map((i) => el("li", { text: i })))] : []);
  box.append(...list("Strengths", report.strengths), ...list("To work on before your next attempt", report.improvements));
  if (teacher && report.authenticity) {
    box.append(el("h3", { text: "Authenticity indicator (teacher only)" }), el("p", {}, el("strong", { text: report.authenticity.level + ". " }), report.authenticity.notes || ""));
  }
  return box;
}
