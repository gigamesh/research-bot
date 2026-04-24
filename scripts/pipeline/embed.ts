/// Embed all Signals that don't yet have an embedding. Uses Ollama locally.
/// Default model: nomic-embed-text (768-dim). Install with:
///   brew install ollama && ollama serve
///   ollama pull nomic-embed-text
///
/// Run: `pnpm pipeline:embed`

import "dotenv/config";
import { Ollama } from "ollama";
import { prisma } from "@/lib/db";
import { buffersFromFloats } from "@/lib/similarity";

const MODEL = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
const HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";

async function run() {
  const ollama = new Ollama({ host: HOST });

  const signals = await prisma.signal.findMany({
    where: { embedding: null },
    orderBy: { createdAt: "asc" },
  });
  console.log(`[embed] ${signals.length} signals to embed with ${MODEL}`);

  for (const sig of signals) {
    try {
      const res = await ollama.embeddings({ model: MODEL, prompt: sig.summary });
      const vec = new Float32Array(res.embedding);
      await prisma.signal.update({
        where: { id: sig.id },
        data: { embedding: buffersFromFloats(vec) },
      });
    } catch (err) {
      console.error(`[embed]   ${sig.id.slice(0, 8)} FAILED: ${(err as Error).message}`);
    }
  }

  console.log(`[embed] done`);
  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
