// gitstore.ts — a real in-memory git object store (SHA-1 via node:crypto, zlib via node:zlib).
// Objects are stored by their git id: sha1("<type> <len>\0" + raw content). Commits, trees, blobs
// and annotated tags are all first-class, so REST contents SHAs and git-protocol SHAs agree by
// construction. No wall clock and no randomness live here: object ids are pure functions of content.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export const ZERO_SHA = '0000000000000000000000000000000000000000';
export const TYPE_IDS: Readonly<Record<ObjType, number>> = Object.freeze({ commit: 1, tree: 2, blob: 3, tag: 4 });
export const ID_TYPES: Readonly<Record<number, ObjType>> = Object.freeze({ 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' });

/** The git object id of a raw object body. */
export function objectId(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** One repository's object database. */
export class Store {
  readonly objects = new Map<string, { type: ObjType; data: Buffer }>();
  /**
   * Memoized derivations, all pure functions of immutable object bytes: a stored object's
   * parsed form, the closure of a tip, its reachable-commit list and its flattened tree can
   * never change once computed (objects are only ever added, and a tip's ancestry is fixed
   * by its bytes), so these caches need no invalidation. Callers must not mutate what the
   * helpers hand back.
   */
  readonly commitInfoCache = new Map<string, CommitInfo>();
  readonly treeCache = new Map<string, TreeEntry[]>();
  readonly closureCache = new Map<string, Set<string>>();
  readonly reachableCache = new Map<string, string[]>();
  readonly flatCache = new Map<string, Map<string, { sha: string; mode: string }>>();

  has(sha: string): boolean {
    return this.objects.has(sha);
  }

  get(sha: string): { type: ObjType; data: Buffer } | undefined {
    return this.objects.get(sha);
  }

  /** Insert (or find) an object; returns its id. */
  put(type: ObjType, data: Buffer): string {
    const sha = objectId(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  /** Insert an object whose id is already known (pack receive path). */
  putKnown(sha: string, type: ObjType, data: Buffer): void {
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
  }
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a raw commit object body. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = ZERO_SHA;
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** The parsed commit for an object id, memoized per store; null when absent or not a commit. */
export function commitInfo(store: Store, sha: string): CommitInfo | null {
  const cached = store.commitInfoCache.get(sha);
  if (cached !== undefined) return cached;
  const object = store.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const info = parseCommit(object.data);
  store.commitInfoCache.set(sha, info);
  return info;
}

/** Serialize a commit object body. */
export function buildCommit(info: CommitInfo): Buffer {
  let head = `tree ${info.tree}\n`;
  for (const parent of info.parents) head += `parent ${parent}\n`;
  head += `author ${info.author}\ncommitter ${info.committer}\n`;
  return Buffer.from(`${head}\n${info.message}`, 'utf8');
}

/** The message subject (first line) of a commit. */
export function commitSubject(data: Buffer): string {
  const { message } = parseCommit(data);
  return message.split('\n')[0] ?? '';
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Parse a raw tree object body. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** The parsed entries of a tree object, memoized per store; null when absent or not a tree. */
export function treeEntries(store: Store, sha: string): TreeEntry[] | null {
  const cached = store.treeCache.get(sha);
  if (cached !== undefined) return cached;
  const object = store.get(sha);
  if (object === undefined || object.type !== 'tree') return null;
  const entries = parseTree(object.data);
  store.treeCache.set(sha, entries);
  return entries;
}

/** Git's tree-entry sort key: directories compare as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialize a tree object body, sorting entries the way git does. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Whether a tree entry mode denotes a subtree. */
export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Recursive worker for flattenTree (no caching; the public wrapper memoizes whole trees). */
function flattenInto(store: Store, treeSha: string, prefix: string, out: Map<string, { sha: string; mode: string }>): void {
  const entries = treeEntries(store, treeSha);
  if (entries === null) return;
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isTreeMode(entry.mode)) flattenInto(store, entry.sha, path, out);
    else out.set(path, { sha: entry.sha, mode: entry.mode });
  }
}

/** Flatten a tree into a map of full path -> blob entry, recursing into subtrees. */
export function flattenTree(store: Store, treeSha: string, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
  if (prefix !== '') {
    flattenInto(store, treeSha, prefix, out);
    return out;
  }
  // The whole-tree flattening is a pure function of the immutable tree: memoize it. The
  // cached map is copied into `out`, so callers may freely mutate what they get back.
  let flat = store.flatCache.get(treeSha);
  if (flat === undefined) {
    flat = new Map<string, { sha: string; mode: string }>();
    flattenInto(store, treeSha, '', flat);
    store.flatCache.set(treeSha, flat);
  }
  for (const [path, entry] of flat) out.set(path, entry);
  return out;
}

/** The entry (file or dir) at a path inside a tree, or null. Walks component by component. */
export function treeEntryAt(store: Store, treeSha: string, path: string): { sha: string; mode: string; type: 'file' | 'dir' } | null {
  const parts = path.split('/').filter((part) => part !== '');
  let current = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const entries = treeEntries(store, current);
    if (entries === null) return null;
    const entry = entries.find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) return { sha: entry.sha, mode: entry.mode, type: isTreeMode(entry.mode) ? 'dir' : 'file' };
    if (!isTreeMode(entry.mode)) return null;
    current = entry.sha;
  }
  return null;
}

/** The directory listing of a tree at a path (entries of that subtree), or null when absent. */
export function treeListAt(store: Store, treeSha: string, path: string): TreeEntry[] | null {
  if (path === '' || path === '/') return treeEntries(store, treeSha);
  const found = treeEntryAt(store, treeSha, path);
  if (found === null || found.type !== 'dir') return null;
  return treeEntries(store, found.sha);
}

/**
 * Rebuild a root tree from a flat path -> blob map, creating intermediate trees bottom-up.
 * Returns the root tree id (the empty tree for an empty map).
 */
export function buildTreeFromFiles(store: Store, files: ReadonlyMap<string, { sha: string; mode: string }>): string {
  interface DirNode {
    files: Map<string, { sha: string; mode: string }>;
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]!);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i]!, next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1]!, file);
  }
  const build = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, sha: file.sha });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, sha: build(dir) });
    return store.put('tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------- ancestry

/** All commits reachable from `tip` (inclusive), breadth-first, parents in order. */
export function reachableCommits(store: Store, tip: string): string[] {
  const cached = store.reachableCache.get(tip);
  if (cached !== undefined) return cached;
  const seen = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [tip];
  for (let head = 0; head < queue.length; head += 1) {
    const sha = queue[head]!;
    if (seen.has(sha)) continue;
    const info = commitInfo(store, sha);
    if (info === null) continue;
    seen.add(sha);
    order.push(sha);
    for (const parent of info.parents) queue.push(parent);
  }
  store.reachableCache.set(tip, order);
  return order;
}

/** Whether `ancestor` is reachable from `descendant` (inclusive). */
export function isAncestor(store: Store, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  for (let head = 0; head < queue.length; head += 1) {
    const sha = queue[head]!;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const info = commitInfo(store, sha);
    if (info === null) continue;
    for (const parent of info.parents) queue.push(parent);
  }
  return false;
}

/**
 * A merge base of two commits: the common ancestor that is not itself an ancestor of another
 * common ancestor. Histories in this forge are shallow and small, so the simple
 * candidate-elimination walk is exact enough (and exact for linear/diverged-once histories).
 */
export function mergeBase(store: Store, a: string, b: string): string | null {
  const fromA = new Set(reachableCommits(store, a));
  const candidates = reachableCommits(store, b).filter((sha) => fromA.has(sha));
  for (const candidate of candidates) {
    const shadowed = candidates.some((other) => other !== candidate && isAncestor(store, candidate, other));
    if (!shadowed) return candidate;
  }
  return null;
}

/** The commit a (possibly annotated) tag object ultimately points at, following tag chains. */
export function peelToCommit(store: Store, sha: string): string | null {
  let current = sha;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (match === null) return null;
    current = match[1]!;
  }
  return null;
}

/** The object a tag points at directly (one hop), for peeled advertisement lines. */
export function tagTarget(store: Store, sha: string): string | null {
  const object = store.get(sha);
  if (object === undefined || object.type !== 'tag') return null;
  const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
  return match === null ? null : match[1]!;
}

// ---------------------------------------------------------------- packfiles

/** Apply a git binary delta to a base object body. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset]!;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: ${sourceSize} vs ${base.length}`);
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if ((op & 0x01) !== 0) { copyOffset |= delta[offset]!; offset += 1; }
      if ((op & 0x02) !== 0) { copyOffset |= delta[offset]! << 8; offset += 1; }
      if ((op & 0x04) !== 0) { copyOffset |= delta[offset]! << 16; offset += 1; }
      if ((op & 0x08) !== 0) { copyOffset |= delta[offset]! << 24; offset += 1; }
      if ((op & 0x10) !== 0) { copySize |= delta[offset]!; offset += 1; }
      if ((op & 0x20) !== 0) { copySize |= delta[offset]! << 8; offset += 1; }
      if ((op & 0x40) !== 0) { copySize |= delta[offset]! << 16; offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(parts);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/** Inflate one zlib stream starting at `offset`; returns the data and the compressed bytes consumed. */
function inflateAt(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; consumed: number } {
  const slice = buf.subarray(offset);
  const result = inflateSync(slice, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten?: number } };
  if (result.buffer.length !== expectedSize) throw new Error(`inflated size ${result.buffer.length} != pack header size ${expectedSize}`);
  let consumed = result.engine?.bytesWritten;
  if (typeof consumed !== 'number' || consumed <= 0) {
    // Fallback: double then binary-search the smallest prefix that inflates to the expected size.
    let lo = 1;
    let hi = Math.min(slice.length, Math.max(64, expectedSize + 64));
    const inflates = (length: number): boolean => {
      try {
        return inflateSync(slice.subarray(0, length)).length === expectedSize;
      } catch {
        return false;
      }
    };
    while (!inflates(hi) && hi < slice.length) {
      lo = hi;
      hi = Math.min(slice.length, hi * 2);
    }
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (inflates(mid)) hi = mid;
      else lo = mid + 1;
    }
    consumed = lo;
  }
  return { data: result.buffer, consumed };
}

/**
 * Parse a packfile into the store. Handles plain objects plus OFS-DELTA and REF-DELTA entries
 * (delta bases may live in the same pack or already in the store). Returns the object count.
 * Throws on any structural problem; objects already inserted stay inserted, which mirrors git:
 * a failed receive still leaves the objects, it just moves no refs.
 */
export function readPack(store: Store, pack: Buffer): number {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('latin1', 0, 4) !== 'PACK') throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let offset = 12;

  interface DeltaEntry {
    baseSha: string | null;
    baseOffset: number | null;
    delta: Buffer;
  }
  const deltas: DeltaEntry[] = [];
  // Pack offset -> plain object id, or -1 - deltaIndex for a delta entry at that offset.
  const byOffset = new Map<number, string>();
  const deltaIndexAt = new Map<number, number>();

  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset]!;
    offset += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseSha: string | null = null;
    let baseOffset: number | null = null;
    if (typeId === 6) {
      // OFS-DELTA: negative offset to the base object's start, in git's offset encoding.
      byte = pack[offset]!;
      offset += 1;
      let back = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[offset]!;
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - back;
    } else if (typeId === 7) {
      baseSha = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const { data, consumed } = inflateAt(pack, offset, size);
    offset += consumed;
    if (typeId === 6 || typeId === 7) {
      deltaIndexAt.set(start, deltas.length);
      deltas.push({ baseSha, baseOffset, delta: data });
    } else {
      const type = ID_TYPES[typeId];
      if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
      const sha = objectId(type, data);
      store.putKnown(sha, type, data);
      byOffset.set(start, sha);
    }
  }

  // Resolve deltas with memoization; a delta's base may itself be a delta in this pack.
  const resolved = new Array<string | null>(deltas.length).fill(null);
  const resolveDelta = (index: number, guard: number): string => {
    const cached = resolved[index];
    if (cached !== null) return cached;
    if (guard > count + 4) throw new Error('delta chain too deep');
    const entry = deltas[index]!;
    let base: { type: ObjType; data: Buffer } | undefined;
    if (entry.baseSha !== null) {
      base = store.get(entry.baseSha);
      if (base === undefined) {
        // The base is a delta in this pack whose id is not known until it is resolved.
        for (let j = 0; j < deltas.length && base === undefined; j += 1) {
          if (j === index) continue;
          if (resolveDelta(j, guard + 1) === entry.baseSha) base = store.get(entry.baseSha);
        }
      }
      if (base === undefined) throw new Error(`delta base ${entry.baseSha} not in pack or store`);
    } else {
      const baseStart = entry.baseOffset!;
      const plainSha = byOffset.get(baseStart);
      if (plainSha !== undefined) {
        base = store.get(plainSha);
      } else {
        const baseIndex = deltaIndexAt.get(baseStart);
        if (baseIndex === undefined) throw new Error('ofs-delta base offset not found');
        base = store.get(resolveDelta(baseIndex, guard + 1));
      }
      if (base === undefined) throw new Error('delta base object missing');
    }
    const data = applyDelta(base.data, entry.delta);
    const sha = objectId(base.type, data);
    store.putKnown(sha, base.type, data);
    resolved[index] = sha;
    return sha;
  };
  for (let d = 0; d < deltas.length; d += 1) resolveDelta(d, 0);
  return count;
}

/** Serialize a set of objects as a packfile v2 with no deltas (every object stored whole). */
export function writePack(store: Store, shas: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  parts.push(header);
  for (const sha of shas) {
    const object = store.get(sha);
    if (object === undefined) throw new Error(`writePack: missing object ${sha}`);
    const typeId = TYPE_IDS[object.type];
    let size = object.data.length;
    const headBytes: number[] = [];
    let first = (typeId << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    headBytes.push(first);
    while (size > 0) {
      let byte = size & 0x7f;
      size >>= 7;
      if (size > 0) byte |= 0x80;
      headBytes.push(byte);
    }
    parts.push(Buffer.from(headBytes));
    // Level 1, not the default 6: pack building is CPU-bound and the transport here is
    // loopback, so the ~4x faster compression of text at level 1 beats the slightly
    // larger pack. The wire format is identical either way; git inflates any level.
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- fetch selection

export interface FetchSelection {
  /** Object ids to pack, in a valid order (commits, then trees, then blobs/tags). */
  objects: string[];
  /** Commits that become the client's new shallow boundary. */
  shallow: string[];
  /** Commits leaving the client's shallow boundary because their parents are now included. */
  unshallow: string[];
}

/** The full object closure (commits + trees + blobs + tags) reachable from a commit/tag id. */
export function objectClosure(store: Store, tip: string, treatAsParentless: ReadonlySet<string> = new Set()): Set<string> {
  // The plain closure of a tip is fixed by the tip's bytes: memoize it. The shallow-aware
  // variant (a non-empty parentless set) depends on the caller's set and is not cached.
  const memoize = treatAsParentless.size === 0;
  if (memoize) {
    const cached = store.closureCache.get(tip);
    if (cached !== undefined) return cached;
  }
  const out = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (out.has(sha)) continue;
    const object = store.get(sha);
    if (object === undefined) continue;
    out.add(sha);
    if (object.type === 'commit') {
      const info = commitInfo(store, sha)!;
      stack.push(info.tree);
      if (!treatAsParentless.has(sha)) for (const parent of info.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of treeEntries(store, sha)!) stack.push(entry.sha);
    } else if (object.type === 'tag') {
      const target = tagTarget(store, sha);
      if (target !== null) stack.push(target);
    }
  }
  if (memoize) store.closureCache.set(tip, out);
  return out;
}

/**
 * Select the objects for a fetch: the closure of `wants`, limited by `depth` (commits at
 * distance < depth from a want are included), minus everything reachable from `haves` (whose
 * declared shallow commits count as parentless). Mirrors git's shallow bookkeeping.
 */
export function selectFetchObjects(store: Store, wants: readonly string[], haves: readonly string[], clientShallow: readonly string[], depth: number | null): FetchSelection {
  const shallowSet = new Set(clientShallow);
  // Everything the client already has: full closure of haves, shallow commits parentless.
  const haveObjects = new Set<string>();
  for (const have of haves) {
    for (const sha of objectClosure(store, have, shallowSet)) haveObjects.add(sha);
  }

  // Distance-limited commit inclusion from the wants.
  const includedCommits = new Set<string>();
  const distance = new Map<string, number>();
  const queue: { sha: string; dist: number }[] = [];
  const wantObjects = new Set<string>();
  for (const want of wants) {
    const object = store.get(want);
    if (object === undefined) continue;
    if (object.type === 'commit') queue.push({ sha: want, dist: 0 });
    else {
      // A tag (or tree/blob) want: include its closure whole, then queue its commit.
      for (const sha of objectClosure(store, want)) wantObjects.add(sha);
      const commit = peelToCommit(store, want);
      if (commit !== null) queue.push({ sha: commit, dist: 0 });
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const { sha, dist } = queue[head]!;
    if (distance.has(sha) && distance.get(sha)! <= dist) continue;
    distance.set(sha, dist);
    includedCommits.add(sha);
    if (depth !== null && dist + 1 >= depth) continue;
    const info = commitInfo(store, sha);
    if (info === null) continue;
    for (const parent of info.parents) queue.push({ sha: parent, dist: dist + 1 });
  }

  // The new boundary: included commits with at least one parent that exists but is not included.
  const newShallow: string[] = [];
  for (const sha of includedCommits) {
    const info = commitInfo(store, sha);
    if (info === null) continue;
    if (info.parents.some((parent) => store.has(parent) && !includedCommits.has(parent))) newShallow.push(sha);
  }
  // Commits the client held as shallow whose parents are now included stop being shallow.
  const unshallow: string[] = [];
  for (const sha of shallowSet) {
    if (includedCommits.has(sha) && !newShallow.includes(sha)) unshallow.push(sha);
  }

  const include = new Set<string>(wantObjects);
  for (const sha of includedCommits) {
    const info = commitInfo(store, sha);
    if (info === null) continue;
    include.add(sha);
    for (const objSha of objectClosure(store, info.tree)) include.add(objSha);
  }
  for (const sha of haveObjects) include.delete(sha);
  // A commit the client already has as a have is never re-sent, but its tree objects may still
  // be needed if they were never sent; objectClosure(haves) above already covers that case.

  const commits: string[] = [];
  const trees: string[] = [];
  const rest: string[] = [];
  for (const sha of include) {
    const object = store.get(sha);
    if (object === undefined) continue;
    if (object.type === 'commit') commits.push(sha);
    else if (object.type === 'tree') trees.push(sha);
    else rest.push(sha);
  }
  // Commits newest-first (BFS distance order) so a reader sees parents after children.
  commits.sort((a, b) => (distance.get(a) ?? 0) - (distance.get(b) ?? 0));
  return { objects: [...commits, ...trees, ...rest], shallow: newShallow, unshallow };
}
