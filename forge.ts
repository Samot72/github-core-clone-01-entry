// forge.ts — the forge's domain state and operations, shared by the REST, GraphQL, MCP and
// git-protocol surfaces so every surface sees the same objects (the suite's parity checks
// compare them). All state is in memory. Time is a logical clock seeded from
// MAKEFUN_TRIAL_NOW (or a fixed epoch), so identical request sequences produce identical
// timestamps, commit ids and exports: no wall clock reaches any stored value.

import {
  Store,
  ZERO_SHA,
  buildCommit,
  buildTreeFromFiles,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
  treeEntryAt,
  treeListAt,
  type TreeEntry,
} from './gitstore.ts';

/** The login the shop token names: the suite's fixed scenario account. */
export const ACCOUNT_LOGIN = process.env.MAKEFUN_SHOP_LOGIN ?? 'adaiversen';
export const ACCOUNT_ID = 1000;

/** The identity API-made commits carry. */
const COMMITTER_NAME = 'MakeFun Forge';
const COMMITTER_EMAIL = 'forge@make.fun';

// ---------------------------------------------------------------- logical clock

const CLOCK_BASE_MS = (() => {
  const fromEnv = process.env.MAKEFUN_TRIAL_NOW;
  if (fromEnv !== undefined && fromEnv !== '') {
    const parsed = Date.parse(fromEnv);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.parse('2026-01-01T00:00:00.000Z');
})();

let clockSeq = 0;

/** Advance the logical clock and return the new sequence number. */
export function tick(): number {
  clockSeq += 1;
  return clockSeq;
}

/** ISO timestamp for a sequence number. */
export function isoAt(seq: number): string {
  return new Date(CLOCK_BASE_MS + seq * 1000).toISOString();
}

/** The current logical time as ISO (advances the clock). */
export function nowIso(): string {
  return isoAt(tick());
}

/** A git author/committer line for a sequence number. */
export function gitIdent(seq: number): string {
  const seconds = Math.floor((CLOCK_BASE_MS + seq * 1000) / 1000);
  return `${COMMITTER_NAME} <${COMMITTER_EMAIL}> ${seconds} +0000`;
}

// ---------------------------------------------------------------- records

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedSeq: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  seq: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  store: Store;
  /** Full ref name (refs/heads/x, refs/tags/x) -> object id. */
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
  seq: number;
}

const repos = new Map<string, RepoRec>();
let nextRepoId = 1;
let nextIssueId = 1;
let nextCommentId = 1;

/** Map key for a repository. */
export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/** Look up a repository by owner/name (null when absent — callers answer 404). */
export function getRepo(owner: string, name: string): RepoRec | null {
  return repos.get(repoKey(owner, name)) ?? null;
}

/** Look up a repository by its numeric database id (GraphQL node/createPullRequest inputs). */
export function getRepoById(id: number): RepoRec | null {
  for (const repo of repos.values()) if (repo.id === id) return repo;
  return null;
}

/** All repositories owned by the account, in creation order. */
export function listRepos(): RepoRec[] {
  return [...repos.values()].filter((repo) => repo.owner === ACCOUNT_LOGIN);
}

/** Create a repository; returns null when the name is taken under this owner. */
export function createRepo(name: string, options: { private?: boolean; description?: string } = {}): RepoRec | null {
  const key = repoKey(ACCOUNT_LOGIN, name);
  if (repos.has(key)) return null;
  const repo: RepoRec = {
    id: nextRepoId,
    owner: ACCOUNT_LOGIN,
    name,
    private: options.private ?? false,
    description: options.description ?? '',
    defaultBranch: 'main',
    store: new Store(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    seq: tick(),
  };
  nextRepoId += 1;
  repos.set(key, repo);
  return repo;
}

/** Delete a repository outright. */
export function deleteRepo(repo: RepoRec): void {
  repos.delete(repoKey(repo.owner, repo.name));
}

// ---------------------------------------------------------------- refs & commits

/** The full ref name for a branch. */
export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

/** The commit id a branch points at, or null when the branch does not exist. */
export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(branchRef(branch)) ?? null;
}

/** The ref HEAD names: the default branch, always (HEAD is a symref to it). */
export function headRefName(repo: RepoRec): string {
  return branchRef(repo.defaultBranch);
}

/** Resolve a ref-ish (branch name, full ref, tag, or sha) to a commit id, or null. */
export function resolveCommit(repo: RepoRec, refish: string): string | null {
  if (refish === 'HEAD') {
    const tip = branchTip(repo, repo.defaultBranch);
    if (tip !== null) return tip;
  }
  const candidates = [refish, branchRef(refish), `refs/tags/${refish}`];
  for (const candidate of candidates) {
    const sha = repo.refs.get(candidate);
    if (sha !== undefined) {
      const object = repo.store.get(sha);
      if (object !== undefined && object.type === 'commit') return sha;
      if (object !== undefined && object.type === 'tag') {
        // peel one or more tag hops
        let current = sha;
        for (let hops = 0; hops < 8; hops += 1) {
          const inner = repo.store.get(current);
          if (inner === undefined) return null;
          if (inner.type === 'commit') return current;
          if (inner.type !== 'tag') return null;
          const match = /^object ([0-9a-f]{40})$/m.exec(inner.data.toString('utf8'));
          if (match === null) return null;
          current = match[1]!;
        }
        return null;
      }
    }
  }
  const object = repo.store.get(refish);
  if (object !== undefined && object.type === 'commit') return refish;
  return null;
}

/** Create a commit on top of a parent (or as a root) and move a branch to it. */
export function commitOnBranch(repo: RepoRec, branch: string, treeSha: string, message: string, parent: string | null): string {
  const seq = tick();
  const ident = gitIdent(seq);
  const data = buildCommit({
    tree: treeSha,
    parents: parent === null ? [] : [parent],
    author: ident,
    committer: ident,
    message: message.endsWith('\n') ? message : `${message}\n`,
  });
  const sha = repo.store.put('commit', data);
  repo.refs.set(branchRef(branch), sha);
  return sha;
}

/** The flat file map of a commit's tree. */
export function filesOfCommit(repo: RepoRec, commitSha: string): Map<string, { sha: string; mode: string }> {
  const object = repo.store.get(commitSha);
  if (object === undefined || object.type !== 'commit') return new Map();
  return flattenTree(repo.store, parseCommit(object.data).tree);
}

/**
 * Write a file through the contents API's semantics: returns the new commit id, or a failure
 * tag. Creates the branch from the default branch's tip when it does not exist yet (the MCP
 * setup relies on the contents route as a branch-creation fallback), and the first commit on
 * an unborn default branch.
 */
export function putContent(
  repo: RepoRec,
  path: string,
  content: Buffer,
  message: string,
  branch: string,
  expectedSha: string | null,
): { ok: true; commitSha: string; blobSha: string; created: boolean } | { ok: false; reason: 'conflict' | 'sha-required' } {
  let tip = branchTip(repo, branch);
  if (tip === null && branch !== repo.defaultBranch) {
    const baseTip = branchTip(repo, repo.defaultBranch);
    if (baseTip !== null) {
      repo.refs.set(branchRef(branch), baseTip);
      tip = baseTip;
    }
  }
  const files = tip === null ? new Map<string, { sha: string; mode: string }>() : filesOfCommit(repo, tip);
  const existing = files.get(path);
  if (existing !== undefined && expectedSha === null) return { ok: false, reason: 'sha-required' };
  if (existing !== undefined && expectedSha !== null && existing.sha !== expectedSha) return { ok: false, reason: 'conflict' };
  if (existing === undefined && expectedSha !== null) return { ok: false, reason: 'conflict' };
  const blobSha = repo.store.put('blob', content);
  files.set(path, { sha: blobSha, mode: existing?.mode ?? '100644' });
  const treeSha = buildTreeFromFiles(repo.store, files);
  const commitSha = commitOnBranch(repo, branch, treeSha, message, tip);
  return { ok: true, commitSha, blobSha, created: existing === undefined };
}

/** Delete a file through the contents API's semantics. */
export function deleteContent(
  repo: RepoRec,
  path: string,
  message: string,
  branch: string,
  expectedSha: string | null,
): { ok: true; commitSha: string } | { ok: false; reason: 'missing' | 'conflict' } {
  const tip = branchTip(repo, branch);
  if (tip === null) return { ok: false, reason: 'missing' };
  const files = filesOfCommit(repo, tip);
  const existing = files.get(path);
  if (existing === undefined) return { ok: false, reason: 'missing' };
  if (expectedSha !== null && existing.sha !== expectedSha) return { ok: false, reason: 'conflict' };
  files.delete(path);
  const treeSha = buildTreeFromFiles(repo.store, files);
  const commitSha = commitOnBranch(repo, branch, treeSha, message, tip);
  return { ok: true, commitSha };
}

/** Read a path (file or directory) at a ref-ish; null when absent. */
export function readContentAt(repo: RepoRec, path: string, refish: string): { kind: 'file'; sha: string; mode: string; data: Buffer } | { kind: 'dir'; entries: TreeEntry[] } | null {
  const commit = resolveCommit(repo, refish);
  if (commit === null) return null;
  const commitObject = repo.store.get(commit);
  if (commitObject === undefined) return null;
  const treeSha = parseCommit(commitObject.data).tree;
  if (path === '' || path === '/') {
    const entries = treeListAt(repo.store, treeSha, '');
    return entries === null ? null : { kind: 'dir', entries };
  }
  const found = treeEntryAt(repo.store, treeSha, path);
  if (found === null) return null;
  if (found.type === 'dir') {
    const entries = treeListAt(repo.store, treeSha, path);
    return entries === null ? null : { kind: 'dir', entries };
  }
  const object = repo.store.get(found.sha);
  if (object === undefined || object.type !== 'blob') return null;
  return { kind: 'file', sha: found.sha, mode: found.mode, data: object.data };
}

// ---------------------------------------------------------------- labels & issues

/** Create (or fetch) a label. */
export function createLabel(repo: RepoRec, name: string, color: string): { name: string; color: string } {
  const existing = repo.labels.get(name);
  if (existing !== undefined) return existing;
  const label = { name, color };
  repo.labels.set(name, label);
  return label;
}

/** Create an issue; label names must exist (the caller validates, GitHub answers 422). */
export function createIssue(repo: RepoRec, title: string, body: string, labelNames: readonly string[]): IssueRec {
  const issue: IssueRec = {
    number: repo.nextNumber,
    id: nextIssueId,
    title,
    body,
    state: 'open',
    labels: [...labelNames],
    comments: [],
    seq: tick(),
  };
  repo.nextNumber += 1;
  nextIssueId += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

/** Add a comment to an issue. */
export function addComment(repo: RepoRec, issue: IssueRec, body: string): CommentRec {
  const comment: CommentRec = { id: nextCommentId, body, seq: tick() };
  nextCommentId += 1;
  issue.comments.push(comment);
  return comment;
}

/** Find an issue or pull request by its shared number. */
export function findNumbered(repo: RepoRec, number: number): { kind: 'issue'; rec: IssueRec } | { kind: 'pull'; rec: PullRec } | null {
  const issue = repo.issues.get(number);
  if (issue !== undefined) return { kind: 'issue', rec: issue };
  const pull = repo.pulls.get(number);
  if (pull !== undefined) return { kind: 'pull', rec: pull };
  return null;
}

// ---------------------------------------------------------------- pull requests & merging

/** Create a pull request between two existing branches. */
export function createPull(repo: RepoRec, title: string, body: string, headRef: string, baseRef: string): PullRec {
  const pull: PullRec = {
    number: repo.nextNumber,
    id: nextIssueId,
    title,
    body,
    state: 'open',
    merged: false,
    mergedSeq: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    seq: tick(),
  };
  repo.nextNumber += 1;
  nextIssueId += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Line counts of a text diff (multiset line difference; exact for the small files in play). */
function lineDelta(oldText: string, newText: string): { additions: number; deletions: number } {
  const countLines = (text: string): Map<string, number> => {
    const counts = new Map<string, number>();
    if (text === '') return counts;
    for (const line of text.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const oldCounts = countLines(oldText);
  const newCounts = countLines(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCounts) additions += Math.max(0, count - (oldCounts.get(line) ?? 0));
  for (const [line, count] of oldCounts) deletions += Math.max(0, count - (newCounts.get(line) ?? 0));
  return { additions, deletions };
}

/** The file changes between two commits' trees (merge-base tree vs head tree, computed by callers). */
export function diffCommits(repo: RepoRec, fromCommit: string | null, toCommit: string): FileChange[] {
  const from = fromCommit === null ? new Map<string, { sha: string; mode: string }>() : filesOfCommit(repo, fromCommit);
  const to = filesOfCommit(repo, toCommit);
  const changes: FileChange[] = [];
  const paths = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before !== undefined && after !== undefined && before.sha === after.sha) continue;
    const oldText = before === undefined ? '' : (repo.store.get(before.sha)?.data.toString('utf8') ?? '');
    const newText = after === undefined ? '' : (repo.store.get(after.sha)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDelta(oldText, newText);
    changes.push({
      path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

/**
 * A tree-level three-way merge: for every path, if both sides agree take it, if only one side
 * moved from the merge base take that side, otherwise the path conflicts. Returns the merged
 * file map, or the list of conflicting paths.
 */
export function threeWayMerge(
  repo: RepoRec,
  baseCommit: string,
  oursCommit: string,
  theirsCommit: string,
): { ok: true; files: Map<string, { sha: string; mode: string }> } | { ok: false; conflicts: string[] } {
  const base = filesOfCommit(repo, baseCommit);
  const ours = filesOfCommit(repo, oursCommit);
  const theirs = filesOfCommit(repo, theirsCommit);
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged = new Map<string, { sha: string; mode: string }>();
  const conflicts: string[] = [];
  for (const path of paths) {
    const b = base.get(path)?.sha ?? null;
    const o = ours.get(path)?.sha ?? null;
    const t = theirs.get(path)?.sha ?? null;
    let winner: string | null;
    if (o === t) winner = o;
    else if (b === o) winner = t;
    else if (b === t) winner = o;
    else {
      conflicts.push(path);
      continue;
    }
    if (winner !== null) {
      const source = (ours.get(path)?.sha === winner ? ours : theirs).get(path)!;
      merged.set(path, source);
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts };
  return { ok: true, files: merged };
}

/** Whether a pull request can merge cleanly right now (and its merge base). */
export function pullMergeability(repo: RepoRec, pull: PullRec): { mergeable: boolean; base: string | null } {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return { mergeable: false, base: null };
  const base = mergeBase(repo.store, baseTip, headTip);
  if (base === null) return { mergeable: false, base: null };
  if (base === headTip) return { mergeable: true, base }; // already up to date
  const result = threeWayMerge(repo, base, baseTip, headTip);
  return { mergeable: result.ok, base };
}

/**
 * Squash-merge a pull request onto its base branch: one commit with the merged tree, the base
 * tip as its only parent, and the pull request's title/body as the message. Returns the merge
 * commit id, or null when the merge conflicts (callers answer 405 / CONFLICTING).
 */
export function squashMerge(repo: RepoRec, pull: PullRec): string | null {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return null;
  const base = mergeBase(repo.store, baseTip, headTip);
  if (base === null) return null;
  const result = threeWayMerge(repo, base, baseTip, headTip);
  if (!result.ok) return null;
  const treeSha = buildTreeFromFiles(repo.store, result.files);
  const message = pull.body.trim() === '' ? `${pull.title} (#${pull.number})\n` : `${pull.title} (#${pull.number})\n\n${pull.body}\n`;
  const sha = commitOnBranch(repo, pull.baseRef, treeSha, message, baseTip);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedSeq = tick();
  pull.mergeCommitSha = sha;
  return sha;
}

/** Whether one commit is an ancestor of another (re-exported for the protocol surface). */
export function isAncestorCommit(repo: RepoRec, ancestor: string, descendant: string): boolean {
  return isAncestor(repo.store, ancestor, descendant);
}

// ---------------------------------------------------------------- REST serializers

/** The GitHub-shaped user object for the account. */
export function userJson(): Record<string, unknown> {
  return { login: ACCOUNT_LOGIN, id: ACCOUNT_ID, type: 'User', site_admin: false };
}

/** The GitHub-shaped repository object. */
export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: isoAt(repo.seq),
    updated_at: isoAt(repo.seq),
    pushed_at: isoAt(repo.seq),
    default_branch: repo.defaultBranch,
    visibility: repo.private ? 'private' : 'public',
  };
}

/** The GitHub-shaped label object. */
export function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? '000000', description: null, default: false };
}

/** The GitHub-shaped issue object. */
export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(),
    comments: issue.comments.length,
    created_at: isoAt(issue.seq),
    updated_at: isoAt(issue.seq),
    closed_at: issue.state === 'closed' ? isoAt(issue.seq) : null,
    pull_request: undefined,
  };
}

/** The GitHub-shaped comment object. */
export function commentJson(comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: userJson(),
    created_at: isoAt(comment.seq),
    updated_at: isoAt(comment.seq),
  };
}

/** The GitHub-shaped pull request object (head/base shas are the live branch tips). */
export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef);
  const baseSha = branchTip(repo, pull.baseRef);
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged && pull.mergedSeq !== null ? isoAt(pull.mergedSeq) : null,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(),
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    created_at: isoAt(pull.seq),
    updated_at: isoAt(pull.mergedSeq ?? pull.seq),
    closed_at: pull.state === 'closed' ? isoAt(pull.mergedSeq ?? pull.seq) : null,
  };
}
