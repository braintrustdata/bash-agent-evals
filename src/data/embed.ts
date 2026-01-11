#!/usr/bin/env tsx
/**
 * Pre-compute embeddings for all issues and PRs
 * Stores them in a binary file for fast loading
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import OpenAI from 'openai';

const DB_PATH = join(import.meta.dirname, '../../data/database.sqlite');
const EMBEDDINGS_PATH = join(import.meta.dirname, '../../data/embeddings.bin');
const INDEX_PATH = join(import.meta.dirname, '../../data/embeddings-index.json');

const openai = new OpenAI();
const EMBEDDING_DIM = 1536; // text-embedding-3-small dimension
const BATCH_SIZE = 100;

interface EmbeddingIndex {
  items: Array<{
    id: number;
    type: 'issue' | 'pull';
    repo: string;
    number: number;
    title: string;
    body_preview: string | null;
    offset: number; // Byte offset in binary file
  }>;
  dimension: number;
  count: number;
}

async function main() {
  console.log('Loading items from database...');
  const db = new Database(DB_PATH, { readonly: true });

  // Get all issues and PRs
  const issues = db
    .prepare(
      `
    SELECT i.id, i.title, i.body, i.number, r.full_name as repo
    FROM issues i
    JOIN repos r ON i.repo_id = r.id
    WHERE i.title IS NOT NULL
  `,
    )
    .all() as Array<{
    id: number;
    title: string;
    body: string | null;
    number: number;
    repo: string;
  }>;

  const pulls = db
    .prepare(
      `
    SELECT p.id, p.title, p.body, p.number, r.full_name as repo
    FROM pulls p
    JOIN repos r ON p.repo_id = r.id
    WHERE p.title IS NOT NULL
  `,
    )
    .all() as Array<{
    id: number;
    title: string;
    body: string | null;
    number: number;
    repo: string;
  }>;

  console.log(`Found ${issues.length} issues and ${pulls.length} PRs`);

  const allItems = [
    ...issues.map((i) => ({ ...i, type: 'issue' as const })),
    ...pulls.map((p) => ({ ...p, type: 'pull' as const })),
  ];

  console.log(`Total: ${allItems.length} items to embed`);

  // Check for existing embeddings
  let existingIndex: EmbeddingIndex | null = null;
  let existingEmbeddings: Float32Array | null = null;

  if (existsSync(INDEX_PATH) && existsSync(EMBEDDINGS_PATH)) {
    console.log('Found existing embeddings, checking for updates...');
    existingIndex = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));
    const buffer = readFileSync(EMBEDDINGS_PATH);
    existingEmbeddings = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);

    // Create a set of existing item keys
    const existingKeys = new Set(existingIndex!.items.map((i) => `${i.type}-${i.id}`));
    const newItems = allItems.filter((i) => !existingKeys.has(`${i.type}-${i.id}`));

    if (newItems.length === 0) {
      console.log('All items already have embeddings!');
      return;
    }

    console.log(`Found ${newItems.length} new items to embed`);
  }

  // Prepare to collect embeddings
  const index: EmbeddingIndex = {
    items: existingIndex?.items || [],
    dimension: EMBEDDING_DIM,
    count: existingIndex?.count || 0,
  };

  // Start with existing embeddings or empty
  const allEmbeddings: number[] = existingEmbeddings ? Array.from(existingEmbeddings) : [];

  // Filter to items that need embedding
  const existingKeys = new Set(index.items.map((i) => `${i.type}-${i.id}`));
  const itemsToEmbed = allItems.filter((i) => !existingKeys.has(`${i.type}-${i.id}`));

  console.log(`Embedding ${itemsToEmbed.length} items in batches of ${BATCH_SIZE}...`);

  let processed = 0;
  for (let i = 0; i < itemsToEmbed.length; i += BATCH_SIZE) {
    const batch = itemsToEmbed.slice(i, i + BATCH_SIZE);
    const texts = batch.map((item) => {
      const text = `${item.title}\n${item.body || ''}`;
      return text.slice(0, 8000); // Truncate for embedding model
    });

    try {
      const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: texts,
      });

      // Add to index and embeddings
      for (let j = 0; j < batch.length; j++) {
        const item = batch[j];
        const embedding = response.data[j].embedding;

        index.items.push({
          id: item.id,
          type: item.type,
          repo: item.repo,
          number: item.number,
          title: item.title,
          body_preview: item.body?.slice(0, 200) || null,
          offset: allEmbeddings.length / EMBEDDING_DIM,
        });

        allEmbeddings.push(...embedding);
        index.count++;
      }

      processed += batch.length;
      const pct = ((processed / itemsToEmbed.length) * 100).toFixed(1);
      process.stdout.write(`\r  ${processed}/${itemsToEmbed.length} (${pct}%)`);
    } catch (e: any) {
      console.error(`\nError embedding batch ${i}: ${e.message}`);
      // Continue with next batch
    }

    // Small delay to avoid rate limits
    if (i + BATCH_SIZE < itemsToEmbed.length) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  console.log('\n\nSaving embeddings...');

  // Save binary embeddings
  const embeddingsBuffer = Buffer.from(new Float32Array(allEmbeddings).buffer);
  writeFileSync(EMBEDDINGS_PATH, embeddingsBuffer);
  console.log(`  ${EMBEDDINGS_PATH} (${(embeddingsBuffer.length / 1024 / 1024).toFixed(1)} MB)`);

  // Save index
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
  console.log(`  ${INDEX_PATH}`);

  console.log(`\nDone! Embedded ${index.count} items.`);
}

main().catch(console.error);
