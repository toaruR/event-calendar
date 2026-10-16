import { test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import * as cheerio from 'cheerio';
import ICAL from 'ical.js';

test('ajv 2020 compiles and validates', () => {
  const v = new Ajv2020.default({ strict: false }).compile({ type: 'string' });
  assert.equal(v('a'), true);
  assert.equal(v(1), false);
});

test('cheerio selects by css', () => {
  assert.equal(cheerio.load('<ul><li class=a>x</li></ul>')('.a').text(), 'x');
});

test('ical.js parses VEVENT', () => {
  const s = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260101T000000Z\r\nSUMMARY:s\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const comp = new ICAL.Component(ICAL.parse(s));
  const ev = new ICAL.Event(comp.getFirstSubcomponent("vevent") as InstanceType<typeof ICAL.Component>);
  assert.equal(ev.summary, 's');
});
