import { createReadStream, writeFileSync, existsSync, statSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import type {
  GitHubEvent,
  IssuesEvent,
  IssueCommentEvent,
  PullRequestEvent,
  PullRequestReviewCommentEvent,
} from './schema.js';

const RAW_FILE = join(import.meta.dirname, '../../data/raw/2024-01-15-15.json');
const OUTPUT_FILE = join(import.meta.dirname, '../../data/codemode.json');

// Data structures matching the types we'll expose to codemode
interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
}

interface User {
  id: number;
  login: string;
  issuesOpened: number;
  prsOpened: number;
  commentsMade: number;
}

interface Comment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
}

interface Issue {
  id: number;
  repoId: number;
  repoFullName: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: string;
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

interface Pull {
  id: number;
  repoId: number;
  repoFullName: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: string;
  merged: boolean;
  mergedAt: string | null;
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
}

interface CodemodeData {
  repos: Repo[];
  users: User[];
  issues: Issue[];
  pulls: Pull[];
}

// Track data as we process
const reposMap = new Map<string, Repo>();
const usersMap = new Map<string, User>();
const issuesMap = new Map<string, Issue>(); // key: "owner/repo#number"
const pullsMap = new Map<string, Pull>(); // key: "owner/repo#number"

function getOrCreateUser(login: string, id: number): User {
  if (!usersMap.has(login)) {
    usersMap.set(login, {
      id,
      login,
      issuesOpened: 0,
      prsOpened: 0,
      commentsMade: 0,
    });
  }
  return usersMap.get(login)!;
}

function getOrCreateRepo(repoName: string, repoId: number): Repo {
  if (!reposMap.has(repoName)) {
    const [owner, name] = repoName.split('/');
    reposMap.set(repoName, {
      id: repoId,
      owner,
      name,
      fullName: repoName,
    });
  }
  return reposMap.get(repoName)!;
}

function processEvent(event: GitHubEvent) {
  const repo = getOrCreateRepo(event.repo.name, event.repo.id);
  getOrCreateUser(event.actor.login, event.actor.id);

  switch (event.type) {
    case 'IssuesEvent': {
      const e = event as IssuesEvent;
      const key = `${event.repo.name}#${e.payload.issue.number}`;
      const issue = e.payload.issue;

      if (e.payload.action === 'opened') {
        const user = getOrCreateUser(issue.user.login, issue.user.id);
        user.issuesOpened++;
      }

      if (!issuesMap.has(key)) {
        issuesMap.set(key, {
          id: issue.id,
          repoId: repo.id,
          repoFullName: repo.fullName,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          author: issue.user.login,
          labels: issue.labels.map((l) => l.name),
          comments: [],
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          closedAt: issue.closed_at,
        });
      } else {
        const existing = issuesMap.get(key)!;
        existing.state = issue.state;
        existing.updatedAt = issue.updated_at;
        existing.closedAt = issue.closed_at;
      }
      break;
    }

    case 'IssueCommentEvent': {
      const e = event as IssueCommentEvent;
      const key = `${event.repo.name}#${e.payload.issue.number}`;
      const comment = e.payload.comment;

      const user = getOrCreateUser(comment.user.login, comment.user.id);
      user.commentsMade++;

      if (!issuesMap.has(key)) {
        const issue = e.payload.issue;
        issuesMap.set(key, {
          id: issue.id,
          repoId: repo.id,
          repoFullName: repo.fullName,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          author: issue.user.login,
          labels: issue.labels.map((l) => l.name),
          comments: [],
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          closedAt: issue.closed_at,
        });
      }

      const issueData = issuesMap.get(key)!;
      issueData.comments.push({
        id: comment.id,
        body: comment.body,
        author: comment.user.login,
        createdAt: comment.created_at,
      });
      break;
    }

    case 'PullRequestEvent': {
      const e = event as PullRequestEvent;
      const key = `${event.repo.name}#${e.payload.number}`;
      const pr = e.payload.pull_request;

      if (e.payload.action === 'opened') {
        const user = getOrCreateUser(pr.user.login, pr.user.id);
        user.prsOpened++;
      }

      if (!pullsMap.has(key)) {
        pullsMap.set(key, {
          id: pr.id,
          repoId: repo.id,
          repoFullName: repo.fullName,
          number: pr.number,
          title: pr.title,
          body: pr.body,
          state: pr.state,
          author: pr.user.login,
          merged: pr.merged,
          mergedAt: pr.merged_at,
          comments: [],
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
        });
      } else {
        const existing = pullsMap.get(key)!;
        existing.state = pr.state;
        existing.merged = pr.merged;
        existing.mergedAt = pr.merged_at;
        existing.updatedAt = pr.updated_at;
      }
      break;
    }

    case 'PullRequestReviewCommentEvent': {
      const e = event as PullRequestReviewCommentEvent;
      const key = `${event.repo.name}#${e.payload.pull_request.number}`;
      const comment = e.payload.comment;
      const pr = e.payload.pull_request;

      const user = getOrCreateUser(comment.user.login, comment.user.id);
      user.commentsMade++;

      if (!pullsMap.has(key)) {
        pullsMap.set(key, {
          id: pr.id,
          repoId: repo.id,
          repoFullName: repo.fullName,
          number: pr.number,
          title: pr.title,
          body: pr.body,
          state: pr.state,
          author: pr.user.login,
          merged: pr.merged,
          mergedAt: pr.merged_at,
          comments: [],
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
        });
      }

      const pullData = pullsMap.get(key)!;
      pullData.comments.push({
        id: comment.id,
        body: comment.body,
        author: comment.user.login,
        createdAt: comment.created_at,
      });
      break;
    }
  }
}

async function main() {
  if (!existsSync(RAW_FILE)) {
    console.error(`Raw file not found: ${RAW_FILE}`);
    console.error('Run `pnpm download` first.');
    process.exit(1);
  }

  console.log('Reading events from:', RAW_FILE);

  const fileStream = createReadStream(RAW_FILE);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let count = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as GitHubEvent;
      processEvent(event);
      count++;
      if (count % 100000 === 0) {
        console.log(`Processed ${count} events...`);
      }
    } catch {
      // Skip malformed lines
    }
  }

  console.log(`\nTotal events processed: ${count}`);
  console.log(`Unique repos: ${reposMap.size}`);
  console.log(`Issues: ${issuesMap.size}`);
  console.log(`Pull requests: ${pullsMap.size}`);
  console.log(`Users: ${usersMap.size}`);

  // Build the final data structure
  const data: CodemodeData = {
    repos: Array.from(reposMap.values()),
    users: Array.from(usersMap.values()),
    issues: Array.from(issuesMap.values()),
    pulls: Array.from(pullsMap.values()),
  };

  console.log('\nWriting codemode.json...');
  writeFileSync(OUTPUT_FILE, JSON.stringify(data));

  const stats = statSync(OUTPUT_FILE);
  const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
  console.log(`Output: ${OUTPUT_FILE} (${sizeMB} MB)`);

  console.log('\nDone! Run `pnpm eval:codemode` to test the codemode agent.');
}

main();
