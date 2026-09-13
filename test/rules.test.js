'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { NUMBER_FIELDS, validateRuleSet, sameRuleSet } = require('../public/rules.js');

const VALID_INPUT = {
  allowedRelations: ['synonym', 'antonym'],
  minReasonLen: '4',
  turnSeconds: '90',
  apPerTurn: '3',
  rounds: '4',
  challengeTokens: '3',
};

test('合法输入通过校验，数值字段解析为整数', () => {
  const { errors, ruleSet } = validateRuleSet(VALID_INPUT);
  assert.deepStrictEqual(errors, {});
  assert.deepStrictEqual(ruleSet, {
    allowedRelations: ['synonym', 'antonym'],
    minReasonLen: 4,
    turnSeconds: 90,
    apPerTurn: 3,
    rounds: 4,
    challengeTokens: 3,
  });
});

test('关系类型至少选择一种', () => {
  const { errors } = validateRuleSet({ ...VALID_INPUT, allowedRelations: [] });
  assert.match(errors.allowedRelations, /至少/);
  const missing = validateRuleSet({ ...VALID_INPUT, allowedRelations: undefined });
  assert.match(missing.errors.allowedRelations, /至少/);
});

test('空值、非数字、小数都报字段错误', () => {
  for (const bad of ['', 'abc', '1.5', ' ']) {
    const { errors, ruleSet } = validateRuleSet({ ...VALID_INPUT, turnSeconds: bad });
    assert.match(errors.turnSeconds, /30~300/, `输入 ${JSON.stringify(bad)} 应报错`);
    assert.strictEqual(ruleSet.turnSeconds, undefined, '非法值不应进入结果');
  }
});

test('超出范围的值按字段边界报错', () => {
  const { errors } = validateRuleSet({
    ...VALID_INPUT,
    minReasonLen: '51',
    turnSeconds: '29',
    apPerTurn: '0',
    rounds: '11',
    challengeTokens: '10',
  });
  assert.match(errors.minReasonLen, /0~50/);
  assert.match(errors.turnSeconds, /30~300/);
  assert.match(errors.apPerTurn, /1~6/);
  assert.match(errors.rounds, /1~10/);
  assert.match(errors.challengeTokens, /0~9/);
});

test('边界值本身合法', () => {
  const { errors } = validateRuleSet({
    ...VALID_INPUT,
    minReasonLen: '0',
    turnSeconds: '300',
    apPerTurn: '1',
    rounds: '10',
    challengeTokens: '0',
  });
  assert.deepStrictEqual(errors, {});
});

test('数值字段范围与服务端 clamp 范围一致', () => {
  // 与 game.js 中 setRuleSet 的 clamp 范围对齐，防止前后端校验口径漂移
  const g = require('../game');
  const room = g.newRoom('T', 'h', '房主');
  g.addPlayer(room, 'h', '房主');
  for (const f of NUMBER_FIELDS) {
    g.setRuleSet(room, 'h', { [f.key]: f.min - 1 });
    assert.strictEqual(room.ruleSet[f.key], f.min, `${f.key} 下界应一致`);
    g.setRuleSet(room, 'h', { [f.key]: f.max + 1 });
    assert.strictEqual(room.ruleSet[f.key], f.max, `${f.key} 上界应一致`);
  }
});

test('sameRuleSet 检测规则变化', () => {
  const a = { turnSeconds: 90, allowedRelations: ['synonym'] };
  assert.strictEqual(sameRuleSet(a, { ...a }), true);
  assert.strictEqual(sameRuleSet(a, { ...a, turnSeconds: 60 }), false);
  assert.strictEqual(sameRuleSet(a, { ...a, allowedRelations: ['antonym'] }), false);
});
