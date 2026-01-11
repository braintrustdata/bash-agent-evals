import { Eval } from 'braintrust';
import { model, data, createWorkerTask, scorerArgs } from './shared.js';

Eval('bash-evals', {
  experimentName: `bash-${model}`,
  metadata: { model, agent: 'bash' },
  data,
  task: createWorkerTask('bash'),
  ...scorerArgs,
});
