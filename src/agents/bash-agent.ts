import { ToolLoopAgent, stepCountIs } from '../tracing.js';
import { createBashTool, type BashToolkit } from 'bash-tool';
import { Bash, OverlayFs } from 'just-bash';
import { join } from 'path';
import { createModel, getModelFromEnv, type ModelId } from '../models.js';

// Max steps for agent execution (shared across all agents)
export const MAX_STEPS = 50;

const DATA_DIR = join(process.cwd(), 'data/filesystem');
const MAX_OUTPUT_CHARS = 30000;
const DEFAULT_TIMEOUT_MS = 10000; // 10 second default timeout

// Configurable via BASH_TIMEOUT_MS env var (in milliseconds)
export const BASH_TIMEOUT_MS =
  parseInt(process.env.BASH_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS;

// Execution limits for just-bash (increased from defaults for large datasets)
const EXECUTION_LIMITS = {
  maxCallDepth: 200,
  maxCommandCount: 50000,
  maxLoopIterations: 50000,
  maxAwkIterations: 50000,
  maxSedIterations: 50000,
};

// Tool configurations - which tools to expose to the agent
export type BashToolSet = 'all' | 'bash-only' | 'bash-read';

export const BASH_TOOL_SET: BashToolSet = (process.env.BASH_TOOL_SET as BashToolSet) || 'bash-only';

// Whitelist of bash commands available to the agent
// Default: standard Unix tools for file exploration
const DEFAULT_BASH_TOOLS = ['ls', 'grep', 'cat', 'find', 'head', 'wc'];

// Parse BASH_TOOLS env var as comma-separated list, or use default
export const BASH_TOOLS: string[] = process.env.BASH_TOOLS
  ? process.env.BASH_TOOLS.split(',').map((t) => t.trim())
  : DEFAULT_BASH_TOOLS;

function selectTools(toolkit: BashToolkit, toolSet: BashToolSet): BashToolkit['tools'] {
  switch (toolSet) {
    case 'bash-only':
      // Return only bash tool, cast to satisfy type (other tools are optional at runtime)
      return { bash: toolkit.tools.bash } as BashToolkit['tools'];
    case 'bash-read':
      return { bash: toolkit.tools.bash, readFile: toolkit.tools.readFile } as BashToolkit['tools'];
    case 'all':
    default:
      return toolkit.tools;
  }
}

class TimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(
      `Command timed out after ${timeoutMs / 1000}s: ${command.slice(0, 100)}${command.length > 100 ? '...' : ''}`,
    );
    this.name = 'TimeoutError';
  }
}

// Wrapper that adds timeout to bash commands
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

// Wrapper that adds timeout to just-bash exec calls
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

// Tool descriptions for the system prompt
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
};

function buildSystemPrompt(tools: string[]): string {
  const toolList = tools.map((t) => `- ${t}: ${TOOL_DESCRIPTIONS[t] || 'Unix command'}`).join('\n');

  const tips = [
    "Use 'find' to locate files by pattern",
    "Use 'grep -r' for recursive text search",
    'All files are in the working directory',
  ];

  if (tools.includes('jq')) {
    tips.push("Use 'jq' to extract specific fields from JSON files");
  }

  return `You are a data analyst assistant that explores GitHub event data stored in a filesystem.

The data is organized as follows:
- repos/{owner}/{repo}/repo.json - Repository metadata
- repos/{owner}/{repo}/issues/{number}.json - Issue data with title, body, state, labels, comments
- repos/{owner}/{repo}/pulls/{number}.json - Pull request data with title, body, state, merged status, comments
- users/{username}.json - User data with activity counts

You have access to standard Unix tools via bash:
${toolList}

Use these tools to explore the data and answer questions. Start by understanding the directory structure, then drill down to find specific information.

When searching, consider:
${tips.map((t) => `- ${t}`).join('\n')}`;
}

export interface AgentResult {
  answer: string;
  latencyMs: number;
  tokens: number;
  toolCalls: number;
}

export interface StreamCallbacks {
  onText?: (text: string) => void;
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
  onToolResult?: (toolName: string, result: string) => void;
  onProgress?: (update: { toolCalls: number; tokens: number }) => void;
}

export async function runBashAgent(
  question: string,
  callbacks?: StreamCallbacks,
  modelId?: ModelId,
): Promise<AgentResult> {
  const startTime = Date.now();
  let fullText = '';
  let totalTokens = 0;
  let toolCallCount = 0;

  // Use OverlayFs to read from real disk (writes stay in memory)
  const overlay = new OverlayFs({ root: DATA_DIR });
  const bash = new Bash({
    fs: overlay,
    cwd: overlay.getMountPoint(),
    executionLimits: EXECUTION_LIMITS,
  });

  // Wrap bash with timeout handling
  const timeoutBash = createTimeoutBash(bash, BASH_TIMEOUT_MS);

  // Create bash tool with the timeout-wrapped sandbox
  // Set destination to match overlay mount point so cwd is correct
  const toolkit = await createBashTool({
    sandbox: timeoutBash,
    destination: overlay.getMountPoint(),
    onAfterBashCall: ({ result }) => ({
      result: {
        ...result,
        stdout: truncateOutput(result.stdout),
        stderr: truncateOutput(result.stderr),
      },
    }),
  });

  // Select which tools to expose based on configuration
  const tools = selectTools(toolkit, BASH_TOOL_SET);

  const agent = new ToolLoopAgent({
    model: createModel(modelId ?? getModelFromEnv()),
    instructions: buildSystemPrompt(BASH_TOOLS),
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
  });

  const stream = await agent.stream({
    prompt: question,
  });

  // Process fullStream for all events
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

  // Check if agent ran out of steps without completing
  const steps = await stream.steps;
  const lastStep = steps[steps.length - 1];
  // If we hit max steps and the last step ended with tool-calls (not a text response),
  // the agent was still working and didn't finish
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
