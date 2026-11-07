// Provider-neutral LLM access. The provider and models are chosen with
// environment variables so that Claude and OpenAI can be swapped without code changes.
//
//   LLM_PROVIDER     "anthropic" (default) or "openai"
//   LLM_API_KEY      secret, set with `wrangler secret put LLM_API_KEY`
//   LLM_MODEL_FAST   model used for live examiner turns (low latency, low cost)
//   LLM_MODEL_SMART  model used for question planning and marking

const DEFAULTS = {
  anthropic: { fast: "claude-haiku-5-5", smart: "claude-sonnet-5-5" },
  openai: { fast: "gpt-5.4-mini", smart: "gpt-5.4" },
};

export function modelFor(env, tier) {
  const provider = (env.LLM_PROVIDER || "anthropic").toLowerCase();
  const d = DEFAULTS[provider] || DEFAULTS.anthropic;
  if (tier === "smart") return env.LLM_MODEL_SMART || d.smart;
  return env.LLM_MODEL_FAST || d.fast;
}

export async function callLLM(env, { tier = "fast", system, user, maxTokens = 600 }) {
  // Test hook: a fake implementation may be injected for unit tests.
  if (env.__fakeLLM) return env.__fakeLLM({ tier, system, user, maxTokens });

  if (!env.LLM_API_KEY) throw new HttpError(503, "The AI service has not been configured yet (missing LLM_API_KEY).");
  const provider = (env.LLM_PROVIDER || "anthropic").toLowerCase();
  const model = modelFor(env, tier);

  let res;
  if (provider === "openai") {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.LLM_API_KEY}` },
      body: JSON.stringify({
        model,
        max_completion_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    const data = await safeJson(res);
    if (!res.ok) throw new HttpError(502, `AI provider error: ${data?.error?.message || res.status}`);
    return { text: data.choices?.[0]?.message?.content || "", usage: data.usage || null };
  }

  res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.LLM_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const data = await safeJson(res);
  if (!res.ok) throw new HttpError(502, `AI provider error: ${data?.error?.message || res.status}`);
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return { text, usage: data.usage || null };
}

// Extracts the first JSON object from a model reply, tolerating code fences or stray prose.
export function parseJSON(text) {
  if (!text) throw new Error("Empty AI reply");
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("AI reply was not valid JSON");
  }
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch (_) {
    return null;
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
