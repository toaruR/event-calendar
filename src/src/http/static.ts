import { readFileSync, statSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../errors.ts';
import type { RouteResult } from './server.ts';

const GUI_ROOT = resolve(fileURLToPath(new URL('../../gui/', import.meta.url)));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function isStaticPath(path: string): boolean {
  return path === '/' || path.startsWith('/gui/');
}

export interface GuiSettings { weekStart?: string }

/** Serve GET / (index.html with the gui_token and GUI settings embedded) and GET /gui/* (files under gui/ only). */
export function serveStatic(rawPath: string, token: string, gui: GuiSettings = {}): RouteResult {
  let rel: string;
  try { rel = rawPath === '/' ? 'index.html' : decodeURIComponent(rawPath.slice('/gui/'.length)); } catch {
    throw new AppError('INVALID_ARGUMENT', 'bad path encoding', {});
  }
  if (rel.includes(String.fromCharCode(0)) || rel.includes(String.fromCharCode(92)) || rel.split('/').some((s) => s === '..')) {
    throw new AppError('INVALID_ARGUMENT', 'path traversal rejected', {});
  }
  const file = resolve(GUI_ROOT, rel);
  if (!file.startsWith(GUI_ROOT + sep)) throw new AppError('INVALID_ARGUMENT', 'path traversal rejected', {});
  let isFile: boolean;
  try { isFile = statSync(file).isFile(); } catch { isFile = false; }
  if (!isFile) throw new AppError('NOT_FOUND', `no such file: ${rawPath}`, { path: rawPath });
  let text = readFileSync(file, 'utf8');
  if (rel === 'index.html') {
    text = text.replaceAll('<meta name="gui-token" content="">', `<meta name="gui-token" content="${token}">`);
    const ws = gui.weekStart === 'monday' ? 'monday' : 'sunday';
    text = text.replaceAll('<meta name="week-start" content="">', `<meta name="week-start" content="${ws}">`);
  }
  return { raw: text, headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' } };
}
