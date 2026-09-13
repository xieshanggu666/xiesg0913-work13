'use strict';
// 战术练习纯逻辑测试：三个固定局面的操作、计分、级联与评估
const test = require('node:test');
const assert = require('node:assert');
const P = require('../public/practice.js');
const game = require('../game.js');

const find = (s, id) => s.nodes.find(n => n.id === id);

// 用 game.js 在相同节点上结算，验证练习模块的计分与核心规则一致
function gameScore(nodes, playerId) {
  const room = {
    nodes: JSON.parse(JSON.stringify(nodes)),
    players: [
      { id: 'p1', name: '甲', color: '#2e86de' },
      { id: 'p2', name: '乙', color: '#e0533d' },
    ],
  };
  return game.computeScores(room).find(s => s.playerId === playerId).total;
}

test('第 1 关：候选词按顺序解锁，最优接法通关，次优接法不通关', () => {
  // 前置词没上场时，「星」不能直接接
  const locked = P.startSession('extend-chain');
  assert.strictEqual(P.playWord(locked, 'm-xing'), '要先接上它前面的词');

  // 最优：夜 → 星（沿最长链接长）
  const s = P.startSession('extend-chain');
  assert.strictEqual(P.playWord(s, 'm-ye'), null);
  assert.strictEqual(s.apLeft, 1);
  assert.strictEqual(P.playWord(s, 'm-xing'), null);
  assert.strictEqual(s.apLeft, 0);
  assert.strictEqual(P.playWord(s, 'm-lang'), '行动点不足');
  const r = P.submit(s);
  assert.strictEqual(r.passed, true);
  assert.strictEqual(r.scores.you.before, 7);
  assert.strictEqual(r.scores.you.after, 18);
  assert.ok(r.lines.some(l => l.includes('通关')));
  // 提交后锁定，不能继续操作
  assert.strictEqual(P.playWord(s, 'm-lang'), '已提交答案，请先重置');

  // 次优：从另一个起始词旁开短链 + 只延长一节
  const s2 = P.startSession('extend-chain');
  P.playWord(s2, 'm-lang');
  P.playWord(s2, 'm-ye');
  const r2 = P.submit(s2);
  assert.strictEqual(r2.passed, false);
  assert.strictEqual(r2.scores.you.after, 13);
  assert.ok(r2.lines.some(l => l.includes('还没到最优')));
});

test('第 1 关：同一候选词不能重复接，重置恢复初始局面', () => {
  const s = P.startSession('extend-chain');
  P.playWord(s, 'm-ye');
  assert.strictEqual(P.playWord(s, 'm-ye'), '这个词已经接上场了');
  P.resetSession(s);
  assert.strictEqual(s.apLeft, 2);
  assert.strictEqual(s.nodes.length, 4);
  assert.strictEqual(s.finished, false);
  assert.strictEqual(s.actions.length, 0);
  // 重置后重新走最优可通关
  P.playWord(s, 'm-ye');
  P.playWord(s, 'm-xing');
  assert.strictEqual(P.submit(s).passed, true);
});

test('第 2 关：只有加固关键连接「光」能把最坏损失降到最小', () => {
  // 失分以加固前总分（14）为基准，与解释面板"你的总分 14 → X"口径一致
  const outcomes = { none: 14, guang: 6, deng: 7, ye: 11, ying: 11 };
  for (const [rid, loss] of Object.entries(outcomes)) {
    const s = P.startSession('protect-link');
    if (rid !== 'none') P.reinforce(s, rid);
    const r = P.submit(s);
    assert.strictEqual(r.passed, rid === 'guang', `方案 ${rid}`);
    assert.strictEqual(r.scores.you.before - r.scores.you.after, loss, `方案 ${rid} 失分`);
    // 解释里要能看到对手各候选目标的得失与全部防守方案对比
    assert.ok(r.lines.some(l => l.includes('对手选它')));
    assert.ok(r.lines.some(l => l.includes('最优')));
  }
});

test('第 2 关：加固只能用在自己的未加固连接上，且只有一次', () => {
  const s = P.startSession('protect-link');
  assert.strictEqual(P.reinforce(s, 's0'), '起始词无需加固');
  assert.strictEqual(P.reinforce(s, 'opp-chuan'), '只能加固自己的词');
  assert.strictEqual(P.reinforce(s, 'guang'), null);
  assert.strictEqual(P.reinforce(s, 'deng'), '行动点不足');
  assert.strictEqual(find(s, 'guang').reinforced, true);
  // 重置后加固标记消失
  P.resetSession(s);
  assert.strictEqual(find(s, 'guang').reinforced, false);
});

test('第 3 关：质疑靠近根的「浪」拆除最多，选深层词不通关', () => {
  const expected = { lang: 15, chuan: 5, chonglang: 5, ban: 3 };
  for (const [cid, loss] of Object.entries(expected)) {
    const s = P.startSession('cascade-teardown');
    assert.strictEqual(P.selectChallenge(s, cid), null);
    assert.strictEqual(s.pendingChallengeId, cid);
    const r = P.submit(s);
    assert.strictEqual(r.passed, cid === 'lang', `目标 ${cid}`);
    assert.strictEqual(r.scores.opp.before - r.scores.opp.after, loss, `目标 ${cid} 失分`);
  }
  // 最优方案：拆掉 4 个词、失 15 分
  const best = P.startSession('cascade-teardown');
  P.selectChallenge(best, 'lang');
  const br = P.submit(best);
  assert.deepStrictEqual(br.removed.map(n => n.word), ['浪', '船', '冲浪', '冲浪板']);
  assert.ok(br.lines.some(l => l.includes('各质疑目标的效果')));
});

test('第 3 关：加固词「帆」免疫质疑且会成为幸存根截断级联', () => {
  const s = P.startSession('cascade-teardown');
  assert.strictEqual(P.selectChallenge(s, 'fan'), '加固过的连接免疫质疑');
  assert.strictEqual(P.selectChallenge(s, 'matou'), '只能质疑对手接出的词');
  // 再点一次取消选择；不选直接提交报错
  P.selectChallenge(s, 'lang');
  P.selectChallenge(s, 'lang');
  assert.strictEqual(s.pendingChallengeId, null);
  assert.strictEqual(P.submit(s), '先点击选择要质疑的词');

  // 质疑「浪」：拆掉浪/船/冲浪/冲浪板，加固的帆成为新根保留下来
  P.selectChallenge(s, 'lang');
  const r = P.submit(s);
  assert.deepStrictEqual(r.removed.map(n => n.word), ['浪', '船', '冲浪', '冲浪板']);
  const fan = find(s, 'fan');
  assert.ok(fan && fan.survivedAsRoot && fan.parentId === null);
  assert.ok(r.lines.some(l => l.includes('截断了级联')));
});

test('练习模块计分与 game.js 核心规则一致（初始局面与级联后局面）', () => {
  for (const id of ['extend-chain', 'protect-link', 'cascade-teardown']) {
    const sc = P.SCENARIOS.find(x => x.id === id);
    assert.strictEqual(P.scoreBreakdown(sc.nodes, 'p1').total, gameScore(sc.nodes, 'p1'), `${id} 你`);
    assert.strictEqual(P.scoreBreakdown(sc.nodes, 'p2').total, gameScore(sc.nodes, 'p2'), `${id} 对手`);
  }
  // 级联结果也一致：以第 3 关质疑「浪」后的盘面，用 game.cascadeRemove 复算
  const sc = P.SCENARIOS.find(x => x.id === 'cascade-teardown');
  const room = { nodes: JSON.parse(JSON.stringify(sc.nodes)) };
  const removedGame = [];
  game.cascadeRemove(room, 'lang', removedGame);
  const practice = P.applyChallenge(sc.nodes, 'lang');
  assert.deepStrictEqual(
    practice.nodes.map(n => [n.id, n.parentId, !!n.survivedAsRoot]).sort(),
    room.nodes.map(n => [n.id, n.parentId, !!n.survivedAsRoot]).sort());
  assert.deepStrictEqual(practice.removed.map(n => n.id).sort(),
    removedGame.map(n => n.id).sort());
});

test('parentWord 能解析起始词、初始玩家词与候选词父节点', () => {
  const sc = P.SCENARIOS.find(x => x.id === 'extend-chain');
  assert.strictEqual(P.parentWord(sc, 's1'), '海');
  assert.strictEqual(P.parentWord(sc, 'deng'), '灯');
  assert.strictEqual(P.parentWord(sc, 'm-ye'), '夜');
});
