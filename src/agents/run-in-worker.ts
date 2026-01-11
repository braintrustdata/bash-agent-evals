import { fork } from 'child_process';
import { join } from 'path';
import type { AgentResult, StreamCallbacks } from './bash-agent.js';

// Worker path relative to project root (works in both ESM and CJS contexts)
const WORKER_PATH = join(process.cwd(), 'src/agents/worker.ts');

export interface WorkerOptions {
  callbacks?: StreamCallbacks;
  parentSpanContext?: string; // Serialized span context from span.export()
}

function isStreamCallbacks(obj: unknown): obj is StreamCallbacks {
  return obj !== null && typeof obj === 'object' && 'onText' in obj;
}

export function runAgentInWorker(
  agentType: 'bash' | 'fs' | 'sql' | 'embedding',
  question: string,
  options?: WorkerOptions | StreamCallbacks,
): Promise<AgentResult> {
  // Support both old (callbacks only) and new (options object) signatures
  let opts: WorkerOptions;
  if (isStreamCallbacks(options)) {
    opts = { callbacks: options };
  } else {
    opts = options || {};
  }

  return new Promise((resolve, reject) => {
    // Fork a child process running the worker script via tsx
    const child = fork(WORKER_PATH, [], {
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        AGENT_TYPE: agentType,
        AGENT_QUESTION: question,
        PARENT_SPAN_CONTEXT: opts.parentSpanContext || '',
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    child.on('message', (message: any) => {
      switch (message.type) {
        case 'text':
          opts.callbacks?.onText?.(message.chunk);
          break;
        case 'tool_call':
          opts.callbacks?.onToolCall?.(message.toolName, message.args);
          break;
        case 'tool_result':
          opts.callbacks?.onToolResult?.(message.toolName, message.result);
          break;
        case 'progress':
          opts.callbacks?.onProgress?.({ toolCalls: message.toolCalls, tokens: message.tokens });
          break;
        case 'done':
          child.kill();
          resolve(message.result);
          break;
        case 'error':
          child.kill();
          reject(new Error(message.error));
          break;
      }
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Worker stopped with exit code ${code}`));
      }
    });
  });
}
