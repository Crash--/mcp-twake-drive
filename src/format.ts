import { extname } from 'node:path';
import type { CozyDoc } from './drive.js';

export interface ItemSummary {
  id: string;
  name: string;
  type: 'file' | 'directory';
  path?: string;
  dir_id?: string;
  size?: number;
  mime?: string;
  class?: string;
  created_at?: string;
  updated_at?: string;
  favorite?: boolean;
  tags?: string[];
  trashed?: boolean;
  shared_drive_id?: string;
  url?: string;
}

/** Compact, AI-friendly view of an io.cozy.files document. */
export function summarize(doc: CozyDoc, appUrl: string, extra: { dirPath?: string; driveId?: string } = {}): ItemSummary {
  const a = doc.attributes ?? {};
  const type = a.type === 'directory' ? 'directory' : 'file';
  const path =
    a.path ?? (extra.dirPath ? `${extra.dirPath === '/' ? '' : extra.dirPath}/${a.name}` : undefined);
  const out: ItemSummary = { id: doc.id, name: a.name, type };
  if (path) out.path = path;
  if (a.dir_id) out.dir_id = a.dir_id;
  if (type === 'file') {
    if (a.size !== undefined) out.size = Number(a.size);
    if (a.mime) out.mime = a.mime;
    if (a.class) out.class = a.class;
  }
  if (a.created_at) out.created_at = a.created_at;
  if (a.updated_at) out.updated_at = a.updated_at;
  if (a.cozyMetadata?.favorite) out.favorite = true;
  if (Array.isArray(a.tags) && a.tags.length) out.tags = a.tags;
  if (a.trashed) out.trashed = true;
  if (extra.driveId) out.shared_drive_id = extra.driveId;
  out.url = webUrl(doc, appUrl);
  return out;
}

export function webUrl(doc: CozyDoc, appUrl: string): string {
  const a = doc.attributes ?? {};
  if (a.type === 'directory') return `${appUrl}/#/folder/${doc.id}`;
  return `${appUrl}/#/folder/${a.dir_id ?? 'io.cozy.files.root-dir'}/file/${doc.id}`;
}

export function humanSize(bytes?: number): string | undefined {
  if (bytes === undefined || Number.isNaN(bytes)) return undefined;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.cozy-note': 'text/vnd.cozy.note+markdown',
  '.excalidraw': 'application/vnd.excalidraw+json',
};

export function guessMime(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

const TEXT_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-yaml',
  'application/yaml',
  'application/vnd.excalidraw+json',
  'text/vnd.cozy.note+markdown',
]);

export function isTextLike(mime: string | undefined, name: string): boolean {
  const m = (mime ?? '').split(';')[0].trim().toLowerCase();
  if (m.startsWith('text/') || TEXT_MIMES.has(m)) return true;
  return ['.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml', '.html', '.cozy-note', '.excalidraw', '.log'].includes(
    extname(name).toLowerCase()
  );
}

/** A note with images is stored as a tar archive (index.md + images). */
export function isTar(bytes: Uint8Array): boolean {
  if (bytes.length < 262) return false;
  return new TextDecoder().decode(bytes.slice(257, 262)) === 'ustar';
}

/** Extract `index.md` from a (uncompressed, POSIX) tar archive. */
export function markdownFromTar(bytes: Uint8Array): string | undefined {
  let offset = 0;
  const dec = new TextDecoder();
  while (offset + 512 <= bytes.length) {
    const header = bytes.slice(offset, offset + 512);
    const name = dec.decode(header.slice(0, 100)).replace(/\0.*$/s, '');
    if (!name) return undefined;
    const size = parseInt(dec.decode(header.slice(124, 136)).replace(/\0.*$/s, '').trim() || '0', 8);
    const start = offset + 512;
    if (name === 'index.md' || name.endsWith('/index.md')) return dec.decode(bytes.slice(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

/** `report.pdf` -> `report (2).pdf` */
export function variantName(name: string, n: number): string {
  const ext = extname(name);
  const base = ext && ext !== name ? name.slice(0, -ext.length) : name;
  return `${base} (${n})${ext && ext !== name ? ext : ''}`;
}

export function withExtension(name: string, ext: string): string {
  const trimmed = name.trim() || 'Sans titre';
  return trimmed.toLowerCase().endsWith(`.${ext}`) ? trimmed : `${trimmed}.${ext}`;
}
