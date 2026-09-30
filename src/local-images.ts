/**
 * local-images.ts: the images a reply points at on this computer. A phone
 * cannot open a local path, so a reply like "![screenshot](/Users/me/shot.png)"
 * showed nothing there (2026-09-29: a Codex user asked for a desktop
 * screenshot twice and never saw it). Only the agent can read the file, so it
 * sends each one as the image_chunk frame a Claude tool-result image already
 * uses, which the server and every iOS build render.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Sent as is up to this size; larger files are re-encoded on macOS and skipped elsewhere. */
export const PHONE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
};

export interface LocalImageRef {
  /** The whole markdown image or link, as written. */
  markdown: string;
  alt: string;
  path: string;
}

/** Markdown images and links in `text` whose target is an absolute path (or ~/, or file://) to an image file. */
export function localImageRefs(text: string): LocalImageRef[] {
  const refs: LocalImageRef[] = [];
  for (const m of text.matchAll(/!?\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^)\s]+))\s*\)/g)) {
    let target = (m[2] ?? m[3] ?? '').trim();
    if (target.startsWith('file://')) {
      try { target = decodeURI(target.slice('file://'.length)); } catch { continue; } // malformed %-escape
    }
    if (target.startsWith('~/')) target = path.join(os.homedir(), target.slice(2));
    const ext = path.extname(target).slice(1).toLowerCase();
    if (!path.isAbsolute(target) || !MIME[ext]) continue;
    refs.push({ markdown: m[0], alt: m[1].trim(), path: target });
  }
  return refs;
}

/** The file as an image a phone can take, or null when it is missing or too big to send. */
export function readImageForPhone(filePath: string): { mimeType: string; data: string } | null {
  let size: number;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return null;
    size = st.size;
  } catch {
    return null;
  }
  const mimeType = MIME[path.extname(filePath).slice(1).toLowerCase()];
  if (!mimeType) return null;
  if (size <= PHONE_IMAGE_MAX_BYTES) {
    try {
      const data = fs.readFileSync(filePath);
      // A file can grow or become unreadable between stat and read. Neither
      // should prevent the completed turn's text from reaching the phone.
      return data.length <= PHONE_IMAGE_MAX_BYTES ? { mimeType, data: data.toString('base64') } : null;
    } catch {
      return null;
    }
  }
  if (process.platform !== 'darwin') return null;
  // A full-resolution Retina screenshot: a 2048px JPEG is plenty for a phone.
  const out = path.join(os.tmpdir(), `vibekit-image-${process.pid}-${Date.now()}.jpg`);
  try {
    execFileSync('sips', ['-Z', '2048', '-s', 'format', 'jpeg', filePath, '--out', out], { stdio: 'ignore', timeout: 15_000 });
    const data = fs.readFileSync(out);
    return data.length <= PHONE_IMAGE_MAX_BYTES ? { mimeType: 'image/jpeg', data: data.toString('base64') } : null;
  } catch {
    return null;
  } finally {
    try { fs.rmSync(out, { force: true }); } catch { /* Cleanup must not discard the final reply. */ }
  }
}
