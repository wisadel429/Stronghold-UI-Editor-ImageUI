// UI 布局编辑器 · 布局模型 / CSS 编译 / 存取（浏览器端，游戏内加载）
//
// 一套布局 = 两套「设备方案」：desktop（电脑版）与 mobile（手机端），各自一组条目（entries）。
// 每条用一条选择器锁定一个界面元素，记录它相对原始位置的偏移、尺寸、缩放、层级和显隐。
//
// 为什么要分两套：游戏自己就按设备换布局（public/css/devices.css 用 @media (max-width: 767px)、
// (pointer: coarse) 等改写同一批元素的位置和尺寸；js/ui/device.js 在 <html> 上挂 sp-touch / sp-coarse）。
// 同一元素在两种设备上的原始位置不同，所以覆盖值也要分开存、分设备生效。
//
// 设备判定（与游戏阈值一致，见 currentDeviceKind）：
//   窗口宽 ≤ 767px            → 手机端
//   触屏且窗口宽 ≤ 1024px      → 手机端（横屏手机 / 平板）
//   其余                      → 电脑版
//
// 长度单位一律是「设计像素」：游戏把 1rem 定义成 100 设计像素（public/css/theme.css），
// 所以 12 → 0.12rem；在不同分辨率、不同「界面大小」(75–100%) 下按同一比例缩放。
//
// 运行时由 apply.js 调用 applyLayout(profile)：把某一套方案编译成一段 CSS 写进 <style>，用 !important
// 覆盖游戏样式。位移用独立的 translate 属性（不是 transform），不会破坏游戏自带的 transform 动画。
//
// 「边距固定」(anchors)：除了逐条的绝对偏移，一套方案还可以带若干条锚定关系，
//   { selector: 被锁的元素, to: 参照元素, side: 'below'|'above'|'right'|'left', gap: 设计像素 }
// 意思是被锁元素与参照元素在某一个轴上的间距固定为 gap。applyLayout 在写完基础位移之后按真实
// rect 反算还需要补多少 translate（见 resolveAnchors），这样换比例 / 换分辨率时游戏自己重排参照
// 元素，被锁元素会跟着走，间距保持不变。
//   把 to 写成 '@screen' 表示锁到**屏幕边界**：side 取 left/right/top/bottom/centerX/centerY，
//   gap 是从那条边到元素对应边的固定像素（centerX / centerY 忽略 gap）。
//
// 「母集」(groups)：一组元素打包成编辑用的整体，
//   { id, name, members: [selector…], edges: [{ side, gap }] }
//   · 选中母集 = 选中全部成员：拖动整组一起动，拖手柄整组等比缩放（成员大小与位置同比例）；
//   · 母集边界不单独存，而是每帧按成员实测 rect 求并集（见 groupBounds），所以子元素一动边界就跟着变；
//   · edges 让母集**整体**贴住屏幕某条边保持固定像素（整组平移，组内相对关系不变）。

export const LAYOUT_VERSION = 4;
export const STYLE_ID = 'sp-ui-layout-style';
export const API_URL = '/ui-editor/layout';
export const DEVICES = ['desktop', 'mobile'];

export const DEVICE_LABEL = { desktop: '电脑版', mobile: '手机端' };
export const ANCHOR_SIDE_LABEL = {
  below: '下方',
  above: '上方',
  right: '右侧',
  left: '左侧',
  top: '顶部',
  bottom: '底部',
  centerX: '水平居中',
  centerY: '垂直居中',
};
export const ANCHOR_SIDES = ['below', 'above', 'right', 'left'];
export const SCREEN_SIDES = ['left', 'right', 'top', 'bottom', 'centerX', 'centerY'];

const MAX_SELECTOR = 400;
const MAX_ENTRIES = 2000;
const MAX_ANCHORS = 400;
const MAX_GROUPS = 200;
const MAX_GROUP_MEMBERS = 200;
const MAX_ABS = 20000; // 设计像素
// 屏幕边界锚定：left/right/top/bottom 是「边到边」的固定像素，centerX/centerY 是居中。
// 屏幕边界锚定：left/right/top/bottom 是「边到边」的固定像素，centerX/centerY 是居中。
const BOUNDARY_TARGET = '@screen';
const BOUNDARY_SIDES = ['left', 'right', 'top', 'bottom', 'centerX', 'centerY'];
// 只允许编辑器自己的图片目录，避免把远程 URL / 脚本写进布局。
const IMAGE_RE = /^\/ui-editor\/images\/[A-Za-z0-9._@-]+$/;

const finite = (v, fallback = null) => {
  const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const clampAbs = (v) => Math.max(-MAX_ABS, Math.min(MAX_ABS, v));
const round2 = (v) => Math.round(v * 100) / 100;

function normalizeImage(value) {
  if (typeof value !== 'string') return null;
  const url = value.trim().slice(0, 300);
  return IMAGE_RE.test(url) ? url : null;
}

/** 请求超时信号：接口卡住时不要让面板一直停在「保存中…」。 */
function timeoutSignal(ms = 10000) {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

/** 设计像素 → rem 字面量（100 设计像素 = 1rem）。 */
export function toRem(designPx) {
  return `${(designPx / 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}rem`;
}

/** 一条都算不上的条目（全部为默认值）返回 true。 */
export function isNeutral(e) {
  if (!e) return true;
  return !e.x && !e.y
    && e.w == null && e.h == null
    && (e.scale == null || e.scale === 1)
    && e.z == null && !e.hidden
    && !e.image;
}

/** 校验 / 规整一条。非法或中性（等于没改）→ null。 */
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const selector = typeof raw.selector === 'string' ? raw.selector.trim().slice(0, MAX_SELECTOR) : '';
  if (!selector) return null;
  const entry = {
    selector,
    x: round2(clampAbs(finite(raw.x, 0))),
    y: round2(clampAbs(finite(raw.y, 0))),
    w: raw.w == null ? null : Math.max(1, round2(clampAbs(finite(raw.w, null)))),
    h: raw.h == null ? null : Math.max(1, round2(clampAbs(finite(raw.h, null)))),
    scale: raw.scale == null ? null : Math.min(4, Math.max(0.2, finite(raw.scale, 1) || 1)),
    z: raw.z == null ? null : Math.max(0, Math.min(9999, Math.round(finite(raw.z, 0)))),
    hidden: raw.hidden === true,
  };
  const image = normalizeImage(raw.image);
  if (image) {
    entry.image = image;
    entry.imageMode = raw.imageMode === 'overlay' ? 'overlay' : 'replace';
    entry.imageFit = ['contain', 'stretch'].includes(raw.imageFit) ? raw.imageFit : 'cover';
  }
  if (entry.scale != null && Math.abs(entry.scale - 1) < 0.005) entry.scale = null;
  return isNeutral(entry) ? null : entry;
}

function normalizeEntries(list) {
  const bySelector = new Map();
  const items = Array.isArray(list) ? list.slice(0, MAX_ENTRIES) : [];
  for (const item of items) {
    const entry = normalizeEntry(item);
    if (!entry) continue;
    bySelector.delete(entry.selector);
    bySelector.set(entry.selector, entry);
  }
  return [...bySelector.values()];
}

/**
 * 校验 / 规整一条「边距固定」关系。同一对元素只保留一条（目标唯一）。
 * gap 允许负数：负值表示两个元素互相重叠这么多，同样需要固定。
 * to === '@screen' 时是屏幕边界锚定，side 换成 left/right/top/bottom/centerX/centerY。
 */
export function normalizeAnchor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const selector = typeof raw.selector === 'string' ? raw.selector.trim().slice(0, MAX_SELECTOR) : '';
  const to = typeof raw.to === 'string' ? raw.to.trim().slice(0, MAX_SELECTOR) : '';
  if (!selector || !to || selector === to) return null;
  const boundary = to === BOUNDARY_TARGET;
  if (boundary ? !BOUNDARY_SIDES.includes(raw.side) : !ANCHOR_SIDES.includes(raw.side)) return null;
  const gap = round2(clampAbs(finite(raw.gap, 0)));
  return { selector, to, side: raw.side, gap };
}

/** 同一目标只留最后一条；参照元素自己也可以被别的元素参照（允许链式）。 */
export function normalizeAnchors(list) {
  const bySelector = new Map();
  const items = Array.isArray(list) ? list.slice(0, MAX_ANCHORS) : [];
  for (const item of items) {
    const anchor = normalizeAnchor(item);
    if (!anchor) continue;
    bySelector.delete(anchor.selector);
    bySelector.set(anchor.selector, anchor);
  }
  return [...bySelector.values()];
}

export function anchorOf(profile, selector) {
  if (!profile || !selector) return null;
  return (profile.anchors || []).find((a) => a.selector === selector) || null;
}

/** 写入 / 更新 / 删除一条锚定（gap 传 null 或删除用 removeAnchor）。 */
export function setAnchor(profile, selector, patch) {
  if (!profile || !selector) return null;
  if (!Array.isArray(profile.anchors)) profile.anchors = [];
  const index = profile.anchors.findIndex((a) => a.selector === selector);
  const base = index >= 0 ? profile.anchors[index] : { selector, to: '', side: 'below', gap: 0 };
  const next = normalizeAnchor({ ...base, ...patch, selector });
  if (!next) {
    if (index >= 0) profile.anchors.splice(index, 1);
    return null;
  }
  if (index >= 0) profile.anchors[index] = next;
  else profile.anchors.push(next);
  return next;
}

export function removeAnchor(profile, selector) {
  if (!profile || !Array.isArray(profile.anchors)) return false;
  const index = profile.anchors.findIndex((a) => a.selector === selector);
  if (index >= 0) profile.anchors.splice(index, 1);
  return index >= 0;
}

// ─────────────────────────────────────────────────────────── 母集
const GROUP_ID_RE = /^[A-Za-z0-9._-]{1,40}$/;

/** 一条母集：id + 名字 + 成员选择器 + 边界锁定（edges）。成员为空时返回 null（空母集没意义）。 */
export function normalizeGroup(raw, fallbackId = '') {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && GROUP_ID_RE.test(raw.id) ? raw.id : fallbackId;
  if (!id || !GROUP_ID_RE.test(id)) return null;
  const name = typeof raw.name === 'string' && raw.name.trim()
    ? raw.name.trim().slice(0, 60)
    : '';
  const members = [];
  for (const item of Array.isArray(raw.members) ? raw.members.slice(0, MAX_GROUP_MEMBERS) : []) {
    const selector = typeof item === 'string' ? item.trim().slice(0, MAX_SELECTOR) : '';
    if (!selector || members.includes(selector)) continue;
    members.push(selector);
  }
  if (!members.length) return null;
  const edges = [];
  for (const item of Array.isArray(raw.edges) ? raw.edges.slice(0, 6) : []) {
    if (!item || !BOUNDARY_SIDES.includes(item.side)) continue;
    if (edges.some((edge) => edge.side === item.side)) continue;
    edges.push({ side: item.side, gap: round2(clampAbs(finite(item.gap, 0))) });
  }
  return { id, name, members, edges };
}

/** 一个元素只能属于一个母集：后面重复出现的成员会被前一个母集吃掉。 */
export function normalizeGroups(list) {
  const out = [];
  const claimed = new Set();
  const ids = new Set();
  const items = Array.isArray(list) ? list.slice(0, MAX_GROUPS) : [];
  items.forEach((item, index) => {
    const group = normalizeGroup(item, `group-${index + 1}`);
    if (!group) return;
    const members = group.members.filter((selector) => !claimed.has(selector));
    if (!members.length) return;
    let id = group.id;
    let n = 2;
    while (ids.has(id)) id = `${group.id}-${n++}`;
    ids.add(id);
    members.forEach((selector) => claimed.add(selector));
    out.push({ ...group, id, members });
  });
  return out;
}

export function groupById(profile, id) {
  if (!profile || !id || !Array.isArray(profile.groups)) return null;
  return profile.groups.find((group) => group.id === id) || null;
}

/** 元素属于哪个母集。 */
export function groupOf(profile, selector) {
  if (!profile || !selector || !Array.isArray(profile.groups)) return null;
  return profile.groups.find((group) => group.members.includes(selector)) || null;
}

/** 新建一个母集（成员已经在别的母集里就跳过）。 */
export function addGroup(profile, members, name = '') {
  if (!profile) return null;
  if (!Array.isArray(profile.groups)) profile.groups = [];
  const claimed = new Set(profile.groups.flatMap((group) => group.members));
  const fresh = [];
  for (const selector of Array.isArray(members) ? members : []) {
    if (typeof selector !== 'string' || !selector.trim()) continue;
    if (claimed.has(selector) || fresh.includes(selector)) continue;
    fresh.push(selector);
  }
  if (!fresh.length) return null;
  const id = `g${Date.now().toString(36).slice(-6)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const group = normalizeGroup({ id, name: name || `母集 ${profile.groups.length + 1}`, members: fresh, edges: [] }, id);
  if (!group) return null;
  profile.groups.push(group);
  return group;
}

/** 删除母集（只删分组关系，元素的调整值原样保留）。 */
export function removeGroup(profile, id) {
  if (!profile || !Array.isArray(profile.groups)) return null;
  const index = profile.groups.findIndex((group) => group.id === id);
  if (index < 0) return null;
  return profile.groups.splice(index, 1)[0] || null;
}

/** 把元素移出母集；母集被搬空时顺手删掉，返回 { group, empty }。 */
export function removeFromGroup(profile, selector) {
  const group = groupOf(profile, selector);
  if (!group) return null;
  group.members = group.members.filter((item) => item !== selector);
  if (!group.members.length) {
    removeGroup(profile, group.id);
    return { group, empty: true };
  }
  return { group, empty: false };
}

/** 母集的边界锁定：同一侧只留一条。 */
export function setGroupEdge(profile, id, side, gap) {
  const group = groupById(profile, id);
  if (!group || !BOUNDARY_SIDES.includes(side)) return null;
  if (!Array.isArray(group.edges)) group.edges = [];
  const existing = group.edges.find((edge) => edge.side === side);
  const value = round2(clampAbs(finite(gap, 0)));
  if (existing) existing.gap = value;
  else group.edges.push({ side, gap: value });
  return group.edges.find((edge) => edge.side === side) || null;
}

export function clearGroupEdges(profile, id) {
  const group = groupById(profile, id);
  if (!group) return false;
  group.edges = [];
  return true;
}

/** 一套空方案。 */
export function emptyProfile() {
  return { entries: [], anchors: [], groups: [] };
}

/**
 * 任意输入 → 干净布局（v4：{ version, updatedAt, profiles: { desktop: {entries, anchors, groups}, mobile: … } }）。
 * v3 / v2 / v1 的文件都能读：缺 anchors / groups 时按空数组补齐，不会丢已有布局。
 */
export function normalizeLayout(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const profilesIn = source.profiles && typeof source.profiles === 'object' ? source.profiles : null;
  const legacyEntries = Array.isArray(source.entries) ? source.entries : null;
  const profiles = {};
  for (const kind of DEVICES) {
    let list = null;
    if (profilesIn) {
      const item = profilesIn[kind];
      list = Array.isArray(item) ? item : (Array.isArray(item?.entries) ? item.entries : []);
    } else if (legacyEntries && kind === 'desktop') {
      list = legacyEntries;
    }
    const entries = normalizeEntries(list);
    const anchors = normalizeAnchors(profilesIn ? profilesIn[kind]?.anchors : null);
    // 母集成员允许暂时没有调整值（还没被拖过的元素），所以这里不按 entries 过滤：
    // 成员在界面上找不到时，求边界 / 选中时会被自动跳过。
    const groups = normalizeGroups(profilesIn ? profilesIn[kind]?.groups : null);
    profiles[kind] = { entries, anchors, groups };
  }
  return {
    version: LAYOUT_VERSION,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    profiles,
  };
}

export function cloneLayout(layout) {
  return JSON.parse(JSON.stringify(normalizeLayout(layout)));
}

/** 当前窗口属于哪套设备方案（与游戏自己的断点保持一致）。 */
export function currentDeviceKind(win = globalThis) {
  const width = Number(win?.innerWidth) || 0;
  let coarse = false;
  try {
    coarse = !!(win?.matchMedia?.('(any-pointer: coarse)')?.matches || win?.matchMedia?.('(pointer: coarse)')?.matches);
  } catch { coarse = false; }
  const touchClass = win?.document?.documentElement?.classList?.contains('sp-touch') === true;
  const touch = coarse || touchClass;
  if (width > 0 && width <= 767) return 'mobile';
  if (touch && (width === 0 || width <= 1024)) return 'mobile';
  return 'desktop';
}

/** 某一套方案（不是整份布局）。 */
export function profileOf(layout, kind) {
  const key = DEVICES.includes(kind) ? kind : 'desktop';
  return (layout?.profiles?.[key]) || emptyProfile();
}

export function entryOf(profile, selector) {
  if (!profile || !selector) return null;
  return profile.entries.find((e) => e.selector === selector) || null;
}

/**
 * 改写一条（不存在则创建）。patch 后若变成「没改」则删除该条并返回 null。
 * 直接修改 profile（编辑器用它做实时预览）。
 */
export function setEntry(profile, selector, patch) {
  if (!profile || !selector) return null;
  if (!Array.isArray(profile.entries)) profile.entries = [];
  const index = profile.entries.findIndex((e) => e.selector === selector);
  const base = index >= 0
    ? profile.entries[index]
    : { selector, x: 0, y: 0, w: null, h: null, scale: null, z: null, hidden: false };
  const next = normalizeEntry({ ...base, ...patch, selector });
  if (!next) {
    if (index >= 0) profile.entries.splice(index, 1);
    return null;
  }
  if (index >= 0) profile.entries[index] = next;
  else profile.entries.push(next);
  return next;
}

export function removeEntry(profile, selector) {
  if (!profile || !Array.isArray(profile.entries)) return false;
  const index = profile.entries.findIndex((e) => e.selector === selector);
  if (index >= 0) profile.entries.splice(index, 1);
  return index >= 0;
}

/** 选择器收口到游戏根节点，避免误伤编辑器自己的 DOM。 */
function scopeSelector(selector) {
  const sel = String(selector || '').trim();
  if (!sel) return '';
  if (/^(#app|html|body)([\s>.#:[]|$)/.test(sel)) return sel;
  // 极个别旧版本没有 #app，退化成 body，保证覆盖仍然命中
  const root = typeof document !== 'undefined' && !document.getElementById('app') ? 'body' : '#app';
  return `${root} ${sel}`;
}

/**
 * 一套方案 → CSS 文本。空方案返回空串。
 * extras（可选）：Map<选择器, {x, y}>，是「边距固定」解算出来的追加位移（设计像素），
 * 会叠加到该元素原本的 x / y 上；没有对应的 entry 时单独出一条只有 translate 的规则。
 */
export function toCss(profile, extras = null) {
  const out = [];
  const extraFor = (selector) => (extras instanceof Map ? extras.get(selector) : null);
  const covered = new Set();
  for (const e of profile?.entries || []) {
    const scoped = scopeSelector(e.selector);
    covered.add(e.selector);
    const decls = [];
    const extra = extraFor(e.selector);
    const ex = extra ? extra.x : 0;
    const ey = extra ? extra.y : 0;
    const x = round2((e.x || 0) + ex);
    const y = round2((e.y || 0) + ey);
    if (x || y) decls.push(`translate: ${toRem(x)} ${toRem(y)} !important;`);
    if (e.w != null) decls.push(`width: ${toRem(e.w)} !important;`);
    if (e.h != null) decls.push(`height: ${toRem(e.h)} !important;`);
    if (e.scale != null && e.scale !== 1) decls.push(`scale: ${e.scale} !important;`);
    if (e.z != null) decls.push(`z-index: ${e.z} !important;`);
    if (e.hidden) decls.push('display: none !important;');
    if (decls.length) out.push(`${scoped} {\n  ${decls.join('\n  ')}\n}`);
    if (!e.image) continue;

    const url = `url("${e.image.replace(/["\\]/g, '\\$&')}")`;
    const size = e.imageFit === 'contain' ? 'contain' : e.imageFit === 'stretch' ? '100% 100%' : 'cover';
    if (e.imageMode === 'overlay') {
      // 覆盖：图片盖在元素上，保留原内容与交互。
      out.push(`${scoped} {\n  position: relative !important;\n}`);
      out.push(`${scoped}::after {\n  content: "" !important;\n  position: absolute !important;\n  inset: 0 !important;\n  background-image: ${url} !important;\n  background-repeat: no-repeat !important;\n  background-position: center !important;\n  background-size: ${size} !important;\n  pointer-events: none !important;\n  z-index: 999 !important;\n  border-radius: inherit !important;\n}`);
    } else {
      // 替换：图片铺满元素，隐藏原有文字 / 图标 / 装饰。
      out.push(`${scoped} {\n  background-image: ${url} !important;\n  background-repeat: no-repeat !important;\n  background-position: center !important;\n  background-size: ${size} !important;\n  background-color: transparent !important;\n  background-origin: border-box !important;\n  background-clip: border-box !important;\n  border-color: transparent !important;\n  box-shadow: none !important;\n  color: transparent !important;\n}`);
      out.push(`${scoped} > * {\n  visibility: hidden !important;\n}`);
      out.push(`${scoped}::before,\n${scoped}::after {\n  display: none !important;\n}`);
    }
  }
  // 只被「边距固定」挪动、自己没有任何调整条目的元素
  if (extras instanceof Map) {
    for (const [selector, extra] of extras) {
      if (covered.has(selector) || !extra) continue;
      const x = round2(extra.x);
      const y = round2(extra.y);
      if (!x && !y) continue;
      out.push(`${scopeSelector(selector)} {\n  translate: ${toRem(x)} ${toRem(y)} !important;\n}`);
    }
  }
  if (!out.length) return '';
  return `/* Stronghold Protocol · UI 布局覆盖（由 UI 布局编辑器生成）*/\n${out.join('\n\n')}\n`;
}

// 上一次真正写进 <style> 的追加位移：解算时用它把实测 rect 还原成「不含补偿」的基准位置，
// 这样每帧都是从基准重算，不会把误差一代代累积下去。
let appliedExtras = new Map();
let styleEl = null;

/** 设计像素 ↔ 屏幕像素（1rem = 100 设计像素）。 */
function remPxNow() {
  try {
    const value = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return Number.isFinite(value) && value > 0 ? value : 100;
  } catch {
    return 100;
  }
}

/** 选择器 → 元素（找不到就 null，绝不抛错）。 */
function findElement(selector) {
  try {
    const el = document.querySelector(selector);
    if (el) return el;
  } catch { /* 选择器失效 */ }
  try {
    return document.querySelector(scopeSelector(selector));
  } catch {
    return null;
  }
}

/**
 * 按「边距固定」/「母集贴边」关系算出一批追加位移（设计像素）。
 * skip 里的目标本轮不重算（编辑器正在手拖它），保留上一次的值，避免松手前跳一下。
 * reset 里的目标连保留都不保留：调用方已经把这些补偿并进了 x / y，这一轮从干净的 base 起算。
 */
export function resolveAnchors(profile, skip = null, reset = null) {
  const extras = new Map();
  const anchors = Array.isArray(profile?.anchors) ? profile.anchors : [];
  const groups = Array.isArray(profile?.groups) ? profile.groups : [];
  if ((!anchors.length && !groups.length) || typeof document === 'undefined') return extras;
  const rem = remPxNow();
  const pxToDesign = 100 / rem;

  // 实测 rect 减去上一轮的追加位移 = 这个元素「只按 entry 摆好」时的基准 rect。
  const baseRects = new Map();
  const baseRect = (selector) => {
    if (baseRects.has(selector)) return baseRects.get(selector);
    let rect = null;
    const el = findElement(selector);
    if (el) {
      const box = el.getBoundingClientRect();
      if (box.width > 0 || box.height > 0) {
        const applied = appliedExtras.get(selector);
        const dx = applied ? applied.x / pxToDesign : 0;
        const dy = applied ? applied.y / pxToDesign : 0;
        rect = {
          left: box.left - dx,
          top: box.top - dy,
          right: box.right - dx,
          bottom: box.bottom - dy,
        };
      }
    }
    baseRects.set(selector, rect);
    return rect;
  };
  const shifted = (rect, extra) => (
    extra ? { left: rect.left + extra.x, top: rect.top + extra.y, right: rect.right + extra.x, bottom: rect.bottom + extra.y } : rect
  );

  // 屏幕边界（#app 的矩形；没有 #app 时退化成窗口）。
  let boundaryCache = null;
  const boundaryRect = () => {
    if (boundaryCache) return boundaryCache;
    let rect = null;
    const el = findElement('#app');
    if (el) {
      const box = el.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) rect = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    }
    if (!rect) {
      const root = document.documentElement;
      rect = { left: 0, top: 0, right: root?.clientWidth || 0, bottom: root?.clientHeight || 0 };
    }
    boundaryCache = rect;
    return rect;
  };

  /** 让 box 满足某条边界关系还需要平移多少（屏幕像素，正数 = 往右 / 往下）。 */
  const boundaryDelta = (box, side, gapPx) => {
    const b = boundaryRect();
    if (side === 'left') return (b.left + gapPx) - box.left;
    if (side === 'right') return (b.right - gapPx) - box.right;
    if (side === 'top') return (b.top + gapPx) - box.top;
    if (side === 'bottom') return (b.bottom - gapPx) - box.bottom;
    if (side === 'centerX') return ((b.left + b.right) - (box.left + box.right)) / 2;
    return ((b.top + b.bottom) - (box.top + box.bottom)) / 2;
  };
  const axisOf = (side) => (side === 'left' || side === 'right' || side === 'centerX' ? 'x' : 'y');

  for (const anchor of anchors) {
    if (reset && reset.has(anchor.selector)) continue;
    if (skip && skip.has(anchor.selector)) {
      const applied = appliedExtras.get(anchor.selector);
      if (applied) extras.set(anchor.selector, { x: applied.x, y: applied.y });
    }
  }

  /** 母集：成员矩形求并集（含本轮已算出的追加位移）。 */
  const groupBox = (group) => {
    let box = null;
    for (const selector of group.members) {
      const base = baseRect(selector);
      if (!base) continue;
      const rect = shifted(base, extras.get(selector));
      if (!box) {
        box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        continue;
      }
      box.left = Math.min(box.left, rect.left);
      box.top = Math.min(box.top, rect.top);
      box.right = Math.max(box.right, rect.right);
      box.bottom = Math.max(box.bottom, rect.bottom);
    }
    return box;
  };

  // 组贴边 + 元素锚定交替几轮：两边都会产生位移，迭代收敛（位移是线性的，三轮足够）。
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;

    for (const group of groups) {
      const edges = Array.isArray(group.edges) ? group.edges : [];
      if (!edges.length) continue;
      // 正在手拖 / 手缩放这一组里的成员时不参与解算，否则会跟手抢。
      if (skip && group.members.some((selector) => skip.has(selector))) continue;
      if (reset && group.members.some((selector) => reset.has(selector))) continue;
      const box = groupBox(group);
      if (!box) continue;
      const shift = { x: 0, y: 0 };
      for (const edge of edges) {
        const delta = boundaryDelta(box, edge.side, edge.gap / pxToDesign);
        if (!Number.isFinite(delta)) continue;
        if (axisOf(edge.side) === 'x') shift.x = delta;
        else shift.y = delta;
      }
      if (Math.abs(shift.x) < 0.05 && Math.abs(shift.y) < 0.05) continue;
      const dx = shift.x * pxToDesign;
      const dy = shift.y * pxToDesign;
      for (const selector of group.members) {
        const current = extras.get(selector) || { x: 0, y: 0 };
        extras.set(selector, { x: current.x + dx, y: current.y + dy });
      }
      changed = true;
    }

    for (const anchor of anchors) {
      if (skip && skip.has(anchor.selector)) continue;
      if (reset && reset.has(anchor.selector)) continue;
      const targetBase = baseRect(anchor.selector);
      if (!targetBase) continue;
      const current = extras.get(anchor.selector) || { x: 0, y: 0 };
      const target = shifted(targetBase, current);
      const gapPx = anchor.gap / pxToDesign;
      let deltaPx = 0;
      let axis = 'y';
      if (anchor.to === BOUNDARY_TARGET) {
        deltaPx = boundaryDelta(target, anchor.side, gapPx);
        axis = axisOf(anchor.side);
      } else {
        const refBase = baseRect(anchor.to);
        if (!refBase) continue;
        const ref = shifted(refBase, extras.get(anchor.to));
        // 链式关系（A 锁 B、B 锁 C）靠几轮迭代收敛。
        if (anchor.side === 'below' || anchor.side === 'above') {
          deltaPx = anchor.side === 'below' ? (ref.bottom + gapPx) - target.top : (ref.top - gapPx) - target.bottom;
          axis = 'y';
        } else {
          deltaPx = anchor.side === 'right' ? (ref.right + gapPx) - target.left : (ref.left - gapPx) - target.right;
          axis = 'x';
        }
      }
      if (!Number.isFinite(deltaPx) || Math.abs(deltaPx) < 0.05) continue;
      const delta = deltaPx * pxToDesign;
      extras.set(anchor.selector, axis === 'x'
        ? { x: current.x + delta, y: current.y }
        : { x: current.x, y: current.y + delta });
      changed = true;
    }

    if (!changed) break;
  }
  return extras;
}

/**
 * 一组选择器 → 页面上的并集矩形（屏幕像素）。母集边界就是这么来的：
 * 每次都按成员实测位置重算，所以子元素一动，边界立刻跟着动。
 */
export function boundsOf(selectors) {
  if (typeof document === 'undefined') return null;
  let box = null;
  for (const selector of Array.isArray(selectors) ? selectors : []) {
    const el = findElement(selector);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 0.5 && rect.height < 0.5) continue;
    if (!box) {
      box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      continue;
    }
    box.left = Math.min(box.left, rect.left);
    box.top = Math.min(box.top, rect.top);
    box.right = Math.max(box.right, rect.right);
    box.bottom = Math.max(box.bottom, rect.bottom);
  }
  if (!box) return null;
  box.width = box.right - box.left;
  box.height = box.bottom - box.top;
  return box;
}

/**
 * 把一套方案编译并写进 <style>，页面上的元素立刻按新位置显示。
 * options.skip：本轮不要重算的目标选择器集合（编辑器正在拖动 / 缩放它们）。
 * options.reset：这些目标的补偿已经并进 x / y，本轮不再追加。
 * options.solve === false：完全不处理「边距固定」与「母集贴边」（用于清空 / 换设备后先落一遍基础样式）。
 */
export function applyLayout(profile, options = {}) {
  const skip = options.skip ? new Set(options.skip) : null;
  const reset = options.reset ? new Set(options.reset) : null;
  const extras = options.solve === false ? new Map() : resolveAnchors(profile, skip, reset);
  const css = toCss(profile, extras);
  appliedExtras = extras;
  if (!styleEl || !styleEl.isConnected) {
    styleEl = document.getElementById(STYLE_ID);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(styleEl);
    }
  }
  if (styleEl.textContent !== css) styleEl.textContent = css;
  return css;
}

/**
 * 读取布局。两种来源：
 *   1. 编辑器代理提供的 /ui-editor/layout（编辑时，能写盘）；
 *   2. 普通游玩时没有接口，读游戏自带的静态文件 /ui-layout.json。
 */
export async function fetchLayout() {
  try {
    const res = await fetch(`${API_URL}?t=${Date.now()}`, { cache: 'no-store', signal: timeoutSignal() });
    if (res.ok) {
      const body = await res.json();
      return { ok: true, saved: body?.saved !== false, layout: normalizeLayout(body?.layout), error: null };
    }
  } catch { /* 没有接口，继续尝试静态文件 */ }

  try {
    const res = await fetch(`/ui-layout.json?t=${Date.now()}`, { cache: 'no-store', signal: timeoutSignal() });
    if (res.ok) {
      const body = await res.json();
      return { ok: true, saved: true, layout: normalizeLayout(body), error: null };
    }
  } catch { /* 两个都没有就当空布局 */ }

  return { ok: false, saved: false, layout: normalizeLayout({}), error: '没有找到布局文件' };
}

/** 把整份布局保存到游戏的 public/ui-layout.json（由编辑器代理写入）。 */
export async function saveLayout(layout) {
  const body = {
    version: LAYOUT_VERSION,
    updatedAt: new Date().toISOString(),
    profiles: {
      desktop: {
        entries: profileOf(layout, 'desktop').entries,
        anchors: profileOf(layout, 'desktop').anchors || [],
        groups: profileOf(layout, 'desktop').groups || [],
      },
      mobile: {
        entries: profileOf(layout, 'mobile').entries,
        anchors: profileOf(layout, 'mobile').anchors || [],
        groups: profileOf(layout, 'mobile').groups || [],
      },
    },
  };
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeoutSignal(),
    });
    const out = await res.json().catch(() => null);
    if (!res.ok || !out?.ok) throw new Error(out?.error || `HTTP ${res.status}`);
    return { ok: true, savedAt: out.savedAt || null, counts: out.counts || null };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}
