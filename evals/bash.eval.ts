import { Eval } from 'braintrust';
import { runBashAgent } from '../src/agents/bash-agent.js';
import { model, data, Factuality, createTask } from './shared.js';

Eval('bash-evals', {
  experimentName: `bash-${model}`,
  metadata: { model, agent: 'bash' },
  data,
  task: createTask(runBashAgent),
  scores: [Factuality],
});
