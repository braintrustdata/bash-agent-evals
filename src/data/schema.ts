// Type definitions for GitHub events from GH Archive

export interface Actor {
  id: number;
  login: string;
  display_login?: string;
  gravatar_id: string;
  url: string;
  avatar_url: string;
}

export interface Repo {
  id: number;
  name: string; // format: "owner/repo"
  url: string;
}

export interface BaseEvent {
  id: string;
  type: string;
  actor: Actor;
  repo: Repo;
  public: boolean;
  created_at: string;
  org?: {
    id: number;
    login: string;
    gravatar_id: string;
    url: string;
    avatar_url: string;
  };
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: {
    id: number;
    login: string;
  };
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: {
    id: number;
    login: string;
  };
  merged: boolean;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: number;
  body: string;
  user: {
    id: number;
    login: string;
  };
  created_at: string;
  updated_at: string;
}

export interface IssuesEvent extends BaseEvent {
  type: 'IssuesEvent';
  payload: {
    action: 'opened' | 'closed' | 'reopened';
    issue: Issue;
  };
}

export interface IssueCommentEvent extends BaseEvent {
  type: 'IssueCommentEvent';
  payload: {
    action: 'created';
    issue: Issue;
    comment: Comment;
  };
}

export interface PullRequestEvent extends BaseEvent {
  type: 'PullRequestEvent';
  payload: {
    action: 'opened' | 'closed' | 'reopened' | 'merged';
    number: number;
    pull_request: PullRequest;
  };
}

export interface PullRequestReviewCommentEvent extends BaseEvent {
  type: 'PullRequestReviewCommentEvent';
  payload: {
    action: 'created';
    pull_request: PullRequest;
    comment: Comment;
  };
}

export interface PushEvent extends BaseEvent {
  type: 'PushEvent';
  payload: {
    push_id: number;
    size: number;
    distinct_size: number;
    ref: string;
    head: string;
    before: string;
    commits: Array<{
      sha: string;
      author: { name: string; email: string };
      message: string;
      distinct: boolean;
      url: string;
    }>;
  };
}

export type GitHubEvent =
  | IssuesEvent
  | IssueCommentEvent
  | PullRequestEvent
  | PullRequestReviewCommentEvent
  | PushEvent
  | BaseEvent;

// Filesystem representation types
export interface RepoFile {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  description?: string;
}

export interface IssueFile {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: string;
  labels: string[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: CommentFile[];
}

export interface PullFile {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: string;
  merged: boolean;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
  comments: CommentFile[];
}

export interface CommentFile {
  id: number;
  body: string;
  author: string;
  created_at: string;
}

export interface UserFile {
  id: number;
  login: string;
  issues_opened: number;
  prs_opened: number;
  comments_made: number;
}
