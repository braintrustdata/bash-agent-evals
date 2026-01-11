import { Eval } from 'braintrust';
import { model, data, createWorkerTask, scorerArgs } from './shared.js';

Eval('bash-evals', {
  experimentName: `fs-${model}`,
  metadata: { model, agent: 'fs' },
  data,
  task: createWorkerTask('fs'),
  ...scorerArgs,
});
