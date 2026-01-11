import { Eval } from 'braintrust';
import { model, data, createWorkerTask, scorerArgs } from './shared.js';

Eval('bash-evals', {
  experimentName: `embedding-${model}`,
  metadata: { model, agent: 'embedding' },
  data,
  task: createWorkerTask('embedding'),
  ...scorerArgs,
});
