/// Cosine similarity helpers for Float32Array embeddings stored as Bytes in SQLite.
/// Vectors are serialized with Buffer.from(new Float32Array(...)) and read back
/// via floatsFromBuffer. We intentionally avoid an external vector DB — at
/// <100k signals, in-memory cosine is fast enough and simpler.

/// Serialize to a fresh ArrayBuffer-backed Uint8Array. Prisma's Bytes column
/// type accepts exactly Uint8Array<ArrayBuffer>, so we copy into a new buffer
/// rather than returning a view over Float32Array's underlying memory (which
/// TS widens to ArrayBufferLike).
export function buffersFromFloats(
  values: readonly number[] | Float32Array,
): Uint8Array<ArrayBuffer> {
  const arr = values instanceof Float32Array ? values : new Float32Array(values);
  const ab = new ArrayBuffer(arr.byteLength);
  const out = new Uint8Array(ab);
  out.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
  return out;
}

export function floatsFromBuffer(buf: Uint8Array): Float32Array {
  // Copy into a fresh ArrayBuffer so the returned Float32Array isn't a view
  // over a shared/pooled Node Buffer.
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/// Recompute a centroid by averaging the given member vectors component-wise.
/// All vectors must be the same length.
export function centroid(vectors: Float32Array[]): Float32Array {
  if (vectors.length === 0) throw new Error("cannot compute centroid of empty set");
  const dim = vectors[0]!.length;
  const out = new Float32Array(dim);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) out[i]! += v[i]!;
  }
  for (let i = 0; i < dim; i++) out[i]! /= vectors.length;
  return out;
}

/// Incremental centroid update: re-weights the existing centroid by `n` and
/// folds in a new vector. Avoids rebuilding from all members on every add.
export function updatedCentroid(
  current: Float32Array,
  n: number,
  incoming: Float32Array,
): Float32Array {
  const out = new Float32Array(current.length);
  for (let i = 0; i < current.length; i++) {
    out[i] = (current[i]! * n + incoming[i]!) / (n + 1);
  }
  return out;
}
