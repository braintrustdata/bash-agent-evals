import 'dotenv/config';
import { traced, logger } from '../tracing.js';

// Get agent type and question from environment variables (set by parent process)
const agentType = process.env.AGENT_TYPE!;
const question = process.env.AGENT_QUESTION!;
const parentSpanContext = process.env.PARENT_SPAN_CONTEXT;

async function run() {
  // Import the appropriate agent - but we'll call the underlying logic, not the traced wrapper
  let runAgent: (question: string, callbacks?: any) => Promise<any>;

  switch (agentType) {
    case 'bash':
      const { runBashAgent } = await import('./bash-agent.js');
      runAgent = runBashAgent;
      break;
    case 'fs':
      const { runFsAgent } = await import('./fs-agent.js');
      runAgent = runFsAgent;
      break;
    case 'sql':
      const { runSqlAgent } = await import('./sql-agent.js');
      runAgent = runSqlAgent;
      break;
    case 'embedding':
      const { runEmbeddingAgent } = await import('./embedding-agent.js');
      runAgent = runEmbeddingAgent;
      break;
    default:
      throw new Error(`Unknown agent type: ${agentType}`);
  }

  const callbacks = {
    onText: (chunk: string) => {
      process.send?.({ type: 'text', chunk });
    },
    onToolCall: (toolName: string, args: Record<string, unknown>) => {
      process.send?.({ type: 'tool_call', toolName, args });
    },
    onToolResult: (toolName: string, result: string) => {
      process.send?.({ type: 'tool_result', toolName, result });
    },
    onProgress: (update: { toolCalls: number; tokens: number }) => {
      process.send?.({ type: 'progress', ...update });
    },
  };

  // If we have a parent span context, use it to create a child span
  // Otherwise just run the agent directly
  // Note: parentSpanContext from span.export() is an opaque string, not JSON
  if (parentSpanContext) {
    // Run within traced context, passing the parent span slug directly
    const result = await traced(
      async (_span) => {
        return runAgent(question, callbacks);
      },
      { name: agentType, parent: parentSpanContext },
    );
    await logger.flush();
    process.send?.({ type: 'done', result });
  } else {
    // No parent context, just run directly
    const result = await runAgent(question, callbacks);
    process.send?.({ type: 'done', result });
  }
}

run().catch((error) => {
  process.send?.({ type: 'error', error: error.message });
});
