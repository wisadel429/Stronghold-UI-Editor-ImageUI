// UI 布局编辑器 · 选择器
//
// 把界面上的一个元素变成一条可读、可复现的 CSS 选择器：
//   #app > div.screen.gload > div.gm > div.gm__hud > div.team
//
// 规则：
//   * 锚定在 #app（游戏根节点，main.js 把整个 Preact 树渲染进去）；
//   * 跳过状态类（is-* / has-* / sp-* / js-*）——它们随对局状态变化，写进选择器会失效；
//   * 只用 #app 这一个 id：其它 id 很多是运行时生成的（如输入框的 #tf-xxxxxx），记下来下次就失效；
//   * 同类同级兄弟多于一个时补 :nth-of-type(n) 消歧；
//   * 每段最多带 3 个类名，路径最多 12 层，保持选择器短、稳、可读。

const CACHE = new WeakMap();
const SKIP_CLASS = /^(is-|has-|sp-|js-|spui)/;

const cssEscape = (value) => {
  const s = String(value);
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/[^\w-]/g, (c) => `\\${c}`);
};

function segmentOf(el) {
  const tag = el.tagName.toLowerCase();
  const classes = [...el.classList].filter((c) => !SKIP_CLASS.test(c)).slice(0, 3);
  let out = tag;
  for (const c of classes) out += `.${cssEscape(c)}`;

  const parent = el.parentElement;
  if (parent) {
    const sameTag = [...parent.children].filter((n) => n.tagName === el.tagName);
    if (sameTag.length > 1) {
      const lookalike = sameTag.filter((n) => classes.every((c) => n.classList.contains(c)));
      if (lookalike.length > 1) out += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
    }
  }
  return out;
}

function build(el) {
  const parts = [];
  let node = el;
  let guard = 0;
  while (node && node.nodeType === 1 && guard++ < 12) {
    if (node === document.body || node === document.documentElement) break;
    // 只认游戏根节点这一个 id：其它 id 里有大量运行时生成的（如输入框的 #tf-xxxxxx），
    // 写进选择器下次刷新就失效，所以一律用 tag + class + nth-of-type 表达。
    if (node.id === 'app') {
      parts.unshift('#app');
      break;
    }
    parts.unshift(segmentOf(node));
    node = node.parentElement;
  }
  return parts.join(' > ');
}

/** 元素 → 选择器（同一次会话内缓存，元素不变则结果不变）。 */
export function selectorFor(el) {
  if (!el || el.nodeType !== 1) return '';
  const cached = CACHE.get(el);
  if (cached) return cached;
  const selector = build(el);
  if (selector) CACHE.set(el, selector);
  return selector;
}

/** 选择器 → 元素（失效返回 null）。 */
export function elementFor(selector) {
  if (!selector) return null;
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

/** 面板 / 列表里显示的短名字：tag.cls1.cls2 */
export function labelFor(el) {
  if (!el || el.nodeType !== 1) return '';
  const classes = [...el.classList].filter((c) => !SKIP_CLASS.test(c)).slice(0, 2);
  return el.tagName.toLowerCase() + (classes.length ? `.${classes.join('.')}` : '');
}

/** 选择器尾部两段，够认人也够短。 */
export function shortSelector(selector) {
  const parts = String(selector || '').split(' > ');
  return parts.slice(-2).join(' > ');
}
