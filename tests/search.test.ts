import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCozyClient } from '../src/drive.js';
import { createSearch } from '../src/search.js';

type Doc = Record<string, unknown> & { _id: string; _rev: string };

const dir = (id: string, path: string, name: string): Doc => ({ _id: id, _rev: '1-a', type: 'directory', name, path, dir_id: 'io.cozy.files.root-dir' });
const file = (id: string, name: string, extra: Record<string, unknown> = {}): Doc => ({ _id: id, _rev: '1-a', type: 'file', name, dir_id: 'd1', size: '12', ...extra });

describe('search', () => {
  let server: Server;
  let baseUrl: string;
  let cacheDir: string;
  let docs: Doc[];
  let changes: Array<{ seq: string; id: string; changes: { rev: string }[]; deleted?: boolean; doc?: Doc }>;
  let requests: string[];

  beforeEach(async () => {
    requests = [];
    changes = [];
    docs = [
      dir('io.cozy.files.root-dir', '/', ''),
      dir('io.cozy.files.trash-dir', '/.cozy_trash', '.cozy_trash'),
      dir('d1', '/Projets', 'Projets'),
      dir('d2', '/.cozy_trash/old', 'old report'),
      file('f1', 'Budget Réunion 2027.xlsx', { class: 'spreadsheet', updated_at: '2026-01-01T00:00:00Z' }),
      file('f2', 'reunion-notes.md', { trashed: true }),
      file('f3', 'budget.xlsx', { updated_at: '2020-01-01T00:00:00Z' }),
      file('f4', 'budget 100%.txt', { updated_at: '2024-01-01T00:00:00Z' }),
    ];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const url = new URL(req.url!, 'http://x');
        requests.push(`${req.method} ${url.pathname}`);
        res.setHeader('content-type', 'application/json');
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.end(JSON.stringify(body));
        };
        if (url.pathname === '/data/') return send(200, { couchdb: 'Welcome', version: '3.3.3' });
        const path = url.pathname.replace(/^\/data\/io\.cozy\.files\/?/, '/');
        if (path === '/_all_docs') {
          const after = url.searchParams.get('startkey_docid');
          const from = after ? docs.findIndex((d) => d._id === after) : 0;
          return send(200, { rows: docs.slice(from).map((doc) => ({ id: doc._id, key: doc._id, value: { rev: doc._rev }, doc })) });
        }
        if (path === '/_changes') {
          if (url.searchParams.get('descending')) return send(200, { last_seq: '1-x', results: [] });
          const since = parseInt(url.searchParams.get('since') ?? '0', 10);
          return send(200, { last_seq: `${1 + changes.length}-x`, results: changes.filter((c) => parseInt(c.seq, 10) > since), pending: 0 });
        }
        if (path === '/_revs_diff') {
          const asked = JSON.parse(Buffer.concat(chunks).toString());
          return send(200, Object.fromEntries(Object.entries(asked).map(([id, missing]) => [id, { missing }])));
        }
        if (path === '/_bulk_get') {
          const asked = JSON.parse(Buffer.concat(chunks).toString()).docs as { id: string }[];
          return send(200, {
            results: asked.map(({ id }) => ({ id, docs: [{ ok: changes.find((c) => c.id === id)!.doc }] })),
          });
        }
        if (path.startsWith('/_local')) return req.method === 'GET' ? send(404, { error: 'not_found' }) : send(201, { ok: true, id: 'x', rev: '0-1' });
        if (path === '/') return send(200, { db_name: 'io.cozy.files', doc_count: docs.length, update_seq: '1-x' });
        return send(404, { error: 'not_found' });
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    cacheDir = join(mkdtempSync(join(tmpdir(), 'twake-drive-search-')), 'cache');
  });

  afterEach(() => {
    server.close();
    server.closeAllConnections();
    rmSync(join(cacheDir, '..'), { recursive: true, force: true });
  });

  const open = async () => {
    const client = createCozyClient(baseUrl, { getToken: async () => 'tok', invalidate: vi.fn() });
    await client.getStackClient().loadToken();
    return createSearch(client.getStackClient(), cacheDir);
  };

  it('fetches nothing until the first search', async () => {
    await open();
    expect(requests).toEqual([]);
    expect(() => readdirSync(cacheDir)).toThrow();
  });

  it('matches without accents or case, and resolves paths through the folder', async () => {
    const search = await open();
    const { total, hits } = await search.search('budget reunion', { limit: 10 });
    expect(total).toBe(1);
    expect(hits[0]).toMatchObject({ id: 'f1', type: 'file', path: '/Projets/Budget Réunion 2027.xlsx', size: 12, class: 'spreadsheet' });
  });

  it('hides trashed items, the root and the trash folder', async () => {
    const search = await open();
    expect((await search.search('reunion-notes', { limit: 10 })).total).toBe(0);
    expect((await search.search('old report', { limit: 10 })).total).toBe(0);
    expect((await search.search('cozy_trash', { limit: 10 })).total).toBe(0);
  });

  it('ranks the exact name first, then the prefix, then the most recent', async () => {
    const search = await open();
    const { hits, total } = await search.search('budget', { limit: 2 });
    expect(total).toBe(3);
    expect(hits.map((h) => h.id)).toEqual(['f3', 'f1']);
  });

  it('filters on type, class and folder, and takes % as a plain character', async () => {
    const search = await open();
    expect((await search.search('projets', { type: 'file', limit: 5 })).total).toBe(0);
    expect((await search.search('projets', { type: 'directory', limit: 5 })).total).toBe(1);
    expect((await search.search('budget', { class: 'spreadsheet', limit: 5 })).hits.map((h) => h.id)).toEqual(['f1']);
    expect((await search.search('budget', { inPath: '/projets/', limit: 5 })).total).toBe(3);
    expect((await search.search('budget', { inPath: '/Autre', limit: 5 })).total).toBe(0);
    expect((await search.search('100%', { limit: 5 })).hits.map((h) => h.id)).toEqual(['f4']);
    expect((await search.search('1%0', { limit: 5 })).total).toBe(0);
  });

  it('pulls only the changes on the next searches, new and deleted documents included', async () => {
    const search = await open();
    await search.search('budget', { limit: 5 });
    const added = file('f5', 'budget nouveau.txt');
    changes = [
      { seq: '2-x', id: 'f5', changes: [{ rev: '1-a' }], doc: added },
      { seq: '3-x', id: 'f3', changes: [{ rev: '2-b' }], deleted: true, doc: { _id: 'f3', _rev: '2-b', _deleted: true, _revisions: { start: 2, ids: ['b', 'a'] } } },
    ];
    requests.length = 0;
    const { hits } = await search.search('budget', { limit: 5 });
    expect(hits.map((h) => h.id).sort()).toEqual(['f1', 'f4', 'f5']);
    expect(requests).not.toContain('GET /data/io.cozy.files/_all_docs');
  });

  it('keeps one private file per instance, and removes the old JSON index', async () => {
    const search = await open();
    await search.search('budget', { limit: 5 });
    expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
    const files = readdirSync(cacheDir);
    expect(files.filter((f) => f.endsWith('.sqlite'))).toHaveLength(1);
    for (const f of files) expect(statSync(join(cacheDir, f)).mode & 0o777).toBe(0o600);
    const other = join(cacheDir, `${new URL(baseUrl).host}.json`);
    writeFileSync(other, '{}');
    const again = createSearch(createCozyClient(baseUrl, { getToken: async () => 'tok', invalidate: vi.fn() }).getStackClient(), cacheDir);
    await again.search('budget', { limit: 5 }).catch(() => {});
    expect(readdirSync(cacheDir)).not.toContain(`${new URL(baseUrl).host}.json`);
  });

  it('reports a server that went away, then works again on the next search', async () => {
    const search = await open();
    await search.search('budget', { limit: 5 });
    const { port } = server.address() as { port: number };
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await expect(search.search('budget', { limit: 5 })).rejects.toThrow();
    await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
    expect((await search.search('budget', { limit: 5 })).total).toBe(3);
  });

  it('reports a replication that fails', async () => {
    server.removeAllListeners('request');
    server.on('request', (_req, res) => {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end('{"error":"boom"}');
    });
    const search = await open();
    await expect(search.search('budget', { limit: 5 })).rejects.toThrow();
  });
});
