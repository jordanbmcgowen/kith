/** 1536-dim embeddings, matching the vector() column width in the schema. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts, dimensions: 1536 }),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${await res.text()}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}
