# CLAUDE.md

This file contains guidance for Claude Code when working on this project.

## Project Overview

This is an eval comparing 4 AI agent approaches (Bash, Filesystem, SQL, Embeddings) for data exploration tasks on GitHub event data.

## Model Selection

- **claude-opus-4-5** is the best model available. Use it for:
  - Validation tasks
  - Research and analysis
  - Any task requiring high accuracy
  - Reference answer generation

- **claude-sonnet-4-5** is good for faster iteration during development and testing

- When running evals, the model can be configured via the `MODEL` env var (defaults to `claude-opus-4-5`)

## Key Files

- `src/models.ts` - Model configuration with official API model IDs
- `src/agents/*.ts` - The 4 agent implementations (bash, fs, sql, embedding)
- `src/validate-questions.ts` - Question validation script (uses Opus)
- `evals/questions.json` - Eval questions with reference answers
- `src/eval/run.eval.ts` - Braintrust eval runner

## Commands

```bash
pnpm debug          # Interactive agent debugging
pnpm eval           # Run Braintrust eval
pnpm validate       # Validate reference answers
pnpm lint           # Run oxlint with --deny-warnings
pnpm format         # Run prettier
```

## Code Style

- Pre-commit hooks run prettier and oxlint (strict mode)
- TypeScript with ES modules
- AI SDK v6 with `ToolLoopAgent` for agentic loops
- Braintrust integration via `wrapAISDK` for tracing

## Data

- `data/database.sqlite` - SQLite database with repos, issues, pulls, comments, events, users tables
- `data/filesystem/` - JSON files organized by repos/{owner}/{repo}/ and users/{login}/
