/// Thin wrapper over @anthropic-ai/claude-agent-sdk. Uses the local `claude`
/// CLI's subscription auth (no API key needed). Each call spawns a headless
/// session, prompt-caches the system prompt, and parses the final assistant
/// message. Intended for batch pipeline use from scripts/, not from the web
/// request path.
///
/// Design notes:
/// - We want structured outputs, so every call has a strict JSON rubric in the
///   system prompt and we parse the last fenced JSON block out of the final
///   text. Tools are disabled by default to keep responses terse; the research
///   agent overrides `tools` to enable WebFetch/WebSearch.
/// - Signal extraction and scoring share this wrapper; only the system prompt
///   differs. Both prompts are long enough (~1-2kB) that prompt caching is
///   worth enabling even on subscription for latency.

import { query } from "@anthropic-ai/claude-agent-sdk";

export type ClaudeRunOptions = {
  systemPrompt: string;
  userPrompt: string;
  /// Tool names to enable. Default: none (pure text-in text-out). Tools listed
  /// here are also auto-approved so the headless session doesn't stall on a
  /// permission prompt.
  tools?: string[];
  /// Max agent turns before we force termination. Default: 3 (enough for a
  /// couple of tool calls + final answer).
  maxTurns?: number;
  /// Short model name recognized by Claude Code ("sonnet", "haiku", "opus").
  model?: "sonnet" | "haiku" | "opus";
};

/// Runs a one-shot agent query and returns the final assistant text.
export async function runClaude(opts: ClaudeRunOptions): Promise<string> {
  const { systemPrompt, userPrompt, tools = [], maxTurns = 3, model = "sonnet" } = opts;

  let finalText = "";
  const q = query({
    prompt: userPrompt,
    options: {
      systemPrompt: { type: "preset", preset: "claude_code", append: systemPrompt },
      tools,
      allowedTools: tools,
      maxTurns,
      model,
      includePartialMessages: false,
    },
  });

  for await (const msg of q) {
    if (msg.type === "result" && msg.subtype === "success") {
      finalText = msg.result ?? "";
    }
  }
  if (!finalText) throw new Error("Claude agent returned no final result");
  return finalText;
}

/// Extracts the last ```json ... ``` fenced block from Claude's reply and parses it.
/// Falls back to parsing the whole response if no fence is found.
export function extractJson<T = unknown>(text: string): T {
  const fenceRegex = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
  let lastMatch: RegExpExecArray | null = null;
  for (let m = fenceRegex.exec(text); m; m = fenceRegex.exec(text)) lastMatch = m;
  const candidate = lastMatch ? lastMatch[1]! : text.trim();
  try {
    return JSON.parse(candidate) as T;
  } catch (err) {
    throw new Error(
      `Failed to parse JSON from Claude response: ${(err as Error).message}\n` +
        `--- response ---\n${text.slice(0, 500)}`,
    );
  }
}
