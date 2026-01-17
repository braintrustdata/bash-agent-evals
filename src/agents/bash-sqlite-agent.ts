import { ToolLoopAgent, stepCountIs } from '../tracing.js';
import { createBashTool, type BashToolkit } from 'bash-tool';
import { Bash, OverlayFs, defineCommand } from 'just-bash';
import { join } from 'path';
import { createRequire } from 'module';
import { createModel, getModelFromEnv, type ModelId } from '../models.js';
import { MAX_STEPS, type AgentResult, type StreamCallbacks } from './bash-agent.js';

const DATA_DIR = join(process.cwd(), 'data');
const MAX_OUTPUT_CHARS = 30000;
const DEFAULT_TIMEOUT_MS = 30000;

export const BASH_SQLITE_TIMEOUT_MS =
  parseInt(process.env.BASH_SQLITE_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS;

const EXECUTION_LIMITS = {
  maxCallDepth: 200,
  maxCommandCount: 50000,
  maxLoopIterations: 50000,
  maxAwkIterations: 50000,
  maxSedIterations: 50000,
};

const DEFAULT_BASH_SQLITE_TOOLS = ['ls', 'grep', 'cat', 'find', 'head', 'wc', 'jq', 'sqlite3'];

export const BASH_SQLITE_TOOLS: string[] = process.env.BASH_SQLITE_TOOLS
  ? process.env.BASH_SQLITE_TOOLS.split(',').map((t) => t.trim())
  : DEFAULT_BASH_SQLITE_TOOLS;

let sharedOverlay: OverlayFs | null = null;

function getSharedOverlay(): OverlayFs {
  if (!sharedOverlay) {
    sharedOverlay = new OverlayFs({ root: DATA_DIR, mountPoint: '/' });
  }
  return sharedOverlay;
}

// Custom sqlite3 command using better-sqlite3 (bypasses broken sql.js ESM bundling in just-bash)
function createSqlite3Command() {
  return defineCommand('sqlite3', async (args) => {
    let showHeader = false;
    let separator = '|';
    const filteredArgs: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-header') {
        showHeader = true;
      } else if (arg === '-separator' && i + 1 < args.length) {
        separator = args[++i];
      } else if (arg === '-csv') {
        separator = ',';
        showHeader = true;
      } else if (arg === '-json') {
        separator = 'json';
      } else if (!arg.startsWith('-')) {
        filteredArgs.push(arg);
      }
    }

    const [dbPath, ...sqlParts] = filteredArgs;
    const sql = sqlParts.join(' ');

    if (!dbPath) {
      return {
        stdout: '',
        stderr:
          'Usage: sqlite3 [OPTIONS] DATABASE [SQL]\nOptions: -header, -separator SEP, -csv, -json',
        exitCode: 1,
      };
    }

    if (!sql) {
      return { stdout: '', stderr: 'Error: no SQL statement provided', exitCode: 1 };
    }

    const actualPath = dbPath.startsWith('/')
      ? join(DATA_DIR, dbPath.slice(1))
      : join(DATA_DIR, dbPath);

    try {
      const require = createRequire(join(process.cwd(), 'package.json'));
      const Database = require('better-sqlite3');
      const db = new Database(actualPath, { readonly: true });

      try {
        const stmt = db.prepare(sql);
        const results = stmt.all();

        if (results.length === 0) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }

        let output: string;
        if (separator === 'json') {
          output = JSON.stringify(results, null, 2);
        } else {
          const columns = Object.keys(results[0]);
          const lines: string[] = [];

          if (showHeader) {
            lines.push(columns.join(separator));
          }

          for (const row of results) {
            const values = columns.map((col) => {
              const val = row[col];
              if (val === null) return '';
              if (typeof val === 'string' && val.includes(separator)) {
                return `"${val.replace(/"/g, '""')}"`;
              }
              return String(val);
            });
            lines.push(values.join(separator));
          }

          output = lines.join('\n');
        }

        return { stdout: output + '\n', stderr: '', exitCode: 0 };
      } finally {
        db.close();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { stdout: '', stderr: `Error: ${message}\n`, exitCode: 1 };
    }
  });
}

class TimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(
      `Command timed out after ${timeoutMs / 1000}s: ${command.slice(0, 100)}${command.length > 100 ? '...' : ''}`,
    );
    this.name = 'TimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, command: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(command, timeoutMs));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function createTimeoutBash(bash: Bash, timeoutMs: number) {
  return {
    async exec(command: string) {
      return withTimeout(bash.exec(command), timeoutMs, command);
    },
    fs: bash.fs,
  };
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const truncated = output.slice(0, MAX_OUTPUT_CHARS);
  return `${truncated}\n\n[OUTPUT TRUNCATED: showing ${MAX_OUTPUT_CHARS.toLocaleString()} of ${output.length.toLocaleString()} characters. Use head, grep, or more specific commands to narrow results.]`;
}

const TOOL_DESCRIPTIONS: Record<string, string> = {
  ls: 'List directory contents',
  grep: 'Search for patterns in files',
  cat: 'Read file contents',
  find: 'Find files by name pattern',
  head: 'Show first N lines',
  tail: 'Show last N lines',
  wc: 'Count lines/words',
  jq: 'Query and transform JSON files',
  sort: 'Sort lines of text',
  uniq: 'Filter duplicate lines',
  awk: 'Pattern scanning and processing',
  sed: 'Stream editor for filtering and transforming text',
  xargs: 'Build and execute commands from input',
  cut: 'Remove sections from lines',
  tr: 'Translate or delete characters',
  sqlite3: 'Query SQLite databases',
};

function buildSystemPrompt(bashTools: string[]): string {
  const toolList = bashTools
    .map((t) => `- ${t}: ${TOOL_DESCRIPTIONS[t] || 'Unix command'}`)
    .join('\n');

  return `You are a data analyst assistant that explores GitHub event data. You have access to BOTH:

1. A FILESYSTEM with JSON files organized as:
   - filesystem/repos/{owner}/{repo}/repo.json - Repository metadata
   - filesystem/repos/{owner}/{repo}/issues/{number}.json - Issue data with title, body, state, labels, comments
   - filesystem/repos/{owner}/{repo}/pulls/{number}.json - Pull request data with title, body, state, merged status, comments
   - filesystem/users/{username}.json - User data with activity counts

2. A SQLITE DATABASE at database.sqlite with tables:
   - repos (id, owner, name, full_name)
   - users (id, login, issues_opened, prs_opened, comments_made)
   - issues (id, repo_id, number, title, body, state, author, labels_json, created_at, updated_at, closed_at)
   - pulls (id, repo_id, number, title, body, state, author, merged, merged_at, created_at, updated_at)
   - comments (id, issue_id, pull_id, body, author, created_at)
   - events (id, type, actor_login, repo_name, payload_json, created_at)

IMPORTANT: You are already in the data directory. Do NOT use "cd" commands.

You have access to these tools via bash:
${toolList}

TIPS:
- For aggregation queries (counts, grouping, statistics), use sqlite3:
  sqlite3 database.sqlite "SELECT COUNT(*) FROM issues"
- For text search in issue/PR content, you can use either:
  - SQL: sqlite3 database.sqlite "SELECT * FROM issues WHERE body LIKE '%pattern%'"
  - Filesystem: grep -r "pattern" filesystem/repos/*/issues/
- For complex JSON parsing, use jq on the filesystem
- The 'merged' column in pulls is 0/1 (use merged=1 for merged PRs)
- Use JOINs in SQL to connect tables (e.g., issues to repos via repo_id)`;
}

export async function runBashSqliteAgent(
  question: string,
  callbacks?: StreamCallbacks,
  modelId?: ModelId,
): Promise<AgentResult> {
  const startTime = Date.now();
  let fullText = '';
  let totalTokens = 0;
  let toolCallCount = 0;

  const sqlite3Command = createSqlite3Command();
  const overlay = getSharedOverlay();
  const bash = new Bash({
    fs: overlay,
    cwd: '/',
    executionLimits: EXECUTION_LIMITS,
    customCommands: [sqlite3Command],
  });

  const timeoutBash = createTimeoutBash(bash, BASH_SQLITE_TIMEOUT_MS);
  const toolkit = await createBashTool({
    sandbox: timeoutBash,
    destination: '/',
    onAfterBashCall: ({ result }) => ({
      result: {
        ...result,
        stdout: truncateOutput(result.stdout),
        stderr: truncateOutput(result.stderr),
      },
    }),
  });

  const tools = { bash: toolkit.tools.bash } as BashToolkit['tools'];

  const agent = new ToolLoopAgent({
    model: createModel(modelId ?? getModelFromEnv()),
    instructions: buildSystemPrompt(BASH_SQLITE_TOOLS),
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
  });

  const stream = await agent.stream({ prompt: question });

  for await (const event of stream.fullStream) {
    switch (event.type) {
      case 'text-delta':
        fullText += event.text;
        callbacks?.onText?.(event.text);
        break;

      case 'tool-call':
        toolCallCount++;
        callbacks?.onToolCall?.(event.toolName, event.input as Record<string, unknown>);
        callbacks?.onProgress?.({ toolCalls: toolCallCount, tokens: totalTokens });
        break;

      case 'tool-result':
        const resultStr =
          typeof event.output === 'string' ? event.output : JSON.stringify(event.output);
        callbacks?.onToolResult?.(event.toolName, resultStr.slice(0, 500));
        break;

      case 'finish-step':
        totalTokens += event.usage?.totalTokens || 0;
        callbacks?.onProgress?.({ toolCalls: toolCallCount, tokens: totalTokens });
        break;

      case 'error':
        throw event.error;
    }
  }

  const steps = await stream.steps;
  const lastStep = steps[steps.length - 1];
  if (steps.length >= MAX_STEPS && lastStep?.finishReason === 'tool-calls') {
    throw new Error(`Agent reached maximum ${MAX_STEPS} steps without producing a final answer`);
  }

  return {
    answer: fullText,
    latencyMs: Date.now() - startTime,
    tokens: totalTokens,
    toolCalls: toolCallCount,
  };
}
