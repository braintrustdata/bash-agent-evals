import { ToolLoopAgent, stepCountIs } from '../tracing.js';
import { sqlTools } from '../tools/sql-tools.js';
import { MAX_STEPS, type AgentResult, type StreamCallbacks } from './bash-agent.js';
import { createModel, getModelFromEnv, type ModelId } from '../models.js';

const SYSTEM_PROMPT = `You are a data analyst assistant that queries GitHub event data stored in a SQLite database.

The database has the following tables:
- repos (id, owner, name, full_name)
- users (id, login, issues_opened, prs_opened, comments_made)
- issues (id, repo_id, number, title, body, state, author, labels_json, created_at, updated_at, closed_at)
- pulls (id, repo_id, number, title, body, state, author, merged, merged_at, created_at, updated_at)
- comments (id, issue_id, pull_id, body, author, created_at)
- events (id, type, actor_login, repo_name, payload_json, created_at)

You have access to SQL tools:
- query: Execute a SELECT query
- schema: Get full database schema
- tables: List all tables
- sample: Get sample rows from a table
- count: Count rows in a table

Use SQL to answer questions. Start by understanding the schema if needed, then write queries to find the answer.

Tips:
- Use JOINs to connect related tables (e.g., issues to repos via repo_id)
- labels_json and payload_json are JSON strings - use json_extract() to query them
- The 'merged' column in pulls is 0/1 (not true/false)
- Use LIKE for text pattern matching
- Use GROUP BY and aggregate functions for counting/analysis`;

export async function runSqlAgent(
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
    tools: sqlTools,
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
