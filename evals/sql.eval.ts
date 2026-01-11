import { Eval } from 'braintrust';
import { model, data, Factuality, createWorkerTask } from './shared.js';

Eval('bash-evals', {
  experimentName: `sql-${model}`,
  metadata: { model, agent: 'sql' },
  data,
  task: createWorkerTask('sql'),
  scores: [Factuality],
});
