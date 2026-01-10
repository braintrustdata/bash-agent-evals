# Bash vs SQL vs Embeddings - Agent Comparison

An evaluation framework to test the claim from [Vercel's blog post](https://vercel.com/blog/how-to-build-agents-with-filesystems-and-bash) that bash/filesystem tools are superior to SQL for AI agent data exploration.

## Overview

This project compares **4 different approaches** to AI agent data exploration:

| Agent          | Approach                                                                        | Tools                                                         |
| -------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Bash**       | Sandboxed shell via [just-bash](https://github.com/nicholasgriffintn/just-bash) | `ls`, `grep`, `cat`, `find`, `head`, `wc`, `jq`               |
| **Filesystem** | TypeScript fs operations                                                        | `listDir`, `readFile`, `readJson`, `searchFiles`, `findFiles` |
| **SQL**        | SQLite queries                                                                  | `query`, `schema`, `tables`, `sample`, `count`                |
| **Embedding**  | Semantic vector search                                                          | `searchSimilar`, `getContext`                                 |

All agents use Claude Sonnet 4 via the [Vercel AI SDK v6](https://ai-sdk.dev/) with the `ToolLoopAgent` for agentic loops.

## Dataset

Uses real GitHub event data from [GH Archive](https://www.gharchive.org/):

- ~81k repositories
- ~12k issues
- ~16k pull requests
- ~66k users
- ~267k events

Data is stored in two formats:

1. **Filesystem**: Hierarchical JSON files (`repos/{owner}/{repo}/issues/{num}.json`)
2. **SQLite**: Normalized relational tables

## Setup

```bash
# Install dependencies
pnpm install

# Download GH Archive data (~958 MB)
pnpm download

# Transform to filesystem + SQLite formats
pnpm transform

# Pre-compute embeddings for vector search (~28k items)
pnpm embed
```

## Environment Variables

```bash
ANTHROPIC_API_KEY=sk-ant-...  # Required for Claude
OPENAI_API_KEY=sk-...         # Required for embeddings
BRAINTRUST_API_KEY=...        # Required for evals
```

## Usage

### Interactive CLI (TUI)

Run all 4 agents in parallel with a side-by-side view:

```bash
pnpm cli
```

Features:

- 4-column layout showing all agents simultaneously
- Real-time streaming of tool calls and responses
- Live token/tool count updates
- Error display with visual indicators

### Debug Single Agent

Test one agent at a time with verbose output:

```bash
pnpm debug <agent> "<question>"

# Examples:
pnpm debug bash "which project has the most issues?"
pnpm debug fs "find issues mentioning memory leak"
pnpm debug sql "count PRs by author"
pnpm debug embedding "issues about performance problems"
```

### Run Evaluations

Run the [Braintrust](https://braintrust.dev/) eval suite:

```bash
pnpm eval
```

This runs the agents against a set of questions in `evals/questions.json` and scores them using a custom Factuality scorer.

## Project Structure

```
bash-eval/
├── src/
│   ├── cli.tsx              # Interactive TUI (Ink/React)
│   ├── debug-agent.ts       # Single agent debugger
│   ├── tracing.ts           # Braintrust tracing helpers
│   ├── agents/
│   │   ├── bash-agent.ts    # Sandboxed bash via just-bash + OverlayFs
│   │   ├── fs-agent.ts      # TypeScript filesystem
│   │   ├── sql-agent.ts     # SQLite queries
│   │   └── embedding-agent.ts # Vector search
│   ├── tools/
│   │   ├── fs-tools.ts      # Filesystem tools
│   │   ├── sql-tools.ts     # SQL query tools
│   │   └── embedding-tools.ts # Embedding search tools
│   ├── eval/
│   │   └── run.eval.ts      # Braintrust eval runner
│   └── data/
│       ├── download.ts      # GH Archive downloader
│       ├── transform.ts     # Data transformer
│       └── embed.ts         # Embedding generator
├── evals/
│   └── questions.json       # Eval questions with reference answers
├── data/
│   ├── filesystem/          # Hierarchical JSON files
│   ├── database.sqlite      # SQLite database
│   ├── embeddings.bin       # Pre-computed embeddings
│   └── embeddings-index.json # Embedding metadata
└── package.json
```

## Scripts

| Script                   | Description                              |
| ------------------------ | ---------------------------------------- |
| `pnpm cli`               | Interactive 4-column TUI                 |
| `pnpm debug <agent> <q>` | Debug single agent with streaming output |
| `pnpm download`          | Download GH Archive data                 |
| `pnpm transform`         | Transform to fs + SQLite                 |
| `pnpm embed`             | Pre-compute embeddings                   |
| `pnpm eval`              | Run Braintrust eval                      |
| `pnpm lint`              | Run oxlint                               |
| `pnpm format`            | Format code with prettier                |
| `pnpm format:check`      | Check formatting                         |

## Development

This project uses:

- **TypeScript** with strict mode
- **Prettier** for code formatting
- **oxlint** for linting (with `--deny-warnings`)
- **Husky** + **lint-staged** for pre-commit hooks

Pre-commit hooks automatically run prettier and oxlint on staged files.

## Key Claims Being Tested

From Vercel's blog post:

1. **Precision over embeddings** - exact matches vs semantic search
2. **Minimal context loading** - load files on demand vs upfront
3. **Domain-aligned structure** - hierarchies preserved vs flattened
4. **Debuggability** - visible execution paths
5. **Leverages existing model capabilities** - models understand code navigation

## Technical Notes

### Bash Agent

The bash agent uses [bash-tool](https://github.com/vercel-labs/bash-tool) with [just-bash](https://github.com/nicholasgriffintn/just-bash) and `OverlayFs` to provide a sandboxed shell environment that reads from the real filesystem but keeps writes in memory. Output is truncated to 30k characters to prevent token overflow.

### SQL Agent

Uses `better-sqlite3` with `createRequire` to work around native module bundling issues when running via Braintrust's eval CLI.

### Streaming

All agents use the AI SDK v6 `ToolLoopAgent.stream()` method with `fullStream` to provide real-time streaming of tool calls, results, and text output.
