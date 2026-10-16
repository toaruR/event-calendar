function isControl(c: number): boolean {
  return c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029;
}
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const PHONE = /(?<![\d])\+?\d{1,4}(?:[-\s().]?\d{1,4}){2,4}(?![\d])/g;

/** Remove control characters (CR/LF/NUL etc.), replacing runs with a single space; trims. */
export function stripControl(s: string): string {
  let out = '';
  let inRun = false;
  for (const ch of s) {
    if (isControl(ch.codePointAt(0)!)) {
      if (!inRun) out += ' ';
      inRun = true;
    } else {
      out += ch;
      inRun = false;
    }
  }
  return out.trim();
}

export function redactContactText(s: string): string {
  return s.replace(EMAIL, '').replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 9 ? '' : m));
}

export function sanitizeText(s: string, redactContact: boolean): string {
  let out = stripControl(s);
  if (redactContact) out = redactContactText(out).replace(/ {2,}/g, ' ').trim();
  return out;
}
