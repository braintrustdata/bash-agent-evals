import { Eval } from 'braintrust';
import { model, data, createWorkerTask, scorerArgs, MAX_CONCURRENCY, MAX_STEPS } from './shared.js';

Eval('bash-evals', {
  experimentName: `embedding-${model}`,
  metadata: { model, agent: 'embedding', maxSteps: MAX_STEPS },
  data,
  task: createWorkerTask('embedding'),
  maxConcurrency: MAX_CONCURRENCY,
  ...scorerArgs,
});
