'use strict';
// 规则保存提交锁定的回归测试：用 DOM/WebSocket 桩加载真实 client.js，
// 验证"锁定只能由服务器答复或断线解除"，超时不得误解除导致重复提交。
const test = require('node:test');
const assert = require('node:assert');

// ---------- DOM / 环境桩 ----------

function makeEl(id) {
  const el = {
    id, children: [], _cls: new Set(id === 'rules-editor' ? ['hidden'] : []),
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
    style: {}, dataset: {},
    classList: {
      add: (...c) => c.forEach(x => el._cls.add(x)),
      remove: (...c) => c.forEach(x => el._cls.delete(x)),
      toggle: (c, force) => { (force ?? !el._cls.has(c)) ? el._cls.add(c) : el._cls.delete(c); },
      contains: (c) => el._cls.has(c),
    },
    addEventListener() {}, showModal() {}, close() {},
    appendChild(c) { el.children.push(c); return c; },
    remove() {},
    querySelectorAll: () => [],
    get offsetWidth() { return 0; },
  };
  return el;
}

const els = new Map();
const $id = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
const checkedRelations = [{ dataset: { rel: 'synonym' } }];

global.document = {
  getElementById: $id,
  querySelectorAll: (sel) => {
    if (sel === '[data-rel]:checked') return checkedRelations;
    return []; // .screen / [data-close] / #rules-editor … 等
  },
  createElement: () => makeEl('div'),
};
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.location = { protocol: 'http:', host: 'test', reload() {} };

const sockets = [];
const sentMsgs = [];
global.WebSocket = class {
  constructor(url) { this.url = url; this.readyState = 1; sockets.push(this); }
  send(s) { sentMsgs.push(JSON.parse(s)); }
};

global.WTTips = require('../public/tips.js');
global.WTRules = require('../public/rules.js');
require('../public/client.js'); // IIFE，加载即完成事件绑定并 connect()

const ws = sockets[0];
const recv = (msg) => ws.onmessage({ data: JSON.stringify(msg) });
const setRulesSent = () => sentMsgs.filter(m => m.type === 'setRules');

const LOBBY = {
  code: 'TEST', phase: 'lobby', hostId: 'me', you: 'me',
  ruleSet: { allowedRelations: ['synonym'], allowProperNouns: false, minReasonLen: 4,
    turnSeconds: 90, apPerTurn: 3, rounds: 4, startWordCount: 3, challengeTokens: 3 },
  players: [{ id: 'me', name: '甲', color: '#000', connected: true, tokensLeft: 3 }],
  startWords: [], nodes: [], turn: null, pendingChallenge: null, winner: null, scores: null,
  relationTypes: [{ id: 'synonym', name: '同义/近义', example: '快乐 → 开心' }],
};

test('保存锁定只能由服务器答复或断线解除，超时不得误解除', () => {
  // 假定时器：记录而非执行，用于模拟"时间流逝但服务器未答复"
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const timers = [];
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  global.clearTimeout = () => {};
  const advance = (ms) => {
    const due = timers.filter(t => t.ms <= ms);
    for (const t of due) timers.splice(timers.indexOf(t), 1);
    for (const t of due) t.fn();
  };

  try {
    ws.onopen();
    recv({ type: 'joined', token: 'tok', roomCode: 'TEST', playerId: 'me' });
    recv({ type: 'state', state: LOBBY });

    // 打开编辑器并保存：请求发出，按钮锁定
    $id('btn-edit-rules').onclick();
    assert.strictEqual($id('rules-editor').classList.contains('hidden'), false);
    $id('btn-save-rules').onclick();
    assert.strictEqual(setRulesSent().length, 1, '保存应发送一次请求');
    assert.strictEqual($id('btn-save-rules').disabled, true, '保存后按钮应锁定');

    // 关键回归：时间流逝（超过旧的 3 秒兜底）但服务器未答复 → 锁定必须保持
    advance(5000);
    assert.strictEqual($id('btn-save-rules').disabled, true, '未获答复时超时不得解除锁定');
    $id('btn-save-rules').onclick();
    assert.strictEqual(setRulesSent().length, 1, '锁定期间重复点击不得发送重复请求');

    // 服务器确认 → 解除锁定并关闭编辑器
    recv({ type: 'rulesSaved' });
    assert.strictEqual($id('btn-save-rules').disabled, false, 'rulesSaved 应解除锁定');
    assert.strictEqual($id('rules-editor').classList.contains('hidden'), true);

    // 再次保存 → 服务器拒绝 → 解除锁定、编辑器保持打开、错误就地显示
    $id('btn-edit-rules').onclick();
    $id('btn-save-rules').onclick();
    assert.strictEqual(setRulesSent().length, 2);
    assert.strictEqual($id('btn-save-rules').disabled, true);
    recv({ type: 'error', message: '只有房主可以修改规则', context: 'setRules' });
    assert.strictEqual($id('btn-save-rules').disabled, false, '服务器拒绝应解除锁定');
    assert.strictEqual($id('rules-editor').classList.contains('hidden'), false, '失败后编辑器保持打开');
    assert.strictEqual($id('err-rules-general').textContent, '只有房主可以修改规则');

    // 再次保存 → 连接断开 → 解除锁定（此次请求不会再有答复）
    $id('btn-save-rules').onclick();
    assert.strictEqual(setRulesSent().length, 3);
    assert.strictEqual($id('btn-save-rules').disabled, true);
    ws.onclose();
    assert.strictEqual($id('btn-save-rules').disabled, false, '断线应解除锁定');
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('多标签页：历史响应只清理本次查询过的失效 token，不误删新记录', () => {
  // 换成真正可用的 localStorage（另一标签页的写入体现为同一存储）
  const mem = {};
  global.localStorage = {
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: (k) => { delete mem[k]; },
  };
  const readHistory = () => JSON.parse(mem.wt_history || '[]');
  mem.wt_history = JSON.stringify([
    { token: 'tokA', roomCode: 'AAAA' },
    { token: 'tokB', roomCode: 'BBBB' },
  ]);

  const historyReqs = () => sentMsgs.filter(m => m.type === 'history');
  const before = historyReqs().length;
  ws.onopen(); // 重新连接 → 用当前快照发起历史查询
  assert.strictEqual(historyReqs().length, before + 1);
  assert.deepStrictEqual(historyReqs().at(-1).tokens, ['tokA', 'tokB']);

  // 查询在途期间，另一个标签页开了新房并写入 tokC
  mem.wt_history = JSON.stringify([...readHistory(), { token: 'tokC', roomCode: 'CCCC' }]);

  const entry = (token, code) => ({ token, code, phase: 'ended', createdAt: 1, endedAt: 2,
    youId: 'me', youName: '甲', players: ['甲', '乙'], winner: 'me', winnerName: '甲',
    yourRank: 1, yourTotal: 8 });
  // 服务器响应只覆盖 tokA/tokB（tokC 不在本次查询里）
  recv({ type: 'history', entries: [entry('tokA', 'AAAA'), entry('tokB', 'BBBB')] });

  // 关键回归：tokC 未被本次查询覆盖，不得被误删
  assert.ok(readHistory().some(e => e.token === 'tokC'), '其他标签页新增的记录不得被清理');
  // 发现未覆盖的新记录后应补发一次查询，把它也带进列表
  assert.strictEqual(historyReqs().length, before + 2, '发现新记录应补发查询');
  assert.ok(historyReqs().at(-1).tokens.includes('tokC'));

  // 第二次响应：tokC 有效；tokB 已被服务器删除 → 只清 tokB
  recv({ type: 'history', entries: [entry('tokA', 'AAAA'), entry('tokC', 'CCCC')] });
  const tokens = readHistory().map(e => e.token);
  assert.ok(tokens.includes('tokA') && tokens.includes('tokC'), '有效记录保留');
  assert.ok(!tokens.includes('tokB'), '查询过且服务器不认得的记录才被清理');
});
