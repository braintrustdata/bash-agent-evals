import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import Database from 'better-sqlite3';
import type {
  GitHubEvent,
  IssuesEvent,
  IssueCommentEvent,
  PullRequestEvent,
  PullRequestReviewCommentEvent,
  RepoFile,
  UserFile,
} from './schema.js';

const RAW_FILE = join(import.meta.dirname, '../../data/raw/2024-01-15-15.json');
const FS_DIR = join(import.meta.dirname, '../../data/filesystem');
const DB_PATH = join(import.meta.dirname, '../../data/database.sqlite');

// Track data as we process
const repos = new Map<string, RepoFile>();
const issues = new Map<string, IssueFile>(); // key: "owner/repo#number"
const pulls = new Map<string, PullFile>(); // key: "owner/repo#number"
const users = new Map<string, UserFile>();
const events: GitHubEvent[] = [];

function getOrCreateUser(login: string, id: number): UserFile {
  if (!users.has(login)) {
    users.set(login, {
      id,
      login,
      issues_opened: 0,
      prs_opened: 0,
      comments_made: 0,
    });
  }
  return users.get(login)!;
}

function getOrCreateRepo(repoName: string, repoId: number): RepoFile {
  if (!repos.has(repoName)) {
    const [owner, name] = repoName.split('/');
    repos.set(repoName, {
      id: repoId,
      owner,
      name,
      full_name: repoName,
    });
  }
  return repos.get(repoName)!;
}

function processEvent(event: GitHubEvent) {
  // Track the repo
  getOrCreateRepo(event.repo.name, event.repo.id);

  // Track the actor
  getOrCreateUser(event.actor.login, event.actor.id);

  switch (event.type) {
    case 'IssuesEvent': {
      const e = event as IssuesEvent;
      const key = `${event.repo.name}#${e.payload.issue.number}`;
      const issue = e.payload.issue;

      if (e.payload.action === 'opened') {
        const user = getOrCreateUser(issue.user.login, issue.user.id);
        user.issues_opened++;
      }

      if (!issues.has(key)) {
        issues.set(key, {
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          author: issue.user.login,
          labels: issue.labels.map((l) => l.name),
          created_at: issue.created_at,
          updated_at: issue.updated_at,
          closed_at: issue.closed_at,
          comments: [],
        });
      } else {
        // Update state if changed
        const existing = issues.get(key)!;
        existing.state = issue.state;
        existing.updated_at = issue.updated_at;
        existing.closed_at = issue.closed_at;
      }
      break;
    }

    case 'IssueCommentEvent': {
      const e = event as IssueCommentEvent;
      const key = `${event.repo.name}#${e.payload.issue.number}`;
      const comment = e.payload.comment;

      const user = getOrCreateUser(comment.user.login, comment.user.id);
      user.comments_made++;

      // Ensure issue exists
      if (!issues.has(key)) {
        const issue = e.payload.issue;
        issues.set(key, {
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          author: issue.user.login,
          labels: issue.labels.map((l) => l.name),
          created_at: issue.created_at,
          updated_at: issue.updated_at,
          closed_at: issue.closed_at,
          comments: [],
        });
      }

      const issueFile = issues.get(key)!;
      issueFile.comments.push({
        id: comment.id,
        body: comment.body,
        author: comment.user.login,
        created_at: comment.created_at,
      });
      break;
    }

    case 'PullRequestEvent': {
      const e = event as PullRequestEvent;
      const key = `${event.repo.name}#${e.payload.number}`;
      const pr = e.payload.pull_request;

      if (e.payload.action === 'opened') {
        const user = getOrCreateUser(pr.user.login, pr.user.id);
        user.prs_opened++;
      }

      if (!pulls.has(key)) {
        pulls.set(key, {
          id: pr.id,
          number: pr.number,
          title: pr.title,
          body: pr.body,
          state: pr.state,
          author: pr.user.login,
          merged: pr.merged,
          merged_at: pr.merged_at,
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          comments: [],
        });
      } else {
        const existing = pulls.get(key)!;
        existing.state = pr.state;
        existing.merged = pr.merged;
        existing.merged_at = pr.merged_at;
        existing.updated_at = pr.updated_at;
      }
      break;
    }

    case 'PullRequestReviewCommentEvent': {
      const e = event as PullRequestReviewCommentEvent;
      const key = `${event.repo.name}#${e.payload.pull_request.number}`;
      const comment = e.payload.comment;
      const pr = e.payload.pull_request;

      const user = getOrCreateUser(comment.user.login, comment.user.id);
      user.comments_made++;

      if (!pulls.has(key)) {
        pulls.set(key, {
          id: pr.id,
          number: pr.number,
          title: pr.title,
          body: pr.body,
          state: pr.state,
          author: pr.user.login,
          merged: pr.merged,
          merged_at: pr.merged_at,
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          comments: [],
        });
      }

      const pullFile = pulls.get(key)!;
      pullFile.comments.push({
        id: comment.id,
        body: comment.body,
        author: comment.user.login,
        created_at: comment.created_at,
      });
      break;
    }
  }

  // Store all events
  events.push(event);
}

async function readAndProcessEvents() {
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
  console.log(`Unique repos: ${repos.size}`);
  console.log(`Issues: ${issues.size}`);
  console.log(`Pull requests: ${pulls.size}`);
  console.log(`Users: ${users.size}`);
}

function writeFilesystem() {
  console.log('\nWriting filesystem representation...');

  // Create base directories
  const reposDir = join(FS_DIR, 'repos');
  const usersDir = join(FS_DIR, 'users');

  mkdirSync(reposDir, { recursive: true });
  mkdirSync(usersDir, { recursive: true });

  // Write repos with their issues and PRs
  for (const [repoName, repo] of repos) {
    const [owner, name] = repoName.split('/');
    const repoDir = join(reposDir, owner, name);
    mkdirSync(repoDir, { recursive: true });

    // Write repo metadata
    writeFileSync(join(repoDir, 'repo.json'), JSON.stringify(repo, null, 2));

    // Write issues
    const issuesDir = join(repoDir, 'issues');
    let issueCount = 0;
    for (const [key, issue] of issues) {
      if (key.startsWith(repoName + '#')) {
        if (issueCount === 0) mkdirSync(issuesDir, { recursive: true });
        writeFileSync(join(issuesDir, `${issue.number}.json`), JSON.stringify(issue, null, 2));
        issueCount++;
      }
    }

    // Write pulls
    const pullsDir = join(repoDir, 'pulls');
    let pullCount = 0;
    for (const [key, pull] of pulls) {
      if (key.startsWith(repoName + '#')) {
        if (pullCount === 0) mkdirSync(pullsDir, { recursive: true });
        writeFileSync(join(pullsDir, `${pull.number}.json`), JSON.stringify(pull, null, 2));
        pullCount++;
      }
    }
  }

  // Write users
  for (const [login, user] of users) {
    writeFileSync(join(usersDir, `${login}.json`), JSON.stringify(user, null, 2));
  }

  console.log(`Filesystem written to: ${FS_DIR}`);
}

function writeDatabase() {
  console.log('\nWriting SQLite database...');

  // Remove existing database
  if (existsSync(DB_PATH)) {
    require('fs').unlinkSync(DB_PATH);
  }

  const db = new Database(DB_PATH);

  // Create tables
  db.exec(`
    CREATE TABLE repos (
      id INTEGER PRIMARY KEY,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      full_name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      login TEXT UNIQUE NOT NULL,
      issues_opened INTEGER DEFAULT 0,
      prs_opened INTEGER DEFAULT 0,
      comments_made INTEGER DEFAULT 0
    );

    CREATE TABLE issues (
      id INTEGER PRIMARY KEY,
      repo_id INTEGER NOT NULL,
      number INTEGER NOT NULL,
      title TEXT,
      body TEXT,
      state TEXT,
      author TEXT,
      labels_json TEXT,
      created_at TEXT,
      updated_at TEXT,
      closed_at TEXT,
      FOREIGN KEY (repo_id) REFERENCES repos(id),
      UNIQUE(repo_id, number)
    );

    CREATE TABLE pulls (
      id INTEGER PRIMARY KEY,
      repo_id INTEGER NOT NULL,
      number INTEGER NOT NULL,
      title TEXT,
      body TEXT,
      state TEXT,
      author TEXT,
      merged INTEGER DEFAULT 0,
      merged_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (repo_id) REFERENCES repos(id),
      UNIQUE(repo_id, number)
    );

    CREATE TABLE comments (
      id INTEGER PRIMARY KEY,
      issue_id INTEGER,
      pull_id INTEGER,
      body TEXT,
      author TEXT,
      created_at TEXT,
      FOREIGN KEY (issue_id) REFERENCES issues(id),
      FOREIGN KEY (pull_id) REFERENCES pulls(id)
    );

    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      actor_login TEXT,
      repo_name TEXT,
      payload_json TEXT,
      created_at TEXT
    );

    CREATE INDEX idx_issues_repo ON issues(repo_id);
    CREATE INDEX idx_issues_author ON issues(author);
    CREATE INDEX idx_pulls_repo ON pulls(repo_id);
    CREATE INDEX idx_pulls_author ON pulls(author);
    CREATE INDEX idx_comments_author ON comments(author);
    CREATE INDEX idx_events_type ON events(type);
    CREATE INDEX idx_events_repo ON events(repo_name);
    CREATE INDEX idx_events_actor ON events(actor_login);
  `);

  // Insert repos
  const insertRepo = db.prepare(
    'INSERT OR IGNORE INTO repos (id, owner, name, full_name) VALUES (?, ?, ?, ?)',
  );
  for (const repo of repos.values()) {
    insertRepo.run(repo.id, repo.owner, repo.name, repo.full_name);
  }

  // Insert users
  const insertUser = db.prepare(
    'INSERT OR IGNORE INTO users (id, login, issues_opened, prs_opened, comments_made) VALUES (?, ?, ?, ?, ?)',
  );
  for (const user of users.values()) {
    insertUser.run(user.id, user.login, user.issues_opened, user.prs_opened, user.comments_made);
  }

  // Create a map of repo full_name to id for foreign keys
  const repoIdMap = new Map<string, number>();
  for (const repo of repos.values()) {
    repoIdMap.set(repo.full_name, repo.id);
  }

  // Insert issues
  const insertIssue = db.prepare(`
    INSERT OR IGNORE INTO issues (id, repo_id, number, title, body, state, author, labels_json, created_at, updated_at, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const issueIdMap = new Map<string, number>();
  for (const [key, issue] of issues) {
    const repoName = key.split('#')[0];
    const repoId = repoIdMap.get(repoName);
    if (repoId) {
      insertIssue.run(
        issue.id,
        repoId,
        issue.number,
        issue.title,
        issue.body,
        issue.state,
        issue.author,
        JSON.stringify(issue.labels),
        issue.created_at,
        issue.updated_at,
        issue.closed_at,
      );
      issueIdMap.set(key, issue.id);
    }
  }

  // Insert pulls
  const insertPull = db.prepare(`
    INSERT OR IGNORE INTO pulls (id, repo_id, number, title, body, state, author, merged, merged_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const pullIdMap = new Map<string, number>();
  for (const [key, pull] of pulls) {
    const repoName = key.split('#')[0];
    const repoId = repoIdMap.get(repoName);
    if (repoId) {
      insertPull.run(
        pull.id,
        repoId,
        pull.number,
        pull.title,
        pull.body,
        pull.state,
        pull.author,
        pull.merged ? 1 : 0,
        pull.merged_at,
        pull.created_at,
        pull.updated_at,
      );
      pullIdMap.set(key, pull.id);
    }
  }

  // Insert comments
  const insertComment = db.prepare(`
    INSERT OR IGNORE INTO comments (id, issue_id, pull_id, body, author, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const [key, issue] of issues) {
    const issueId = issueIdMap.get(key);
    for (const comment of issue.comments) {
      insertComment.run(
        comment.id,
        issueId,
        null,
        comment.body,
        comment.author,
        comment.created_at,
      );
    }
  }
  for (const [key, pull] of pulls) {
    const pullId = pullIdMap.get(key);
    for (const comment of pull.comments) {
      insertComment.run(comment.id, null, pullId, comment.body, comment.author, comment.created_at);
    }
  }

  // Insert events (sample - first 100k to keep DB manageable)
  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO events (id, type, actor_login, repo_name, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const eventsToInsert = events.slice(0, 100000);
  for (const event of eventsToInsert) {
    insertEvent.run(
      event.id,
      event.type,
      event.actor.login,
      event.repo.name,
      JSON.stringify((event as any).payload || {}),
      event.created_at,
    );
  }

  db.close();
  console.log(`Database written to: ${DB_PATH}`);
}

async function main() {
  console.log('Starting data transformation...\n');

  await readAndProcessEvents();
  writeFilesystem();
  writeDatabase();

  console.log('\nTransformation complete!');
  console.log('Run `pnpm cli` to start the interactive CLI.');
}

main();
