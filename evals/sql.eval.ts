import { Eval } from 'braintrust';
import { runSqlAgent } from '../src/agents/sql-agent.js';
import { model, data, Factuality, createTask } from './shared.js';

Eval('bash-evals', {
  experimentName: `sql-${model}`,
  metadata: { model, agent: 'sql' },
  data,
  task: createTask(runSqlAgent),
  scores: [Factuality],
});
