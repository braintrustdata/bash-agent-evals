import 'dotenv/config';
import { LLMClassifierFromTemplate, makePartial } from 'autoevals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getModelFromEnv, type ModelId } from '../src/models.js';

// Get model from environment or default
export const model = getModelFromEnv();

// Load questions
const questionsPath = join(process.cwd(), 'evals/questions.json');

export interface Question {
  id: string;
  question: string;
  category: string;
  difficulty: string;
  reference_answer: string;
  notes: string;
}

const allQuestions: Question[] = JSON.parse(readFileSync(questionsPath, 'utf-8'));

// Limit for debugging - set to null for all questions
const LIMIT = null;
const questions = LIMIT ? allQuestions.slice(0, LIMIT) : allQuestions;

// Create data for evals
export const data = questions.map((q) => ({
  input: q.question,
  expected: q.reference_answer,
  metadata: {
    id: q.id,
    category: q.category,
    difficulty: q.difficulty,
    notes: q.notes,
  },
}));

// Custom Factuality scorer that doesn't penalize superset answers
// Wrapped with makePartial to support .partial() for pre-binding maxTokens
const FactualityBase = makePartial(
  LLMClassifierFromTemplate({
    name: 'Factuality',
    promptTemplate: `You are comparing a submitted answer to an expert answer on a given question. Here is the data:
[BEGIN DATA]
**********
[Question]: {{input}}
**********
[Expert]: {{expected}}
**********
[Submission]: {{output}}
**********
[END DATA]

Compare the factual content of the submitted answer with the expert answer. Ignore any differences in style, grammar, or punctuation.
The submitted answer may either be a subset or superset of the expert answer, or it may conflict with it. Determine which case applies. Answer the question by selecting one of the following options:
(A) The submitted answer is a subset of the expert answer and is fully consistent with it.
(B) The submitted answer is a superset of the expert answer and is fully consistent with it.
(C) The submitted answer contains all the same details as the expert answer.
(D) There is a disagreement between the submitted answer and the expert answer.
(E) The answers differ, but these differences don't matter from the perspective of factuality.`,
    choiceScores: {
      A: 0.4,
      B: 1, // Changed from 0.6 - superset answers are fully correct
      C: 1,
      D: 0,
      E: 1,
    },
    model: 'gpt-4.1-mini',
  }),
  'Factuality',
);

// Limit output tokens to prevent runaway generation and JSON parsing issues
export const Factuality = FactualityBase.partial({ maxTokens: 500 });

import { runAgentInWorker } from '../src/agents/run-in-worker.js';
import { defaultErrorScoreHandler, type Span } from 'braintrust';

export type AgentType = 'bash' | 'fs' | 'sql' | 'embedding';

// Helper to create task that runs agent in a worker process with tracing
export const createWorkerTask =
  (agentType: AgentType) =>
  async (input: string, { span }: { span: Span }) => {
    const parentSpanContext = await span.export();
    const result = await runAgentInWorker(agentType, input, { parentSpanContext });
    return result.answer;
  };

// Legacy: Helper to create task with model (direct call, no worker)
export const createTask =
  (agentFn: (q: string, cb: undefined, model: ModelId) => Promise<{ answer: string }>) =>
  async (input: string) =>
    (await agentFn(input, undefined, model)).answer;

export const scorerArgs = {
  scores: [Factuality],
  errorScoreHandler: defaultErrorScoreHandler,
};

export { ModelId };
