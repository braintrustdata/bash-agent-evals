import { ToolLoopAgent, stepCountIs } from '../tracing.js';
import { embeddingTools } from '../tools/embedding-tools.js';
import { MAX_STEPS, type AgentResult, type StreamCallbacks } from './bash-agent.js';
import { createModel, getModelFromEnv, type ModelId } from '../models.js';

const SYSTEM_PROMPT = `You are a data analyst assistant that searches GitHub event data using semantic similarity (embeddings).

You have access to embedding-based search tools:
- searchSimilar: Find issues or PRs that are semantically similar to a natural language query. This uses AI embeddings to find conceptually related content, not just keyword matches.
- getContext: Get full details of a specific issue or PR once you've found relevant results.

This approach is different from keyword search:
- It understands meaning, not just matching words
- "memory problems" will find issues about "RAM leak", "OOM errors", etc.
- It's good for finding related concepts even with different terminology

Use searchSimilar first to find relevant content, then use getContext to get full details of specific items.

Note: The similarity score ranges from 0 to 1, where 1 is a perfect match. Generally, scores above 0.7 indicate strong relevance.`;

export async function runEmbeddingAgent(
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
    tools: embeddingTools,
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
