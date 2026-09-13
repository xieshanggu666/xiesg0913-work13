'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { findNewOpponentWords, createTipQueue } = require('../public/tips.js');

test('起始词不会被误认为对手接的词', () => {
  const prev = []; // 大厅阶段盘面为空
  const cur = [
    { id: 'start0', word: '火', ownerId: null },
    { id: 'start1', word: '海', ownerId: null },
    { id: 'start2', word: '桥', ownerId: null },
  ];
  assert.deepStrictEqual(findNewOpponentWords(prev, cur, 'me'), []);
});

test('只认对手新接的词，自己的和中立的都不算', () => {
  const prev = [{ id: 'start0', word: '火', ownerId: null }];
  const cur = [
    ...prev,
    { id: 'w1', word: '火焰', ownerId: 'me' },
    { id: 'w2', word: '海水', ownerId: 'opp' },
  ];
  const found = findNewOpponentWords(prev, cur, 'me');
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].word, '海水');
});

test('级联拆除后词数变化不会产生误报', () => {
  const prev = [
    { id: 'w1', word: 'a', ownerId: 'opp' },
    { id: 'w2', word: 'b', ownerId: 'opp' },
    { id: 'w3', word: 'c', ownerId: 'me' },
  ];
  const cur = [{ id: 'w3', word: 'c', ownerId: 'me' }]; // 对手词被拆除
  assert.deepStrictEqual(findNewOpponentWords(prev, cur, 'me'), []);
});

function makeQueue() {
  const seen = new Set();
  const shown = [];
  const q = createTipQueue({
    isSeen: (k) => seen.has(k),
    markSeen: (k) => seen.add(k),
    show: (t) => shown.push(t),
    hide: () => {},
  });
  return { q, seen, shown };
}

test('多条提示排队展示，不互相覆盖', () => {
  const { q, shown } = makeQueue();
  q.push('a', '第一条');
  q.push('b', '第二条');
  q.push('c', '第三条');
  assert.deepStrictEqual(shown, ['第一条'], '一次只展示一条');
  assert.strictEqual(q.pending(), 2);
  q.dismiss();
  assert.deepStrictEqual(shown, ['第一条', '第二条']);
  q.dismiss();
  assert.deepStrictEqual(shown, ['第一条', '第二条', '第三条']);
});

test('展示时不记已读，关闭才记录', () => {
  const { q, seen } = makeQueue();
  q.push('a', '第一条');
  assert.strictEqual(seen.size, 0, '仅展示不应标记已读');
  q.dismiss();
  assert.ok(seen.has('a'), '关闭后才标记已读');
});

test('已读的提示不再出现，队列内不重复', () => {
  const { q, seen, shown } = makeQueue();
  seen.add('x');
  assert.strictEqual(q.push('x', '旧提示'), false);
  assert.strictEqual(shown.length, 0);
  q.push('y', '新提示');
  assert.strictEqual(q.push('y', '新提示'), false, '队列中不重复');
  q.dismiss();
  assert.strictEqual(q.push('y', '新提示'), false, '已读后不再出现');
});
