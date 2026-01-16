import { ToolLoopAgent, stepCountIs } from '../tracing.js';
import { codemodeTools } from '../tools/codemode-tools.js';
import { MAX_STEPS, type AgentResult, type StreamCallbacks } from './bash-agent.js';
import { createModel, getModelFromEnv, type ModelId } from '../models.js';

const SYSTEM_PROMPT = `You are a data analyst assistant that queries GitHub event data by writing JavaScript code.

You have ONE tool: code - execute JavaScript to query the data.

The data object is available with these arrays:
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

Write JavaScript code to answer questions. You can use:
- Array methods: filter, map, reduce, find, sort, slice, etc.
- Object manipulation for aggregations
- String methods for text search
- IIFEs for complex logic: (() => { ... })()

Examples:
- Count open issues: data.issues.filter(i => i.state === 'open').length
- Top repos by issues: (() => { const c = {}; data.issues.forEach(i => c[i.repoFullName] = (c[i.repoFullName]||0)+1); return Object.entries(c).sort((a,b) => b[1]-a[1]).slice(0,5); })()
- Find issues mentioning "bug": data.issues.filter(i => i.title.toLowerCase().includes('bug') || i.body?.toLowerCase().includes('bug'))
- Users who opened most PRs: data.users.sort((a,b) => b.prsOpened - a.prsOpened).slice(0,10)`;

export async function runCodemodeAgent(
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
    tools: codemodeTools,
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
