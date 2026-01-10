import React, { useState, useEffect, useCallback } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from './tracing.js';
import { runAgentInWorker } from './agents/run-in-worker.js';
import type { AgentResult, StreamCallbacks } from './agents/bash-agent.js';

// Persist history to file
const HISTORY_FILE = join(import.meta.dirname, '../.cli-history.json');
const MAX_HISTORY = 100;

function loadHistory(): string[] {
  try {
    if (existsSync(HISTORY_FILE)) {
      const data = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
      return Array.isArray(data) ? data.slice(-MAX_HISTORY) : [];
    }
  } catch {
    // Ignore errors, start fresh
  }
  return [];
}

function saveHistory(history: string[]): void {
  try {
    writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-MAX_HISTORY), null, 2));
  } catch {
    // Ignore errors
  }
}

// Event types for the activity feed
type ActivityEvent =
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; name: string; args: string }
  | { type: 'tool_result'; name: string; preview: string }
  | { type: 'response'; text: string }
  | { type: 'error'; text: string };

interface AgentState {
  name: string;
  color: string;
  status: 'idle' | 'running' | 'done' | 'error';
  activity: ActivityEvent[]; // Chronological activity feed
  currentText: string; // Buffer for streaming text
  tokens: number;
  toolCount: number;
  latencyMs: number;
  result?: AgentResult;
}

const COLORS = {
  bash: 'blue',
  fs: 'green',
  sql: 'yellow',
  embedding: 'magenta',
} as const;

// Helper to wrap text into lines
function wrapText(text: string, width: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length + word.length + 1 <= width) {
      currentLine += (currentLine ? ' ' : '') + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word.slice(0, width); // Truncate very long words
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

function AgentPanel({ agent, width }: { agent: AgentState; width: number }) {
  const maxLines = 15;
  const contentWidth = width - 4;

  // Build all display lines from activity
  const displayLines: { text: string; color?: string; dim?: boolean }[] = [];

  for (const event of agent.activity) {
    switch (event.type) {
      case 'thinking': {
        const wrapped = wrapText(`💭 ${event.text}`, contentWidth);
        wrapped.forEach((line) => displayLines.push({ text: line, dim: true }));
        break;
      }
      case 'tool_call': {
        const toolText = `🔧 ${event.name}(${event.args})`;
        const wrapped = wrapText(toolText, contentWidth);
        wrapped.forEach((line) => displayLines.push({ text: line, color: 'cyan' }));
        break;
      }
      case 'tool_result': {
        const wrapped = wrapText(`  ↪ ${event.preview}`, contentWidth);
        wrapped.forEach((line) => displayLines.push({ text: line, color: 'gray' }));
        break;
      }
      case 'response': {
        const wrapped = wrapText(event.text, contentWidth);
        wrapped.forEach((line) => displayLines.push({ text: line }));
        break;
      }
      case 'error': {
        const wrapped = wrapText(`❌ ${event.text}`, contentWidth);
        wrapped.forEach((line) => displayLines.push({ text: line, color: 'red' }));
        break;
      }
    }
  }

  // Add current streaming text
  if (agent.currentText && agent.status === 'running') {
    const wrapped = wrapText(`▸ ${agent.currentText}`, contentWidth);
    wrapped.forEach((line) => displayLines.push({ text: line, color: 'white' }));
  }

  // Take last N lines
  const visibleLines = displayLines.slice(-maxLines);

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="round"
      borderColor={agent.color}
      paddingX={1}
    >
      {/* Header */}
      <Box justifyContent="space-between">
        <Text bold color={agent.color}>
          {agent.name}
        </Text>
        <Box>
          {agent.status === 'running' && (
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
          )}
          {agent.status === 'done' && <Text color="green">✓</Text>}
          {agent.status === 'error' && <Text color="red">✗</Text>}
        </Box>
      </Box>

      {/* Stats */}
      <Text dimColor>
        {agent.toolCount} tools | {agent.tokens.toLocaleString()} tok
        {agent.status === 'done' && ` | ${(agent.latencyMs / 1000).toFixed(1)}s`}
      </Text>

      {/* Activity Feed */}
      <Box flexDirection="column" marginTop={1} minHeight={maxLines}>
        {agent.status === 'idle' && <Text dimColor>Waiting...</Text>}
        {visibleLines.map((line, i) => (
          <Text key={`${agent.name}-line-${i}`} color={line.color as any} dimColor={line.dim}>
            {line.text}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function QuestionInput({
  onSubmit,
  disabled,
  history,
}: {
  onSubmit: (q: string) => void;
  disabled: boolean;
  history: string[];
}) {
  const [value, setValue] = useState('');
  const [historyIndex, setHistoryIndex] = useState(-1);

  useInput((input, key) => {
    if (disabled) return;

    if (key.return) {
      if (value.trim()) {
        onSubmit(value.trim());
        setValue('');
        setHistoryIndex(-1);
      }
    } else if (key.upArrow) {
      // Navigate history backwards
      if (history.length > 0) {
        const newIndex = Math.min(historyIndex + 1, history.length - 1);
        setHistoryIndex(newIndex);
        setValue(history[history.length - 1 - newIndex] || '');
      }
    } else if (key.downArrow) {
      // Navigate history forwards
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setValue(history[history.length - 1 - newIndex] || '');
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setValue('');
      }
    } else if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      setHistoryIndex(-1);
    } else if (!key.ctrl && !key.meta && input) {
      setValue((v) => v + input);
      setHistoryIndex(-1);
    }
  });

  return (
    <Box>
      <Text bold color="cyan">
        {'❯ '}
      </Text>
      <Text>{value}</Text>
      {!disabled && <Text color="cyan">▌</Text>}
    </Box>
  );
}

const initialAgents: Record<string, AgentState> = {
  bash: {
    name: 'BASH',
    color: COLORS.bash,
    status: 'idle',
    activity: [],
    currentText: '',
    tokens: 0,
    toolCount: 0,
    latencyMs: 0,
  },
  fs: {
    name: 'FILESYSTEM',
    color: COLORS.fs,
    status: 'idle',
    activity: [],
    currentText: '',
    tokens: 0,
    toolCount: 0,
    latencyMs: 0,
  },
  sql: {
    name: 'SQL',
    color: COLORS.sql,
    status: 'idle',
    activity: [],
    currentText: '',
    tokens: 0,
    toolCount: 0,
    latencyMs: 0,
  },
  embedding: {
    name: 'EMBEDDING',
    color: COLORS.embedding,
    status: 'idle',
    activity: [],
    currentText: '',
    tokens: 0,
    toolCount: 0,
    latencyMs: 0,
  },
};

function App() {
  const { exit } = useApp();
  const [question, setQuestion] = useState<string | null>(null);
  const [agents, setAgents] = useState<Record<string, AgentState>>(initialAgents);
  const [history, setHistory] = useState<string[]>(() => loadHistory());

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c') || (key.ctrl && input === 'd')) {
      exit();
    }
  });

  const createCallbacks = useCallback(
    (agentKey: string): StreamCallbacks => ({
      onText: (chunk) => {
        setAgents((prev) => {
          const agent = prev[agentKey];
          const newText = agent.currentText + chunk;

          // If we hit a newline or enough text, flush to activity as response
          const lines = newText.split('\n');
          if (lines.length > 1) {
            // Flush complete lines to activity
            const completeLines = lines.slice(0, -1);
            const remaining = lines[lines.length - 1];
            const newActivity = [
              ...agent.activity,
              ...completeLines
                .filter((l) => l.trim())
                .map((l) => ({ type: 'response' as const, text: l })),
            ];
            return {
              ...prev,
              [agentKey]: {
                ...agent,
                activity: newActivity,
                currentText: remaining,
              },
            };
          }

          return {
            ...prev,
            [agentKey]: {
              ...agent,
              currentText: newText,
            },
          };
        });
      },
      onToolCall: (toolName, args) => {
        setAgents((prev) => {
          const agent = prev[agentKey];
          const argStr = Object.entries(args)
            .slice(0, 2)
            .map(([k, v]) => {
              const val = typeof v === 'string' ? v : JSON.stringify(v);
              return `${k}=${val.slice(0, 20)}${val.length > 20 ? '..' : ''}`;
            })
            .join(', ');

          // Flush any pending text as "thinking" before tool call
          const newActivity = [...agent.activity];
          if (agent.currentText.trim()) {
            newActivity.push({
              type: 'thinking',
              text: agent.currentText.trim(),
            });
          }
          newActivity.push({ type: 'tool_call', name: toolName, args: argStr });

          return {
            ...prev,
            [agentKey]: {
              ...agent,
              activity: newActivity,
              currentText: '',
            },
          };
        });
      },
      onToolResult: (toolName, result) => {
        setAgents((prev) => {
          const agent = prev[agentKey];
          // Show a short preview of the result
          const preview = result.replace(/\s+/g, ' ').slice(0, 50);
          return {
            ...prev,
            [agentKey]: {
              ...agent,
              activity: [...agent.activity, { type: 'tool_result', name: toolName, preview }],
            },
          };
        });
      },
      onProgress: ({ toolCalls, tokens }) => {
        setAgents((prev) => ({
          ...prev,
          [agentKey]: {
            ...prev[agentKey],
            toolCount: toolCalls,
            tokens,
          },
        }));
      },
    }),
    [],
  );

  const runAllAgents = useCallback(
    async (q: string) => {
      // Wrap the entire request in a Braintrust trace
      await logger.traced(
        async (span) => {
          span.log({ input: q });

          // Reset all agents to running state
          setAgents((prev) => {
            const reset: Record<string, AgentState> = {};
            for (const key of Object.keys(prev)) {
              reset[key] = {
                ...prev[key],
                status: 'running',
                activity: [],
                currentText: '',
                tokens: 0,
                toolCount: 0,
                latencyMs: 0,
                result: undefined,
              };
            }
            return reset;
          });

          const agentTypes = ['bash', 'fs', 'sql', 'embedding'] as const;

          // Export span context so worker processes can create child spans
          const parentSpanContext = await span.export();

          await Promise.all(
            agentTypes.map(async (key) => {
              try {
                const result = await runAgentInWorker(key, q, {
                  callbacks: createCallbacks(key),
                  parentSpanContext,
                });
                setAgents((prev) => {
                  const agent = prev[key];
                  const finalActivity = [...agent.activity];

                  // Flush any remaining streaming text
                  if (agent.currentText.trim()) {
                    finalActivity.push({
                      type: 'response',
                      text: agent.currentText.trim(),
                    });
                  }

                  // Check if the result is an error
                  const isError = result.answer.startsWith('Error:');
                  if (isError) {
                    finalActivity.push({ type: 'error', text: result.answer });
                  } else if (result.answer.trim()) {
                    // Add final answer if not already streamed
                    const lastActivity = finalActivity[finalActivity.length - 1];
                    if (
                      !lastActivity ||
                      lastActivity.type !== 'response' ||
                      !result.answer.includes(lastActivity.text)
                    ) {
                      // Split answer into lines for better display
                      result.answer
                        .split('\n')
                        .filter((l) => l.trim())
                        .forEach((line) => {
                          finalActivity.push({ type: 'response', text: line });
                        });
                    }
                  }

                  return {
                    ...prev,
                    [key]: {
                      ...agent,
                      status: isError ? 'error' : 'done',
                      activity: finalActivity,
                      currentText: '',
                      latencyMs: result.latencyMs,
                      result,
                    },
                  };
                });
              } catch (e: any) {
                setAgents((prev) => ({
                  ...prev,
                  [key]: {
                    ...prev[key],
                    status: 'error',
                    activity: [...prev[key].activity, { type: 'error', text: e.message }],
                  },
                }));
              }
            }),
          );

          // Log summary to the trace
          span.log({ output: 'All agents completed' });
        },
        { name: 'user-query' },
      );

      setQuestion(null);
    },
    [createCallbacks],
  );

  useEffect(() => {
    if (question) {
      runAllAgents(question);
    }
  }, [question, runAllAgents]);

  const termWidth = process.stdout.columns || 120;
  const panelWidth = Math.floor((termWidth - 2) / 4);
  const isRunning = Object.values(agents).some((a) => a.status === 'running');

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          🔍 Bash vs SQL vs Embeddings - Agent Comparison
        </Text>
      </Box>

      {/* 4-column agent panels */}
      <Box flexDirection="row">
        <AgentPanel agent={agents.bash} width={panelWidth} />
        <AgentPanel agent={agents.fs} width={panelWidth} />
        <AgentPanel agent={agents.sql} width={panelWidth} />
        <AgentPanel agent={agents.embedding} width={panelWidth} />
      </Box>

      {/* Input */}
      <Box marginTop={1}>
        {isRunning ? (
          <Box>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text dimColor> Running all agents in parallel... (ESC to quit)</Text>
          </Box>
        ) : (
          <QuestionInput
            onSubmit={(q) => {
              const newHistory = [...history, q];
              setHistory(newHistory);
              saveHistory(newHistory);
              setQuestion(q);
            }}
            disabled={isRunning}
            history={history}
          />
        )}
      </Box>

      {/* Legend */}
      <Box marginTop={1}>
        <Text dimColor>💭 thinking 🔧 tool call ↪ result ▸ streaming</Text>
      </Box>
    </Box>
  );
}

// Configure render with explicit stdin handling to prevent freeze on background
render(<App />, {
  // Prevent exit on Ctrl+C so we can handle it ourselves
  exitOnCtrlC: false,
});
