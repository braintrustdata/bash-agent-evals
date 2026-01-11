import { Eval } from 'braintrust';
import { model, data, createWorkerTask, scorerArgs, MAX_STEPS } from './shared.js';
import { BASH_TIMEOUT_MS, BASH_TOOL_SET, BASH_TOOLS } from '../src/agents/bash-agent.js';

Eval('bash-evals', {
  experimentName: `bash-${model}`,
  metadata: {
    model,
    agent: 'bash',
    maxSteps: MAX_STEPS,
    bashTimeoutMs: BASH_TIMEOUT_MS,
    bashToolSet: BASH_TOOL_SET,
    bashTools: BASH_TOOLS,
  },
  data,
  task: createWorkerTask('bash'),
  ...scorerArgs,
});
