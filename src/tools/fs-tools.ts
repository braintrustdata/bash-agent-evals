import { tool } from 'ai';
import { z } from 'zod';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { glob } from 'glob';

const DATA_DIR = join(process.cwd(), 'data/filesystem');
const MAX_OUTPUT_CHARS = 30000;

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const truncated = output.slice(0, MAX_OUTPUT_CHARS);
  return `${truncated}\n\n[OUTPUT TRUNCATED: showing ${MAX_OUTPUT_CHARS.toLocaleString()} of ${output.length.toLocaleString()} characters. Use more specific queries or filters to narrow results.]`;
}

function sanitizePath(path: string): string {
  const resolved = join(DATA_DIR, path.replace(/^\/+/, ''));
  if (!resolved.startsWith(DATA_DIR)) {
    throw new Error('Path escape attempt blocked');
  }
  return resolved;
}

export const fsTools = {
  listDir: tool({
    description: 'List contents of a directory. Returns files and subdirectories.',
    inputSchema: z.object({
      path: z.string().describe('Directory path relative to data directory'),
      recursive: z.boolean().optional().describe('If true, list all files recursively'),
    }),
    execute: async ({ path, recursive }) => {
      const fullPath = sanitizePath(path);

      if (recursive) {
        const files = await glob('**/*', { cwd: fullPath, nodir: false });
        return truncateOutput(files.join('\n'));
      }

      const entries = readdirSync(fullPath, { withFileTypes: true });
      return truncateOutput(
        entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n'),
      );
    },
  }),

  readFile: tool({
    description: 'Read the contents of a file',
    inputSchema: z.object({
      path: z.string().describe('File path relative to data directory'),
    }),
    execute: async ({ path }) => {
      const fullPath = sanitizePath(path);
      const content = readFileSync(fullPath, 'utf-8');
      return truncateOutput(content);
    },
  }),

  readJson: tool({
    description: 'Read and parse a JSON file, returning the parsed object',
    inputSchema: z.object({
      path: z.string().describe('JSON file path relative to data directory'),
    }),
    execute: async ({ path }) => {
      const fullPath = sanitizePath(path);
      const content = readFileSync(fullPath, 'utf-8');
      const data = JSON.parse(content);
      const output = JSON.stringify(data, null, 2);
      return truncateOutput(output);
    },
  }),

  searchFiles: tool({
    description:
      'Search for a text pattern in files. Returns matching files and the matching lines.',
    inputSchema: z.object({
      pattern: z.string().describe('Text pattern to search for'),
      path: z.string().describe('Directory to search in'),
      filePattern: z
        .string()
        .optional()
        .describe('Glob pattern for files to search, e.g., "*.json"'),
      caseInsensitive: z.boolean().optional().describe('If true, search is case-insensitive'),
    }),
    execute: async ({ pattern, path, filePattern, caseInsensitive }) => {
      const fullPath = sanitizePath(path);
      const globPattern = filePattern || '**/*';
      const files = await glob(globPattern, { cwd: fullPath, nodir: true });

      const results: string[] = [];
      const searchPattern = caseInsensitive ? new RegExp(pattern, 'gi') : new RegExp(pattern, 'g');

      for (const file of files.slice(0, 1000)) {
        const filePath = join(fullPath, file);
        const stat = statSync(filePath);
        if (stat.size > 1024 * 1024) continue; // Skip files > 1MB

        const content = readFileSync(filePath, 'utf-8');
        const matches = content.match(searchPattern);
        if (matches) {
          results.push(`${file}: ${matches.length} match(es)`);
          const lines = content.split('\n');
          let matchCount = 0;
          for (let i = 0; i < lines.length && matchCount < 3; i++) {
            if (searchPattern.test(lines[i])) {
              results.push(`  Line ${i + 1}: ${lines[i].slice(0, 200)}`);
              matchCount++;
            }
          }
        }
      }

      if (results.length === 0) {
        return 'No matches found';
      }
      return truncateOutput(results.join('\n'));
    },
  }),

  findFiles: tool({
    description: 'Find files matching a glob pattern',
    inputSchema: z.object({
      pattern: z.string().describe('Glob pattern, e.g., "**/issues/*.json"'),
      path: z.string().optional().describe('Starting directory (defaults to root)'),
    }),
    execute: async ({ pattern, path }) => {
      const fullPath = path ? sanitizePath(path) : DATA_DIR;
      const files = await glob(pattern, { cwd: fullPath });
      if (files.length === 0) {
        return 'No files found';
      }
      return truncateOutput(files.join('\n'));
    },
  }),

  countFiles: tool({
    description: 'Count files matching a glob pattern',
    inputSchema: z.object({
      pattern: z.string().describe('Glob pattern, e.g., "**/issues/*.json"'),
      path: z.string().optional().describe('Starting directory (defaults to root)'),
    }),
    execute: async ({ pattern, path }) => {
      const fullPath = path ? sanitizePath(path) : DATA_DIR;
      const files = await glob(pattern, { cwd: fullPath });
      return `${files.length} files`;
    },
  }),

  fileExists: tool({
    description: 'Check if a file or directory exists',
    inputSchema: z.object({
      path: z.string().describe('Path to check'),
    }),
    execute: async ({ path }) => {
      const fullPath = sanitizePath(path);
      if (existsSync(fullPath)) {
        const stat = statSync(fullPath);
        return stat.isDirectory() ? 'Directory exists' : 'File exists';
      }
      return 'Does not exist';
    },
  }),
};
