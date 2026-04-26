/// Small dispatcher that lets the signals stage swap between Claude (via the
/// Agent SDK + subscription) and a local Ollama model. The research stage
/// still uses Claude directly — local models are much weaker at tool-using
/// agentic reasoning, so this only makes sense for the classify/extract job.
///
/// Toggle via env:
///   SIGNALS_PROVIDER=claude          (default; uses your subscription)
///   SIGNALS_PROVIDER=ollama          (zero rate limits, slightly weaker)
///   OLLAMA_SIGNALS_MODEL=qwen2.5:14b-instruct   (default when provider=ollama)
///   OLLAMA_HOST=http://127.0.0.1:11434           (shared with embed stage)

import { Ollama } from "ollama";
import { runClaude } from "./claude";

export type LLMOptions = {
  systemPrompt: string;
  userPrompt: string;
};

/// One-shot "read this text, emit structured JSON" call. Returns the raw
/// assistant text — parse it with `extractJson` from `./claude`.
///
/// Ollama's `format: "json"` forces valid-JSON output, which is the main
/// reliability gap between small local models and Claude. Without it, local
/// 14B models emit malformed JSON in ~5% of calls, enough to be annoying.
export async function runTextClassifier(opts: LLMOptions): Promise<string> {
  const provider = (process.env.SIGNALS_PROVIDER ?? "claude").toLowerCase();
  if (provider === "ollama") return runOllamaJson(opts);
  if (provider !== "claude") {
    throw new Error(
      `Unknown SIGNALS_PROVIDER='${provider}' — expected 'claude' or 'ollama'`,
    );
  }
  return runClaude({
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    model: "sonnet",
    maxTurns: 1,
  });
}

async function runOllamaJson(opts: LLMOptions): Promise<string> {
  const model = process.env.OLLAMA_SIGNALS_MODEL ?? "qwen2.5:14b-instruct";
  const host = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  const ollama = new Ollama({ host });
  const res = await ollama.chat({
    model,
    format: "json",
    options: { temperature: 0 },
    messages: [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: opts.userPrompt },
    ],
  });
  return res.message.content;
}
