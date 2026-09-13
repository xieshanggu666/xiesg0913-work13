'use strict';
// 战术练习界面接线回归：用可按选择器查询子元素的 DOM 桩加载真实 client.js，
// 模拟"首页 → 关卡 → 操作 → 提交 → 通关进度持久化 → 重置"的完整点击流。
const test = require('node:test');
const assert = require('node:assert');

function makeEl(id) {
  const el = {
    id: id || '', children: [], _cls: new Set(),
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
    style: { display: '' }, dataset: {}, onclick: null, open: false,
    addEventListener() {},
    showModal() { this.open = true; },
    close() { this.open = false; },
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    get offsetWidth() { return 0; },
  };
  el.classList = {
    add: (...c) => c.forEach(x => el._cls.add(x)),
    remove: (...c) => c.forEach(x => el._cls.delete(x)),
    toggle: (c, force) => { (force ?? !el._cls.has(c)) ? el._cls.add(c) : el._cls.delete(c); },
    contains: (c) => el._cls.has(c),
  };
  el.querySelectorAll = () => [];
  return el;
}

const els = new Map();
const $id = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
// 容器内的动态子元素按键缓存：client.js 每次渲染重新绑定时拿到的是同一个元素
const dynamicCache = new Map();
const dyn = (containerId, key, attrs) => {
  const ck = `${containerId}|${key}`;
  if (!dynamicCache.has(ck)) {
    const el = makeEl();
    Object.assign(el.dataset, attrs || { [containerId === 'practice-list' ? 'sid'
      : containerId === 'pr-pick-list' ? 'move' : 'id']: key});
    dynamicCache.set(ck, el);
  }
  return dynamicCache.get(ck);
};
const scenarioButtons = () => WTPractice.SCENARIOS.map((s, i) => dyn('practice-list', String(i), { sid: String(i) }));
const pickButtons = (ids) => ids.map(m => dyn('pr-pick-list', m, { move: m }));
const nodeButtons = (ids) => ids.map(n => dyn('pr-board', n, { id: n }));

const checkedRelations = [];
global.document = {
  getElementById: $id,
  querySelectorAll: (sel) => sel === '.screen'
    ? ['screen-home', 'screen-lobby', 'screen-game', 'screen-end',
      'screen-practice', 'screen-practice-game'].map($id)
    : sel === '[data-rel]:checked' ? checkedRelations : [],
  createElement: () => makeEl(),
};
const mem = {};
global.localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; },
};
global.location = { protocol: 'http:', host: 'test', reload() {} };
global.WebSocket = class { constructor() { this.readyState = 1; } send() {} };
global.WTTips = require('../public/tips.js');
global.WTRules = require('../public/rules.js');
global.WTPractice = require('../public/practice.js');

// 控制各容器当前返回哪些动态子元素（client.js 每次渲染都会重新查询并绑定 onclick）
let prPickIds = [];
// 棋盘节点全部常备，练习模式的点击合法性由 WTPractice 把关；候选词按解锁情况提供
$id('practice-list').querySelectorAll = () => scenarioButtons();
$id('pr-pick-list').querySelectorAll = () => pickButtons(prPickIds);
$id('pr-board').querySelectorAll = () =>
  nodeButtons(['guang', 'deng', 'ye', 'ying', 'lang', 'chuan', 'chonglang', 'ban', 'fan', 'matou']);

require('../public/client.js'); // IIFE：加载即绑定首页按钮并 connect()

test('练习完整点击流：入口、接词、提交、通关进度落本地', () => {
  // 首页进入练习列表，开第 1 关
  $id('btn-practice').onclick();
  scenarioButtons()[0].onclick();
  assert.ok($id('pr-title').textContent.includes('延长词链'));
  assert.ok($id('pr-board').innerHTML.includes('灯'));

  // 候选词：「星」前置词未接上，不在可点集合中；先接「夜」
  prPickIds = ['m-ye', 'm-lang', 'm-ying'];
  $id('btn-pr-play').onclick();
  assert.strictEqual($id('dlg-practice-pick').open, true);
  dyn('pr-pick-list', 'm-ye').onclick();
  assert.ok($id('pr-board').innerHTML.includes('夜'));
  assert.strictEqual($id('dlg-practice-pick').open, false);

  // 第二次：星已解锁
  prPickIds = ['m-lang', 'm-ying', 'm-xing'];
  $id('btn-pr-play').onclick();
  dyn('pr-pick-list', 'm-xing').onclick();
  assert.ok($id('pr-board').innerHTML.includes('星'));

  // 提交 → 通关 → 进度写入 localStorage
  $id('btn-pr-submit').onclick();
  assert.ok($id('pr-result').innerHTML.includes('通关'));
  assert.ok($id('pr-result').innerHTML.includes('18'));
  const progress = JSON.parse(mem.wt_practice);
  assert.ok(progress['extend-chain'] && progress['extend-chain'].at > 0);

  // 回列表：第 1 关显示"已通关"；再进入时提交按钮已锁定
  $id('btn-practice-exit').onclick();
  assert.ok($id('practice-list').innerHTML.includes('已通关'));
  scenarioButtons()[0].onclick();
  // 重进是全新会话（再练一次），操作按钮恢复可用，通关标记仍在列表上
  assert.strictEqual($id('btn-pr-submit').disabled, false);
});

test('第 2 关：加固错误目标不通关，重置后加固关键连接通关', () => {
  $id('btn-practice').onclick();
  scenarioButtons()[1].onclick(); // 第 2 关

  // 加固模式下点击深层词「夜」
  $id('btn-pr-reinforce').onclick(); // 重渲绑定
  dyn('pr-board', 'ye').onclick();
  assert.ok($id('pr-board').innerHTML.includes('已加固'));

  // 对手仍质疑「光」，不通关、不写进度
  $id('btn-pr-submit').onclick();
  assert.ok($id('pr-result').innerHTML.includes('还没达成最优'));
  assert.ok(!JSON.parse(mem.wt_practice)['protect-link']);

  // 重置后改加固「光」→ 通关
  $id('btn-pr-reset').onclick();
  assert.ok(!$id('pr-board').innerHTML.includes('已加固'));
  assert.ok($id('pr-result').classList.contains('hidden'));
  $id('btn-pr-reinforce').onclick();
  dyn('pr-board', 'guang').onclick();
  $id('btn-pr-submit').onclick();
  assert.ok($id('pr-result').innerHTML.includes('通关'));
  assert.ok($id('pr-result').innerHTML.includes('截断'), '解释应说明级联在加固处截断');
  assert.ok(JSON.parse(mem.wt_practice)['protect-link']);
});

test('第 3 关：未选目标不能提交；选中靠近根的目标通关，进度保存', () => {
  $id('btn-practice').onclick();
  scenarioButtons()[2].onclick(); // 第 3 关
  assert.strictEqual($id('btn-pr-submit').disabled, true);

  // 点对手深层词「冲浪板」→ 不通关
  dyn('pr-board', 'ban').onclick();
  assert.strictEqual($id('btn-pr-submit').disabled, false);
  $id('btn-pr-submit').onclick();
  assert.ok($id('pr-result').innerHTML.includes('还没达成最优'));

  // 重置后质疑「浪」→ 拆 4 词、帆成幸存根 → 通关
  $id('btn-pr-reset').onclick();
  dyn('pr-board', 'lang').onclick();
  $id('btn-pr-submit').onclick();
  assert.ok($id('pr-result').innerHTML.includes('通关'));
  assert.ok($id('pr-result').innerHTML.includes('−15'));
  assert.ok($id('pr-board').innerHTML.includes('幸存根'));
  assert.ok(JSON.parse(mem.wt_practice)['cascade-teardown']);
});
