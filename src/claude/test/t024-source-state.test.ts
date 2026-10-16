import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../src/clock.ts';
import { applyRunOutcome, disableSource, enableSource, getSourceState, resumeSource } from '../src/jobs/source-state.ts';
import { setupDb } from './helpers/run-helpers.ts';

const fresh = () => setupDb().db;

test('§10-T12: 3 failures -> degraded, success -> active with failures 0', () => {
  const db = fresh();
  applyRunOutcome(db, 's1', 'failed'); applyRunOutcome(db, 's1', 'failed');
  assert.equal(getSourceState(db, 's1').state, 'active');
  applyRunOutcome(db, 's1', 'failed');
  assert.equal(getSourceState(db, 's1').state, 'degraded');
  applyRunOutcome(db, 's1', 'ok');
  const s = getSourceState(db, 's1');
  assert.equal(s.state, 'active'); assert.equal(s.consecutive_failures, 0);
});

test('§10-T12: 10 failures -> quarantined, no auto recovery, resumeSource only', () => {
  const db = fresh(); const clock = new FakeClock(0);
  for (let i = 0; i < 10; i++) applyRunOutcome(db, 's1', 'failed');
  assert.equal(getSourceState(db, 's1').state, 'quarantined');
  clock.advance(30 * 86400 * 1000);
  applyRunOutcome(db, 's1', 'ok'); applyRunOutcome(db, 's1', 'not_modified');
  assert.equal(getSourceState(db, 's1').state, 'quarantined');
  resumeSource(db, 's1');
  assert.equal(getSourceState(db, 's1').state, 'active');
});

test('blocked_robots and login/CAPTCHA quarantine immediately', () => {
  for (const o of ['blocked_robots', 'login_or_captcha'] as const) {
    const db = fresh();
    applyRunOutcome(db, 's1', o);
    assert.equal(getSourceState(db, 's1').state, 'quarantined');
  }
});

test('enable/disable semantics and zero_item_streak', () => {
  const db = fresh();
  disableSource(db, 's1');
  assert.equal(getSourceState(db, 's1').state, 'disabled');
  applyRunOutcome(db, 's1', 'ok');
  assert.equal(getSourceState(db, 's1').state, 'disabled');
  enableSource(db, 's1');
  assert.equal(getSourceState(db, 's1').state, 'active');
  applyRunOutcome(db, 's1', 'blocked_robots');
  enableSource(db, 's1');
  assert.equal(getSourceState(db, 's1').state, 'quarantined');
  resumeSource(db, 's1');
  assert.equal(getSourceState(db, 's1').state, 'active');
  for (let i = 0; i < 3; i++) applyRunOutcome(db, 's1', 'ok', { itemsFound: 0 });
  const s = getSourceState(db, 's1');
  assert.equal(s.zero_item_streak, 3); assert.equal(s.state, 'degraded');
  applyRunOutcome(db, 's1', 'ok', { itemsFound: 5 });
  assert.equal(getSourceState(db, 's1').state, 'active');
});
