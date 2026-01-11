import { Eval } from 'braintrust';
import { model, data, Factuality, createWorkerTask } from './shared.js';

Eval('bash-evals', {
  experimentName: `fs-${model}`,
  metadata: { model, agent: 'fs' },
  data,
  task: createWorkerTask('fs'),
  scores: [Factuality],
});
