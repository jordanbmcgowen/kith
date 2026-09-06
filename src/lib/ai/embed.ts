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
