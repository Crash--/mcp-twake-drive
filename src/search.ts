/**
 * Name search on a local replica of the drive metadata, kept by cozy-pouch-link.
 *
 * The cozy-stack has no server-side search, which is why the Twake Drive web
 * and mobile apps also search a local copy. Nothing is loaded or fetched until
 * the first search. The replica holds the io.cozy.files documents (names,
 * folders, types, sizes, dates), never the content of the files.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);

const FILES_DOCTYPE = 'io.cozy.files';
const ROOT_DIR_ID = 'io.cozy.files.root-dir';
const TRASH_DIR_ID = 'io.cozy.files.trash-dir';

let PouchDB: any;

export interface Hit {
  id: string;
  name: string;
  type: 'file' | 'directory';
  path?: string;
  dir_id?: string;
  mime?: string;
  class?: string;
  size?: number;
  updated_at?: string;
}

export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Opens the replica: PouchDB through its node:sqlite adapter, one private file per instance. */
async function openReplica(stack: any, cacheDir: string) {
  const host = new URL(stack.uri).host;
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await rm(join(cacheDir, `${host}.json`), { force: true });
  const file = join(cacheDir, `${host}__doctype__${FILES_DOCTYPE}.sqlite`);
  // SQLite gives its -wal and -shm files the mode of the database.
  await writeFile(file, '', { flag: 'a', mode: 0o600 });

  const { DatabaseSync: Database } = require('node:sqlite') as typeof import('node:sqlite');
  const db = new Database(file);
  db.exec('CREATE TABLE IF NOT EXISTS "pouch-link-state" (key TEXT PRIMARY KEY, value TEXT)');
  db.function('fold', (text) => fold(String(text ?? '')));
  const read = db.prepare('SELECT value FROM "pouch-link-state" WHERE key = ?');
  const write = db.prepare('INSERT OR REPLACE INTO "pouch-link-state" VALUES (?, ?)');
  const erase = db.prepare('DELETE FROM "pouch-link-state" WHERE key = ?');

  // shortcut: pouchdb-browser reads `self` at load, even when the platform brings its own PouchDB. Remove it once cozy-pouch-link loads in Node.
  (globalThis as any).self ??= globalThis;
  const PouchLink = require('cozy-pouch-link').default;
  const CozyClient = require('cozy-client').default;
  PouchDB ??= require('pouchdb-core')
    .plugin(require('pouchdb-adapter-http'))
    .plugin(require('pouchdb-replication'))
    .plugin(require('pouchdb-adapter-node-sqlite').default);

  const sync = { error: undefined as Error | undefined };
  let since: string | undefined;
  const link = new PouchLink({
    doctypes: [FILES_DOCTYPE],
    doctypesReplicationOptions: {
      [FILES_DOCTYPE]: {
        strategy: 'fromRemote',
        // The checkpoint stays in the local file: the server only gets read requests.
        checkpoint: 'target',
        // shortcut: replicateOnce sets since to '' and PouchDB then restarts from 0 every time. Remove once cozy-pouch-link leaves it undefined.
        get since() {
          return since;
        },
        set since(value: string | undefined) {
          since = value || undefined;
        },
      },
    },
    pouch: { options: { adapter: 'sqlite3' } },
    onSyncError: (e: Error) => {
      sync.error = e;
    },
    platform: {
      pouchAdapter: PouchDB.defaults({ prefix: `${cacheDir}/` }),
      isOnline: async () => true,
      events: { addEventListener() {}, removeEventListener() {} },
      storage: {
        getItem: async (key: string) => (read.get(key) as { value: string } | undefined)?.value ?? null,
        setItem: async (key: string, value: string) => void write.run(key, value),
        removeItem: async (key: string) => void erase.run(key),
        destroy: async () => void db.exec('DELETE FROM "pouch-link-state"'),
      },
    },
  });
  // Its own client: the link answers the queries of the client it serves, and the tools must keep reading the stack.
  const client = new CozyClient({ stackClient: stack, links: [link], warningForCustomHandlers: false });
  // The link hands every replicated document to the store, which nothing reads here.
  client.setData = () => {};
  link.registerClient(client);
  await link.onLogin();
  return { db, link, sync };
}

export function createSearch(stack: any, cacheDir: string) {
  let replica: ReturnType<typeof openReplica> | undefined;
  let syncing: Promise<void> | undefined;

  const sync = async () => {
    replica ??= openReplica(stack, cacheDir);
    const { link, sync: state } = await replica;
    state.error = undefined;
    await link.pouches.replicateOnce();
    if (state.error) throw state.error;
  };

  return {
    /**
     * Accent- and case-insensitive name search, after pulling the latest changes; every word
     * of the query must appear in the name. Ranking: exact name, then prefix, then the rest;
     * ties broken by most recent update. SQLite walks the rows, so only the matches reach JS,
     * and only the best ones stay in memory.
     */
    async search(
      query: string,
      opts: { type?: 'file' | 'directory' | 'any'; class?: string; inPath?: string; limit: number }
    ): Promise<{ total: number; hits: Hit[] }> {
      syncing ??= sync().finally(() => {
        syncing = undefined;
      });
      await syncing;
      const { db } = await replica!;

      const q = fold(query.trim());
      const words = q.split(/\s+/).filter(Boolean);
      const scope = opts.inPath ? fold(opts.inPath.replace(/\/+$/, '')) : undefined;
      const parentPaths = new Map<string, string | undefined>();
      const parentPath = parentStatement(db);
      const pathOf = (doc: Row) => {
        if (doc.type === 'directory') return doc.path ?? undefined;
        if (!doc.dir_id) return undefined;
        if (!parentPaths.has(doc.dir_id)) {
          parentPaths.set(doc.dir_id, (parentPath.get(doc.dir_id) as { path: string | null } | undefined)?.path ?? undefined);
        }
        const parent = parentPaths.get(doc.dir_id);
        if (!parent) return undefined;
        return parent === '/' ? `/${doc.name}` : `${parent}/${doc.name}`;
      };

      const rank = (a: Scored, b: Scored) => b.score - a.score || (a.u < b.u ? 1 : a.u > b.u ? -1 : 0);
      let best: Scored[] = [];
      let total = 0;
      for (const doc of matches(db, words, opts) as unknown as Iterable<Row>) {
        if (doc.id === ROOT_DIR_ID || doc.id === TRASH_DIR_ID || doc.trashed) continue;
        const path = pathOf(doc);
        if (path === '/.cozy_trash' || path?.startsWith('/.cozy_trash/')) continue;
        if (scope && !(path && (fold(path) === scope || fold(path).startsWith(`${scope}/`)))) continue;
        total++;
        const name = fold(doc.name ?? '');
        const score = name === q || name.replace(/\.[^.]+$/, '') === q ? 3 : name.startsWith(q) ? 2 : 1;
        best.push({ score, u: doc.updated_at ?? '', doc, path });
        if (best.length >= opts.limit * 2 + 100) best = best.sort(rank).slice(0, opts.limit);
      }
      const hits = best
        .sort(rank)
        .slice(0, opts.limit)
        .map(({ doc, path }) => ({
          id: doc.id,
          name: doc.name ?? '',
          type: doc.type === 'directory' ? ('directory' as const) : ('file' as const),
          path,
          dir_id: doc.dir_id ?? undefined,
          mime: doc.mime ?? undefined,
          class: doc.class ?? undefined,
          size: doc.size === null || doc.size === undefined ? undefined : Number(doc.size),
          updated_at: doc.updated_at ?? undefined,
        }));
      return { total, hits };
    },
  };
}

interface Row {
  id: string;
  name: string | null;
  type: string | null;
  dir_id: string | null;
  path: string | null;
  mime: string | null;
  class: string | null;
  size: string | number | null;
  updated_at: string | null;
  trashed: number | null;
}

interface Scored {
  score: number;
  u: string;
  doc: Row;
  path?: string;
}

// The tables of the PouchDB adapter, read the same way as the SQLite engine of cozy-pouch-link on mobile.
const WINNING = '"document-store" d JOIN "by-sequence" s ON s.seq = d.winningseq WHERE s.deleted = 0';

function parentStatement(db: DatabaseSync) {
  return db.prepare(`SELECT json_extract(s.json, '$.path') AS path FROM ${WINNING} AND d.id = ?`);
}

function matches(db: DatabaseSync, words: string[], opts: { type?: string; class?: string }) {
  const field = (name: string) => `json_extract(s.json, '$.${name}') AS ${name === 'class' ? '"class"' : name}`;
  const filters = words.map(() => `fold(json_extract(s.json, '$.name')) LIKE ? ESCAPE '\\'`);
  const params: string[] = words.map((w) => `%${w.replace(/[\\%_]/g, '\\$&')}%`);
  if (opts.type === 'directory') filters.push(`json_extract(s.json, '$.type') = 'directory'`);
  if (opts.type === 'file') filters.push(`json_extract(s.json, '$.type') <> 'directory'`);
  if (opts.class) {
    filters.push(`json_extract(s.json, '$.class') = ?`);
    params.push(opts.class);
  }
  const columns = ['name', 'type', 'dir_id', 'path', 'mime', 'class', 'size', 'updated_at', 'trashed'].map(field).join(', ');
  const sql = `SELECT d.id AS id, ${columns} FROM ${WINNING}${filters.map((f) => ` AND ${f}`).join('')}`;
  return db.prepare(sql).iterate(...params);
}
