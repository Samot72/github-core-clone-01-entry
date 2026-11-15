// app.ts — the forge's HTTP surface: git smart HTTP at /{owner}/{repo}.git, REST v3 under
// /api/v3, GraphQL at /api/graphql and MCP at /mcp, all over the one store in forge.ts.
// The starter shipped a health probe and an API root; this file grows them into the full
// surface the suite grades. Every reply is JSON (never HTML); errors carry a string message.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ACCOUNT_LOGIN,
  addComment,
  branchRef,
  branchTip,
  commentJson,
  createIssue,
  createLabel,
  createPull,
  createRepo,
  deleteContent,
  deleteRepo,
  diffCommits,
  findNumbered,
  getRepo,
  isAncestorCommit,
  issueJson,
  labelJson,
  listRepos,
  pullJson,
  pullMergeability,
  putContent,
  readContentAt,
  repoJson,
  resolveCommit,
  squashMerge,
  userJson,
  type RepoRec,
} from './forge.ts';
import { parseCommit, reachableCommits } from './gitstore.ts';
import { handleGraphQL } from './gql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const SERVER_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

/** The next X-GitHub-Request-Id value (non-empty, unique per response). */
function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** Answer with a JSON body and the headers every GitHub reply carries. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
    ...(text === '' ? {} : { 'content-length': Buffer.byteLength(text) }),
    ...headers,
  });
  res.end(text);
}

/** Answer with raw bytes (git protocol payloads). */
function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': nextRequestId() });
  res.end(body);
}

/** GitHub's 404 body. */
function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

/** Whether the request carries the shop token (when the process was given one). */
function authed(req: IncomingMessage): boolean {
  if (SERVER_TOKEN === '') return true;
  const header = req.headers.authorization;
  return header === `Bearer ${SERVER_TOKEN}` || header === `token ${SERVER_TOKEN}`;
}

/** Read a whole request body (bounded; git pushes in this suite stay far below the cap). */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > 128 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Parse a JSON request body; empty bodies read as {}. Throws a tagged error on malformed JSON. */
function parseJsonBody(body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw Object.assign(new Error('Problems parsing JSON'), { badJson: true });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------- pagination

interface Page {
  perPage: number;
  page: number;
}

/** Parse ?per_page=&page= the GitHub way (defaults 30 and 1, per_page capped at 100). */
function pageOf(url: URL): Page {
  const perPageRaw = Number.parseInt(url.searchParams.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '', 10);
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

/** Slice a list to a page and build the Link header chain for it. */
function paginate<T>(req: IncomingMessage, url: URL, items: readonly T[]): { page: T[]; headers: Record<string, string> } {
  const { perPage, page } = pageOf(url);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const host = req.headers.host ?? 'entry';
  const linkFor = (target: number): string => {
    const copy = new URL(url.toString());
    copy.searchParams.set('page', String(target));
    copy.searchParams.set('per_page', String(perPage));
    return `<http://${host}${copy.pathname}${copy.search}>`;
  };
  const links: string[] = [];
  if (page < totalPages) {
    links.push(`${linkFor(page + 1)}; rel="next"`);
    links.push(`${linkFor(totalPages)}; rel="last"`);
  }
  if (page > 1) {
    links.push(`${linkFor(page - 1)}; rel="prev"`);
    links.push(`${linkFor(1)}; rel="first"`);
  }
  return { page: slice, headers: links.length > 0 ? { link: links.join(', ') } : {} };
}

// ---------------------------------------------------------------- REST v3

/** The string field of a JSON body, or null. */
function str(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' ? value : null;
}

/** REST v3 routing. `segments` is the path after /api/v3, split and decoded. */
async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, segments: string[], body: Buffer): Promise<void> {
  const method = req.method ?? 'GET';

  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    notFound(res);
    return;
  }
  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', git_version: 'forge-1.0.0' });
    return;
  }
  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, userJson());
    return;
  }
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const { page, headers } = paginate(req, url, listRepos().map(repoJson));
      sendJson(res, 200, page, headers);
      return;
    }
    if (method === 'POST') {
      const data = parseJsonBody(body);
      const name = str(data, 'name');
      if (name === null || name === '') {
        sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'missing_field', field: 'name' }] });
        return;
      }
      const repo = createRepo(name, { private: data.private === true, description: str(data, 'description') ?? '' });
      if (repo === null) {
        sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
        return;
      }
      const defaultBranch = str(data, 'default_branch');
      if (defaultBranch !== null && defaultBranch !== '') repo.defaultBranch = defaultBranch;
      sendJson(res, 201, repoJson(repo));
      return;
    }
  }
  if (segments[0] !== 'repos' || segments.length < 3) {
    notFound(res);
    return;
  }

  const owner = segments[1]!;
  const repo = getRepo(owner, segments[2]!);
  if (repo === null) {
    notFound(res);
    return;
  }
  const rest = segments.slice(3);
  await handleRepoRest(req, res, url, repo, rest, body);
}

/** Routes under /repos/{owner}/{repo}. */
async function handleRepoRest(req: IncomingMessage, res: ServerResponse, url: URL, repo: RepoRec, rest: string[], body: Buffer): Promise<void> {
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const data = parseJsonBody(body);
      const description = str(data, 'description');
      if (description !== null) repo.description = description;
      if (typeof data.private === 'boolean') repo.private = data.private;
      const defaultBranch = str(data, 'default_branch');
      if (defaultBranch !== null && defaultBranch !== '') repo.defaultBranch = defaultBranch;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      deleteRepo(repo);
      sendJson(res, 204, undefined);
      return;
    }
    notFound(res);
    return;
  }

  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
      sendJson(res, 200, branches);
      return;
    }
    if (rest.length >= 2 && method === 'GET') {
      const name = rest.slice(1).join('/');
      const tip = branchTip(repo, name);
      if (tip === null) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { name, commit: { sha: tip }, protected: false });
      return;
    }
  }

  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const refish = url.searchParams.get('sha') ?? repo.defaultBranch;
    const tip = resolveCommit(repo, refish);
    if (tip === null) {
      sendJson(res, 200, []);
      return;
    }
    const all = reachableCommits(repo.store, tip).map((sha) => {
      const object = repo.store.get(sha)!;
      const info = parseCommit(object.data);
      return {
        sha,
        commit: {
          message: info.message.replace(/\n$/, ''),
          author: { name: info.author.replace(/ <.*$/, ''), email: /<([^>]*)>/.exec(info.author)?.[1] ?? '' },
          committer: { name: info.committer.replace(/ <.*$/, ''), email: /<([^>]*)>/.exec(info.committer)?.[1] ?? '' },
          tree: { sha: info.tree },
        },
        parents: info.parents.map((parent) => ({ sha: parent })),
      };
    });
    const { page, headers } = paginate(req, url, all);
    sendJson(res, 200, page, headers);
    return;
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const data = parseJsonBody(body);
      const ref = str(data, 'ref');
      const sha = str(data, 'sha');
      if (ref === null || sha === null) {
        sendJson(res, 422, { message: 'Validation Failed' });
        return;
      }
      const object = repo.store.get(sha);
      if (object === undefined || object.type !== 'commit') {
        sendJson(res, 422, { message: 'Object is not a commit' });
        return;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: `REF_${ref}`, object: { sha, type: 'commit' } });
      return;
    }
    if (rest.length >= 4 && rest[2] === 'heads' && method === 'GET') {
      const branch = rest.slice(3).join('/');
      const tip = branchTip(repo, branch);
      if (tip === null) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { ref: branchRef(branch), node_id: `REF_${branchRef(branch)}`, object: { sha: tip, type: 'commit' } });
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      const all = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: repo.store.get(sha)?.type ?? 'commit' } }));
      sendJson(res, 200, all);
      return;
    }
  }

  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'GET') {
      sendJson(res, 200, [...repo.labels.keys()].map((name) => labelJson(repo, name)));
      return;
    }
    if (rest.length === 1 && method === 'POST') {
      const data = parseJsonBody(body);
      const name = str(data, 'name');
      if (name === null || name === '') {
        sendJson(res, 422, { message: 'Validation Failed' });
        return;
      }
      if (repo.labels.has(name)) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] });
        return;
      }
      const color = (str(data, 'color') ?? '000000').replace(/^#/, '');
      createLabel(repo, name, color);
      sendJson(res, 201, labelJson(repo, name));
      return;
    }
  }

  if (rest[0] === 'contents') {
    await handleContents(req, res, url, repo, rest.slice(1).join('/'), body);
    return;
  }

  if (rest[0] === 'issues') {
    await handleIssues(req, res, url, repo, rest.slice(1), body);
    return;
  }

  if (rest[0] === 'pulls') {
    await handlePulls(req, res, url, repo, rest.slice(1), body);
    return;
  }

  notFound(res);
}

/** The contents API: files backed by real git objects, so blob and commit SHAs are git's own. */
async function handleContents(req: IncomingMessage, res: ServerResponse, url: URL, repo: RepoRec, path: string, body: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'GET') {
    const refish = url.searchParams.get('ref') ?? repo.defaultBranch;
    const found = readContentAt(repo, path, refish);
    if (found === null) {
      notFound(res);
      return;
    }
    if (found.kind === 'dir') {
      const entries = found.entries.map((entry) => {
        const isDir = entry.mode === '40000' || entry.mode === '040000';
        const object = repo.store.get(entry.sha);
        return {
          name: entry.name,
          path: path === '' ? entry.name : `${path}/${entry.name}`,
          sha: entry.sha,
          size: isDir ? 0 : (object?.data.length ?? 0),
          type: isDir ? 'dir' : 'file',
        };
      });
      sendJson(res, 200, entries);
      return;
    }
    const base64 = found.data.toString('base64').replace(/(.{60})/g, '$1\n');
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      name: path.split('/').pop() ?? path,
      path,
      sha: found.sha,
      size: found.data.length,
      content: base64.endsWith('\n') ? base64 : `${base64}\n`,
    });
    return;
  }
  if (method === 'PUT') {
    const data = parseJsonBody(body);
    const message = str(data, 'message') ?? 'Update file';
    const contentBase64 = str(data, 'content');
    if (contentBase64 === null) {
      sendJson(res, 422, { message: 'Validation Failed' });
      return;
    }
    const content = Buffer.from(contentBase64.replace(/\s+/g, ''), 'base64');
    const branch = str(data, 'branch') ?? repo.defaultBranch;
    const expectedSha = str(data, 'sha');
    const result = putContent(repo, path, content, message, branch, expectedSha);
    if (!result.ok) {
      if (result.reason === 'conflict') sendJson(res, 409, { message: `${path} sha does not match the current blob` });
      else sendJson(res, 422, { message: '"sha" wasn\'t supplied.' });
      return;
    }
    sendJson(res, result.created ? 201 : 200, {
      content: { name: path.split('/').pop() ?? path, path, sha: result.blobSha, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: result.commitSha, message },
    });
    return;
  }
  if (method === 'DELETE') {
    const data = parseJsonBody(body);
    const message = str(data, 'message') ?? 'Delete file';
    const branch = str(data, 'branch') ?? repo.defaultBranch;
    const expectedSha = str(data, 'sha');
    const result = deleteContent(repo, path, message, branch, expectedSha);
    if (!result.ok) {
      if (result.reason === 'conflict') sendJson(res, 409, { message: `${path} sha does not match the current blob` });
      else notFound(res);
      return;
    }
    sendJson(res, 200, { content: null, commit: { sha: result.commitSha, message } });
    return;
  }
  notFound(res);
}

/** Issues: create, list (state/sort), read, patch, comments. */
async function handleIssues(req: IncomingMessage, res: ServerResponse, url: URL, repo: RepoRec, rest: string[], body: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  if (rest.length === 0) {
    if (method === 'POST') {
      const data = parseJsonBody(body);
      const title = str(data, 'title');
      if (title === null || title === '') {
        sendJson(res, 422, { message: 'Validation Failed' });
        return;
      }
      const labelNames = Array.isArray(data.labels) ? data.labels.filter((x): x is string => typeof x === 'string') : [];
      for (const name of labelNames) {
        if (!repo.labels.has(name)) {
          sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'invalid', field: 'labels' }] });
          return;
        }
      }
      const issue = createIssue(repo, title, str(data, 'body') ?? '', labelNames);
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      const direction = url.searchParams.get('direction') ?? 'desc';
      issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { page, headers } = paginate(req, url, issues.map((issue) => issueJson(repo, issue)));
      sendJson(res, 200, page, headers);
      return;
    }
  }
  const number = Number.parseInt(rest[0] ?? '', 10);
  const found = Number.isFinite(number) ? findNumbered(repo, number) : null;
  const issue = found !== null && found.kind === 'issue' ? found.rec : null;
  if (rest.length === 1) {
    if (issue === null) {
      notFound(res);
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const data = parseJsonBody(body);
      const state = str(data, 'state');
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = str(data, 'title');
      if (title !== null) issue.title = title;
      const issueBody = str(data, 'body');
      if (issueBody !== null) issue.body = issueBody;
      if (Array.isArray(data.labels)) {
        const names = data.labels.filter((x): x is string => typeof x === 'string');
        for (const name of names) {
          if (!repo.labels.has(name)) {
            sendJson(res, 422, { message: 'Validation Failed' });
            return;
          }
        }
        issue.labels = names;
      }
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
  }
  if (rest.length === 2 && rest[1] === 'comments' && issue !== null) {
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map(commentJson));
      return;
    }
    if (method === 'POST') {
      const data = parseJsonBody(body);
      const commentBody = str(data, 'body');
      if (commentBody === null) {
        sendJson(res, 422, { message: 'Validation Failed' });
        return;
      }
      const comment = addComment(repo, issue, commentBody);
      sendJson(res, 201, commentJson(comment));
      return;
    }
  }
  notFound(res);
}

/** Pull requests: create, list, read, files, squash merge. */
async function handlePulls(req: IncomingMessage, res: ServerResponse, url: URL, repo: RepoRec, rest: string[], body: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  if (rest.length === 0) {
    if (method === 'POST') {
      const data = parseJsonBody(body);
      const title = str(data, 'title');
      const head = str(data, 'head');
      const base = str(data, 'base');
      if (title === null || head === null || base === null) {
        sendJson(res, 422, { message: 'Validation Failed' });
        return;
      }
      const headBranch = head.includes(':') ? head.split(':').pop()! : head;
      const baseBranch = base.includes(':') ? base.split(':').pop()! : base;
      if (branchTip(repo, headBranch) === null || branchTip(repo, baseBranch) === null) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'invalid', field: 'head' }] });
        return;
      }
      const pull = createPull(repo, title, str(data, 'body') ?? '', headBranch, baseBranch);
      sendJson(res, 201, pullJson(repo, pull));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.seq - a.seq);
      const { page, headers } = paginate(req, url, pulls.map((pull) => pullJson(repo, pull)));
      sendJson(res, 200, page, headers);
      return;
    }
  }
  const number = Number.parseInt(rest[0] ?? '', 10);
  const pull = Number.isFinite(number) ? (repo.pulls.get(number) ?? null) : null;
  if (pull === null) {
    notFound(res);
    return;
  }
  if (rest.length === 1 && method === 'GET') {
    sendJson(res, 200, pullJson(repo, pull));
    return;
  }
  if (rest.length === 1 && method === 'PATCH') {
    const data = parseJsonBody(body);
    const state = str(data, 'state');
    if (state === 'open' || state === 'closed') pull.state = state;
    const title = str(data, 'title');
    if (title !== null) pull.title = title;
    sendJson(res, 200, pullJson(repo, pull));
    return;
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const headTip = branchTip(repo, pull.headRef);
    const baseTip = branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) {
      sendJson(res, 200, []);
      return;
    }
    const { base } = pullMergeability(repo, pull);
    const changes = diffCommits(repo, base ?? baseTip, headTip);
    const files = changes.map((change) => ({
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
    }));
    sendJson(res, 200, files);
    return;
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull.merged) {
      sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      return;
    }
    const sha = squashMerge(repo, pull);
    if (sha === null) {
      sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      return;
    }
    sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  notFound(res);
}

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line: 4 hex digits of total length + payload. */
function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'latin1');
  return Buffer.concat([head, body]);
}

const PKT_FLUSH = Buffer.from('0000', 'latin1');
const PKT_DELIM = Buffer.from('0001', 'latin1');

type PktToken = { kind: 'line'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Parse pkt-lines from the front of a buffer; returns the tokens and the unparsed rest. */
function pktParse(buffer: Buffer): { tokens: PktToken[]; rest: Buffer } {
  const tokens: PktToken[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const head = buffer.toString('latin1', offset, offset + 4);
    if (!/^[0-9a-f]{4}$/.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      tokens.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (length === 1) {
      tokens.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      tokens.push({ kind: 'end' });
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > buffer.length) break;
    tokens.push({ kind: 'line', data: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { tokens, rest: buffer.subarray(offset) };
}

/** Wrap a payload in side-band-64k packets (band 1), chunked, and terminate with a flush. */
function sidebandWrap(payload: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < payload.length; offset += CHUNK) {
    const chunk = payload.subarray(offset, offset + CHUNK);
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- git smart HTTP

import { ZERO_SHA, objectClosure, peelToCommit, readPack, selectFetchObjects, tagTarget, writePack } from './gitstore.ts';
import { headRefName } from './forge.ts';

const UPLOAD_CAPS = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not deepen-relative symref=HEAD:refs/heads/main agent=forge/1.0 object-format=sha1';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

/** The sorted ref advertisement lines for a repository (without the HEAD line). */
function refLines(repo: RepoRec): { name: string; sha: string }[] {
  return [...repo.refs.entries()]
    .map(([name, sha]) => ({ name, sha }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** GET info/refs: the v0 or v2 (upload-pack) advertisement, or the receive-pack one. */
function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: RepoRec, service: string): void {
  const protocol = req.headers['git-protocol'] ?? '';
  const wantsV2 = typeof protocol === 'string' && protocol.includes('version=2');
  if (service === 'git-upload-pack' && wantsV2) {
    const body = Buffer.concat([
      pkt('version 2\n'),
      pkt('agent=forge/1.0\n'),
      pkt('ls-refs=unborn\n'),
      pkt('fetch=shallow wait-for-done\n'),
      pkt('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    sendBytes(res, 200, body, 'application/x-git-upload-pack-advertisement');
    return;
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const lines: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = refLines(repo);
  if (refs.length === 0) {
    lines.push(pkt(`${ZERO_SHA} capabilities^{}\0${caps}\n`));
  } else {
    const headSha = repo.refs.get(headRefName(repo)) ?? ZERO_SHA;
    let first = true;
    const pushLine = (text: string): void => {
      if (first) {
        lines.push(pkt(`${text}\0${caps}\n`));
        first = false;
      } else {
        lines.push(pkt(`${text}\n`));
      }
    };
    pushLine(`${headSha} HEAD`);
    for (const ref of refs) {
      pushLine(`${ref.sha} ${ref.name}`);
      const target = tagTarget(repo.store, ref.sha);
      if (target !== null) pushLine(`${target} ${ref.name}^{}`);
    }
  }
  lines.push(PKT_FLUSH);
  sendBytes(res, 200, Buffer.concat(lines), `application/x-${service}-advertisement`);
}

/** The ls-refs command of protocol v2. */
function handleLsRefs(repo: RepoRec, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  if (matches('HEAD')) {
    const target = headRefName(repo);
    const tip = repo.refs.get(target);
    if (tip !== undefined) {
      lines.push(pkt(`${tip} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (unborn) {
      lines.push(pkt(`${ZERO_SHA} HEAD${symrefs ? ` symref-target:${target}` : ''} unborn\n`));
    }
  }
  for (const ref of refLines(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.sha} ${ref.name}`;
    if (peel) {
      const target = tagTarget(repo.store, ref.sha);
      if (target !== null) line += ` peeled:${target}`;
    }
    lines.push(pkt(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

/** Build the fetch response sections for protocol v2. */
function handleFetchV2(repo: RepoRec, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7), 10);
    else if (arg === 'done') done = true;
  }
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    const acks: Buffer[] = [pkt('acknowledgments\n')];
    const common = haves.filter((have) => {
      const object = repo.store.get(have);
      return object !== undefined && object.type === 'commit';
    });
    if (common.length === 0) acks.push(pkt('NAK\n'));
    else for (const sha of common) acks.push(pkt(`ACK ${sha}\n`));
    acks.push(PKT_FLUSH);
    parts.push(Buffer.concat(acks));
  }
  if (!done) return Buffer.concat(parts);

  const selection = selectFetchObjects(repo.store, wants, haves, clientShallow, depth);
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    const info: Buffer[] = [pkt('shallow-info\n')];
    for (const sha of selection.shallow) info.push(pkt(`shallow ${sha}\n`));
    for (const sha of selection.unshallow) info.push(pkt(`unshallow ${sha}\n`));
    info.push(PKT_FLUSH);
    parts.push(Buffer.concat(info));
  }
  const pack = writePack(repo.store, selection.objects);
  parts.push(pkt('packfile\n'));
  parts.push(sidebandWrap(pack));
  return Buffer.concat(parts);
}

/** Build a v0 fetch response: a NAK line, then the side-banded pack. */
function handleFetchV0(repo: RepoRec, wants: readonly string[], haves: readonly string[]): Buffer {
  const selection = selectFetchObjects(repo.store, wants, haves, [], null);
  const pack = writePack(repo.store, selection.objects);
  return Buffer.concat([pkt('NAK\n'), sidebandWrap(pack)]);
}

/** POST git-upload-pack: a v2 command stream or a v0 want/have negotiation. */
function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: RepoRec, body: Buffer): void {
  const protocol = req.headers['git-protocol'] ?? '';
  const wantsV2 = typeof protocol === 'string' && protocol.includes('version=2');
  if (wantsV2) {
    const { tokens } = pktParse(body);
    const lines: string[] = [];
    for (const token of tokens) {
      if (token.kind === 'line') lines.push(token.data.toString('utf8').replace(/\n$/, ''));
      else if (token.kind === 'delim' || token.kind === 'flush') lines.push(token.kind === 'delim' ? '\x01' : '\x00');
    }
    const command = lines.find((line) => line.startsWith('command='));
    if (command === 'command=ls-refs') {
      const delimIndex = lines.indexOf('\x01');
      const args = lines.slice(delimIndex + 1).filter((line) => line !== '\x00');
      sendBytes(res, 200, handleLsRefs(repo, args), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'command=fetch') {
      const delimIndex = lines.indexOf('\x01');
      const args = lines.slice(delimIndex + 1).filter((line) => line !== '\x00');
      sendBytes(res, 200, handleFetchV2(repo, args), 'application/x-git-upload-pack-result');
      return;
    }
    sendBytes(res, 200, PKT_FLUSH, 'application/x-git-upload-pack-result');
    return;
  }
  // v0: want lines, flush, have lines, flush, done.
  const { tokens } = pktParse(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let phase: 'want' | 'have' = 'want';
  for (const token of tokens) {
    if (token.kind === 'flush') {
      phase = 'have';
      continue;
    }
    if (token.kind !== 'line') continue;
    const line = token.data.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
  }
  sendBytes(res, 200, handleFetchV0(repo, wants, haves), 'application/x-git-upload-pack-result');
}

/** POST git-receive-pack: unpack, validate fast-forwards, move refs, report per ref. */
function handleReceivePack(res: ServerResponse, repo: RepoRec, body: Buffer): void {
  const { tokens, rest } = pktParse(body);
  interface Command {
    oldSha: string;
    newSha: string;
    ref: string;
  }
  const commands: Command[] = [];
  let capabilities = '';
  for (const token of tokens) {
    if (token.kind !== 'line') continue;
    let line = token.data.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length === 3 && /^[0-9a-f]{40}$/.test(parts[0]!) && /^[0-9a-f]{40}$/.test(parts[1]!)) {
      commands.push({ oldSha: parts[0]!, newSha: parts[1]!, ref: parts[2]! });
    }
  }
  if (commands.length === 0 && rest.length === 0) {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }

  let unpackLine = 'unpack ok\n';
  if (rest.length > 0) {
    try {
      readPack(repo.store, rest);
    } catch (error) {
      unpackLine = `unpack ${error instanceof Error ? error.message : 'failed'}\n`;
    }
  }

  const results: string[] = [];
  for (const command of commands) {
    const refuse = (reason: string): void => {
      results.push(`ng ${command.ref} ${reason}\n`);
    };
    const accept = (): void => {
      results.push(`ok ${command.ref}\n`);
    };
    if (!unpackLine.startsWith('unpack ok')) {
      refuse('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_SHA;
    if (command.newSha === ZERO_SHA) {
      // Delete: always allowed here (including a missing ref, which git tolerates in reports).
      repo.refs.delete(command.ref);
      accept();
      continue;
    }
    const object = repo.store.get(command.newSha);
    if (object === undefined) {
      refuse('bad object');
      continue;
    }
    if (command.oldSha === ZERO_SHA) {
      if (current !== ZERO_SHA && current !== command.newSha) {
        refuse('already exists');
        continue;
      }
      repo.refs.set(command.ref, command.newSha);
      accept();
      continue;
    }
    if (current !== command.oldSha) {
      refuse('stale info');
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      if (object.type !== 'commit') {
        refuse('bad object');
        continue;
      }
      if (!isAncestorCommit(repo, command.oldSha, command.newSha)) {
        refuse('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newSha);
    accept();
  }

  const reportParts: Buffer[] = [pkt(unpackLine)];
  for (const line of results) reportParts.push(pkt(line));
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  const useSideband = capabilities.split(' ').includes('side-band-64k');
  const payload = useSideband ? sidebandWrap(report) : report;
  sendBytes(res, 200, payload, 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------- the server

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

        if (!authed(req)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }

        if (path === '/api/graphql' && method === 'POST') {
          const outcome = handleGraphQL(body.toString('utf8'));
          sendJson(res, outcome.status, outcome.payload);
          return;
        }
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed: POST only' } });
            return;
          }
          const outcome = handleMcp(body.toString('utf8'));
          sendJson(res, outcome.status, outcome.payload);
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const segments = path
            .slice('/api/v3'.length)
            .split('/')
            .filter((segment) => segment !== '')
            .map((segment) => decodeURIComponent(segment));
          await handleRest(req, res, url, segments, body);
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1]!);
          const name = decodeURIComponent(gitMatch[2]!);
          const tail = gitMatch[3] ?? '';
          const repo = getRepo(owner, name);
          if (tail === 'info/refs' && method === 'GET') {
            if (repo === null) {
              notFound(res);
              return;
            }
            const service = url.searchParams.get('service') ?? '';
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, 400, { message: 'Bad Request' });
              return;
            }
            handleInfoRefs(req, res, repo, service);
            return;
          }
          if (tail === 'git-upload-pack' && method === 'POST') {
            if (repo === null) {
              notFound(res);
              return;
            }
            handleUploadPack(req, res, repo, body);
            return;
          }
          if (tail === 'git-receive-pack' && method === 'POST') {
            if (repo === null) {
              notFound(res);
              return;
            }
            handleReceivePack(res, repo, body);
            return;
          }
          notFound(res);
          return;
        }

        notFound(res);
      } catch (error) {
        if (!res.headersSent) {
          if ((error as { badJson?: boolean } | null)?.badJson === true) sendJson(res, 400, { message: 'Problems parsing JSON' });
          else sendJson(res, 500, { message: 'Internal Server Error' });
        } else res.end();
      }
    })();
  });
}
