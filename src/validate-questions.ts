import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createModel } from './models.js';
import { generateText } from 'ai';
import { createRequire } from 'module';

const require = createRequire(join(process.cwd(), 'package.json'));
const Database = require('better-sqlite3');

// Use Opus for validation - it's the best model for accurate analysis
const VALIDATION_MODEL = createModel('claude-opus-4-5');

const DB_PATH = join(process.cwd(), 'data/database.sqlite');
const QUESTIONS_PATH = join(process.cwd(), 'evals/questions.json');
const OUTPUT_PATH = join(process.cwd(), 'evals/validated-questions.json');

interface Question {
  id: string;
  question: string;
  category: string;
  difficulty: string;
  reference_answer: string;
  notes: string;
}

interface ValidationResult {
  question_id: string;
  question: string;
  original_answer: string;
  sql_findings: string;
  bash_approach: string;
  validated_answer: string;
  confidence: 'high' | 'medium' | 'low';
  discrepancies: string[];
  notes: string;
}

// Initialize database
const db = new Database(DB_PATH, { readonly: true });

// Helper to run SQL queries safely
function runQuery(sql: string): any[] {
  try {
    return db.prepare(sql).all();
  } catch (e: any) {
    return [{ error: e.message }];
  }
}

// Get database schema for context
function getSchema(): string {
  const tables = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { sql: string }[];
  return tables.map((t) => t.sql).join('\n\n');
}

// Research agent that validates a single question
async function validateQuestion(question: Question, schema: string): Promise<ValidationResult> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Validating ${question.id}: ${question.question}`);
  console.log(`Original answer: ${question.reference_answer}`);
  console.log(`${'='.repeat(60)}`);

  // Step 1: Ask the model to generate SQL queries to validate
  const sqlPlanResponse = await generateText({
    model: VALIDATION_MODEL,
    system: `You are a data analyst validating reference answers for an eval dataset.
Given a question about GitHub data, generate 1-3 SQL queries that would help validate the reference answer.

DATABASE SCHEMA:
${schema}

EXAMPLE QUERIES (use these patterns):
-- Count issues per repo:
SELECT repos.full_name, COUNT(*) as issue_count
FROM repos JOIN issues ON repos.id = issues.repo_id
GROUP BY repos.id ORDER BY issue_count DESC LIMIT 5;

-- Find issues by text:
SELECT repos.full_name, issues.number, issues.title
FROM issues JOIN repos ON issues.repo_id = repos.id
WHERE issues.body LIKE '%keyword%';

-- Count by owner:
SELECT owner, COUNT(*) FROM repos GROUP BY owner ORDER BY COUNT(*) DESC LIMIT 10;

-- PRs with merge status:
SELECT repos.full_name, pulls.number, pulls.title, pulls.merged
FROM pulls JOIN repos ON pulls.repo_id = repos.id
WHERE pulls.merged = 1;

IMPORTANT RULES:
- ALWAYS use full table names (repos, issues, pulls, comments, events, users)
- NEVER use aliases like r, i, p - use repos, issues, pulls directly
- labels_json is a JSON array string like '["bug","enhancement"]'
- Use LIKE for text search in body/title fields
- merged column in pulls is 0/1 (not true/false)
- Filter bots with: author NOT LIKE '%[bot]%' AND author NOT LIKE '%bot'

Return ONLY valid SQL queries, one per line. No explanation.`,
    prompt: `Question: ${question.question}
Reference answer to validate: ${question.reference_answer}

Generate SQL queries to verify this answer:`,
    maxTokens: { type: 'token', value: 1000 },
  });

  // Parse SQL queries - handle multi-line queries by splitting on semicolons
  const sqlQueries = sqlPlanResponse.text
    .split(';')
    .map((q) => q.trim().replace(/\n/g, ' ').replace(/\s+/g, ' '))
    .filter((q) => q.toUpperCase().startsWith('SELECT') || q.toUpperCase().startsWith('WITH'))
    .slice(0, 3);

  console.log(`\nGenerated ${sqlQueries.length} SQL queries`);

  // Step 2: Execute SQL queries
  const sqlResults: { query: string; result: any[] }[] = [];
  for (const query of sqlQueries) {
    console.log(`\nRunning: ${query.slice(0, 100)}...`);
    const result = runQuery(query);
    sqlResults.push({ query, result: result.slice(0, 20) }); // Limit results
    console.log(`Result: ${JSON.stringify(result.slice(0, 5), null, 2).slice(0, 500)}`);
  }

  // Step 3: Ask model to suggest bash/filesystem approach
  const bashApproachResponse = await generateText({
    model: VALIDATION_MODEL,
    system: `You are a data analyst. Describe how you would validate this answer using bash commands on a filesystem.
The data is stored in data/filesystem/ with structure:
- repos/{owner}/{repo}/repo.json (repo metadata)
- repos/{owner}/{repo}/issues/{number}.json (issue data with title, body, labels, state)
- repos/{owner}/{repo}/pulls/{number}.json (PR data with title, body, merged status)
- users/{username}/user.json (user data)

Be concise - just describe the approach in 1-2 sentences.`,
    prompt: `Question: ${question.question}
How would you validate using bash/filesystem?`,
    maxTokens: { type: 'token', value: 200 },
  });

  // Step 4: Synthesize findings and produce validated answer
  const synthesisResponse = await generateText({
    model: VALIDATION_MODEL,
    system: `You are validating reference answers for an eval dataset. Based on SQL query results, determine:
1. Is the reference answer correct, partially correct, or incorrect?
2. What is the validated/corrected answer?
3. What is your confidence level (high/medium/low)?
4. Any discrepancies found?

Be precise with numbers and facts. If the SQL results support the reference answer, say so.
If they contradict it, provide the correct answer based on the data.`,
    prompt: `Question: ${question.question}
Category: ${question.category}

Reference answer: ${question.reference_answer}

SQL Query Results:
${sqlResults.map((r) => `Query: ${r.query}\nResult: ${JSON.stringify(r.result, null, 2)}`).join('\n\n')}

Bash approach: ${bashApproachResponse.text}

Respond in this exact format:
VALIDATED_ANSWER: [the correct answer based on evidence]
CONFIDENCE: [high or medium or low]
DISCREPANCIES: [list any differences from reference answer, or "none" if it matches]
NOTES: [any caveats or additional context]`,
    maxTokens: { type: 'token', value: 1000 },
  });

  // Parse the synthesis response
  const synthesisText = synthesisResponse.text;

  // Extract fields from response using line-by-line parsing
  const lines = synthesisText.split('\n');
  let validated_answer = question.reference_answer;
  let confidence: 'high' | 'medium' | 'low' = 'medium';
  let discrepancies: string[] = [];
  let notes = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('VALIDATED_ANSWER:')) {
      validated_answer = line.replace('VALIDATED_ANSWER:', '').trim();
    } else if (line.startsWith('CONFIDENCE:')) {
      const conf = line.replace('CONFIDENCE:', '').trim().toLowerCase();
      if (conf === 'high' || conf === 'medium' || conf === 'low') {
        confidence = conf;
      }
    } else if (line.startsWith('DISCREPANCIES:')) {
      const disc = line.replace('DISCREPANCIES:', '').trim();
      if (disc.toLowerCase() !== 'none' && disc.length > 0) {
        discrepancies = [disc];
      }
    } else if (line.startsWith('NOTES:')) {
      notes = line.replace('NOTES:', '').trim();
    }
  }

  console.log(`\nValidated answer: ${validated_answer.slice(0, 200)}`);
  console.log(`Confidence: ${confidence}`);
  console.log(`Discrepancies: ${discrepancies.length > 0 ? discrepancies.join(', ') : 'none'}`);

  return {
    question_id: question.id,
    question: question.question,
    original_answer: question.reference_answer,
    sql_findings: sqlResults
      .map((r) => `${r.query} → ${JSON.stringify(r.result.slice(0, 5))}`)
      .join('\n'),
    bash_approach: bashApproachResponse.text,
    validated_answer,
    confidence,
    discrepancies,
    notes,
  };
}

async function main() {
  const questions: Question[] = JSON.parse(readFileSync(QUESTIONS_PATH, 'utf-8'));
  const schema = getSchema();

  console.log(`Loaded ${questions.length} questions`);
  console.log(`Database schema:\n${schema}\n`);

  // Parse command line args for specific question
  const args = process.argv.slice(2);
  const specificId = args.find((a) => a.startsWith('--id='))?.split('=')[1];
  const startFrom = args.find((a) => a.startsWith('--start='))?.split('=')[1];

  let questionsToValidate = questions;

  if (specificId) {
    questionsToValidate = questions.filter((q) => q.id === specificId);
    if (questionsToValidate.length === 0) {
      console.error(`Question ${specificId} not found`);
      process.exit(1);
    }
  } else if (startFrom) {
    const startIndex = questions.findIndex((q) => q.id === startFrom);
    if (startIndex === -1) {
      console.error(`Question ${startFrom} not found`);
      process.exit(1);
    }
    questionsToValidate = questions.slice(startIndex);
  }

  console.log(`Validating ${questionsToValidate.length} questions...`);

  const results: ValidationResult[] = [];

  for (const question of questionsToValidate) {
    try {
      const result = await validateQuestion(question, schema);
      results.push(result);

      // Save intermediate results
      writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2));
    } catch (error: any) {
      console.error(`Error validating ${question.id}: ${error.message}`);
      results.push({
        question_id: question.id,
        question: question.question,
        original_answer: question.reference_answer,
        sql_findings: '',
        bash_approach: '',
        validated_answer: question.reference_answer,
        confidence: 'low',
        discrepancies: [`Error during validation: ${error.message}`],
        notes: 'Validation failed',
      });
    }
  }

  // Final save
  writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2));

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('VALIDATION SUMMARY');
  console.log('='.repeat(60));

  const highConfidence = results.filter((r) => r.confidence === 'high').length;
  const mediumConfidence = results.filter((r) => r.confidence === 'medium').length;
  const lowConfidence = results.filter((r) => r.confidence === 'low').length;
  const withDiscrepancies = results.filter((r) => r.discrepancies.length > 0).length;

  console.log(`Total validated: ${results.length}`);
  console.log(`High confidence: ${highConfidence}`);
  console.log(`Medium confidence: ${mediumConfidence}`);
  console.log(`Low confidence: ${lowConfidence}`);
  console.log(`With discrepancies: ${withDiscrepancies}`);

  if (withDiscrepancies > 0) {
    console.log('\nQuestions with discrepancies:');
    for (const r of results.filter((r) => r.discrepancies.length > 0)) {
      console.log(`  ${r.question_id}: ${r.discrepancies.join('; ')}`);
    }
  }

  console.log(`\nResults saved to ${OUTPUT_PATH}`);

  // Reconciliation: update questions.json with validated answers
  const shouldReconcile = args.includes('--reconcile');
  if (shouldReconcile && withDiscrepancies > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('RECONCILING QUESTIONS');
    console.log('='.repeat(60));

    const updatedQuestions = questions.map((q) => {
      const validation = results.find((r) => r.question_id === q.id);
      if (!validation) return { ...q, confidence: 'unvalidated' as const };

      const hasDiscrepancy = validation.discrepancies.length > 0;
      return {
        ...q,
        reference_answer: hasDiscrepancy ? validation.validated_answer : q.reference_answer,
        confidence: validation.confidence,
        validation_notes: validation.notes || undefined,
      };
    });

    writeFileSync(QUESTIONS_PATH, JSON.stringify(updatedQuestions, null, 2));
    console.log(`Updated ${QUESTIONS_PATH} with validated answers`);

    const updated = results.filter((r) => r.discrepancies.length > 0);
    console.log(`\nUpdated ${updated.length} answers:`);
    for (const r of updated) {
      console.log(`  ${r.question_id}:`);
      console.log(`    OLD: ${r.original_answer.slice(0, 80)}...`);
      console.log(`    NEW: ${r.validated_answer.slice(0, 80)}...`);
    }
  } else if (shouldReconcile) {
    console.log('\nNo discrepancies to reconcile.');
  } else if (withDiscrepancies > 0) {
    console.log(`\nRun with --reconcile to update questions.json with validated answers`);
  }
}

main().catch(console.error);
