// Extracts plain text from an uploaded assignment in the browser.
// Supports PDF (pdf.js), Word .docx (mammoth) and plain text or markdown.
const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build";
const MAMMOTH = "https://cdn.jsdelivr.net/npm/mammoth@1.13.0/mammoth.browser.min.js";

export async function extractText(file) {
  const name = file.name.toLowerCase();
  if (file.size > 25 * 1024 * 1024) throw new Error("That file is larger than 25 MB.");
  if (name.endsWith(".pdf")) return tidy(await pdfText(file));
  if (name.endsWith(".docx")) return tidy(await docxText(file));
  if (/\.(txt|md|markdown|text|csv)$/.test(name)) return tidy(await file.text());
  if (name.endsWith(".doc")) throw new Error("Old .doc files are not supported. Please save as .docx or PDF.");
  throw new Error("Please upload a PDF, Word (.docx) or text file.");
}

async function pdfText(file) {
  const pdfjs = await import(`${PDFJS}/pdf.min.mjs`);
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.mjs`;
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let i = 1; i <= Math.min(doc.numPages, 80); i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => it.str + (it.hasEOL ? "\n" : " ")).join(""));
  }
  const text = pages.join("\n\n");
  if (text.replace(/\s/g, "").length < 100) throw new Error("No text could be read from this PDF. It may be a scanned image; please upload the original Word file instead.");
  return text;
}

async function docxText(file) {
  if (!window.mammoth) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = MAMMOTH;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load the Word reader. Please check your connection."));
      document.head.appendChild(s);
    });
  }
  const r = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return r.value;
}

function tidy(t) {
  return t.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}
