import { prisma } from "@/lib/db";

/// Ensures a Source row exists and returns its id. Called by every ingest path
/// (HTTP route handlers + tsx scripts).
export async function ensureSource(
  name: string,
  config?: Record<string, unknown>,
): Promise<string> {
  const existing = await prisma.source.findUnique({ where: { name } });
  if (existing) return existing.id;
  const created = await prisma.source.create({
    data: {
      name,
      config: config ? JSON.stringify(config) : null,
    },
  });
  return created.id;
}

/// Keyword gate applied before expensive LLM work. Matches "I wish", "is there a
/// tool", "how do you", "hate X", "spend $X", "hours per", etc. Deliberately
/// loose — we'd rather over-keep than miss a signal, since Claude extraction
/// is essentially free.
const PAIN_PATTERNS = [
  /\bi (wish|need|hate|want|can't|cannot)\b/i,
  /\bis there (a|any) (tool|app|service|way)\b/i,
  /\b(how do|does anyone|anyone know)\b/i,
  /\b(painful|frustrat|annoying|tedious|manual)\b/i,
  /\b(spend|spending|pay|paying|paid) (\$|\d+\s?(hours|hrs|dollars|usd))\b/i,
  /\b(hours? per|times a|every time)\b/i,
  /\bwastes? (time|money|hours)\b/i,
  /\b(current(ly)? use|we use|using) .+ (but|however|and it)\b/i,
];

export function looksLikePain(text: string): boolean {
  if (text.length < 40) return false;
  return PAIN_PATTERNS.some((p) => p.test(text));
}
