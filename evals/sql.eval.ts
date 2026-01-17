import { Eval } from 'braintrust';
import { model, data, createWorkerTask, scorerArgs, MAX_CONCURRENCY, MAX_STEPS } from './shared.js';

Eval('bash-evals', {
  experimentName: `sql-${model}`,
  metadata: { model, agent: 'sql', maxSteps: MAX_STEPS },
  data,
  task: createWorkerTask('sql'),
  maxConcurrency: MAX_CONCURRENCY,
  ...scorerArgs,
});
