'use strict';
/* 规则编辑器：纯逻辑模块，浏览器（window.WTRules）与 Node（测试）共用 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WTRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // 数值字段的合法范围，与服务端 game.js 中 setRuleSet 的 clamp 范围保持一致。
  // id 对应编辑器里的输入框 id，错误提示元素 id 为 `err-${id}`。
  const NUMBER_FIELDS = [
    { key: 'minReasonLen',    id: 'rule-minlen',  label: '解释最少字数', min: 0,  max: 50 },
    { key: 'turnSeconds',     id: 'rule-seconds', label: '每回合秒数',   min: 30, max: 300 },
    { key: 'apPerTurn',       id: 'rule-ap',      label: '每回合行动点', min: 1,  max: 6 },
    { key: 'rounds',          id: 'rule-rounds',  label: '每人回合数',   min: 1,  max: 10 },
    { key: 'challengeTokens', id: 'rule-tokens',  label: '每人质疑次数', min: 0,  max: 9 },
  ];

  // 校验规则编辑器的原始输入。input: { allowedRelations: string[], 各数值字段为字符串 }
  // 返回 { errors, ruleSet }：errors 以字段 key 为索引，为空对象表示校验通过；
  // ruleSet 为解析出的合法值（数值字段已转为整数），可直接发给服务端。
  function validateRuleSet(input) {
    const errors = {};
    const ruleSet = {};
    const rels = Array.isArray(input.allowedRelations) ? input.allowedRelations : [];
    if (rels.length === 0) {
      errors.allowedRelations = '至少选择一种关系类型';
    } else {
      ruleSet.allowedRelations = rels;
    }
    for (const f of NUMBER_FIELDS) {
      const raw = String(input[f.key] ?? '').trim();
      const n = Number(raw);
      if (raw === '' || !Number.isInteger(n) || n < f.min || n > f.max) {
        errors[f.key] = `${f.label}需为 ${f.min}~${f.max} 的整数`;
      } else {
        ruleSet[f.key] = n;
      }
    }
    return { errors, ruleSet };
  }

  // 两份规则是否一致（用于检测"房主更新了规则"，及时提醒其他玩家）
  function sameRuleSet(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  return { NUMBER_FIELDS, validateRuleSet, sameRuleSet };
});
