import test from 'node:test';
import assert from 'node:assert/strict';

import { flattenProgram, parseGrid, runProgram } from '../src/engine/interpreter.js';
import { levels as world1 } from '../src/game/levels/world1.js';
import { levels as world2 } from '../src/game/levels/world2.js';
import { levels as world3 } from '../src/game/levels/world3.js';
import { levels as world4 } from '../src/game/levels/world4.js';
import { levels as world5 } from '../src/game/levels/world5.js';

const allLevels = [...world1, ...world2, ...world3, ...world4, ...world5];

test('all authored solutions win and collect every star', () => {
  for (const level of allLevels) {
    const result = runProgram(parseGrid(level.grid), level.solution);
    assert.equal(result.win, true, `${level.id} should win`);
    assert.equal(result.starsGot, 3, `${level.id} should collect three stars`);
    assert.ok(level.solution.main.length <= level.allowed.maxMain, `${level.id} should fit its main-program limit`);
  }
});

test('an empty program fails without moving', () => {
  const parsed = parseGrid(world1[0].grid);
  const result = runProgram(parsed, { main: [], functions: [], conditions: [] });
  assert.equal(result.win, false);
  assert.equal(result.reason, 'out-of-commands');
  assert.equal(result.steps.filter((step) => step.type === 'move').length, 0);
});

test('loops and function calls flatten in execution order', () => {
  const R = { t: 'dir', d: 'R' };
  const D = { t: 'dir', d: 'D' };
  const flat = flattenProgram([
    { t: 'loop', n: 2, body: [R, D] },
    { t: 'call', f: 0 },
  ], [[D, R]]);
  assert.deepEqual(flat.map((command) => command.d), ['R', 'D', 'R', 'D', 'D', 'R']);
});

test('color conditions redirect movement', () => {
  const level = world2[0];
  const result = runProgram(parseGrid(level.grid), level.solution);
  assert.equal(result.win, true);
  assert.equal(result.counts.condFires, 1);
  assert.ok(result.steps.some((step) => step.type === 'turn' && step.color === 'p' && step.d === 'D'));
});

test('every level has a unique id and a valid three-star par solution', () => {
  assert.equal(new Set(allLevels.map((level) => level.id)).size, allLevels.length);
  for (const level of allLevels) {
    assert.equal(level.parCommands, level.solution.main.length, `${level.id} par should match the authored solution`);
    assert.equal(parseGrid(level.grid).stars.length, 3, `${level.id} should contain three stars`);
  }
});
