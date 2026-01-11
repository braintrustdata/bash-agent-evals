import { ToolLoopAgent, stepCountIs } from '../tracing.js';
import { fsTools } from '../tools/fs-tools.js';
import { MAX_STEPS, type AgentResult, type StreamCallbacks } from './bash-agent.js';
import { createModel, getModelFromEnv, type ModelId } from '../models.js';

const SYSTEM_PROMPT = `You are a data analyst assistant that explores GitHub event data stored in a filesystem.

The data is organized as follows:
- repos/{owner}/{repo}/repo.json - Repository metadata
- repos/{owner}/{repo}/issues/{number}.json - Issue data with title, body, state, labels, comments
- repos/{owner}/{repo}/pulls/{number}.json - Pull request data with title, body, state, merged status, comments
- users/{username}.json - User data with activity counts

You have access to TypeScript filesystem tools:
- listDir: List directory contents (with optional recursive mode)
- readFile: Read file contents
- readJson: Read and parse JSON files
- searchFiles: Search for text patterns in files
- findFiles: Find files matching a glob pattern
- countFiles: Count files matching a pattern
- fileExists: Check if a file/directory exists

Use these tools to explore the data and answer questions. Start by understanding the directory structure, then drill down to find specific information.

When searching, consider:
- Use 'findFiles' with glob patterns like "**/issues/*.json"
- Use 'searchFiles' for text pattern matching
- Use 'readJson' to parse JSON files directly
- Paths are relative to the data directory (start with "repos/" or "users/")`;

export async function runFsAgent(
  question: string,
  callbacks?: StreamCallbacks,
  modelId?: ModelId,
): Promise<AgentResult> {
  const startTime = Date.now();
  let fullText = '';
  let totalTokens = 0;
  let toolCallCount = 0;

  const agent = new ToolLoopAgent({
    model: createModel(modelId ?? getModelFromEnv()),
    instructions: SYSTEM_PROMPT,
    tools: fsTools,
    stopWhen: stepCountIs(MAX_STEPS),
  });

  const stream = await agent.stream({
    prompt: question,
  });

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
