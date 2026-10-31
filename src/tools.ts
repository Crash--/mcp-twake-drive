import { mkdir, readFile, realpath, writeFile, stat as fsStat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { models } from 'cozy-client';
import type { Config } from './config.js';
import { DriveError, NOTE_SCHEMA, ROOT_DIR_ID, normalizePath, type CozyDoc } from './drive.js';
import {
  FILES_DOCTYPE,
  TRASH_DIR_ID,
  buildDiskUsageQuery,
  buildFavoritesQuery,
  buildRecentFilesInFolderQuery,
  buildRecentFilesQuery,
} from './queries.js';
import {
  guessMime,
  humanSize,
  isTar,
  isTextLike,
  markdownFromTar,
  summarize,
  variantName,
  withExtension,
} from './format.js';
import type { FileIndex, Hit } from './file-index.js';

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const MODIFY = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

// ---------- shared argument shapes ----------
const itemRef = {
  id: z.string().optional().describe('Item id (from a listing or search). Use either id or path.'),
  path: z.string().optional().describe('Absolute path, e.g. "/Documents/Rapport.pdf". Use either id or path.'),
  drive_id: z
    .string()
    .optional()
    .describe('Shared drive id (from list_shared_drives) when the item lives in a shared drive; omit for "My Drive".'),
};
const parentRef = {
  parent_id: z.string().optional().describe('Destination folder id. Use either parent_id or parent_path.'),
  parent_path: z.string().optional().describe('Destination folder absolute path (default: root "/").'),
  drive_id: itemRef.drive_id,
};

type Ref = { id?: string; path?: string; drive_id?: string };

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

const HINTS: Record<number, string> = {
  401: 'The Twake Drive token was refused. Run `twake-token drive-check`; if the grant is revoked, the user must run `twake-token drive-authorize --renew`.',
  403: 'Not allowed: the OAuth scope or the sharing rights do not cover this operation.',
  404: 'Not found: check the id or the path (paths are absolute, e.g. /Documents/report.pdf).',
  409: 'Conflict: an item with the same name already exists in the destination.',
  412: 'The document changed meanwhile (revision mismatch): fetch it again and retry.',
  413: 'The file is too large for the remaining quota.',
};

function stackDetail(reason: any): string {
  if (typeof reason === 'string') return reason.slice(0, 200);
  return reason?.errors?.[0]?.detail ?? reason?.errors?.[0]?.title ?? reason?.error ?? reason?.message ?? '';
}

function errorLines(e: any): string[] {
  if (e instanceof DriveError) return [`Error: ${e.message}`, ...(e.hint ? [`How to fix: ${e.hint}`] : [])];
  if (e.status === undefined) return [e instanceof TypeError ? `Error: Twake Drive did not answer: ${e.message}` : `Error: ${e.message}`];
  const detail = stackDetail(e.reason);
  return [`Error: HTTP ${e.status}${detail ? ` (${detail})` : ''}`, ...(HINTS[e.status] ? [`How to fix: ${HINTS[e.status]}`] : [])];
}

/** The next cursor, from the `links.next` of a paged stack route. */
function nextCursor(res: { links?: { next?: string } }, baseUrl: string): string | undefined {
  return res.links?.next ? new URL(res.links.next, baseUrl).searchParams.get('page[cursor]') ?? undefined : undefined;
}

/** A Q() page: the stack only gives a bookmark, a full page may have more. */
function nextBookmark(res: { data: unknown[]; bookmark?: string }, limit: number): string | undefined {
  return res.data.length === limit ? res.bookmark : undefined;
}

function requireRef(ref: Ref, what = 'item'): void {
  if (!ref.id && !ref.path) throw new DriveError(`Give the ${what} id or path`, 400);
}

async function loadBytes(args: { local_path?: string; content?: string; content_base64?: string }, uploadDir: string): Promise<Uint8Array> {
  const given = [args.local_path, args.content, args.content_base64].filter((v) => v !== undefined).length;
  if (given !== 1) throw new DriveError('Give exactly one of local_path, content or content_base64', 400);
  if (args.local_path !== undefined) {
    if (!isAbsolute(args.local_path)) throw new DriveError('local_path must be absolute', 400);
    await assertInside(uploadDir, args.local_path, 'TWAKE_DRIVE_UPLOAD_DIR');
    return new Uint8Array(await readFile(args.local_path));
  }
  if (args.content !== undefined) return new TextEncoder().encode(args.content);
  return new Uint8Array(Buffer.from(args.content_base64!, 'base64'));
}

/** Follows symlinks through the deepest existing ancestor, since the target itself may not exist yet. */
async function assertInside(root: string, target: string, variable: string): Promise<void> {
  await mkdir(root, { recursive: true });
  let existing = resolvePath(target);
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const rel = relative(await realpath(root), await realpath(existing));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new DriveError(`Local path must stay inside ${root} (${variable})`, 400);
  }
}

export function registerTools(server: McpServer, client: any, config: Config, index: FileIndex): void {
  const app = config.appUrl;
  const stack = client.getStackClient();
  const files = (driveId?: string) => client.collection(FILES_DOCTYPE, driveId ? { driveId } : {});

  const wrap = <A>(fn: (args: A) => Promise<unknown>) => async (args: A) => {
    try {
      // Short-lived tokens: every tool call starts from a valid one, also for the calls that bypass fetchJSON.
      await stack.loadToken();
      return text(await fn(args));
    } catch (e) {
      return { ...text(errorLines(e).join('\n')), isError: true };
    }
  };

  // Q().getById() carries no page: a folder would bring 30 children, and listing would need a Mango index to build.
  const stat = (id: string, driveId?: string, page: { limit: number; cursor?: string } = { limit: 1 }) =>
    files(driveId).statById(id, { 'page[limit]': page.limit, 'page[cursor]': page.cursor });

  const statByPath = (path: string, driveId?: string, page: { limit: number; cursor?: string } = { limit: 1 }) => {
    const query = new URLSearchParams({ Path: normalizePath(path), 'page[limit]': String(page.limit) });
    if (page.cursor) query.set('page[cursor]', page.cursor);
    // FileCollection.statByPath() carries no page.
    return stack.fetchJSON('GET', `${files(driveId).prefix}/metadata?${query}`);
  };

  /** An item from an id or an absolute path (root when both are absent). */
  const resolve = (ref: { id?: string; path?: string }, driveId?: string, page?: { limit: number; cursor?: string }) => {
    if (ref.id) return stat(ref.id, driveId, page);
    if (ref.path && ref.path !== '/') return statByPath(ref.path, driveId, page);
    return stat(ROOT_DIR_ID, driveId, page);
  };

  const resolveDirId = async (ref: { id?: string; path?: string }, driveId?: string): Promise<string> => {
    if (ref.id) return ref.id;
    if (!ref.path || ref.path === '/') return ROOT_DIR_ID;
    const doc = await statByPath(ref.path, driveId);
    if (doc.data.attributes.type !== 'directory') throw new DriveError(`${ref.path} is a file, not a folder`, 400);
    return doc.data.id;
  };

  const download = async (id: string, driveId?: string) =>
    new Uint8Array(await (await files(driveId).fetchFileContentById(id)).arrayBuffer());

  // client.save() always targets /files, never a shared drive, and it trims names.
  const patch = async (id: string, attributes: Record<string, unknown>, driveId?: string): Promise<CozyDoc> =>
    (await files(driveId).updateAttributes(id, attributes, { sanitizeName: false })).data;

  const createDir = async (parentId: string, name: string, driveId?: string): Promise<CozyDoc> =>
    (await client.save({ _type: FILES_DOCTYPE, type: 'directory', name, dirId: parentId }, driveId ? { driveId } : {})).data;

  const hitSummary = (h: Hit) =>
    summarize(
      { id: h.id, attributes: { type: h.type, name: h.name, dir_id: h.dir_id, path: h.path, mime: h.mime, class: h.class, size: h.size, updated_at: h.updated_at } },
      app
    );
  const sum = (doc: CozyDoc, extra: { dirPath?: string; driveId?: string } = {}) => summarize(doc, app, extra);

  /** Upload with a name-conflict policy. */
  const uploadWithPolicy = async (
    dirId: string,
    name: string,
    bytes: Uint8Array,
    mime: string,
    onConflict: 'error' | 'rename' | 'overwrite',
    driveId?: string
  ): Promise<{ doc: CozyDoc; action: string }> => {
    const file = { name, dirId, driveId, options: { contentType: mime } };
    if (onConflict === 'error') return { doc: (await files(driveId).createFile(bytes, file)).data, action: 'created' };
    const conflictStrategy = onConflict === 'overwrite' ? 'erase' : 'rename';
    const { data: doc } = await (models.file as any).uploadFileWithConflictStrategy(client, bytes, { ...file, conflictStrategy });
    if (onConflict === 'overwrite') return { doc, action: doc.meta?.rev?.startsWith('1-') ? 'created' : 'overwritten' };
    return { doc, action: doc.attributes.name === name ? 'created' : 'created (renamed)' };
  };

  // ======================= READ =======================

  server.registerTool(
    'get_drive_info',
    {
      title: 'Drive info',
      description: 'Storage usage and quota of the Twake Drive, plus the web address of the drive.',
      inputSchema: {},
      annotations: READ,
    },
    wrap(async () => {
      const diskUsage = buildDiskUsageQuery();
      const usage: Record<string, any> = (await client.query(diskUsage.definition, diskUsage.options)).data.attributes;
      const used = Number(usage.used ?? 0);
      const quota = usage.quota !== undefined ? Number(usage.quota) : undefined;
      return {
        instance: config.baseUrl,
        web_app: app,
        used: humanSize(used),
        quota: humanSize(quota),
        used_percent: quota ? Math.round((used / quota) * 1000) / 10 : undefined,
        files_count: usage.files_count,
        versions_size: humanSize(usage.versions !== undefined ? Number(usage.versions) : undefined),
        trash_size: humanSize(usage.trash !== undefined ? Number(usage.trash) : undefined),
      };
    })
  );

  server.registerTool(
    'list_folder',
    {
      title: 'List folder',
      description:
        'List the files and sub-folders of a folder (default: root "/"). Paginated: pass next_cursor back as cursor.',
      inputSchema: {
        ...itemRef,
        limit: z.number().int().min(1).max(100).default(50).describe('Max entries (1-100)'),
        cursor: z.string().optional().describe('next_cursor from a previous call'),
      },
      annotations: READ,
    },
    wrap(async (a: Ref & { limit: number; cursor?: string }) => {
      const res = await resolve(a, a.drive_id, { limit: a.limit, cursor: a.cursor });
      const dir: CozyDoc = res.data;
      if (dir.attributes.type !== 'directory') throw new DriveError(`${dir.attributes.name} is a file: use get_item`, 400);
      const included: CozyDoc[] = res.included ?? [];
      const items = included
        .filter((d) => ['file', 'directory'].includes(d.attributes?.type) && d.id !== TRASH_DIR_ID)
        .map((d) => sum(d, { dirPath: dir.attributes.path, driveId: a.drive_id }));
      return {
        folder: { id: dir.id, path: dir.attributes.path, name: dir.attributes.name, url: sum(dir).url },
        count: items.length,
        items,
        next_cursor: nextCursor(res, config.baseUrl),
      };
    })
  );

  server.registerTool(
    'get_item',
    {
      title: 'Get item details',
      description: 'Metadata of a file or folder (size, type, dates, path, tags, favourite, old versions, web link).',
      inputSchema: itemRef,
      annotations: READ,
    },
    wrap(async (a: Ref) => {
      requireRef(a);
      const res = await resolve(a, a.drive_id);
      const doc: CozyDoc = res.data;
      let dirPath: string | undefined;
      if (doc.attributes.type !== 'directory' && doc.attributes.dir_id) {
        dirPath = (await stat(doc.attributes.dir_id, a.drive_id).catch(() => undefined))?.data.attributes.path;
      }
      const versions = ((res.included ?? []) as CozyDoc[])
        .filter((d) => d.type === 'io.cozy.files.versions')
        .map((v) => ({ version_id: v.id.split('/').pop(), updated_at: v.attributes.updated_at, size: humanSize(Number(v.attributes.size)) }));
      return {
        ...sum(doc, { dirPath, driveId: a.drive_id }),
        size_human: humanSize(doc.attributes.size !== undefined ? Number(doc.attributes.size) : undefined),
        rev: doc.meta?.rev,
        created_by_app: doc.attributes.cozyMetadata?.createdByApp,
        old_versions: versions.length ? versions : undefined,
      };
    })
  );

  server.registerTool(
    'search_files',
    {
      title: 'Search files',
      description:
        'Search the whole drive by name: case- and accent-insensitive, every word must appear in the name. ' +
        'Optional filters: type, class (pdf, image, text, spreadsheet, slide, audio, video...) and in_path (folder scope). ' +
        'Uses a local index refreshed from the server before each search; trashed items are excluded. Shared drives not included.',
      inputSchema: {
        query: z.string().min(1).describe('Words of the name to look for'),
        type: z.enum(['file', 'directory', 'any']).default('any'),
        class: z.string().optional().describe('Cozy file class, e.g. "pdf", "image", "text", "spreadsheet", "slide"'),
        in_path: z.string().optional().describe('Only inside this folder (absolute path), e.g. "/LINAGORA/_Clients"'),
        limit: z.number().int().min(1).max(200).default(30),
      },
      annotations: READ,
    },
    wrap(async (a: { query: string; type: 'file' | 'directory' | 'any'; class?: string; in_path?: string; limit: number }) => {
      await index.sync();
      const res = index.search(a.query, { type: a.type, class: a.class, inPath: a.in_path, limit: a.limit });
      return { query: a.query, total: res.total, returned: res.hits.length, items: res.hits.map(hitSummary) };
    })
  );

  server.registerTool(
    'list_recent_files',
    {
      title: 'Recent files',
      description: 'Most recently modified files, newest first (optionally directly inside a folder). Paginated: pass next_cursor back as cursor.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(20),
        in_path: z.string().optional().describe('Only files directly inside this folder (absolute path)'),
        cursor: z.string().optional().describe('next_cursor from a previous call'),
      },
      annotations: READ,
    },
    wrap(async (a: { limit: number; in_path?: string; cursor?: string }) => {
      const dirId = a.in_path ? await resolveDirId({ path: a.in_path }) : undefined;
      const horizon = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const page = { limit: a.limit, bookmark: a.cursor };
      const query = dirId ? buildRecentFilesInFolderQuery(dirId, horizon, page) : buildRecentFilesQuery(horizon, page);
      const res = await client.query(query.definition, query.options);
      return { count: res.data.length, items: res.data.map((d: CozyDoc) => sum(d)), next_cursor: nextBookmark(res, a.limit) };
    })
  );

  server.registerTool(
    'list_favorites',
    {
      title: 'Favourites',
      description: 'Files and folders marked as favourite. Paginated: pass next_cursor back as cursor.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(100),
        cursor: z.string().optional().describe('next_cursor from a previous call'),
      },
      annotations: READ,
    },
    wrap(async (a: { limit: number; cursor?: string }) => {
      const query = buildFavoritesQuery({ limit: a.limit, bookmark: a.cursor });
      const res = await client.query(query.definition, query.options);
      return { count: res.data.length, items: res.data.map((d: CozyDoc) => sum(d)), next_cursor: nextBookmark(res, a.limit) };
    })
  );

  server.registerTool(
    'list_trash',
    {
      title: 'List trash',
      description: 'Items currently in the trash (they can be restored with restore_from_trash).',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().optional(),
      },
      annotations: READ,
    },
    wrap(async (a: { limit: number; cursor?: string }) => {
      const res = await stat(TRASH_DIR_ID, undefined, { limit: a.limit, cursor: a.cursor });
      const items: CozyDoc[] = res.included ?? [];
      return {
        count: items.length,
        items: items.map((d) => ({ ...sum(d), restore_path: d.attributes.restore_path })),
        next_cursor: nextCursor(res, config.baseUrl),
      };
    })
  );

  server.registerTool(
    'read_file',
    {
      title: 'Read a text file',
      description:
        'Return the text content of a text-like file: .txt, .md, .csv, .json, .xml, .html, Cozy notes (.cozy-note, returned as Markdown) ' +
        'and Excalidraw drawings. For binary files (PDF, Office, images) use download_file and process the local copy.',
      inputSchema: {
        ...itemRef,
        max_chars: z.number().int().min(100).max(500000).optional().describe('Truncate after this many characters'),
      },
      annotations: READ,
    },
    wrap(async (a: Ref & { max_chars?: number }) => {
      requireRef(a, 'file');
      const meta = (await resolve(a, a.drive_id)).data;
      if (meta.attributes.type === 'directory') throw new DriveError('This is a folder: use list_folder', 400);
      const name: string = meta.attributes.name;
      if (!isTextLike(meta.attributes.mime, name)) {
        throw new DriveError(`${name} (${meta.attributes.mime}) is not a text file: use download_file`, 415);
      }
      const bytes = await download(meta.id, a.drive_id);
      const markdown = isTar(bytes) ? markdownFromTar(bytes) : new TextDecoder().decode(bytes);
      if (markdown === undefined) throw new DriveError(`${name} is a damaged note: its archive has no readable index.md`, 422);
      let content = markdown;
      const max = a.max_chars ?? config.maxTextChars;
      const truncated = content.length > max;
      if (truncated) content = content.slice(0, max);
      return { id: meta.id, name, mime: meta.attributes.mime, chars: content.length, truncated, content };
    })
  );

  server.registerTool(
    'download_file',
    {
      title: 'Download a file',
      description:
        'Download a file to the local disk (default folder: TWAKE_DRIVE_DOWNLOAD_DIR) and return its local path, ' +
        'e.g. to read a PDF or an Office document with local tools.',
      inputSchema: {
        ...itemRef,
        save_to: z
          .string()
          .optional()
          .describe('Absolute local path (new file or existing folder) inside the download folder. Default: download folder.'),
      },
      annotations: CREATE,
    },
    wrap(async (a: Ref & { save_to?: string }) => {
      requireRef(a, 'file');
      const meta = (await resolve(a, a.drive_id)).data;
      if (meta.attributes.type === 'directory') throw new DriveError('Downloading a whole folder is not supported', 400);
      const name: string = meta.attributes.name;
      let target: string;
      if (a.save_to) {
        if (!isAbsolute(a.save_to)) throw new DriveError('save_to must be absolute', 400);
        const isDir = existsSync(a.save_to) && (await fsStat(a.save_to)).isDirectory();
        target = isDir ? join(a.save_to, name) : a.save_to;
      } else {
        target = join(config.downloadDir, name);
        for (let n = 2; existsSync(target); n++) target = join(config.downloadDir, variantName(name, n));
      }
      await assertInside(config.downloadDir, target, 'TWAKE_DRIVE_DOWNLOAD_DIR');
      await mkdir(dirname(target), { recursive: true });
      const bytes = await download(meta.id, a.drive_id);
      await writeFile(target, bytes, { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
        throw e.code === 'EEXIST' ? new DriveError(`${target} already exists`, 409) : e;
      });
      return { id: meta.id, name, local_path: resolvePath(target), size: humanSize(bytes.length), mime: meta.attributes.mime };
    })
  );

  server.registerTool(
    'list_shared_drives',
    {
      title: 'Shared drives',
      description: 'Shared drives the user owns or belongs to. Use the returned drive_id with the other tools.',
      inputSchema: {},
      annotations: READ,
    },
    wrap(async () => {
      const drives: CozyDoc[] = (await client.collection('io.cozy.sharings').fetchSharedDrives()).data;
      return drives.map((d) => ({
        drive_id: d.id,
        name: d.attributes.description ?? d.attributes.rules?.[0]?.title,
        owner: d.attributes.owner === true,
        root_folder_id: d.attributes.rules?.[0]?.values?.[0],
        members: (d.attributes.members ?? []).map((m: any) => ({ name: m.public_name ?? m.name, email: m.email, status: m.status, read_only: m.read_only })),
      }));
    })
  );

  server.registerTool(
    'list_sharings',
    {
      title: 'Sharings',
      description: 'Files and folders shared with people (owner side and recipient side), with members and rights.',
      inputSchema: {},
      annotations: READ,
    },
    wrap(async () => {
      const list: CozyDoc[] = (await client.collection('io.cozy.sharings').findByDoctype(FILES_DOCTYPE)).data;
      return list.map((s) => ({
        sharing_id: s.id,
        description: s.attributes.description,
        owner: s.attributes.owner === true,
        drive: s.attributes.drive === true || undefined,
        file_ids: (s.attributes.rules ?? []).flatMap((r: any) => (r.doctype === 'io.cozy.files' ? r.values ?? [] : [])),
        members: (s.attributes.members ?? []).map((m: any) => ({ name: m.public_name ?? m.name, email: m.email, status: m.status, read_only: m.read_only })),
        created_at: s.attributes.created_at,
      }));
    })
  );

  server.registerTool(
    'list_share_links',
    {
      title: 'Public links',
      description: 'Public share links (anyone with the link) that exist on files and folders, with their rights and expiry.',
      inputSchema: {},
      annotations: READ,
    },
    wrap(async () => {
      const links: CozyDoc[] = (await client.collection('io.cozy.permissions').fetchAllLinks({ _type: FILES_DOCTYPE })).data;
      return links.map((p) => linkSummary(p, app));
    })
  );

  // ======================= CREATE =======================

  server.registerTool(
    'create_folder',
    {
      title: 'Create folder',
      description: 'Create a folder. With parents=true, every missing folder of `path` is created (like mkdir -p).',
      inputSchema: {
        name: z.string().optional().describe('Folder name (with parent_id/parent_path)'),
        path: z.string().optional().describe('Full absolute path of the folder to create, e.g. "/Projets/2027/Kick-off"'),
        parents: z.boolean().default(false),
        ...parentRef,
      },
      annotations: CREATE,
    },
    wrap(async (a: { name?: string; path?: string; parents: boolean; parent_id?: string; parent_path?: string; drive_id?: string }) => {
      if (a.path) {
        const parts = normalizePath(a.path).split('/').filter(Boolean);
        if (!parts.length) throw new DriveError('path must not be the root', 400);
        let parentId = ROOT_DIR_ID;
        let current = '';
        let last: CozyDoc | undefined;
        for (const [i, part] of parts.entries()) {
          current += `/${part}`;
          try {
            last = (await statByPath(current, a.drive_id)).data as CozyDoc;
            if (i === parts.length - 1) return { already_existed: true, ...sum(last) };
          } catch (e) {
            if ((e as { status?: number }).status !== 404 || e instanceof DriveError) throw e;
            if (i < parts.length - 1 && !a.parents) throw new DriveError(`${current} does not exist (use parents=true)`, 404);
            last = await createDir(parentId, part, a.drive_id);
          }
          parentId = last.id;
        }
        return { created: true, ...sum(last!) };
      }
      if (!a.name) throw new DriveError('Give either path, or name with parent_id/parent_path', 400);
      const parentId = await resolveDirId({ id: a.parent_id, path: a.parent_path }, a.drive_id);
      return { created: true, ...sum(await createDir(parentId, a.name, a.drive_id)) };
    })
  );

  const conflict = z
    .enum(['error', 'rename', 'overwrite'])
    .default('error')
    .describe('If a file with this name exists: error (default), rename ("name (2).ext") or overwrite (new version)');

  server.registerTool(
    'upload_file',
    {
      title: 'Upload / create a file',
      description:
        'Create a file in the drive from a local file (local_path), from text (content) or from base64 bytes (content_base64).',
      inputSchema: {
        name: z.string().optional().describe('File name in the drive (default: basename of local_path)'),
        local_path: z.string().optional().describe('Absolute path of a local file inside the upload folder (TWAKE_DRIVE_UPLOAD_DIR)'),
        content: z.string().optional().describe('Text content (UTF-8)'),
        content_base64: z.string().optional().describe('Binary content, base64-encoded'),
        mime: z.string().optional().describe('MIME type (guessed from the extension by default)'),
        on_conflict: conflict,
        ...parentRef,
      },
      annotations: CREATE,
    },
    wrap(async (a: any) => {
      const name: string | undefined = a.name ?? (a.local_path ? basename(a.local_path) : undefined);
      if (!name) throw new DriveError('name is required when uploading content', 400);
      const bytes = await loadBytes(a, config.uploadDir);
      const dirId = await resolveDirId({ id: a.parent_id, path: a.parent_path }, a.drive_id);
      const { doc, action } = await uploadWithPolicy(dirId, name, bytes, a.mime ?? guessMime(name), a.on_conflict, a.drive_id);
      return { action, ...sum(doc, { driveId: a.drive_id }), size_human: humanSize(bytes.length) };
    })
  );

  server.registerTool(
    'update_file_content',
    {
      title: 'Replace file content',
      description: 'Replace the content of an existing file (the previous content is kept as an old version).',
      inputSchema: {
        ...itemRef,
        local_path: z.string().optional().describe('Absolute path of a local file inside the upload folder (TWAKE_DRIVE_UPLOAD_DIR)'),
        content: z.string().optional(),
        content_base64: z.string().optional(),
      },
      annotations: MODIFY,
    },
    wrap(async (a: any) => {
      requireRef(a, 'file');
      const meta = (await resolve(a, a.drive_id)).data;
      if (meta.attributes.type === 'directory') throw new DriveError('This is a folder', 400);
      const bytes = await loadBytes(a, config.uploadDir);
      const contentType = meta.attributes.mime ?? guessMime(meta.attributes.name);
      const file = { fileId: meta.id, name: meta.attributes.name, options: { contentType } };
      const { data: doc } = await files(a.drive_id).updateFile(bytes, file, { ifMatch: meta.meta?.rev, sanitizeName: false });
      return { updated: true, ...sum(doc, { driveId: a.drive_id }), size_human: humanSize(bytes.length) };
    })
  );

  server.registerTool(
    'create_document',
    {
      title: 'Create an office document',
      description:
        'Create an empty office document from the Twake Drive templates: text (.docx), sheet (.xlsx) or slide (.pptx). ' +
        'It opens in the online office editor from the returned url.',
      inputSchema: {
        kind: z.enum(['text', 'sheet', 'slide']),
        name: z.string().describe('Document name (extension added if missing)'),
        on_conflict: conflict,
        ...parentRef,
      },
      annotations: CREATE,
    },
    wrap(async (a: any) => {
      const tpl = { text: 'text.docx', sheet: 'sheet.xlsx', slide: 'slide.pptx' }[a.kind as 'text' | 'sheet' | 'slide'];
      const ext = tpl.split('.')[1];
      const name = withExtension(a.name, ext);
      const bytes = new Uint8Array(await readFile(join(TEMPLATES_DIR, tpl)));
      const dirId = await resolveDirId({ id: a.parent_id, path: a.parent_path }, a.drive_id);
      const { doc, action } = await uploadWithPolicy(dirId, name, bytes, guessMime(name), a.on_conflict, a.drive_id);
      return { action, ...sum(doc, { driveId: a.drive_id }) };
    })
  );

  server.registerTool(
    'create_note',
    {
      title: 'Create a note',
      description:
        'Create a Twake/Cozy note (collaborative rich-text document). Optional initial content in Markdown ' +
        '(headings, lists, bold, italic, links, code, quotes).',
      inputSchema: {
        title: z.string().describe('Note title (also the file name)'),
        markdown: z.string().optional().describe('Initial content in Markdown'),
        on_conflict: conflict,
        ...parentRef,
      },
      annotations: CREATE,
    },
    wrap(async (a: any) => {
      const dirId = await resolveDirId({ id: a.parent_id, path: a.parent_path }, a.drive_id);
      if (!a.markdown) {
        // NotesCollection.create() always sends an empty title.
        const { data: doc } = await stack.fetchJSON('POST', `${client.collection('io.cozy.notes', { driveId: a.drive_id }).prefix}/notes`, {
          data: { type: 'io.cozy.notes.documents', attributes: { title: a.title, dir_id: dirId, schema: NOTE_SCHEMA } },
        });
        return { action: 'created', ...sum(doc, { driveId: a.drive_id }) };
      }
      // A .cozy-note upload is turned back into a ProseMirror note by the stack (docs/notes.md).
      const name = withExtension(a.title, 'cozy-note');
      const { doc, action } = await uploadWithPolicy(
        dirId,
        name,
        new TextEncoder().encode(a.markdown),
        'text/vnd.cozy.note+markdown',
        a.on_conflict,
        a.drive_id
      );
      return { action, ...sum(doc, { driveId: a.drive_id }) };
    })
  );

  server.registerTool(
    'create_shortcut',
    {
      title: 'Create a web shortcut',
      description: 'Create a shortcut (.url file) to a web address in a folder.',
      inputSchema: {
        name: z.string(),
        url: z.string().url(),
        parent_id: parentRef.parent_id,
        parent_path: parentRef.parent_path,
      },
      annotations: CREATE,
    },
    wrap(async (a: { name: string; url: string; parent_id?: string; parent_path?: string }) => {
      const dirId = await resolveDirId({ id: a.parent_id, path: a.parent_path });
      const shortcut = { _type: 'io.cozy.files.shortcuts', name: withExtension(a.name, 'url'), url: a.url, dir_id: dirId };
      return { action: 'created', ...sum((await client.save(shortcut)).data) };
    })
  );

  server.registerTool(
    'create_drawing',
    {
      title: 'Create a drawing',
      description: 'Create an empty Excalidraw drawing (.excalidraw) that opens in the Twake Drive whiteboard.',
      inputSchema: { name: z.string(), on_conflict: conflict, ...parentRef },
      annotations: CREATE,
    },
    wrap(async (a: any) => {
      const name = withExtension(a.name, 'excalidraw');
      const scene = JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} });
      const dirId = await resolveDirId({ id: a.parent_id, path: a.parent_path }, a.drive_id);
      const { doc, action } = await uploadWithPolicy(
        dirId,
        name,
        new TextEncoder().encode(scene),
        'application/vnd.excalidraw+json',
        a.on_conflict,
        a.drive_id
      );
      return { action, ...sum(doc, { driveId: a.drive_id }) };
    })
  );

  // ======================= ORGANISE =======================

  server.registerTool(
    'rename_item',
    {
      title: 'Rename',
      description: 'Rename a file or a folder (keep the extension unless asked otherwise).',
      inputSchema: { ...itemRef, new_name: z.string().min(1) },
      annotations: MODIFY,
    },
    wrap(async (a: Ref & { new_name: string }) => {
      requireRef(a);
      const meta = (await resolve(a, a.drive_id)).data;
      return { renamed_from: meta.attributes.name, ...sum(await patch(meta.id,{ name: a.new_name }, a.drive_id)) };
    })
  );

  server.registerTool(
    'move_item',
    {
      title: 'Move',
      description: 'Move a file or folder into another folder of the same drive.',
      inputSchema: {
        ...itemRef,
        destination_id: z.string().optional().describe('Destination folder id'),
        destination_path: z.string().optional().describe('Destination folder absolute path ("/" for root)'),
      },
      annotations: MODIFY,
    },
    wrap(async (a: Ref & { destination_id?: string; destination_path?: string }) => {
      requireRef(a);
      if (!a.destination_id && !a.destination_path) throw new DriveError('Give destination_id or destination_path', 400);
      const meta = (await resolve(a, a.drive_id)).data;
      const dirId = await resolveDirId({ id: a.destination_id, path: a.destination_path }, a.drive_id);
      return { moved: true, ...sum(await patch(meta.id,{ dir_id: dirId }, a.drive_id)) };
    })
  );

  server.registerTool(
    'copy_file',
    {
      title: 'Copy a file',
      description: 'Copy a file, in the same folder (a copy suffix is added) or into another folder, optionally with a new name.',
      inputSchema: {
        ...itemRef,
        destination_id: z.string().optional(),
        destination_path: z.string().optional(),
        new_name: z.string().optional(),
      },
      annotations: CREATE,
    },
    wrap(async (a: Ref & { destination_id?: string; destination_path?: string; new_name?: string }) => {
      requireRef(a, 'file');
      const meta = (await resolve(a, a.drive_id)).data;
      if (meta.attributes.type === 'directory') throw new DriveError('Copying a folder is not supported by the API', 400);
      const dirId =
        a.destination_id || a.destination_path
          ? await resolveDirId({ id: a.destination_id, path: a.destination_path }, a.drive_id)
          : undefined;
      const { data: copy } = await files(a.drive_id).copy(meta.id, a.new_name, dirId, { sanitizeName: false });
      return { copied: true, ...sum(copy) };
    })
  );

  server.registerTool(
    'set_favorite',
    {
      title: 'Favourite',
      description: 'Mark or unmark a file or folder as favourite.',
      inputSchema: { ...itemRef, favorite: z.boolean().default(true) },
      annotations: MODIFY,
    },
    wrap(async (a: Ref & { favorite: boolean }) => {
      requireRef(a);
      const meta = (await resolve(a, a.drive_id)).data;
      const cozyMetadata = { ...(meta.attributes.cozyMetadata ?? {}), favorite: a.favorite };
      return sum(await patch(meta.id,{ cozyMetadata }, a.drive_id));
    })
  );

  server.registerTool(
    'set_tags',
    {
      title: 'Tags',
      description: 'Replace the tags of a file or folder (pass [] to clear).',
      inputSchema: { ...itemRef, tags: z.array(z.string()) },
      annotations: MODIFY,
    },
    wrap(async (a: Ref & { tags: string[] }) => {
      requireRef(a);
      const meta = (await resolve(a, a.drive_id)).data;
      return sum(await patch(meta.id,{ tags: a.tags }, a.drive_id));
    })
  );

  server.registerTool(
    'trash_item',
    {
      title: 'Move to trash',
      description: 'Move a file or folder to the trash (reversible with restore_from_trash).',
      inputSchema: itemRef,
      annotations: { ...MODIFY, destructiveHint: true },
    },
    wrap(async (a: Ref) => {
      requireRef(a);
      const meta = (await resolve(a, a.drive_id)).data;
      await files(a.drive_id).destroy({ _id: meta.id });
      return { trashed: true, id: meta.id, name: meta.attributes.name };
    })
  );

  server.registerTool(
    'restore_from_trash',
    {
      title: 'Restore from trash',
      description: 'Restore a trashed item to its original folder (id from list_trash).',
      inputSchema: { id: z.string() },
      annotations: MODIFY,
    },
    wrap(async (a: { id: string }) => ({ restored: true, ...sum((await files().restore(a.id)).data) }))
  );

  server.registerTool(
    'revert_version',
    {
      title: 'Restore an old version',
      description: 'Make an old version (version_id from get_item.old_versions) the current content of a file.',
      inputSchema: { id: z.string(), version_id: z.string() },
      annotations: MODIFY,
    },
    wrap(async (a: { id: string; version_id: string }) => {
      // cozy-client has no call for this route.
      const path = `${files().prefix}/revert/${encodeURIComponent(a.id)}/${encodeURIComponent(a.version_id)}`;
      return { reverted: true, ...sum((await stack.fetchJSON('POST', path)).data) };
    })
  );

  // ======================= SHARE LINKS =======================

  server.registerTool(
    'create_share_link',
    {
      title: 'Create a public link',
      description:
        'Create a public link to a file or folder: ANYONE with the link can open it (read-only by default). ' +
        'Optional password and expiry date. Confirm with the user before creating one.',
      inputSchema: {
        ...itemRef,
        write: z.boolean().default(false).describe('Allow editing through the link (default: read-only)'),
        password: z.string().min(4).optional(),
        expires_at: z.string().optional().describe('ISO date/time after which the link stops working'),
      },
      annotations: CREATE,
    },
    wrap(async (a: Ref & { write: boolean; password?: string; expires_at?: string }) => {
      requireRef(a);
      if (a.drive_id) throw new DriveError('Public links on shared-drive items are not supported by this tool', 400);
      const meta = (await resolve(a, undefined)).data;
      const expiresAt = a.expires_at ? new Date(a.expires_at).toISOString() : undefined;
      const { data: perm } = await client.save({
        _type: 'io.cozy.permissions',
        codes: 'email',
        permissions: { files: { type: FILES_DOCTYPE, verbs: a.write ? ['GET', 'POST', 'PUT', 'PATCH'] : ['GET'], values: [meta.id] } },
        ...(a.password ? { password: a.password } : {}),
        ...(expiresAt ? { expires_at: expiresAt } : {}),
      });
      return { item: sum(meta), link: linkSummary(perm, app) };
    })
  );

  server.registerTool(
    'revoke_share_link',
    {
      title: 'Revoke public links',
      description: 'Delete every public link that gives access to a file or folder.',
      inputSchema: itemRef,
      annotations: { ...MODIFY, destructiveHint: true },
    },
    wrap(async (a: Ref) => {
      requireRef(a);
      const meta = (await resolve(a, undefined)).data;
      const permissions = client.collection('io.cozy.permissions');
      const links: CozyDoc[] = (await permissions.fetchAllLinks({ _type: FILES_DOCTYPE })).data;
      const matching = links.filter((p) =>
        Object.values(p.attributes.permissions ?? {}).some((r: any) => (r.values ?? []).includes(meta.id))
      );
      for (const p of matching) await permissions.destroy(p);
      return { item: meta.attributes.name, revoked_links: matching.length };
    })
  );

  // ======================= PERMANENT DELETION =======================

  server.registerTool(
    'delete_permanently',
    {
      title: 'Delete permanently',
      description: 'Permanently destroy an item that is ALREADY in the trash. Irreversible.',
      inputSchema: { id: z.string() },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a: { id: string }) => {
      const meta: CozyDoc = (await stat(a.id)).data;
      const inTrash =
        meta.attributes.trashed === true ||
        meta.attributes.dir_id === TRASH_DIR_ID ||
        String(meta.attributes.path ?? '').startsWith('/.cozy_trash/');
      if (!inTrash) throw new DriveError('Only trashed items can be destroyed: use trash_item first', 400);
      await files().deleteFilePermanently(a.id);
      return { destroyed: true, id: a.id, name: meta.attributes.name };
    })
  );

  server.registerTool(
    'empty_trash',
    {
      title: 'Empty trash',
      description: 'Permanently destroy everything in the trash. Irreversible.',
      inputSchema: {},
      annotations: DESTRUCTIVE,
    },
    wrap(async () => {
      await files().emptyTrash();
      return { emptied: true };
    })
  );
}

export function linkSummary(p: CozyDoc, appUrl: string) {
  const a = p.attributes ?? {};
  const code = a.shortcodes?.email ?? a.shortcodes?.code ?? a.codes?.email ?? a.codes?.code;
  const rules = Object.values(a.permissions ?? {}) as Array<{ verbs?: string[]; values?: string[] }>;
  const verbs = rules.flatMap((r) => r.verbs ?? []);
  return {
    link_id: p.id,
    url: code ? `${appUrl}/public?sharecode=${encodeURIComponent(code)}` : undefined,
    file_ids: rules.flatMap((r) => r.values ?? []),
    rights: verbs.some((v) => v !== 'GET') ? 'edit' : 'read-only',
    password: a.password ? true : undefined,
    expires_at: a.expires_at,
    created_at: a.cozyMetadata?.createdAt,
  };
}
