import { Eval } from 'braintrust';
import { model, data, createWorkerTask, scorerArgs, MAX_STEPS } from './shared.js';

Eval('bash-evals', {
  experimentName: `sql-${model}`,
  metadata: { model, agent: 'sql', maxSteps: MAX_STEPS },
  data,
  task: createWorkerTask('sql'),
  ...scorerArgs,
  maxConcurrency: 5, // Run 5 evals at a time
});
