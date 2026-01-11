import { Eval } from 'braintrust';
import { model, data, createWorkerTask, scorerArgs, MAX_STEPS } from './shared.js';

Eval('bash-evals', {
  experimentName: `fs-${model}`,
  metadata: { model, agent: 'fs', maxSteps: MAX_STEPS },
  data,
  task: createWorkerTask('fs'),
  ...scorerArgs,
});
