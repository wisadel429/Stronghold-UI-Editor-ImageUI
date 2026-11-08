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

export const LAYOUT_VERSION = 2;
export const STYLE_ID = 'sp-ui-layout-style';
export const API_URL = '/ui-editor/layout';
export const DEVICES = ['desktop', 'mobile'];

export const DEVICE_LABEL = { desktop: '电脑版', mobile: '手机端' };

const MAX_SELECTOR = 400;
const MAX_ENTRIES = 2000;
const MAX_ABS = 20000; // 设计像素
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

/** 一套空方案。 */
export function emptyProfile() {
  return { entries: [] };
}

/**
 * 任意输入 → 干净布局（v2：{ version, updatedAt, profiles: { desktop, mobile } }）。
 * 兼容 v1 的 { entries } ：那是有设备方案之前的文件，全部归到 desktop。
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
    profiles[kind] = { entries: normalizeEntries(list) };
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

/** 一套方案 → CSS 文本。空方案返回空串。 */
export function toCss(profile) {
  const out = [];
  for (const e of profile?.entries || []) {
    const scoped = scopeSelector(e.selector);
    const decls = [];
    if (e.x || e.y) decls.push(`translate: ${toRem(e.x)} ${toRem(e.y)} !important;`);
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
  if (!out.length) return '';
  return `/* Stronghold Protocol · UI 布局覆盖（由 UI 布局编辑器生成）*/\n${out.join('\n\n')}\n`;
}

let styleEl = null;

/** 把一套方案编译并写进 <style>，页面上的元素立刻按新位置显示。 */
export function applyLayout(profile) {
  const css = toCss(profile);
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
      desktop: { entries: profileOf(layout, 'desktop').entries },
      mobile: { entries: profileOf(layout, 'mobile').entries },
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
