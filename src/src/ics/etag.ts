import { createHash } from 'node:crypto';

/** Strong ETag derived from the content hash (quoted per RFC 9110). */
export function computeEtag(body: string): string {
  return '"' + createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 32) + '"';
}
