import { Eval } from 'braintrust';
import { model, data, createWorkerTask, scorerArgs } from './shared.js';

Eval('bash-evals', {
  experimentName: `sql-${model}`,
  metadata: { model, agent: 'sql' },
  data,
  task: createWorkerTask('sql'),
  ...scorerArgs,
});
