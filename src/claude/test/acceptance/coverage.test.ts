import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PREFIX = '§10-T';
const TESTS_ROOT = path.resolve(import.meta.dirname, '..');
const SELF = path.resolve(import.meta.filename);

function walk(dir: string, out: string[]): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

// test( / it( の直後のクォート文字列が PREFIX で始まる箇所から番号を収集
export function collectNumbers(src: string): number[] {
  const nums: number[] = [];
  for (const call of ['test(', 'it(']) {
    let from = 0;
    for (;;) {
      const idx = src.indexOf(call, from);
      if (idx < 0) break;
      from = idx + call.length;
      const before = idx > 0 ? src[idx - 1] : ' ';
      if (/[A-Za-z0-9_.$]/.test(before)) continue; // e.g. latest(, foo.test(
      let j = from;
      while (src[j] === ' ' || src[j] === '\n' || src[j] === '\r' || src[j] === '\t') j++;
      const q = src[j];
      if (q !== "'" && q !== '"' && q !== '`') continue;
      j++;
      if (!src.startsWith(PREFIX, j)) continue;
      j += PREFIX.length;
      let k = j;
      while (k < src.length && src[k] >= '0' && src[k] <= '9') k++;
      if (k > j) nums.push(Number(src.slice(j, k)));
    }
  }
  return nums;
}

export function missingNumbers(found: Iterable<number>, max = 27): number[] {
  const set = new Set(found);
  const missing: number[] = [];
  for (let n = 1; n <= max; n++) if (!set.has(n)) missing.push(n);
  return missing;
}

test('coverage: §10 T1..T27 全シナリオのテスト名が存在する', () => {
  const files = walk(TESTS_ROOT, []).filter((f) => path.resolve(f) !== SELF);
  const found = new Set<number>();
  for (const f of files) for (const n of collectNumbers(fs.readFileSync(f, 'utf8'))) found.add(n);
  const sorted = [...found].sort((a, b) => a - b);
  assert.deepEqual(missingNumbers(found), []);
  assert.equal(found.size, 27);
  assert.deepEqual(sorted, Array.from({ length: 27 }, (_, i) => i + 1));
});

test('coverage: n=5 を除くと欠落配列が [5] (純関数)', () => {
  const all = Array.from({ length: 27 }, (_, i) => i + 1);
  assert.deepEqual(missingNumbers(all), []);
  assert.deepEqual(missingNumbers(all.filter((n) => n !== 5)), [5]);
  assert.deepEqual(collectNumbers("test('§10-T5 x', () => {}); it(\"§10-T12\", f)"), [5, 12]);
});
