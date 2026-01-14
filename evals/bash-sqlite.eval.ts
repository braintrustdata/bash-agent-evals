import { Eval } from 'braintrust';
import { model, data, createWorkerTask, scorerArgs, MAX_STEPS } from './shared.js';
import { BASH_SQLITE_TIMEOUT_MS, BASH_SQLITE_TOOLS } from '../src/agents/bash-sqlite-agent.js';

Eval('bash-evals', {
  experimentName: `bash-sqlite-${model}`,
  metadata: {
    model,
    agent: 'bash-sqlite',
    maxSteps: MAX_STEPS,
    bashSqliteTimeoutMs: BASH_SQLITE_TIMEOUT_MS,
    bashSqliteTools: BASH_SQLITE_TOOLS,
  },
  data,
  task: createWorkerTask('bash-sqlite'),
  maxConcurrency: 5, // Run 5 evals at a time
  ...scorerArgs,
});
