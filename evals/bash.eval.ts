import { Eval } from 'braintrust';
import { model, data, createWorkerTask, scorerArgs, MAX_STEPS } from './shared.js';
import { BASH_TIMEOUT_MS } from '../src/agents/bash-agent.js';

Eval('bash-evals', {
  experimentName: `bash-${model}`,
  metadata: { model, agent: 'bash', maxSteps: MAX_STEPS, bashTimeoutMs: BASH_TIMEOUT_MS },
  data,
  task: createWorkerTask('bash'),
  ...scorerArgs,
});
