import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {lintDeck, validateDeck, validateDeckReport} from '../web/src/model.js';

const deck = JSON.parse(fs.readFileSync(new URL('../web/examples/minimal.livedeck.json', import.meta.url)));

test('stable slide ids, speaker notes and command expectations are optional v1 fields', () => {
  const edited = structuredClone(deck);
  edited.slides[0].id = 'opening';
  edited.slides[0].speakerNotes = '先说明今天要验证的目标。';
  edited.terminals['shell-a'].commands[0].expect = '输出当前工作目录。';
  assert.equal(validateDeck(edited).slides[0].id, 'opening');
  assert.equal(validateDeck(edited).terminals['shell-a'].commands[0].expect, '输出当前工作目录。');
});

test('validation reports expose JSON pointers while preserving existing throw semantics', () => {
  const broken = structuredClone(deck);
  broken.slides[1].terminal = 'missing';
  assert.throws(() => validateDeck(broken), /未定义终端/);
  const report = validateDeckReport(broken);
  assert.equal(report.valid, false);
  assert.equal(report.issues[0].code, 'TERMINAL_REFERENCE_INVALID');
  assert.equal(report.issues[0].path, '/slides/1/terminal');

  const duplicate = structuredClone(deck);
  duplicate.slides[0].id = 'same';
  duplicate.slides[1].id = 'same';
  const duplicateReport = validateDeckReport(duplicate);
  assert.equal(duplicateReport.valid, false);
  assert.equal(duplicateReport.issues[0].path, '/slides/1/id');
});

test('structure lint reports unknown fields and missing stable slide ids without blocking playback', () => {
  const edited = structuredClone(deck);
  delete edited.slides[0].id;
  edited.slides[0].typo = true;
  edited.terminals['shell-a'].commands[0].unexpected = 'ignored';
  const warnings = lintDeck(edited);
  assert.ok(warnings.some(issue => issue.code === 'UNKNOWN_FIELD' && issue.path === '/slides/0/typo'));
  assert.ok(warnings.some(issue => issue.code === 'UNKNOWN_FIELD' && issue.path === '/terminals/shell-a/commands/0/unexpected'));
  assert.ok(warnings.some(issue => issue.code === 'SLIDE_ID_MISSING' && issue.path === '/slides/0'));
  assert.equal(validateDeckReport(edited).valid, true);
});
