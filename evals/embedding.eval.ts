import { Eval } from 'braintrust';
import { runEmbeddingAgent } from '../src/agents/embedding-agent.js';
import { model, data, Factuality, createTask } from './shared.js';

Eval('bash-evals', {
  experimentName: `embedding-${model}`,
  metadata: { model, agent: 'embedding' },
  data,
  task: createTask(runEmbeddingAgent),
  scores: [Factuality],
});
