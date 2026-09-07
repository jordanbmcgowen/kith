/** 1536-dim embeddings, matching the vector() column width in the schema. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts, dimensions: 1536 }),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Embedding failed (${res.status}): ${await res.text()}`), { status: res.status });
  }
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}

/**
 * Embeddings from the app Worker, which has no OpenAI key on purpose. It asks
 * kith-processor over the PROCESSOR service binding (see wrangler.jsonc);
 * the processor's fetch handler runs `embed` above with its own secret. Same
 * shape, same error contract as calling OpenAI directly.
 */
export const EMBED_MAX_TEXTS = 500;

export async function embedVia(processor: Fetcher, texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const res = await processor.fetch("https://kith-processor/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Embedding failed (${res.status}): ${await res.text()}`), { status: res.status });
  }
  const json = (await res.json()) as { vectors: number[][] };
  return json.vectors;
}
