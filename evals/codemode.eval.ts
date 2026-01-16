import { Eval } from 'braintrust';
import { model, data, createWorkerTask, scorerArgs, MAX_STEPS } from './shared.js';

Eval('bash-evals', {
  experimentName: `codemode-${model}`,
  metadata: { model, agent: 'codemode', maxSteps: MAX_STEPS },
  data,
  task: createWorkerTask('codemode'),
  ...scorerArgs,
});
