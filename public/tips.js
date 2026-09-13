'use strict';
/* 教学提示：纯逻辑模块，浏览器（window.WTTips）与 Node（测试）共用 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WTTips = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // 找出"新出现的、由对手接出的词"。起始词等中立节点（ownerId 为空）不算。
  function findNewOpponentWords(prevNodes, curNodes, you) {
    const prevIds = new Set((prevNodes || []).map(n => n.id));
    return (curNodes || []).filter(n => !prevIds.has(n.id) && n.ownerId && n.ownerId !== you);
  }

  // 提示队列：一次只展示一条，后面的排队；用户点"知道了"关闭时才标记已读。
  function createTipQueue({ isSeen, markSeen, show, hide }) {
    const queue = [];
    let current = null;
    function pump() {
      if (current || queue.length === 0) return;
      current = queue.shift();
      show(current.text);
    }
    return {
      push(key, text) {
        if (isSeen(key)) return false;                 // 已读过的不再出现
        if (current && current.key === key) return false; // 正在展示
        if (queue.some(t => t.key === key)) return false; // 已在队列中
        queue.push({ key, text });
        pump();
        return true;
      },
      dismiss() {
        if (!current) return;
        markSeen(current.key); // 关闭（读完）才记录已读
        current = null;
        hide();
        pump();
      },
      current() { return current; },
      pending() { return queue.length; },
    };
  }

  return { findNewOpponentWords, createTipQueue };
});
