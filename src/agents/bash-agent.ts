import { ToolLoopAgent, stepCountIs } from '../tracing.js';
import { createBashTool } from 'bash-tool';
import { Bash, OverlayFs } from 'just-bash';
import { join } from 'path';
import { createModel, getModelFromEnv, type ModelId } from '../models.js';

const DATA_DIR = join(process.cwd(), 'data/filesystem');
const MAX_OUTPUT_CHARS = 30000;

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const truncated = output.slice(0, MAX_OUTPUT_CHARS);
  return `${truncated}\n\n[OUTPUT TRUNCATED: showing ${MAX_OUTPUT_CHARS.toLocaleString()} of ${output.length.toLocaleString()} characters. Use head, grep, or more specific commands to narrow results.]`;
}

const SYSTEM_PROMPT = `You are a data analyst assistant that explores GitHub event data stored in a filesystem.

The data is organized as follows:
- repos/{owner}/{repo}/repo.json - Repository metadata
- repos/{owner}/{repo}/issues/{number}.json - Issue data with title, body, state, labels, comments
- repos/{owner}/{repo}/pulls/{number}.json - Pull request data with title, body, state, merged status, comments
- users/{username}.json - User data with activity counts

You have access to standard Unix tools via bash:
- ls: List directory contents
- grep: Search for patterns in files
- cat: Read file contents
- find: Find files by name pattern
- head: Show first N lines
- wc: Count lines/words
- jq: Query JSON files

Use these tools to explore the data and answer questions. Start by understanding the directory structure, then drill down to find specific information.

When searching, consider:
- Use 'find' to locate files by pattern
- Use 'grep -r' for recursive text search
- Use 'jq' to extract specific JSON fields
- All files are in the working directory`;

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
  const bash = new Bash({ fs: overlay, cwd: overlay.getMountPoint() });

  // Create bash tool with the overlay sandbox
  // Set destination to match overlay mount point so cwd is correct
  const { tools } = await createBashTool({
    sandbox: bash,
    destination: overlay.getMountPoint(),
    onAfterBashCall: ({ result }) => ({
      result: {
        ...result,
        stdout: truncateOutput(result.stdout),
        stderr: truncateOutput(result.stderr),
      },
    }),
  });

  const agent = new ToolLoopAgent({
    model: createModel(modelId ?? getModelFromEnv()),
    instructions: SYSTEM_PROMPT,
    tools,
    stopWhen: stepCountIs(20),
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

  return {
    answer: fullText,
    latencyMs: Date.now() - startTime,
    tokens: totalTokens,
    toolCalls: toolCallCount,
  };
}
