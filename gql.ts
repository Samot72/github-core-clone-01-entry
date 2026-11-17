// gql.ts — a small GraphQL executor for the documents gh and github-mcp-server actually send:
// queries and mutations with variables, aliases, inline fragments, connections with cursor
// pagination, node() round-trips, __type introspection and batched operation arrays. It is a
// real (if small) parser and tree-walking executor, not a pattern match on the documents, so
// field order, aliases and variable indirection all behave as the suite expects.

export type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Map<string, GqlValue> };

export interface GqlField {
  name: string;
  alias: string | null;
  args: Map<string, GqlValue>;
  selection: GqlSelection[] | null;
}

export type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'inline'; typeCondition: string | null; selection: GqlSelection[] }
  | { kind: 'spread'; name: string };

export interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: GqlSelection[];
}

export interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, { typeCondition: string; selection: GqlSelection[] }>;
}

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1]!;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === '/') value += '/';
          else if (esc === '\\') value += '\\';
          else if (esc === '"') value += '"';
          else if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: GqlSelection[] }>();
    while (this.peek() !== undefined) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | null = null;
        const next = this.peek();
        if (next !== undefined && next.kind === 'name') name = this.expectName();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipBalancedParens();
        this.skipDirectives();
        const selection = this.parseSelectionSet();
        operations.push({ type: keyword === 'mutation' ? 'mutation' : 'query', name, selection });
        continue;
      }
      if (keyword === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected on in fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        const selection = this.parseSelectionSet();
        fragments.set(fragName, { typeCondition, selection });
        continue;
      }
      throw new Error(`unexpected definition ${keyword}`);
    }
    return { operations, fragments };
  }

  /** Skip a balanced (...) group (variable definitions). */
  private skipBalancedParens(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  /** Skip any @directive(...) groups. */
  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipBalancedParens();
    }
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        const next = this.peek();
        if (next !== undefined && next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else if (next !== undefined && next.kind === 'name') {
          const name = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        } else {
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition: null, selection: this.parseSelectionSet() });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
  }

  private parseField(): GqlField {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = new Map<string, GqlValue>();
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      for (;;) {
        if (this.skipPunct(')')) break;
        const argName = this.expectName();
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
    }
    this.skipDirectives();
    let selection: GqlSelection[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selection = this.parseSelectionSet();
    return { name, alias, args, selection };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      for (;;) {
        if (this.skipPunct(']')) break;
        items.push(this.parseValue());
      }
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, GqlValue>();
      for (;;) {
        if (this.skipPunct('}')) break;
        const key = this.expectName();
        this.expectPunct(':');
        fields.set(key, this.parseValue());
      }
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value token');
  }
}

/** Parse a GraphQL document. */
export function parseGraphQL(source: string): GqlDocument {
  return new Parser(source).parseDocument();
}

/** Resolve an AST value against the operation's variables. */
export function resolveValue(value: GqlValue, variables: Readonly<Record<string, unknown>>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = resolveValue(inner, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- executor

import {
  ACCOUNT_LOGIN,
  addComment,
  branchTip,
  createIssue,
  createPull,
  diffCommits,
  getRepo,
  getRepoById,
  isoAt,
  pullMergeability,
  squashMerge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './forge.ts';
import { mergeBase } from './gitstore.ts';

/** A resolved GraphQL object: a type name plus its backing record. */
interface GObj {
  __typename: string;
  data: Record<string, unknown>;
}

function obj(typename: string, data: Record<string, unknown>): GObj {
  return { __typename: typename, data };
}

const UNKNOWN_FIELD = Symbol('unknown-field');

interface ExecCtx {
  variables: Readonly<Record<string, unknown>>;
  fragments: GqlDocument['fragments'];
  errors: { message: string }[];
}

// ---- global ids: opaque, stable, round-trippable, never the plain database id

/** Encode a global id for a repository / issue / pull request / comment. */
export function encodeGlobalId(type: string, ...parts: (string | number)[]): string {
  return Buffer.from(['v1', type, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}

/** Decode a global id; null when it is not one of ours. */
export function decodeGlobalId(id: string): { type: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts[0] !== 'v1' || parts.length < 3) return null;
    return { type: parts[1]!, parts: parts.slice(2) };
  } catch {
    return null;
  }
}

function repoObj(repo: RepoRec): GObj {
  return obj('Repository', { repo });
}

function issueObj(repo: RepoRec, issue: IssueRec): GObj {
  return obj('Issue', { repo, issue });
}

function pullObj(repo: RepoRec, pull: PullRec): GObj {
  return obj('PullRequest', { repo, pull });
}

function userObj(login: string): GObj {
  return obj('User', { login });
}

/** Resolve a global id to the object it names (node() and mutation inputs). */
function objectByGlobalId(id: string): GObj | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.type === 'Repository') {
    const repo = getRepoById(Number.parseInt(decoded.parts[0] ?? '', 10));
    return repo === null ? null : repoObj(repo);
  }
  if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
    const repo = getRepoById(Number.parseInt(decoded.parts[0] ?? '', 10));
    if (repo === null) return null;
    const number = Number.parseInt(decoded.parts[1] ?? '', 10);
    if (decoded.type === 'Issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueObj(repo, issue);
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : pullObj(repo, pull);
  }
  if (decoded.type === 'IssueComment') {
    const repo = getRepoById(Number.parseInt(decoded.parts[0] ?? '', 10));
    if (repo === null) return null;
    const issue = repo.issues.get(Number.parseInt(decoded.parts[1] ?? '', 10));
    if (issue === undefined) return null;
    const comment = issue.comments.find((c) => c.id === Number.parseInt(decoded.parts[2] ?? '', 10));
    if (comment === undefined) return null;
    return obj('IssueComment', { repo, issue, comment });
  }
  if (decoded.type === 'User') return userObj(decoded.parts[0] ?? ACCOUNT_LOGIN);
  return null;
}

// ---- connections

/** Cursor for the item at `index` in a connection's full list. */
function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

/** The index a cursor points at, or -1. */
function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number.parseInt(match[1]!, 10);
  } catch {
    return -1;
  }
}

/** Slice a list into a connection page. */
function connectionPage<T>(items: readonly T[], args: Map<string, unknown>): { page: T[]; startIndex: number; hasNext: boolean } {
  const first = typeof args.get('first') === 'number' ? (args.get('first') as number) : items.length;
  const afterIndex = indexOfCursor(args.get('after'));
  const start = afterIndex + 1;
  const page = items.slice(start, start + first);
  return { page, startIndex: start, hasNext: start + page.length < items.length };
}

/** A connection object in the shape the suite reads (nodes + pageInfo). */
function connection(typename: string, items: readonly GObj[], args: Map<string, unknown>): GObj {
  const { page, startIndex, hasNext } = connectionPage(items, args);
  return obj(typename, {
    nodes: page,
    edges: page.map((node, i) => obj('Edge', { node, cursor: cursorOf(startIndex + i) })),
    pageInfo: obj('PageInfo', {
      hasNextPage: hasNext,
      hasPreviousPage: startIndex > 0,
      startCursor: page.length > 0 ? cursorOf(startIndex) : null,
      endCursor: page.length > 0 ? cursorOf(startIndex + page.length - 1) : null,
    }),
    totalCount: items.length,
  });
}

// ---- field resolution

/** Resolve arguments of a field node to plain values. */
function argsOf(field: GqlField, ctx: ExecCtx): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of field.args) out.set(key, resolveValue(value, ctx.variables));
  return out;
}

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'isPrivate', 'description', 'createdAt', 'updatedAt', 'url', 'issue', 'issues', 'pullRequest', 'pullRequests'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'repository', 'url'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'author', 'createdAt', 'updatedAt', 'repository', 'files'],
  User: ['id', 'login', 'name'],
  Ref: ['name', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
});

/** Resolve one field on one object; UNKNOWN_FIELD when the type has no such field. */
function resolveField(target: GObj, field: GqlField, ctx: ExecCtx): unknown {
  const args = argsOf(field, ctx);
  const d = target.data;
  switch (target.__typename) {
    case 'Query': {
      if (field.name === 'viewer') return userObj(ACCOUNT_LOGIN);
      if (field.name === 'repository') {
        const repo = getRepo(String(args.get('owner') ?? ''), String(args.get('name') ?? ''));
        return repo === null ? null : repoObj(repo);
      }
      if (field.name === 'node') return objectByGlobalId(String(args.get('id') ?? ''));
      if (field.name === '__type') {
        const name = String(args.get('name') ?? '');
        if (name === 'SearchType') {
          return obj('__Type', { name, kind: 'ENUM', fields: null, enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'].map((n) => obj('__EnumValue', { name: n })) });
        }
        const fields = TYPE_FIELDS[name];
        if (fields === undefined) return null;
        return obj('__Type', { name, kind: 'OBJECT', fields: fields.map((n) => obj('__Field', { name: n })), enumValues: null });
      }
      if (field.name === '__schema') return obj('__Schema', {});
      return UNKNOWN_FIELD;
    }
    case 'User': {
      if (field.name === 'login') return d.login;
      if (field.name === 'id') return encodeGlobalId('User', String(d.login));
      if (field.name === 'name') return d.login;
      return UNKNOWN_FIELD;
    }
    case 'Repository': {
      const repo = d.repo as RepoRec;
      switch (field.name) {
        case 'id': return encodeGlobalId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return userObj(repo.owner);
        case 'defaultBranchRef': {
          const tip = branchTip(repo, repo.defaultBranch);
          return tip === null ? null : obj('Ref', { name: repo.defaultBranch, target: tip });
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'isPrivate': return repo.private;
        case 'description': return repo.description;
        case 'createdAt': return isoAt(repo.seq);
        case 'updatedAt': return isoAt(repo.seq);
        case 'url': return `https://forge.invalid/${repo.owner}/${repo.name}`;
        case 'issue': {
          const issue = repo.issues.get(Number(args.get('number')));
          return issue === undefined ? null : issueObj(repo, issue);
        }
        case 'issues': {
          const states = (args.get('states') as unknown[] | undefined)?.map(String) ?? null;
          let issues = [...repo.issues.values()];
          if (states !== null) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
          const orderBy = args.get('orderBy') as { field?: string; direction?: string } | undefined;
          const direction = orderBy?.direction === 'DESC' ? 'DESC' : 'ASC';
          issues.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
          return connection('IssueConnection', issues.map((issue) => issueObj(repo, issue)), args);
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.get('number')));
          return pull === undefined ? null : pullObj(repo, pull);
        }
        case 'pullRequests': {
          const states = (args.get('states') as unknown[] | undefined)?.map(String) ?? null;
          let pulls = [...repo.pulls.values()];
          if (states !== null) {
            pulls = pulls.filter((pull) => {
              const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
              return states.includes(state);
            });
          }
          pulls.sort((a, b) => a.seq - b.seq);
          return connection('PullRequestConnection', pulls.map((pull) => pullObj(repo, pull)), args);
        }
        default: return UNKNOWN_FIELD;
      }
    }
    case 'Issue': {
      const repo = d.repo as RepoRec;
      const issue = d.issue as IssueRec;
      switch (field.name) {
        case 'id': return encodeGlobalId('Issue', repo.id, issue.number);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'author': return userObj(repo.owner);
        case 'createdAt': return isoAt(issue.seq);
        case 'updatedAt': return isoAt(issue.seq);
        case 'repository': return repoObj(repo);
        case 'url': return `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
        default: return UNKNOWN_FIELD;
      }
    }
    case 'PullRequest': {
      const repo = d.repo as RepoRec;
      const pull = d.pull as PullRec;
      switch (field.name) {
        case 'id': return encodeGlobalId('PullRequest', repo.id, pull.number);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          return pullMergeability(repo, pull).mergeable ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRefOid': return branchTip(repo, pull.headRef);
        case 'baseRefOid': return branchTip(repo, pull.baseRef);
        case 'author': return userObj(repo.owner);
        case 'createdAt': return isoAt(pull.seq);
        case 'updatedAt': return isoAt(pull.mergedSeq ?? pull.seq);
        case 'repository': return repoObj(repo);
        case 'files': {
          const headTip = branchTip(repo, pull.headRef);
          const baseTip = branchTip(repo, pull.baseRef);
          if (headTip === null || baseTip === null) return connection('PullRequestFileConnection', [], args);
          const base = mergeBase(repo.store, baseTip, headTip);
          const changes = diffCommits(repo, base ?? baseTip, headTip);
          const nodes = changes.map((change) => obj('PullRequestFile', { path: change.path, additions: change.additions, deletions: change.deletions, changeType: change.status.toUpperCase() }));
          return connection('PullRequestFileConnection', nodes, args);
        }
        default: return UNKNOWN_FIELD;
      }
    }
    case 'Ref': {
      if (field.name === 'name') return d.name;
      if (field.name === 'target') return null;
      return UNKNOWN_FIELD;
    }
    case 'PageInfo': {
      if (field.name in d) return d[field.name];
      return UNKNOWN_FIELD;
    }
    case 'IssueComment': {
      const repo = d.repo as RepoRec;
      const issue = d.issue as IssueRec;
      const comment = d.comment as { id: number; body: string; seq: number };
      switch (field.name) {
        case 'id': return encodeGlobalId('IssueComment', repo.id, issue.number, comment.id);
        case 'body': return comment.body;
        case 'author': return userObj(repo.owner);
        case 'createdAt': return isoAt(comment.seq);
        default: return UNKNOWN_FIELD;
      }
    }
    case '__Type': {
      if (field.name === 'name') return d.name;
      if (field.name === 'kind') return d.kind;
      if (field.name === 'fields') return d.fields;
      if (field.name === 'enumValues') return d.enumValues;
      return UNKNOWN_FIELD;
    }
    case '__Field':
    case '__EnumValue': {
      if (field.name === 'name') return d.name;
      return UNKNOWN_FIELD;
    }
    default: {
      // Connections, edges, mutation payloads and simple record objects (PullRequestFile and
      // friends) carry their fields in data directly.
      if (field.name in d) return d[field.name];
      return UNKNOWN_FIELD;
    }
  }
}

/** Execute a selection set against an object, merging fragments. */
function executeSelection(target: GObj, selection: GqlSelection[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const visit = (selections: GqlSelection[]): void => {
    for (const node of selections) {
      if (node.kind === 'inline') {
        if (node.typeCondition === null || node.typeCondition === target.__typename) visit(node.selection);
        continue;
      }
      if (node.kind === 'spread') {
        const fragment = ctx.fragments.get(node.name);
        if (fragment !== undefined && fragment.typeCondition === target.__typename) visit(fragment.selection);
        continue;
      }
      const field = node.field;
      const key = field.alias ?? field.name;
      const value = resolveField(target, field, ctx);
      if (value === UNKNOWN_FIELD) {
        ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${target.__typename}'` });
        out[key] = null;
        continue;
      }
      out[key] = materialize(value, field, ctx);
    }
  };
  visit(selection);
  return out;
}

/** Turn a resolved value into JSON-shaped output, applying sub-selections to objects. */
function materialize(value: unknown, field: GqlField, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => materialize(item, field, ctx));
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    const target = value as GObj;
    if (field.selection === null) return target.data.name ?? null;
    return executeSelection(target, field.selection, ctx);
  }
  return value;
}

// ---- mutations

/** Resolve one mutation field on the Mutation root. */
function resolveMutation(field: GqlField, ctx: ExecCtx): unknown {
  const args = argsOf(field, ctx);
  const input = (args.get('input') ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.type === 'Repository' ? getRepoById(Number.parseInt(decoded.parts[0] ?? '', 10)) : null;
      if (repo === null) {
        ctx.errors.push({ message: 'repository not found' });
        return obj('CreateIssuePayload', { issue: null, clientMutationId: input.clientMutationId ?? null });
      }
      const issue = createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return obj('CreateIssuePayload', { issue: issueObj(repo, issue), clientMutationId: input.clientMutationId ?? null });
    }
    case 'closeIssue': {
      const target = objectByGlobalId(String(input.issueId ?? ''));
      if (target === null || target.__typename !== 'Issue') {
        ctx.errors.push({ message: 'issue not found' });
        return obj('CloseIssuePayload', { issue: null, clientMutationId: input.clientMutationId ?? null });
      }
      const issue = target.data.issue as IssueRec;
      issue.state = 'closed';
      issue.version += 1;
      return obj('CloseIssuePayload', { issue: target, clientMutationId: input.clientMutationId ?? null });
    }
    case 'createPullRequest': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.type === 'Repository' ? getRepoById(Number.parseInt(decoded.parts[0] ?? '', 10)) : null;
      if (repo === null) {
        ctx.errors.push({ message: 'repository not found' });
        return obj('CreatePullRequestPayload', { pullRequest: null, clientMutationId: input.clientMutationId ?? null });
      }
      const headRefName = String(input.headRefName ?? '');
      const baseRefName = String(input.baseRefName ?? '');
      if (branchTip(repo, headRefName) === null || branchTip(repo, baseRefName) === null) {
        ctx.errors.push({ message: 'head or base ref does not exist' });
        return obj('CreatePullRequestPayload', { pullRequest: null, clientMutationId: input.clientMutationId ?? null });
      }
      const pull = createPull(repo, String(input.title ?? ''), String(input.body ?? ''), headRefName, baseRefName);
      return obj('CreatePullRequestPayload', { pullRequest: pullObj(repo, pull), clientMutationId: input.clientMutationId ?? null });
    }
    case 'mergePullRequest': {
      const target = objectByGlobalId(String(input.pullRequestId ?? ''));
      if (target === null || target.__typename !== 'PullRequest') {
        ctx.errors.push({ message: 'pull request not found' });
        return obj('MergePullRequestPayload', { pullRequest: null, clientMutationId: input.clientMutationId ?? null });
      }
      const repo = target.data.repo as RepoRec;
      const pull = target.data.pull as PullRec;
      if (!pull.merged) {
        const sha = squashMerge(repo, pull);
        if (sha === null) ctx.errors.push({ message: 'Pull Request is not mergeable' });
      }
      return obj('MergePullRequestPayload', { pullRequest: target, clientMutationId: input.clientMutationId ?? null });
    }
    case 'addComment': {
      const target = objectByGlobalId(String(input.subjectId ?? ''));
      if (target === null || target.__typename !== 'Issue') {
        ctx.errors.push({ message: 'subject not found' });
        return obj('AddCommentPayload', { commentEdge: null, clientMutationId: input.clientMutationId ?? null });
      }
      const repo = target.data.repo as RepoRec;
      const issue = target.data.issue as IssueRec;
      const comment = addComment(repo, issue, String(input.body ?? ''));
      const commentObj = obj('IssueComment', { repo, issue, comment });
      return obj('AddCommentPayload', {
        commentEdge: obj('IssueCommentEdge', { node: commentObj, cursor: cursorOf(issue.comments.length - 1) }),
        clientMutationId: input.clientMutationId ?? null,
      });
    }
    default:
      return UNKNOWN_FIELD;
  }
}

// ---- entry point

/** Execute one operation document (already-parsed body element). */
function executeOne(body: Record<string, unknown>): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Record<string, unknown>;
  let document: GqlDocument;
  try {
    document = parseGraphQL(query);
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'syntax error' }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation = document.operations.find((op) => operationName === null || op.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const ctx: ExecCtx = { variables, fragments: document.fragments, errors: [] };
  let data: Record<string, unknown>;
  if (operation.type === 'mutation') {
    const root = obj('Mutation', {});
    data = {};
    const visit = (selections: GqlSelection[]): void => {
      for (const node of selections) {
        if (node.kind !== 'field') continue;
        const field = node.field;
        const key = field.alias ?? field.name;
        const value = resolveMutation(field, ctx);
        if (value === UNKNOWN_FIELD) {
          ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Mutation'` });
          data[key] = null;
          continue;
        }
        data[key] = materialize(value, field, ctx);
      }
    };
    void root;
    visit(operation.selection);
  } else {
    data = executeSelection(obj('Query', {}), operation.selection, ctx);
  }
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/**
 * The GraphQL HTTP handler: a single operation object, or a batch array answered in order.
 * Returns the HTTP status and the JSON payload.
 */
export function handleGraphQL(bodyText: string): { status: number; payload: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return { status: 400, payload: { errors: [{ message: 'malformed JSON body' }] } };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((element) => executeOne((typeof element === 'object' && element !== null ? element : {}) as Record<string, unknown>));
    return { status: 200, payload: results };
  }
  if (typeof parsed !== 'object' || parsed === null) return { status: 400, payload: { errors: [{ message: 'malformed request body' }] } };
  return { status: 200, payload: executeOne(parsed as Record<string, unknown>) };
}
