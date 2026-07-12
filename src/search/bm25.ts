/** Minimal BM25 implementation over an in-memory corpus of tokenized docs. */

export interface Bm25Doc {
  id: string;
  tokens: string[];
}

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[_\-./\\]+/g, " ")
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length >= 2);
}

export class Bm25Index {
  private docs: Bm25Doc[] = [];
  private df = new Map<string, number>();
  private avgdl = 0;
  private readonly k1: number;
  private readonly b: number;

  constructor(k1 = 1.4, b = 0.75) {
    this.k1 = k1;
    this.b = b;
  }

  clear(): void {
    this.docs = [];
    this.df.clear();
    this.avgdl = 0;
  }

  add(id: string, text: string): void {
    const tokens = tokenize(text);
    this.docs.push({ id, tokens });
  }

  build(): void {
    this.df.clear();
    let totalLen = 0;
    for (const doc of this.docs) {
      totalLen += doc.tokens.length;
      const seen = new Set<string>();
      for (const t of doc.tokens) {
        if (seen.has(t)) continue;
        seen.add(t);
        this.df.set(t, (this.df.get(t) ?? 0) + 1);
      }
    }
    this.avgdl = this.docs.length ? totalLen / this.docs.length : 0;
  }

  search(query: string, topK = 10): Array<{ id: string; score: number }> {
    const qTokens = tokenize(query);
    if (!qTokens.length || !this.docs.length) return [];

    const N = this.docs.length;
    const scores = new Map<string, number>();

    for (const doc of this.docs) {
      const tf = new Map<string, number>();
      for (const t of doc.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      const dl = doc.tokens.length || 1;
      let score = 0;
      for (const qt of qTokens) {
        const f = tf.get(qt) ?? 0;
        if (!f) continue;
        const df = this.df.get(qt) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const denom = f + this.k1 * (1 - this.b + (this.b * dl) / (this.avgdl || 1));
        score += idf * ((f * (this.k1 + 1)) / denom);
      }
      if (score > 0) scores.set(doc.id, score);
    }

    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  get size(): number {
    return this.docs.length;
  }
}
