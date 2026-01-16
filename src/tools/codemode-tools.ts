import { tool } from 'ai';
import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';

const DATA_PATH = join(import.meta.dirname, '../../data/codemode.json');
const MAX_OUTPUT_CHARS = 30000;

// Lazy-load the data
let cachedData: CodemodeData | null = null;

interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
}

interface User {
  id: number;
  login: string;
  issuesOpened: number;
  prsOpened: number;
  commentsMade: number;
}

interface Comment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
}

interface Issue {
  id: number;
  repoId: number;
  repoFullName: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: string;
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

interface Pull {
  id: number;
  repoId: number;
  repoFullName: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: string;
  merged: boolean;
  mergedAt: string | null;
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
}

interface CodemodeData {
  repos: Repo[];
  users: User[];
  issues: Issue[];
  pulls: Pull[];
}

function loadData(): CodemodeData {
  if (cachedData) return cachedData;

  if (!existsSync(DATA_PATH)) {
    throw new Error(`Data file not found: ${DATA_PATH}\nRun 'pnpm transform:codemode' first.`);
  }

  console.log('Loading codemode data...');
  const raw = readFileSync(DATA_PATH, 'utf-8');
  cachedData = JSON.parse(raw) as CodemodeData;
  console.log(
    `Loaded: ${cachedData.repos.length} repos, ${cachedData.users.length} users, ${cachedData.issues.length} issues, ${cachedData.pulls.length} pulls`,
  );
  return cachedData;
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const truncated = output.slice(0, MAX_OUTPUT_CHARS);
  return `${truncated}\n\n[OUTPUT TRUNCATED: showing ${MAX_OUTPUT_CHARS.toLocaleString()} of ${output.length.toLocaleString()} characters]`;
}

export const codemodeTools = {
  code: tool({
    description: `Execute JavaScript code to query GitHub data.

Available in your code:
- data.repos: Repo[] - all repositories
- data.users: User[] - all users with activity counts
- data.issues: Issue[] - all issues with comments
- data.pulls: Pull[] - all pull requests with comments

Types:
interface Repo { id, owner, name, fullName }
interface User { id, login, issuesOpened, prsOpened, commentsMade }
interface Issue { id, repoId, repoFullName, number, title, body, state, author, labels: string[], comments: Comment[], createdAt, updatedAt, closedAt }
interface Pull { id, repoId, repoFullName, number, title, body, state, author, merged, mergedAt, comments: Comment[], createdAt, updatedAt }
interface Comment { id, body, author, createdAt }

Write a JavaScript expression or function body that returns the answer.
Examples:
- data.issues.filter(i => i.state === 'open').length
- data.repos.map(r => r.fullName).slice(0, 10)
- (() => { const counts = {}; data.issues.forEach(i => counts[i.repoFullName] = (counts[i.repoFullName]||0)+1); return Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0,5); })()`,
    inputSchema: z.object({
      code: z.string().describe('JavaScript code to execute. Can be an expression or IIFE.'),
    }),
    execute: async ({ code }) => {
      try {
        const data = loadData();

        // Create a sandbox with the data available
        const sandbox = {
          data,
          console: {
            log: (...args: unknown[]) => args.map((a) => JSON.stringify(a)).join(' '),
          },
        };

        // Execute the code in a sandbox
        const result = runInNewContext(code, sandbox, {
          timeout: 30000, // 30 second timeout
        });

        // Format the result
        const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return truncateOutput(output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Error: ${message}`;
      }
    },
  }),
};
