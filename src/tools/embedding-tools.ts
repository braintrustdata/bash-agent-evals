import { tool } from 'ai';
import { z } from 'zod';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';
import OpenAI from 'openai';

const EMBEDDINGS_PATH = join(process.cwd(), 'data/embeddings.bin');
const INDEX_PATH = join(process.cwd(), 'data/embeddings-index.json');

const openai = new OpenAI();

interface EmbeddingIndex {
  items: Array<{
    id: number;
    type: 'issue' | 'pull';
    repo: string;
    number: number;
    title: string;
    body_preview: string | null;
    offset: number;
  }>;
  dimension: number;
  count: number;
}

// Lazy-loaded embeddings
let embeddingsData: { index: EmbeddingIndex; embeddings: Float32Array } | null = null;

function loadEmbeddings(): { index: EmbeddingIndex; embeddings: Float32Array } {
  if (embeddingsData) return embeddingsData;

  if (!existsSync(INDEX_PATH) || !existsSync(EMBEDDINGS_PATH)) {
    throw new Error('Embeddings not found. Run "pnpm embed" first to generate them.');
  }

  console.log('Loading pre-computed embeddings...');
  const index: EmbeddingIndex = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));
  const buffer = readFileSync(EMBEDDINGS_PATH);
  const embeddings = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);

  embeddingsData = { index, embeddings };
  console.log(`Loaded ${index.count} embeddings (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);

  return embeddingsData;
}

// Cache for query embeddings
const queryCache = new Map<string, number[]>();

async function getQueryEmbedding(query: string): Promise<number[]> {
  const key = query.slice(0, 8000);
  if (queryCache.has(key)) {
    return queryCache.get(key)!;
  }

  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: key,
  });

  const embedding = response.data[0].embedding;
  queryCache.set(key, embedding);
  return embedding;
}

// Cosine similarity
function cosineSimilarity(
  a: number[] | Float32Array,
  b: Float32Array,
  bOffset: number,
  dim: number,
): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < dim; i++) {
    const aVal = a[i];
    const bVal = b[bOffset + i];
    dotProduct += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export const embeddingTools = {
  searchSimilar: tool({
    description:
      'Search for issues or PRs semantically similar to a query using embeddings. This finds content that is conceptually related, not just keyword matches.',
    inputSchema: z.object({
      query: z.string().describe('Natural language query to search for'),
      type: z.enum(['issues', 'pulls', 'all']).optional().describe('Type of content to search'),
      limit: z.number().default(10).describe('Maximum number of results'),
    }),
    execute: async ({ query, type, limit }) => {
      const { index, embeddings } = loadEmbeddings();
      const dim = index.dimension;

      // Get query embedding (single API call)
      const queryEmbedding = await getQueryEmbedding(query);

      // Filter items by type
      let items = index.items;
      if (type === 'issues') {
        items = items.filter((i) => i.type === 'issue');
      } else if (type === 'pulls') {
        items = items.filter((i) => i.type === 'pull');
      }

      // Compute similarities
      const results: Array<{ item: (typeof items)[0]; similarity: number }> = [];

      for (const item of items) {
        const similarity = cosineSimilarity(queryEmbedding, embeddings, item.offset * dim, dim);
        results.push({ item, similarity });
      }

      // Sort by similarity and return top results
      results.sort((a, b) => b.similarity - a.similarity);
      const topResults = results.slice(0, limit);

      return JSON.stringify(
        topResults.map((r) => ({
          type: r.item.type,
          repo: r.item.repo,
          number: r.item.number,
          title: r.item.title,
          similarity: r.similarity.toFixed(4),
          body_preview: r.item.body_preview,
        })),
        null,
        2,
      );
    },
  }),

  getContext: tool({
    description: 'Get full details of an issue or PR by repo and number',
    inputSchema: z.object({
      repo: z.string().describe('Full repo name like "owner/repo"'),
      number: z.number().describe('Issue or PR number'),
      type: z.enum(['issue', 'pull']).describe('Whether this is an issue or pull request'),
    }),
    execute: async ({ repo, number, type }) => {
      // Import database lazily to avoid circular deps
      const Database = (await import('better-sqlite3')).default;
      const DB_PATH = join(process.cwd(), 'data/database.sqlite');
      const database = new Database(DB_PATH, { readonly: true });

      if (type === 'issue') {
        const result = database
          .prepare(
            `
            SELECT i.*, r.full_name as repo
            FROM issues i
            JOIN repos r ON i.repo_id = r.id
            WHERE r.full_name = ? AND i.number = ?
          `,
          )
          .get(repo, number);
        database.close();
        return JSON.stringify(result, null, 2);
      } else {
        const result = database
          .prepare(
            `
            SELECT p.*, r.full_name as repo
            FROM pulls p
            JOIN repos r ON p.repo_id = r.id
            WHERE r.full_name = ? AND p.number = ?
          `,
          )
          .get(repo, number);
        database.close();
        return JSON.stringify(result, null, 2);
      }
    },
  }),
};
