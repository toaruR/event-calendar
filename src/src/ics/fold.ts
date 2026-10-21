const enc = new TextEncoder();

/**
 * RFC 5545 3.1 line folding: each physical line is at most 75 octets (UTF-8, excluding CRLF);
 * continuation lines start with one SP. Never splits a code point.
 * Returns the folded text joined with CRLF (no trailing CRLF).
 */
export function foldLine(line: string): string {
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (curBytes + n > limit) {
      out.push(cur);
      cur = ' ';
      curBytes = 1;
      limit = 75;
    }
    cur += ch;
    curBytes += n;
  }
  out.push(cur);
  return out.join('\r\n');
}

/** Inverse of foldLine (CRLF + SP/HT removal). */
export function unfold(text: string): string {
  return text.replace(/\r\n[ \t]/g, '');
}
