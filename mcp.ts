// mcp.ts — the Model Context Protocol endpoint (POST /mcp, JSON-RPC 2.0 over streamable HTTP).
// Speaks the modern revision (server/discover, no handshake) and the legacy initialize
// handshake. The six required tools act on the same store as REST and GraphQL, so objects
// created over MCP are the same objects over REST (the suite's parity checks compare them).

import {
  ACCOUNT_LOGIN,
  branchTip,
  createIssue,
  createPull,
  createRepo,
  getRepo,
  issueJson,
  pullJson,
  repoJson,
  squashMerge,
  type RepoRec,
} from './forge.ts';

const SERVER_INFO = Object.freeze({ name: 'makefun-forge', version: '1.0.0' });
const SUPPORTED_VERSIONS = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

/** A JSON-schema object property shorthand. */
function prop(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

/**
 * The tool list. Defined once and frozen: two tools/list answers must be byte-identical,
 * so this array is serialized from the same object every time.
 */
export const MCP_TOOLS = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated account.',
    inputSchema: {
      type: 'object',
      properties: {
        name: prop('The repository name.'),
        description: prop('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: prop('The repository owner login.'), repo: prop('The repository name.') },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('The repository owner login.'),
        repo: prop('The repository name.'),
        title: prop('The issue title.'),
        body: prop('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed, all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('The repository owner login.'),
        repo: prop('The repository name.'),
        state: prop('The issue state filter: open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('The repository owner login.'),
        repo: prop('The repository name.'),
        title: prop('The pull request title.'),
        body: prop('The pull request body.'),
        head: prop('The head branch name.'),
        base: prop('The base branch name.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('The repository owner login.'),
        repo: prop('The repository name.'),
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

interface ToolOutcome {
  value: unknown;
  isError: boolean;
}

/** A successful tool result carrying a JSON value. */
function ok(value: unknown): ToolOutcome {
  return { value, isError: false };
}

/** A failed tool result (isError), for missing arguments and missing objects. */
function err(message: string): ToolOutcome {
  return { value: { message }, isError: true };
}

/** The string argument of a tool call, or null. */
function argStr(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Resolve the repository a tool call names (the account's own, like REST). */
function toolRepo(args: Record<string, unknown>): RepoRec | null {
  const owner = argStr(args, 'owner');
  const repo = argStr(args, 'repo');
  if (owner === null || repo === null) return null;
  return getRepo(owner, repo);
}

/** Execute one tool by its canonical name. */
function runTool(name: string, args: Record<string, unknown>): ToolOutcome | null {
  switch (name) {
    case 'create_repo': {
      const repoName = argStr(args, 'name');
      if (repoName === null) return err('missing required argument: name');
      const existing = getRepo(ACCOUNT_LOGIN, repoName);
      if (existing !== null) return ok(repoJson(existing));
      const repo = createRepo(repoName, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      return repo === null ? err('repository already exists') : ok(repoJson(repo));
    }
    case 'get_repo': {
      const repo = toolRepo(args);
      return repo === null ? err('repository not found') : ok(repoJson(repo));
    }
    case 'create_issue': {
      const repo = toolRepo(args);
      if (repo === null) return err('repository not found');
      const title = argStr(args, 'title');
      if (title === null) return err('missing required argument: title');
      const issue = createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
      return ok(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = toolRepo(args);
      if (repo === null) return err('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.seq - b.seq);
      return ok(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = toolRepo(args);
      if (repo === null) return err('repository not found');
      const title = argStr(args, 'title');
      const head = argStr(args, 'head');
      const base = argStr(args, 'base');
      if (title === null || head === null || base === null) return err('missing required argument: title, head or base');
      if (branchTip(repo, head) === null || branchTip(repo, base) === null) return err('head or base branch does not exist');
      const pull = createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, base);
      return ok(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = toolRepo(args);
      if (repo === null) return err('repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return err('pull request not found');
      if (!pull.merged) {
        const sha = squashMerge(repo, pull);
        if (sha === null) return err('pull request is not mergeable');
      }
      return ok(pullJson(repo, pull));
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- JSON-RPC handler

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_METHOD_NOT_FOUND = -32601;

interface RpcOutcome {
  status: number;
  payload: unknown;
}

/** A JSON-RPC result envelope. */
function rpcResult(id: unknown, result: unknown): RpcOutcome {
  return { status: 200, payload: { jsonrpc: '2.0', id, result } };
}

/** A JSON-RPC error envelope. */
function rpcError(id: unknown, code: number, message: string, status = 200): RpcOutcome {
  return { status, payload: { jsonrpc: '2.0', id, error: { code, message } } };
}

/** Handle one JSON-RPC request object. */
function handleRpc(request: Record<string, unknown>): RpcOutcome {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  const isNotification = id === undefined || id === null;

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { ...SERVER_INFO },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
    return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { ...SERVER_INFO } });
  }
  if (method.startsWith('notifications/')) {
    return { status: 202, payload: {} };
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: MCP_TOOLS });
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    if (!MCP_TOOLS.some((tool) => tool.name === name)) {
      return rpcError(id, JSON_RPC_INVALID_PARAMS, `unknown tool: ${name}`);
    }
    const outcome = runTool(name, args);
    if (outcome === null) return rpcError(id, JSON_RPC_INVALID_PARAMS, `unknown tool: ${name}`);
    const text = JSON.stringify(outcome.value);
    return rpcResult(id, {
      content: [{ type: 'text', text }],
      structuredContent: outcome.value,
      isError: outcome.isError,
    });
  }
  if (isNotification) return { status: 202, payload: {} };
  return rpcError(id, JSON_RPC_METHOD_NOT_FOUND, `method not found: ${method}`);
}

/**
 * The MCP HTTP handler. A body that is not JSON answers HTTP 400 with a -32700 parse error,
 * as the suite's parse-error check requires; everything else is answered per request.
 */
export function handleMcp(bodyText: string): RpcOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return rpcError(null, JSON_RPC_PARSE_ERROR, 'Parse error', 400);
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((element) => handleRpc((typeof element === 'object' && element !== null ? element : {}) as Record<string, unknown>).payload);
    return { status: 200, payload: results };
  }
  if (typeof parsed !== 'object' || parsed === null) return rpcError(null, JSON_RPC_PARSE_ERROR, 'Parse error', 400);
  return handleRpc(parsed as Record<string, unknown>);
}
