import { Eval } from 'braintrust';
import { runFsAgent } from '../src/agents/fs-agent.js';
import { model, data, Factuality, createTask } from './shared.js';

Eval('bash-evals', {
  experimentName: `fs-${model}`,
  metadata: { model, agent: 'fs' },
  data,
  task: createTask(runFsAgent),
  scores: [Factuality],
});
