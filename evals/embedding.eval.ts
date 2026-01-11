import { Eval } from 'braintrust';
import { model, data, Factuality, createWorkerTask } from './shared.js';

Eval('bash-evals', {
  experimentName: `embedding-${model}`,
  metadata: { model, agent: 'embedding' },
  data,
  task: createWorkerTask('embedding'),
  scores: [Factuality],
});
