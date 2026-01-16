#!/usr/bin/env tsx
import chalk from 'chalk';
import { traced } from './tracing.js';
import { runBashAgent, type StreamCallbacks } from './agents/bash-agent.js';
import { runFsAgent } from './agents/fs-agent.js';
import { runSqlAgent } from './agents/sql-agent.js';
import { runEmbeddingAgent } from './agents/embedding-agent.js';
import { runCodemodeAgent } from './agents/codemode-agent.js';

const AGENTS = {
  bash: { name: 'Bash', fn: runBashAgent, color: chalk.blue },
  fs: { name: 'Filesystem', fn: runFsAgent, color: chalk.green },
  sql: { name: 'SQL', fn: runSqlAgent, color: chalk.yellow },
  embedding: { name: 'Embedding', fn: runEmbeddingAgent, color: chalk.magenta },
  codemode: { name: 'Codemode', fn: runCodemodeAgent, color: chalk.cyan },
} as const;

type AgentKey = keyof typeof AGENTS;

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log(chalk.bold('Usage: pnpm debug <agent> <question>'));
    console.log();
    console.log('Agents: bash, fs, sql, embedding, codemode');
    console.log();
    console.log('Example:');
    console.log('  pnpm debug fs "which project has the most issues?"');
    process.exit(1);
  }

  const [agentKey, ...questionParts] = args;
  const question = questionParts.join(' ');

  if (!(agentKey in AGENTS)) {
    console.log(chalk.red(`Unknown agent: ${agentKey}`));
    console.log(`Available: ${Object.keys(AGENTS).join(', ')}`);
    process.exit(1);
  }

  const agent = AGENTS[agentKey as AgentKey];
  console.log(agent.color.bold(`\n═══ ${agent.name} Agent Debug ═══\n`));
  console.log(chalk.dim(`Question: ${question}\n`));

  // Wrap in a Braintrust trace
  await traced(
    async (span) => {
      span.log({ input: question, metadata: { agent: agentKey } });

      const callbacks: StreamCallbacks = {
        onText: (chunk) => {
          process.stdout.write(chalk.white(chunk));
        },
        onToolCall: (toolName, args) => {
          console.log(chalk.cyan(`\n🔧 TOOL CALL: ${toolName}`));
          console.log(
            chalk.cyan(`   Args: ${JSON.stringify(args, null, 2).split('\n').join('\n   ')}`),
          );
        },
        onToolResult: (toolName, result) => {
          const preview = result.length > 500 ? result.slice(0, 500) + '...' : result;
          console.log(chalk.gray(`\n↪ RESULT (${toolName}):`));
          console.log(chalk.gray(`   ${preview.split('\n').join('\n   ')}`));
          console.log();
        },
        onProgress: () => {},
      };

      try {
        const result = await agent.fn(question, callbacks);

        console.log(agent.color.bold(`\n\n═══ Final Result ═══\n`));
        console.log(result.answer || chalk.dim('(no text response)'));
        console.log();
        console.log(chalk.dim(`─────────────────────────────────`));
        console.log(chalk.dim(`Latency:    ${(result.latencyMs / 1000).toFixed(2)}s`));
        console.log(chalk.dim(`Tool calls: ${result.toolCalls}`));
        console.log(chalk.dim(`Tokens:     ${result.tokens.toLocaleString()}`));

        span.log({
          output: result.answer,
          metadata: {
            latencyMs: result.latencyMs,
            toolCalls: result.toolCalls,
            tokens: result.tokens,
          },
        });
      } catch (error: any) {
        console.log(chalk.red.bold(`\n\n═══ Error ═══\n`));
        console.log(chalk.red(error.message));
        span.log({ error: error.message });
      }
    },
    { name: `debug-${agentKey}` },
  );
}

main().catch(console.error);
