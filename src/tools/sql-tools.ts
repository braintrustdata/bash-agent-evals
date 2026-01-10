import { tool } from 'ai';
import { z } from 'zod';
import { join } from 'path';
import { createRequire } from 'module';

const DB_PATH = join(process.cwd(), 'data/database.sqlite');
const MAX_OUTPUT_CHARS = 30000;

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const truncated = output.slice(0, MAX_OUTPUT_CHARS);
  return `${truncated}\n\n[OUTPUT TRUNCATED: showing ${MAX_OUTPUT_CHARS.toLocaleString()} of ${output.length.toLocaleString()} characters. Use LIMIT or more specific WHERE clauses to narrow results.]`;
}

// Use createRequire to load better-sqlite3 from the actual node_modules path
// This bypasses the Braintrust CLI's eval bundling which breaks native modules
let db: any = null;

async function getDb(): Promise<any> {
  if (!db) {
    const require = createRequire(join(process.cwd(), 'package.json'));
    const Database = require('better-sqlite3');
    db = new Database(DB_PATH, { readonly: true });
  }
  return db;
}

export const sqlTools = {
  query: tool({
    description:
      'Execute a SQL query on the GitHub events database. Returns results as JSON array. Use SELECT queries only.',
    inputSchema: z.object({
      sql: z.string().describe('SQL query to execute (SELECT only)'),
    }),
    execute: async ({ sql }) => {
      const normalized = sql.trim().toUpperCase();
      if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
        throw new Error('Only SELECT queries are allowed');
      }

      const database = await getDb();
      const results = database.prepare(sql).all();
      const output = JSON.stringify(results, null, 2);
      return truncateOutput(output);
    },
  }),

  schema: tool({
    description: 'Get the database schema showing all tables and their columns',
    inputSchema: z.object({}),
    execute: async () => {
      const database = await getDb();
      const tables = database
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { sql: string }[];
      return tables.map((t) => t.sql).join('\n\n');
    },
  }),

  tables: tool({
    description: 'List all tables in the database',
    inputSchema: z.object({}),
    execute: async () => {
      const database = await getDb();
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
      return tables.map((t) => t.name).join('\n');
    },
  }),

  sample: tool({
    description: 'Get a sample of rows from a table to understand its structure',
    inputSchema: z.object({
      table: z.string().describe('Table name'),
      limit: z.number().default(5).describe('Number of rows to return'),
    }),
    execute: async ({ table, limit }) => {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
        throw new Error('Invalid table name');
      }
      const database = await getDb();
      const results = database.prepare(`SELECT * FROM ${table} LIMIT ?`).all(limit);
      return truncateOutput(JSON.stringify(results, null, 2));
    },
  }),

  count: tool({
    description: 'Count rows in a table, optionally with a WHERE condition',
    inputSchema: z.object({
      table: z.string().describe('Table name'),
      where: z.string().optional().describe('Optional WHERE condition (without the WHERE keyword)'),
    }),
    execute: async ({ table, where }) => {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
        throw new Error('Invalid table name');
      }
      const database = await getDb();
      const sql = where
        ? `SELECT COUNT(*) as count FROM ${table} WHERE ${where}`
        : `SELECT COUNT(*) as count FROM ${table}`;
      const result = database.prepare(sql).get() as { count: number };
      return `${result.count} rows`;
    },
  }),
};
