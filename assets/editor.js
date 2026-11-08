// UI 布局编辑器 · 页面内编辑面板
//
// 只在地址栏带 ?ui-edit=1 时由 apply.js 动态载入。它不读取游戏内部状态、不依赖 Preact，
// 只对 #app 里的真实 DOM 做「选中 / 拖动 / 数值微调」，把结果写进当前设备方案（电脑版 / 手机端），
// 由一段覆盖 CSS 立即生效；点「保存」后两套方案一起落到 data/ui-layout.json，下次载入按设备自动套用。
//
// 单位：设计像素（100 设计像素 = 1rem，见 public/css/theme.css），所以同一个数值在
// 1920×1080、2K、笔记本小窗、手机横屏下都按同一比例缩放。

import {
  DEVICE_LABEL, applyLayout, cloneLayout, currentDeviceKind, entryOf, fetchLayout,
  normalizeLayout, profileOf, removeEntry, saveLayout, setEntry, toCss,
} from './layout.js';
import { elementFor, labelFor, selectorFor, shortSelector } from './selector.js';

const POS_KEY = 'sp.uiEditor.pos';
const STEP_DEFAULT = 0.5; // 设计像素
const STEP_FINE = 0.1;
const STEP_KEY = 1; // 方向键
const STEP_KEY_FAST = 10; // Shift + 方向键

const remPx = () => {
  const v = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(v) && v > 0 ? v : 100;
};
const designPerPx = () => (remPx() > 0 ? 100 / remPx() : 1);
const round2 = (v) => Math.round(v * 100) / 100;

const isEditorNode = (node) => node instanceof Element && !!node.closest('[data-sp-uiedit]');

const MARKUP = `
<button type="button" class="spui-fab" data-act="expand" title="展开 UI 布局编辑器">UI</button>
<div class="spui-panel">
  <div class="spui-head" data-role="head">
    <button type="button" class="spui-mode is-on" data-act="mode" title="Tab：拾取（点击只选中）/ 操作（正常点游戏）">拾取中</button>
    <button type="button" class="spui-mode spui-mode--multi" data-act="multi" title="多选：点击元素加入 / 移出选择（等同于一直按住 Shift）">多选</button>
    <span class="spui-title">UI 布局编辑器</span>
    <button type="button" class="spui-min is-on" data-act="handles" title="显示 / 隐藏缩放手柄（H）">⤡</button>
    <button type="button" class="spui-min" data-act="collapse" title="收起面板">–</button>
  </div>
  <div class="spui-body">
    <div class="spui-devices">
      <button type="button" class="spui-dev is-on" data-act="kind" data-kind="desktop">电脑版</button>
      <button type="button" class="spui-dev" data-act="kind" data-kind="mobile">手机端</button>
      <span class="spui-detect" data-role="detect">窗口：桌面</span>
    </div>
    <button type="button" class="spui-copy" data-act="copy" data-role="copy">复制另一设备方案</button>
    <div class="spui-row spui-row--profiles" data-role="profiles" hidden>
      <select class="spui-select" data-role="profile-select" title="该游戏版本的布局存档"></select>
      <button type="button" data-act="profile-save" title="把当前布局另存为一份存档">存</button>
      <button type="button" data-act="profile-load" title="载入选中的存档">读</button>
      <button type="button" data-act="profile-delete" title="删除选中的存档">删</button>
    </div>
    <div class="spui-crumbs" data-role="crumbs"><span class="spui-crumb-hint">点击画面里的元素开始调整</span></div>
    <div class="spui-hintline" data-role="hint">点击只选中 · <b>Ctrl+点击/双击</b> 选最里层 · <b>Alt+点击</b> 放行</div>
    <div class="spui-fields">
      <label class="spui-field"><span>X</span><input data-field="x" type="number" step="0.5" inputmode="decimal" disabled /></label>
      <label class="spui-field"><span>Y</span><input data-field="y" type="number" step="0.5" inputmode="decimal" disabled /></label>
      <label class="spui-field"><span>宽</span><input data-field="w" type="number" step="1" placeholder="自动" disabled /></label>
      <label class="spui-field"><span>高</span><input data-field="h" type="number" step="1" placeholder="自动" disabled /></label>
      <label class="spui-field"><span>缩放%</span><input data-field="scale" type="number" step="5" placeholder="100" disabled /></label>
      <label class="spui-field"><span>层级</span><input data-field="z" type="number" step="1" placeholder="自动" disabled /></label>
    </div>
    <div class="spui-nudge" data-role="nudge">
      <button type="button" class="spui-dir" data-nudge="0,-1" data-dir="up" title="上移（可长按连发）" disabled>▲</button>
      <button type="button" class="spui-dir" data-nudge="0,1" data-dir="down" title="下移（可长按连发）" disabled>▼</button>
      <button type="button" class="spui-dir" data-nudge="-1,0" data-dir="left" title="左移（可长按连发）" disabled>◀</button>
      <button type="button" class="spui-dir" data-nudge="1,0" data-dir="right" title="右移（可长按连发）" disabled>▶</button>
      <button type="button" class="spui-step" data-act="step" title="微调步长（设计像素），点击切换">1</button>
    </div>
    <div class="spui-row">
      <button type="button" data-act="zero" disabled>归零</button>
      <button type="button" data-act="hide" disabled>隐藏</button>
      <button type="button" data-act="reset" disabled>重置</button>
      <button type="button" data-act="parent" disabled>父级</button>
      <button type="button" data-act="child" disabled>子级</button>
    </div>
    <div class="spui-row spui-row--multi" data-role="multirow" hidden>
      <button type="button" data-act="addparent" disabled>加选父级</button>
      <button type="button" data-act="siblings" disabled>全选同级</button>
      <button type="button" data-act="clearsel" disabled>清空选择</button>
    </div>
    <div class="spui-listhead">已调整 <b data-role="count">0</b><span class="spui-listhint">点条目可定位</span></div>
    <div class="spui-list" data-role="list"></div>
  </div>
  <div class="spui-foot">
    <button type="button" class="spui-ok" data-act="save">保存</button>
    <button type="button" data-act="reload">重载</button>
    <button type="button" data-act="undo">撤销</button>
    <button type="button" data-act="redo">重做</button>
    <button type="button" data-act="css">导出CSS</button>
    <button type="button" data-act="clear">清空</button>
  </div>
  <div class="spui-info" data-role="info"></div>
</div>
<div class="spui-box spui-hover" data-role="hoverbox"></div>
<div class="spui-tag" data-role="hovertag"></div>
<div class="spui-box spui-sel" data-role="selbox"></div>
<div class="spui-tag spui-tag--sel" data-role="seltag"></div>
<div class="spui-handles" data-role="handles" hidden>
  <i class="spui-h spui-h--nw" data-handle="nw"></i>
  <i class="spui-h spui-h--n" data-handle="n"></i>
  <i class="spui-h spui-h--ne" data-handle="ne"></i>
  <i class="spui-h spui-h--w" data-handle="w"></i>
  <i class="spui-h spui-h--e" data-handle="e"></i>
  <i class="spui-h spui-h--sw" data-handle="sw"></i>
  <i class="spui-h spui-h--s" data-handle="s"></i>
  <i class="spui-h spui-h--se" data-handle="se"></i>
</div>
<div class="spui-toast" data-role="toast"></div>
<div class="spui-modal" data-role="modal" hidden>
  <div class="spui-dialog">
    <div class="spui-dialog-head"><span data-role="csstitle">生成的 CSS</span><button type="button" data-act="close-modal">×</button></div>
    <textarea data-role="csstext" readonly spellcheck="false"></textarea>
    <div class="spui-dialog-foot">
      <span class="spui-dialog-hint">想永久固化：存成 public/ui-editor/ui-layout.css，再在 index.html 里 link</span>
      <button type="button" data-act="copy-css-modal">复制</button>
      <button type="button" data-act="download">下载</button>
    </div>
  </div>
</div>
`;

/** 面板样式：同一页面只插一次。 */
function ensureStyles() {
  if (document.querySelector('link[data-sp-ui-editor]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/ui-editor/editor.css';
  link.setAttribute('data-sp-ui-editor', '');
  document.head.appendChild(link);
}

/** 启动（同一个页面只启动一次）。 */
export function startEditor(payload = {}) {
  if (globalThis.__spUiEditor) return globalThis.__spUiEditor;
  ensureStyles();
  const editor = createEditor(payload);
  globalThis.__spUiEditor = editor;
  return editor;
}

function createEditor(payload) {
  const state = {
    editing: true,
    dirty: false,
    layout: normalizeLayout(payload.layout),
    kind: payload.kind === 'mobile' ? 'mobile' : 'desktop',
    selected: null,
    selection: [],
    hover: null,
    drag: null,
    resize: null,
    chain: [],
    lastPoint: null,
    handles: true,
    multiMode: false,
    profiles: [],
    undo: [],
    redo: [],
    editBefore: null,
    saving: false,
    apiOk: payload.ok !== false,
    step: 1,
    toastTimer: 0,
    embed: payload.embed === true,
    zoom: 1,
    batchBefore: null,
    versionKey: '',
    shiftHeld: false,
  };
  // 起始方案 = 当前窗口判定（手机窗口 → 手机端方案）；手动切换只影响本次会话，刷新后跟随窗口。

  const listeners = new Set();
  // 必须在使用 schedulePublish 之前初始化（面板初始化时 setStep → schedulePublish）。
  let publishTimer = 0;
  function emitEvent(type, payload) {
    for (const listener of listeners) {
      try { listener(type, payload); } catch (error) { console.error('[ui-editor] listener 失败', error); }
    }
  }

  // ─────────────────────────────────────────────────────────── DOM
  const host = document.createElement('div');
  host.className = 'spui';
  host.setAttribute('data-sp-uiedit', '');
  if (state.embed) host.classList.add('spui--embed');
  host.innerHTML = MARKUP;
  document.body.appendChild(host);

  const q = (sel) => host.querySelector(sel);
  const panel = q('.spui-panel');
  const fab = q('.spui-fab');
  const head = q('[data-role="head"]');
  const crumbsEl = q('[data-role="crumbs"]');
  const hintEl = q('[data-role="hint"]');
  const handlesEl = q('[data-role="handles"]');
  const handleViews = [...host.querySelectorAll('[data-handle]')];
  const listEl = q('[data-role="list"]');
  const countEl = q('[data-role="count"]');
  const infoEl = q('[data-role="info"]');
  const modal = q('[data-role="modal"]');
  const cssText = q('[data-role="csstext"]');
  const cssTitle = q('[data-role="csstitle"]');
  const toastEl = q('[data-role="toast"]');
  const detectEl = q('[data-role="detect"]');
  const copyBtn = q('[data-role="copy"]');
  const profilesRow = q('[data-role="profiles"]');
  const profileSelect = q('[data-role="profile-select"]');
  const deviceButtons = [...host.querySelectorAll('[data-act="kind"]')];
  const boxes = {
    hover: { box: q('[data-role="hoverbox"]'), tag: q('[data-role="hovertag"]') },
    sel: { box: q('[data-role="selbox"]'), tag: q('[data-role="seltag"]') },
  };
  const modeBtn = q('[data-act="mode"]');
  const multiBtn = q('[data-act="multi"]');
  const multiRow = q('[data-role="multirow"]');
  const hideBtn = q('[data-act="hide"]');
  const fields = {};
  for (const input of host.querySelectorAll('[data-field]')) fields[input.dataset.field] = input;
  const actionButtons = [...host.querySelectorAll('.spui-row button')];
  const nudgeButtons = [...host.querySelectorAll('.spui-dir')];
  const stepBtn = q('[data-act="step"]');

  // ─────────────────────────────────────────────────────────── 当前设备方案
  const profile = () => profileOf(state.layout, state.kind);
  const entries = () => profile().entries;
  const entriesOf = (kind) => (state.layout.profiles?.[kind]?.entries || []);
  const otherKind = () => (state.kind === 'mobile' ? 'desktop' : 'mobile');

  // ─────────────────────────────────────────────────────────── 状态 → 界面
  const snapshot = () => cloneLayout(state.layout);

  function pushUndo(before) {
    if (!before) return;
    state.undo.push(before);
    if (state.undo.length > 80) state.undo.shift();
    state.redo.length = 0;
    state.dirty = true;
    updateInfo();
    schedulePublish();
  }

  function describe(entry) {
    const bits = [];
    if (entry.hidden) bits.push('隐藏');
    if (entry.image) bits.push('图片');
    if (entry.x || entry.y) bits.push(`${entry.x},${entry.y}`);
    if (entry.w != null || entry.h != null) bits.push(`${entry.w ?? '自动'}×${entry.h ?? '自动'}`);
    if (entry.scale != null && entry.scale !== 1) bits.push(`${Math.round(entry.scale * 100)}%`);
    if (entry.z != null) bits.push(`z${entry.z}`);
    return bits.join(' · ') || '已记录';
  }

  function renderDevices() {
    const auto = currentDeviceKind();
    for (const button of deviceButtons) {
      const kind = button.dataset.kind;
      button.classList.toggle('is-on', kind === state.kind);
      button.textContent = `${DEVICE_LABEL[kind]} · ${entriesOf(kind).length}`;
    }
    detectEl.textContent = auto === state.kind
      ? `窗口：${DEVICE_LABEL[auto]}`
      : `窗口：${DEVICE_LABEL[auto]}（正在看另一套）`;
    detectEl.classList.toggle('is-warn', auto !== state.kind);
    copyBtn.textContent = `复制${DEVICE_LABEL[otherKind()]}方案 → ${DEVICE_LABEL[state.kind]}`;
  }

  function renderList() {
    listEl.textContent = '';
    countEl.textContent = String(entries().length);
    if (!entries().length) {
      const empty = document.createElement('div');
      empty.className = 'spui-empty';
      empty.textContent = `${DEVICE_LABEL[state.kind]}还没有调整任何元素`;
      listEl.append(empty);
      return;
    }
    for (const entry of [...entries()].reverse()) {
      const row = document.createElement('div');
      row.className = 'spui-item';

      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'spui-item-name';
      name.textContent = shortSelector(entry.selector);
      name.title = entry.selector;
      name.dataset.jump = entry.selector;

      const meta = document.createElement('span');
      meta.className = 'spui-item-meta';
      meta.textContent = describe(entry);

      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'spui-item-drop';
      drop.textContent = '↺';
      drop.title = '删除这一项的调整';
      drop.dataset.drop = entry.selector;

      row.append(name, meta, drop);
      listEl.append(row);
    }
  }

  function currentEntry() {
    if (!state.selected) return null;
    return entryOf(profile(), selectorFor(state.selected));
  }

  function syncFields() {
    if (isMulti()) {
      // 多选：每个元素的 X/Y/宽/高 各不相同，只有缩放是共同的
      fields.x.value = '';
      fields.y.value = '';
      fields.w.value = '';
      fields.h.value = '';
      const scales = state.selection.map((el) => {
        const entry = entryOf(profile(), selectorFor(el));
        return entry && entry.scale != null ? Math.round(entry.scale * 100) : 100;
      });
      const same = scales.every((value) => value === scales[0]);
      fields.scale.value = same ? String(scales[0]) : '';
      fields.z.value = '';
      return;
    }
    const entry = currentEntry();
    fields.x.value = entry ? String(entry.x) : '0';
    fields.y.value = entry ? String(entry.y) : '0';
    fields.w.value = entry && entry.w != null ? String(entry.w) : '';
    fields.h.value = entry && entry.h != null ? String(entry.h) : '';
    fields.scale.value = entry && entry.scale != null ? String(Math.round(entry.scale * 100)) : '';
    fields.z.value = entry && entry.z != null ? String(entry.z) : '';
  }

  function renderCrumbs() {
    crumbsEl.textContent = '';
    if (!state.selected || !state.selected.isConnected) {
      const hint = document.createElement('span');
      hint.className = 'spui-crumb-hint';
      hint.textContent = '点击画面里的元素开始调整 · Shift+点击可多选';
      crumbsEl.append(hint);
      state.chain = [];
      return;
    }
    if (isMulti()) {
      const badge = document.createElement('span');
      badge.className = 'spui-crumb-count';
      badge.textContent = `已选 ${state.selection.length} 个`;
      badge.title = '拖动任意一个选中元素 = 整组移动；拖四角 = 整组等比缩放';
      crumbsEl.append(badge);
      const sep0 = document.createElement('span');
      sep0.className = 'spui-crumb-sep';
      sep0.textContent = '›';
      crumbsEl.append(sep0);
    }
    const chain = [];
    let node = state.selected;
    while (node && node.nodeType === 1 && chain.length < 12) {
      chain.unshift(node);
      if (node.id === 'app') break;
      node = node.parentElement;
    }
    state.chain = chain;
    chain.forEach((el, index) => {
      if (index) {
        const sep = document.createElement('span');
        sep.className = 'spui-crumb-sep';
        sep.textContent = '›';
        crumbsEl.append(sep);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `spui-crumb${index === chain.length - 1 ? ' is-current' : ''}`;
      button.dataset.crumb = String(index);
      button.textContent = el.id === 'app' ? '#app' : labelFor(el);
      button.title = `${selectorFor(el)}\n点击选中这一层`;
      crumbsEl.append(button);
    });
    crumbsEl.scrollLeft = crumbsEl.scrollWidth;
  }

  const memberBoxes = [];

  /** 多选时每个成员画一个框（主选仍用金色框）。 */
  function renderMembers() {
    const extras = state.selection.slice(0, -1);
    while (memberBoxes.length < extras.length) {
      const box = document.createElement('div');
      box.className = 'spui-box spui-member';
      host.append(box);
      memberBoxes.push(box);
    }
    while (memberBoxes.length > extras.length) {
      const box = memberBoxes.pop();
      box.remove();
    }
    for (const box of memberBoxes) box.dataset.paint = '';
  }

  function renderSel() {
    // 屏幕切换后旧元素会失联，顺手清掉
    if (state.selection.some((el) => !el.isConnected)) {
      state.selection = state.selection.filter((el) => el.isConnected);
      state.selected = state.selection[state.selection.length - 1] || null;
    }
    const has = !!state.selected;
    const multi = isMulti();
    for (const [name, input] of Object.entries(fields)) {
      input.disabled = !has || (multi && name !== 'scale');
    }
    for (const btn of actionButtons) btn.disabled = !has;
    for (const btn of nudgeButtons) btn.disabled = !has;
    multiRow.hidden = !(state.multiMode || multi);
    for (const btn of multiRow.querySelectorAll('button')) btn.disabled = !has;
    renderCrumbs();
    renderMembers();
    if (!has) {
      handlesEl.hidden = true;
      schedulePublish();
      return;
    }
    syncFields();
    const entry = currentEntry();
    hideBtn.textContent = entry && entry.hidden ? '显示' : '隐藏';
    hideBtn.classList.toggle('is-on', !!entry && !!entry.hidden);
    updateInfo();
  }

  function updateInfo() {
    const status = state.saving ? '保存中…' : (state.apiOk ? (state.dirty ? '未保存' : '已同步') : '接口未安装');
    const picked = state.selection.length > 1 ? ` · 选中 ${state.selection.length}` : '';
    infoEl.textContent = `${innerWidth}×${innerHeight} · 1rem=${Math.round(remPx())}px · ${DEVICE_LABEL[state.kind]} ${entries().length} 项${picked} · ${status}`;
    infoEl.classList.toggle('is-bad', !state.apiOk);
    schedulePublish();
  }

  function refresh() {
    applyLayout(profile());
    renderDevices();
    renderSel();
    renderList();
    updateInfo();
  }

  function select(el, additive = false) {
    if (!el || el.nodeType !== 1) return;
    if (additive) {
      const index = state.selection.indexOf(el);
      if (index >= 0) {
        state.selection.splice(index, 1);
        state.selected = state.selection[state.selection.length - 1] || null;
      } else {
        state.selection.push(el);
        state.selected = el;
      }
    } else {
      state.selection = [el];
      state.selected = el;
    }
    renderSel();
  }

  const isMulti = () => state.selection.length > 1;

  function toast(text, bad = false) {
    toastEl.textContent = text;
    toastEl.classList.toggle('is-bad', bad);
    toastEl.classList.add('is-on');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 2800);
    emitEvent('toast', { text, bad: !!bad });
  }

  function switchKind(kind) {
    if (kind !== 'desktop' && kind !== 'mobile') return;
    if (kind === state.kind) return;
    state.kind = kind;
    state.selected = null;
    state.selection = [];
    refresh();
    const auto = currentDeviceKind();
    if (auto !== kind) {
      toast(`正在编辑${DEVICE_LABEL[kind]}方案；当前窗口是${DEVICE_LABEL[auto]}宽度，把窗口拉窄/拉宽到对应宽度才看得到该设备的原始布局`);
    } else {
      toast(`已切换到${DEVICE_LABEL[kind]}方案`);
    }
  }

  // ─────────────────────────────────────────────────────────── 选中 / 拖动
  // 按钮里的文字（span.btn__label）、图标（svg > path）默认不单独选，统一落到最近的交互容器；
  // 按住 Ctrl / 双击时反过来，专挑最里层。
  const INTERACTIVE = 'button, a[href], [role="button"], [role="tab"], [role="option"], .btn';

  /** 值得选中的元素（排除根节点、整屏容器、画布）。 */
  function acceptable(el) {
    return !!el && el.nodeType === 1
      && el.id !== 'app'
      && !el.classList.contains('screen')
      && el.tagName !== 'CANVAS';
  }

  /**
   * 按几何找最里层元素。elementFromPoint 看不见 pointer-events:none 的装饰层
   * （主界面的背景、光晕、雷达全是 none），只能自己按包围盒往下钻。
   */
  function deepestAt(x, y) {
    const root = document.getElementById('app');
    if (!root) return null;
    let best = null;
    const walk = (el) => {
      if (!(el instanceof Element)) return;
      const rect = el.getBoundingClientRect();
      const sized = rect.width > 0 && rect.height > 0;
      const inside = sized && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      // #app / .app-root 这类容器自己是 0 尺寸（子元素全是绝对定位），不能按尺寸剪枝，
      // 但已经"有尺寸且不含该点"的子树可以整块跳过。
      if (sized && !inside) return;
      if (inside && el !== root && acceptable(el)) best = el;
      for (const child of el.children) walk(child);
    };
    walk(root);
    return best;
  }

  function pickAt(x, y, deep = false, allowDeep = false) {
    const hit = document.elementFromPoint(x, y);
    if (hit && hit.nodeType === 1 && !isEditorNode(hit) && hit.closest('#app') && acceptable(hit)) {
      let el = hit;
      if (!deep) {
        const hostEl = hit.closest(INTERACTIVE);
        if (hostEl && hostEl !== hit && hostEl.closest('#app') && !hostEl.classList.contains('screen')) {
          const box = hostEl.getBoundingClientRect();
          if (box.width >= 8 && box.height >= 8) el = hostEl;
        }
      }
      const rect = el.getBoundingClientRect();
      if (rect.width >= 4 && rect.height >= 4) return el;
    }
    if (!allowDeep) return null;

    const deepEl = deepestAt(x, y);
    if (!deepEl) return null;
    if (deep) return deepEl;
    const hostEl = deepEl.closest(INTERACTIVE);
    if (hostEl && hostEl !== deepEl && hostEl.closest('#app') && !hostEl.classList.contains('screen')) {
      const box = hostEl.getBoundingClientRect();
      if (box.width >= 8 && box.height >= 8) return hostEl;
    }
    const rect = deepEl.getBoundingClientRect();
    return rect.width >= 4 && rect.height >= 4 ? deepEl : null;
  }

  /** 拾取模式下，除了面板本身，任何指针事件都不许落到游戏里（Alt 临时放行）。 */
  function swallow(event) {
    if (!state.editing) return false;
    if (event.altKey) return false;
    if (isEditorNode(event.target)) return false;
    if (holdStop) holdStop(); // 手指移出方向键再松开时，别让连发卡住
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  }

  function childUnderPoint() {
    const parent = state.selected;
    if (!parent) return null;
    const point = state.lastPoint || (() => {
      const rect = parent.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })();
    let best = null;
    let first = null;
    for (const child of parent.children) {
      if (!(child instanceof Element) || isEditorNode(child)) continue;
      const rect = child.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      if (!first) first = child;
      if (point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) best = child;
    }
    return best || first;
  }

  function onPointerDown(event) {
    if (!state.editing || event.button !== 0) return;
    if (isEditorNode(event.target)) return;
    if (event.altKey) return; // Alt+点击：放行给游戏，不选中

    event.preventDefault();
    event.stopImmediatePropagation();
    state.lastPoint = { x: event.clientX, y: event.clientY };

    const deep = event.ctrlKey || event.metaKey;
    const el = pickAt(event.clientX, event.clientY, deep, true);
    if (!el) {
      // 点到 #app 之外（启动动画、toast 等）：只吞掉，不改变选中
      return;
    }
    // Shift+点击、或多选模式下点未选中的元素：只加选，不开始拖动
    if (event.shiftKey || (state.multiMode && !state.selection.includes(el))) {
      select(el, true);
      return;
    }
    // 多选模式下点已选中的元素：可以整组拖动；松手没动就把它移出选择
    const toggleOnClick = state.multiMode && state.selection.includes(el);
    if (!state.selection.includes(el)) select(el);

    // 一次拖动把所有选中元素按同一位移移动
    const items = state.selection.map((target) => {
      const selector = selectorFor(target);
      const entry = entryOf(profile(), selector);
      return { selector, baseX: entry ? entry.x : 0, baseY: entry ? entry.y : 0 };
    });
    // 指针捕获：手指滑出这个元素也不丢事件（触屏"断触"的主要来源之一）
    try { el.setPointerCapture?.(event.pointerId); } catch { /* 忽略 */ }
    state.drag = {
      items,
      el,
      toggleOnClick,
      pointerId: event.pointerId,
      sx: event.clientX,
      sy: event.clientY,
      dx: 0,
      dy: 0,
      before: snapshot(),
      moved: false,
    };
  }

  let dragRaf = 0;

  /** 把当前拖动增量写进布局与样式（不落撤销点）。 */
  function applyDrag(drag) {
    if (!drag) return;
    for (const item of drag.items) {
      setEntry(profile(), item.selector, {
        x: round2(item.baseX + drag.dx),
        y: round2(item.baseY + drag.dy),
      });
    }
    applyLayout(profile());
    syncFields();
    schedulePublish();
  }

  /** 一帧只写一次样式表，触屏才跟手。 */
  function scheduleDrag() {
    if (dragRaf) return;
    dragRaf = requestAnimationFrame(() => {
      dragRaf = 0;
      applyDrag(state.drag);
    });
  }

  /** 结束拖动（松手 / 指针被系统收走）：落最后一帧，再记一个撤销点。 */
  function endDrag() {
    const drag = state.drag;
    if (!drag) return;
    state.drag = null;
    if (dragRaf) {
      cancelAnimationFrame(dragRaf);
      dragRaf = 0;
    }
    if (drag.moved) {
      applyDrag(drag);
      pushUndo(drag.before);
      renderList();
      updateInfo();
    } else if (drag.toggleOnClick && drag.el) {
      // 多选模式下"点一下"= 移出选择
      select(drag.el, true);
    } else {
      refresh();
    }
  }

  function onPointerMove(event) {
    if (!state.editing) return;

    if (state.resize) {
      const resize = state.resize;
      resize.dx = (event.clientX - resize.sx) * designPerPx();
      resize.dy = (event.clientY - resize.sy) * designPerPx();
      resize.moved = Math.abs(resize.dx) > 0.5 || Math.abs(resize.dy) > 0.5;
      resize.shift = event.shiftKey;
      scheduleResize();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (state.drag) {
      const drag = state.drag;
      let dx = (event.clientX - drag.sx) * designPerPx();
      let dy = (event.clientY - drag.sy) * designPerPx();
      if (event.shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const step = event.altKey ? STEP_FINE : STEP_DEFAULT;
      drag.dx = Math.round(dx / step) * step;
      drag.dy = Math.round(dy / step) * step;
      drag.moved = Math.abs(drag.dx) > 0.001 || Math.abs(drag.dy) > 0.001;
      scheduleDrag();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // 触屏没有悬停，别每帧做命中测试（会明显拖慢拖动）
    state.lastPoint = { x: event.clientX, y: event.clientY };
    state.hover = event.pointerType === 'touch' ? null : pickAt(event.clientX, event.clientY, false, true);
  }

  function onPointerUp(event) {
    if (!state.editing) return;
    if (state.resize) {
      if (event.pointerId !== undefined && state.resize.pointerId !== event.pointerId) return;
      endResize();
      return;
    }
    if (isEditorNode(event.target)) return;
    swallow(event); // 拾取模式下 pointerup 也不许落进游戏
    const drag = state.drag;
    if (!drag) return;
    if (event.pointerId !== undefined && drag.pointerId !== event.pointerId) return;
    endDrag();
  }

  /** 指针被系统收走（来电话、切换窗口、手势接管）时收尾，别留下卡住的拖动。 */
  function onPointerCancelEnd() {
    if (state.resize) {
      endResize();
      return;
    }
    endDrag();
  }

  // ─────────────────────────────────────────────────────────── 拖角/拖边改尺寸
  let resizeRaf = 0;

  function beginResize(handle, event) {
    const el = state.selected;
    if (!el) return;
    try { event.target.setPointerCapture?.(event.pointerId); } catch { /* 忽略 */ }

    // 多选：拖四角 = 整组按同一倍率缩放
    if (isMulti()) {
      const bound = unionRect();
      state.resize = {
        mode: 'scale',
        pointerId: event.pointerId,
        sx: event.clientX,
        sy: event.clientY,
        dx: 0,
        dy: 0,
        shift: false,
        moved: false,
        span: Math.max(60, (bound ? bound.width + bound.height : 200)),
        items: state.selection.map((target) => {
          const entry = entryOf(profile(), selectorFor(target));
          return { selector: selectorFor(target), baseScale: entry && entry.scale != null ? entry.scale : 1 };
        }),
        before: snapshot(),
      };
      return;
    }

    const selector = selectorFor(el);
    const entry = entryOf(profile(), selector);
    const rect = el.getBoundingClientRect();
    const rem = remPx();
    state.resize = {
      mode: 'size',
      handle,
      selector,
      pointerId: event.pointerId,
      sx: event.clientX,
      sy: event.clientY,
      dx: 0,
      dy: 0,
      shift: false,
      moved: false,
      // 没被覆盖过尺寸时，以元素当前实际尺寸为起点（换算成设计像素）
      base: {
        x: entry ? entry.x : 0,
        y: entry ? entry.y : 0,
        w: entry && entry.w != null ? entry.w : (rect.width * 100) / rem,
        h: entry && entry.h != null ? entry.h : (rect.height * 100) / rem,
      },
      before: snapshot(),
    };
  }

  function applyResize() {
    const resize = state.resize;
    if (!resize) return;

    // 多选等比缩放：拖动的对角位移换算成一个共同倍率
    if (resize.mode === 'scale') {
      const factor = Math.min(4, Math.max(0.2, 1 + (resize.dx + resize.dy) / resize.span));
      for (const item of resize.items) {
        setEntry(profile(), item.selector, { scale: Math.round(item.baseScale * factor * 1000) / 1000 });
      }
      applyLayout(profile());
      syncFields();
      schedulePublish();
      return;
    }

    const { base, handle } = resize;
    let w = base.w;
    let h = base.h;
    let x = base.x;
    let y = base.y;

    if (handle.includes('e')) w = base.w + resize.dx;
    if (handle.includes('s')) h = base.h + resize.dy;
    if (handle.includes('w')) { w = base.w - resize.dx; x = base.x + resize.dx; }
    if (handle.includes('n')) { h = base.h - resize.dy; y = base.y + resize.dy; }

    // Shift：四角保持长宽比
    if (resize.shift && handle.length === 2) {
      const ratio = base.h / base.w;
      if (Math.abs(w - base.w) >= Math.abs(h - base.h)) h = w * ratio;
      else w = h / ratio;
      if (handle.includes('w')) x = base.x + (base.w - w);
      if (handle.includes('n')) y = base.y + (base.h - h);
    }

    const MIN = 4;
    if (w < MIN) { if (handle.includes('w')) x = base.x + (base.w - MIN); w = MIN; }
    if (h < MIN) { if (handle.includes('n')) y = base.y + (base.h - MIN); h = MIN; }

    setEntry(profile(), resize.selector, { x: round2(x), y: round2(y), w: round2(w), h: round2(h) });
    applyLayout(profile());
    syncFields();
    schedulePublish();
  }

  function scheduleResize() {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      applyResize();
    });
  }

  function endResize() {
    const resize = state.resize;
    if (!resize) return;
    state.resize = null;
    if (resizeRaf) {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = 0;
    }
    if (resize.moved) {
      applyResize();
      pushUndo(resize.before);
      renderList();
      updateInfo();
    }
  }

  const STEPS = [0.5, 1, 5, 10];

  /** 只改数据、不落撤销点（长按连发时用）。多选时整组一起走。 */
  function applyNudge(dx, dy, step) {
    if (!state.selection.length) return false;
    for (const el of state.selection) {
      const selector = selectorFor(el);
      const entry = entryOf(profile(), selector);
      setEntry(profile(), selector, {
        x: round2((entry ? entry.x : 0) + dx * step),
        y: round2((entry ? entry.y : 0) + dy * step),
      });
    }
    applyLayout(profile());
    syncFields();
    renderList();
    updateInfo();
    schedulePublish();
    return true;
  }

  function nudge(dx, dy, step) {
    if (!state.selected) return;
    const before = snapshot();
    if (!applyNudge(dx, dy, step)) return;
    pushUndo(before);
  }

  function setStep(next) {
    state.step = next;
    if (!stepBtn) return;
    stepBtn.textContent = String(next);
    stepBtn.title = `微调步长 ${next} 设计像素（点击切换：0.5 / 1 / 5 / 10）`;
    schedulePublish();
  }

  function cycleStep() {
    const index = STEPS.indexOf(state.step);
    setStep(STEPS[(index + 1) % STEPS.length] || 1);
    toast(`微调步长：${state.step} 设计像素（方向键 / 触摸方向键同一步长）`);
  }

  // 长按连发：按下立即走一步，420ms 后每 80ms 一步；整段只落一个撤销点。
  let holdStop = null;
  function beginHold(button, dx, dy, event) {
    if (!state.selected) return;
    if (holdStop) holdStop();
    // 指针捕获：手指移出按钮再松开，pointerup 仍然回到这个按钮上
    try { button.setPointerCapture?.(event.pointerId); } catch { /* 忽略 */ }
    const before = snapshot();
    let moved = 0;
    let timer = 0;
    let repeat = 0;

    const stop = () => {
      clearTimeout(timer);
      clearInterval(repeat);
      window.removeEventListener('pointerup', stop, true);
      window.removeEventListener('pointercancel', stop, true);
      button.removeEventListener('pointerleave', stop);
      if (moved) pushUndo(before);
      holdStop = null;
    };

    const tick = () => {
      if (!state.selected) { stop(); return; }
      if (applyNudge(dx, dy, state.step)) moved++;
    };

    holdStop = stop;
    tick();
    timer = setTimeout(() => { repeat = setInterval(tick, 80); }, 420);
    window.addEventListener('pointerup', stop, true);
    window.addEventListener('pointercancel', stop, true);
    button.addEventListener('pointerleave', stop);
  }

  // ─────────────────────────────────────────────────────────── 键盘
  function onKeyDown(event) {
    const target = event.target;
    const inEditor = target instanceof Element && isEditorNode(target);
    const formField = target instanceof Element
      && (target.matches('input, textarea, select') || target.isContentEditable);

    if (event.key === 'Shift' && !inEditor && !formField) {
      // 按住 Shift = 临时多选：自动切到 UI 编辑并高亮，Shift+点击加选。
      if (!state.shiftHeld) {
        state.shiftHeld = true;
        if (!state.editing) toggleEditing();
        schedulePublish();
      }
      return;
    }

    if (event.key === 'Tab' && !inEditor && !formField && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      toggleEditing();
      return;
    }
    if (event.key === 'Escape') {
      if (inEditor) return;
      if (modal.hidden === false) {
        modal.hidden = true;
        return;
      }
      state.selection = [];
      state.selected = null;
      renderSel();
      return;
    }
    if (!inEditor && !event.ctrlKey && !event.metaKey && (event.key === 'h' || event.key === 'H')) {
      event.preventDefault();
      toggleHandles();
      return;
    }
    if (!state.editing) return;

    if (event.ctrlKey || event.metaKey) {
      const key = String(event.key || '').toLowerCase();
      if (key === 's') {
        event.preventDefault();
        void save();
      } else if (key === 'z' && !inEditor) {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (key === 'y' && !inEditor) {
        event.preventDefault();
        redo();
      }
      return;
    }
    if (!state.selected || inEditor) return;

    const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const dir = dirs[event.key];
    if (!dir) return;
    event.preventDefault();
    event.stopPropagation();
    nudge(dir[0], dir[1], event.shiftKey ? STEP_KEY_FAST : STEP_KEY);
  }

  // ─────────────────────────────────────────────────────────── 操作
  function toggleEditing() {
    state.editing = !state.editing;
    host.classList.toggle('spui--edit', state.editing);
    document.documentElement.classList.toggle('spui-editing', state.editing);
    modeBtn.textContent = state.editing ? '拾取中' : '操作中';
    modeBtn.classList.toggle('is-on', state.editing);
    hintEl.hidden = !state.editing;
    if (!state.editing) state.hover = null;
    toast(state.editing
      ? 'UI 编辑模式：点击只选中元素，不会触发游戏按钮（Alt+点击可临时放行）'
      : '游戏内点击模式：点击直接操作游戏（Tab 切回 UI 编辑）');
    schedulePublish();
  }

  /** 面板上的「多选」开关：打开后普通点击 = 加入 / 移出选择，不用按 Shift。 */
  function toggleMultiMode(force) {
    const next = typeof force === 'boolean' ? force : !state.multiMode;
    if (next === state.multiMode) return;
    // 进入多选先切回 UI 编辑模式，否则点击会直接落到游戏里。
    if (next && !state.editing) toggleEditing();
    state.multiMode = next;
    if (!next) {
      // 关闭多选 = 取消选择。
      state.selected = null;
      state.selection = [];
    }
    multiBtn.classList.toggle('is-on', state.multiMode);
    renderSel();
    toast(state.multiMode
      ? '多选模式：点元素加入选择，再点一次移出；拖动已选元素 = 整组移动，拖四角 = 整组缩放'
      : '多选模式已关闭，已取消选择');
    schedulePublish();
  }

  /** 把和当前主选同类（同标签、同首类名）的元素一起选上；父级没有再往上找一层。 */
  function selectSiblings() {
    const el = state.selected;
    if (!el) return;
    const firstClass = [...el.classList].find((name) => !name.startsWith('is-')) || '';
    const collect = (scope) => [...scope.querySelectorAll(el.tagName)]
      .filter((child) => child !== el
        && (firstClass ? child.classList.contains(firstClass) : true)
        && child.getBoundingClientRect().width > 1)
      .slice(0, 40);

    let matches = [];
    let scope = el.parentElement;
    for (let depth = 0; depth < 2 && scope && !matches.length; depth++) {
      matches = collect(scope);
      scope = scope.parentElement;
    }
    if (!matches.length) {
      toast('没有找到同类元素（同标签 + 同首类名）', true);
      return;
    }
    state.selection = [el, ...matches];
    state.selected = matches[matches.length - 1] || el;
    renderSel();
    toast(`已选 ${state.selection.length} 个同类元素`);
  }

  function undo() {
    const before = state.undo.pop();
    if (!before) return;
    state.redo.push(snapshot());
    state.layout = before;
    state.dirty = true;
    refresh();
  }

  function redo() {
    const next = state.redo.pop();
    if (!next) return;
    state.undo.push(snapshot());
    state.layout = next;
    state.dirty = true;
    refresh();
  }

  async function save() {
    if (state.saving) return;
    state.saving = true;
    updateInfo();
    const result = await saveLayout(state.layout);
    state.saving = false;
    state.apiOk = result.ok;
    const counts = result.counts || { desktop: entriesOf('desktop').length, mobile: entriesOf('mobile').length };
    if (result.ok) {
      state.dirty = false;
      toast(`已保存：电脑版 ${counts.desktop} 项 · 手机端 ${counts.mobile} 项`);
    } else {
      toast(`保存失败：${result.error}（先运行 UI-Editor\\install.bat 安装保存接口）`, true);
    }
    updateInfo();
    schedulePublish(true);
    emitEvent('saved', {
      ok: result.ok,
      counts,
      savedAt: result.savedAt || null,
      error: result.error || null,
    });
  }

  async function reload() {
    const result = await fetchLayout();
    state.apiOk = result.ok;
    if (!result.ok) {
      toast(`读取失败：${result.error}`, true);
      updateInfo();
      return;
    }
    state.layout = result.layout;
    state.undo.length = 0;
    state.redo.length = 0;
    state.dirty = false;
    state.selected = null;
    state.selection = [];
    refresh();
    toast(`已从磁盘重新载入（电脑版 ${entriesOf('desktop').length} 项 · 手机端 ${entriesOf('mobile').length} 项）`);
  }

  function clearAll(confirmed = false) {
    if (!entries().length) return;
    if (!confirmed && !window.confirm(`清空${DEVICE_LABEL[state.kind]}的 ${entries().length} 项调整？（可用「撤销」恢复，未保存前不影响磁盘）`)) return;
    const before = snapshot();
    profile().entries = [];
    pushUndo(before);
    state.selected = null;
    state.selection = [];
    refresh();
  }

  // ─── 存档：按游戏版本分开，存在工具目录的 profiles\，可多份 ───
  async function refreshProfiles() {
    try {
      const res = await fetch('/ui-editor/profiles', { cache: 'no-store' });
      if (!res.ok) return;
      const body = await res.json();
      if (!body?.ok) return;
      state.profiles = Array.isArray(body.profiles) ? body.profiles : [];
      state.versionKey = body.current || '';
      profilesRow.hidden = false;
      profileSelect.textContent = '';
      if (!state.profiles.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '（还没有存档，按「存」新建）';
        profileSelect.append(option);
        emitEvent('profiles', { list: [], selectedId: '', current: state.versionKey });
        return;
      }
      for (const item of state.profiles) {
        const option = document.createElement('option');
        option.value = item.id;
        const counts = item.counts ? `（电脑版 ${item.counts.desktop} · 手机端 ${item.counts.mobile}）` : '';
        option.textContent = `${item.name}${counts}`;
        profileSelect.append(option);
      }
      const auto = state.profiles.find((item) => item.auto);
      profileSelect.value = (auto || state.profiles[0]).id;
      emitEvent('profiles', {
        list: state.profiles,
        selectedId: profileSelect.value,
        current: state.versionKey,
      });
    } catch { /* 游戏内版没有这个接口，保持隐藏 */ }
  }

  async function saveProfileToDisk(name) {
    if (!name) {
      name = window.prompt('存档名字（换版本 / 换机器时，把工具目录的 profiles 文件夹一起带走就能继续用）',
        `存档 ${new Date().toLocaleString()}`);
    }
    if (!name) return;
    try {
      const res = await fetch('/ui-editor/profiles/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, layout: state.layout }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      toast(`已新建存档：${name}`);
      await refreshProfiles();
    } catch (error) {
      toast(`存档失败：${error?.message || error}`, true);
    }
  }

  async function loadProfileFromDisk(id, confirmed = false) {
    id = id || profileSelect.value;
    if (!id) { toast('还没有可载入的存档', true); return; }
    const meta = state.profiles.find((item) => item.id === id);
    if (!confirmed && !window.confirm(`载入存档「${meta?.name || id}」？当前未保存的调整会被覆盖（可用「撤销」回退）。`)) return;
    const before = snapshot();
    try {
      const res = await fetch('/ui-editor/profiles/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      state.layout = normalizeLayout(body.layout);
      pushUndo(before);
      state.selected = null;
      state.selection = [];
      refresh();
      await refreshProfiles();
      toast(`已载入存档：${meta?.name || id}`);
    } catch (error) {
      toast(`载入失败：${error?.message || error}`, true);
    }
  }

  async function deleteProfileFromDisk(id, confirmed = false) {
    id = id || profileSelect.value;
    if (!id) return;
    const meta = state.profiles.find((item) => item.id === id);
    if (!confirmed && !window.confirm(`删除存档「${meta?.name || id}」？删掉就找不回来了。`)) return;
    try {
      const res = await fetch('/ui-editor/profiles/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      toast('存档已删除');
      await refreshProfiles();
    } catch (error) {
      toast(`删除失败：${error?.message || error}`, true);
    }
  }

  function copyOther(confirmed = false) {
    const from = otherKind();
    const source = entriesOf(from);
    if (!source.length) {
      toast(`${DEVICE_LABEL[from]}还没有调整，没有可复制的`, true);
      return;
    }
    if (!confirmed && !window.confirm(`用${DEVICE_LABEL[from]}的 ${source.length} 项覆盖${DEVICE_LABEL[state.kind]}方案？（可用「撤销」恢复）`)) return;
    const before = snapshot();
    profile().entries = JSON.parse(JSON.stringify(source));
    pushUndo(before);
    state.selected = null;
    state.selection = [];
    refresh();
  }

  function openCss() {
    cssTitle.textContent = `生成的 CSS · ${DEVICE_LABEL[state.kind]}`;
    cssText.value = toCss(profile()) || '/* 这套方案还没有任何调整 */\n';
    modal.hidden = false;
    cssText.focus();
    cssText.select();
  }

  async function copyCss() {
    const text = cssText.value;
    try {
      await navigator.clipboard.writeText(text);
      toast('CSS 已复制到剪贴板');
    } catch {
      cssText.select();
      try {
        document.execCommand('copy');
        toast('CSS 已复制到剪贴板');
      } catch {
        toast('复制失败，请手动全选复制', true);
      }
    }
  }

  function downloadCss() {
    try {
      const blob = new Blob([cssText.value], { type: 'text/css;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ui-layout-${state.kind}.css`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast(`已导出 ui-layout-${state.kind}.css`);
    } catch (error) {
      toast(`下载被浏览器拦截：${error?.message || error}，请手动复制`, true);
    }
  }

  // ─────────────────────────────────────────────────────────── 面板事件
  host.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    // 层级面包屑：点哪一段就选哪一层
    const crumb = target.closest('[data-crumb]');
    if (crumb) {
      const el = state.chain?.[Number(crumb.dataset.crumb)];
      if (el && el.isConnected) select(el);
      return;
    }

    const jump = target.closest('[data-jump]');
    if (jump) {
      const el = elementFor(jump.dataset.jump);
      if (el) select(el);
      else toast('当前界面没有这个元素，先切到它所在的界面', true);
      return;
    }

    const drop = target.closest('[data-drop]');
    if (drop) {
      const before = snapshot();
      removeEntry(profile(), drop.dataset.drop);
      pushUndo(before);
      refresh();
      return;
    }

    const button = target.closest('button[data-act]');
    if (!button) return;

    switch (button.dataset.act) {
      case 'kind': switchKind(button.dataset.kind); break;
      case 'copy': copyOther(); break;
      case 'profile-save': void saveProfileToDisk(); break;
      case 'profile-load': void loadProfileFromDisk(); break;
      case 'profile-delete': void deleteProfileFromDisk(); break;
      case 'handles': toggleHandles(); break;
      case 'multi': toggleMultiMode(); break;
      case 'addparent': {
        const el = state.selected && state.selected.parentElement;
        if (el && el.closest('#app') && el.id !== 'app' && !el.classList.contains('screen')) select(el, true);
        break;
      }
      case 'siblings': selectSiblings(); break;
      case 'clearsel':
        state.selection = [];
        state.selected = null;
        renderSel();
        break;
      case 'mode': toggleEditing(); break;
      case 'collapse': panel.hidden = true; fab.hidden = false; break;
      case 'expand': panel.hidden = false; fab.hidden = true; break;
      case 'save': void save(); break;
      case 'reload': void reload(); break;
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'clear': clearAll(); break;
      case 'css': openCss(); break;
      case 'close-modal': modal.hidden = true; break;
      case 'copy-css-modal': void copyCss(); break;
      case 'download': downloadCss(); break;
      case 'zero': {
        if (!state.selection.length) break;
        const before = snapshot();
        for (const el of state.selection) setEntry(profile(), selectorFor(el), { x: 0, y: 0 });
        pushUndo(before);
        refresh();
        break;
      }
      case 'hide': {
        if (!state.selection.length) break;
        const entry = currentEntry();
        const hidden = !(entry && entry.hidden);
        const before = snapshot();
        for (const el of state.selection) setEntry(profile(), selectorFor(el), { hidden });
        pushUndo(before);
        refresh();
        break;
      }
      case 'reset': {
        if (!state.selection.length) break;
        const before = snapshot();
        for (const el of state.selection) removeEntry(profile(), selectorFor(el));
        pushUndo(before);
        refresh();
        break;
      }
      case 'parent': {
        const el = state.selected && state.selected.parentElement;
        if (!el || !el.closest('#app') || el.id === 'app' || el.classList.contains('screen')) break;
        select(el);
        break;
      }
      case 'child': {
        const el = childUnderPoint();
        if (el) select(el);
        else toast('这一层没有可选的子元素', true);
        break;
      }
      default: break;
    }
  });

  // 输入框：输入即生效，失焦/回车落一步撤销点
  for (const input of Object.values(fields)) {
    input.addEventListener('focus', () => { state.editBefore = snapshot(); });
    input.addEventListener('input', () => {
      if (!state.selected) return;
      const num = (value, fallback) => {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
      };
      // 多选：只有「缩放%」是共同属性，写给整组
      if (isMulti()) {
        if (input.dataset.field !== 'scale') return;
        const scale = fields.scale.value.trim() === '' ? null : num(fields.scale.value, 100) / 100;
        for (const el of state.selection) setEntry(profile(), selectorFor(el), { scale });
        applyLayout(profile());
        renderList();
        updateInfo();
        return;
      }
      setEntry(profile(), selectorFor(state.selected), {
        x: num(fields.x.value, 0),
        y: num(fields.y.value, 0),
        w: fields.w.value.trim() === '' ? null : num(fields.w.value, null),
        h: fields.h.value.trim() === '' ? null : num(fields.h.value, null),
        scale: fields.scale.value.trim() === '' ? null : num(fields.scale.value, 100) / 100,
        z: fields.z.value.trim() === '' ? null : Math.round(num(fields.z.value, 0)),
      });
      applyLayout(profile());
      renderList();
      updateInfo();
    });
    input.addEventListener('change', () => {
      if (state.editBefore) {
        pushUndo(state.editBefore);
        state.editBefore = null;
      }
    });
  }

  // 触摸方向键：按下微调一步，按住连发（触屏上比拖拽稳得多）
  for (const button of nudgeButtons) {
    button.addEventListener('pointerdown', (event) => {
      if (!state.selected || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const [dx, dy] = String(button.dataset.nudge || '').split(',').map(Number);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      beginHold(button, dx, dy, event);
    });
    button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); });
  }
  stepBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    cycleStep();
  });
  setStep(state.step);

  // 拖角 / 拖边改尺寸
  for (const handleView of handleViews) {
    handleView.addEventListener('pointerdown', (event) => {
      if (!state.selected || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      beginResize(handleView.dataset.handle, event);
    });
  }

  // 面板拖动
  head.addEventListener('pointerdown', (event) => {
    if (event.target instanceof Element && event.target.closest('button')) return;
    const rect = panel.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    head.setPointerCapture(event.pointerId);
    const move = (ev) => {
      const left = Math.max(0, Math.min(innerWidth - 120, start.left + ev.clientX - start.x));
      const top = Math.max(0, Math.min(innerHeight - 40, start.top + ev.clientY - start.y));
      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(top)}px`;
      panel.style.right = 'auto';
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({ left: panel.style.left, top: panel.style.top }));
      } catch { /* 隐私模式忽略 */ }
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
    event.preventDefault();
  });

  // 恢复面板位置
  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (saved && saved.left && saved.top) {
      panel.style.left = saved.left;
      panel.style.top = saved.top;
      panel.style.right = 'auto';
    }
  } catch { /* ignore */ }

  // ─────────────────────────────────────────────────────────── 高亮框
  function hideBox(box, tag) {
    box.classList.remove('is-on');
    if (tag) tag.classList.remove('is-on');
    box.dataset.paint = '';
  }

  function placeBox(box, tag, el, isSelected) {
    if (!el || !el.isConnected) { hideBox(box, tag); return null; }
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 && rect.height < 1) { hideBox(box, tag); return null; }
    const label = isSelected
      ? `${labelFor(el)} · ${Math.round(rect.width)}×${Math.round(rect.height)}`
      : labelFor(el);
    // 位置没变就不写样式：空闲时每帧 0 次样式写入，触屏才不会被高亮框拖慢
    const key = `${Math.round(rect.left)}|${Math.round(rect.top)}|${Math.round(rect.width)}|${Math.round(rect.height)}|${label}`;
    if (box.dataset.paint !== key) {
      box.dataset.paint = key;
      box.classList.add('is-on');
      box.style.transform = `translate3d(${Math.round(rect.left)}px, ${Math.round(rect.top)}px, 0)`;
      box.style.width = `${Math.round(rect.width)}px`;
      box.style.height = `${Math.round(rect.height)}px`;
      if (tag) {
        tag.classList.add('is-on');
        const offset = 21 / (state.zoom || 1);
        const top = rect.top > offset ? rect.top - offset : rect.top + 2;
        tag.style.transform = `translate3d(${Math.round(rect.left)}px, ${Math.round(top)}px, 0)`;
        tag.textContent = label;
      }
    }
    return rect;
  }

  /** 所有选中元素的并集矩形。 */
  function unionRect() {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const el of state.selection) {
      if (!el.isConnected) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 && rect.height < 1) continue;
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    if (!Number.isFinite(left)) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  /** 把缩放手柄贴到选框上（贴着选框外侧；太小或手动关掉时隐藏）。 */
  function positionHandles(rect, multi = false) {
    if (!state.handles || !rect || rect.width < 18 || rect.height < 18) {
      handlesEl.hidden = true;
      return;
    }
    handlesEl.hidden = false;
    // 多选只留四角（拖角 = 整组等比缩放）；小元素也只留四角
    const onScreen = (state.zoom || 1);
    // 四角 + 四边共 8 个手柄始终保留；元素太小时由 positionHandles 的整体阈值处理。
    handlesEl.classList.remove('is-compact');
    handlesEl.classList.toggle('is-multi', multi);
    // 不要四舍五入：手柄按整像素偏移时可能压住元素边缘一个像素
    handlesEl.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`;
    handlesEl.style.width = `${rect.width}px`;
    handlesEl.style.height = `${rect.height}px`;
  }

  function toggleHandles(force) {
    state.handles = typeof force === 'boolean' ? force : !state.handles;
    const button = q('[data-act="handles"]');
    if (button) button.classList.toggle('is-on', state.handles);
    if (!state.handles) handlesEl.hidden = true;
    toast(state.handles ? '缩放手柄已显示（按 H 隐藏）' : '缩放手柄已隐藏（按 H 显示）：现在拖元素任意位置都是移动');
    schedulePublish();
  }

  // ─────────────────────────────────────────────────────────── 编辑台桥（iframe ↔ 侧边栏）
  function schedulePublish(immediate = false) {
    if (!state.embed) return;
    if (immediate) {
      if (publishTimer) { clearTimeout(publishTimer); publishTimer = 0; }
      publishNow();
      return;
    }
    if (publishTimer) return;
    publishTimer = setTimeout(publishNow, 40);
  }

  function publishNow() {
    publishTimer = 0;
    emitEvent('state', buildState());
  }

  function buildState() {
    const selected = state.selected && state.selected.isConnected ? state.selected : null;
    const rem = remPx();
    let selectedInfo = null;
    if (selected) {
      const selector = selectorFor(selected);
      const entry = entryOf(profile(), selector);
      const rect = selected.getBoundingClientRect();
      const chain = [];
      let node = selected;
      while (node && node.nodeType === 1 && chain.length < 12) {
        chain.unshift({
          label: node.id === 'app' ? '#app' : labelFor(node),
          selector: selectorFor(node),
        });
        if (node.id === 'app') break;
        node = node.parentElement;
      }
      selectedInfo = {
        selector,
        label: labelFor(selected),
        x: entry ? entry.x : 0,
        y: entry ? entry.y : 0,
        w: entry ? entry.w : null,
        h: entry ? entry.h : null,
        scale: entry ? entry.scale : null,
        z: entry ? entry.z : null,
        hidden: !!(entry && entry.hidden),
        image: entry ? entry.image || null : null,
        imageMode: entry ? entry.imageMode || 'replace' : 'replace',
        imageFit: entry ? entry.imageFit || 'cover' : 'cover',
        actualW: Math.round((rect.width * 100) / rem),
        actualH: Math.round((rect.height * 100) / rem),
        chain,
      };
    }
    return {
      kind: state.kind,
      editing: state.editing,
      handles: state.handles,
      multiMode: state.multiMode,
      step: state.step,
      dirty: state.dirty,
      saving: state.saving,
      apiOk: state.apiOk,
      counts: { desktop: entriesOf('desktop').length, mobile: entriesOf('mobile').length },
      entries: entries().map((entry) => ({ ...entry })),
      selected: selectedInfo,
      selectionCount: state.selection.length,
      shiftHeld: !!state.shiftHeld,
      winW: innerWidth,
      winH: innerHeight,
    };
  }

  /** 侧边栏输入框：输入即生效，撤销点由 editBegin / editEnd 包起来。 */
  function applyField(field, raw) {
    if (!state.selected) return;
    const value = String(raw == null ? '' : raw).trim();
    const num = (v, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    if (isMulti()) {
      if (field !== 'scale') return;
      const scale = value === '' ? null : num(value, 100) / 100;
      for (const el of state.selection) setEntry(profile(), selectorFor(el), { scale });
    } else {
      const patch = {};
      if (field === 'x') patch.x = num(value, 0);
      else if (field === 'y') patch.y = num(value, 0);
      else if (field === 'w') patch.w = value === '' ? null : num(value, null);
      else if (field === 'h') patch.h = value === '' ? null : num(value, null);
      else if (field === 'scale') patch.scale = value === '' ? null : num(value, 100) / 100;
      else if (field === 'z') patch.z = value === '' ? null : Math.round(num(value, 0));
      else return;
      setEntry(profile(), selectorFor(state.selected), patch);
    }
    applyLayout(profile());
    syncFields();
    renderList();
    updateInfo();
    schedulePublish();
  }

  /** 侧边栏 → 编辑引擎。返回 Promise 以便外壳等待保存等异步动作。 */
  async function dispatch(action, data = {}) {
    switch (action) {
      case 'nudge':
        nudge(Number(data.dx) || 0, Number(data.dy) || 0, Number(data.step) || state.step);
        break;
      case 'nudgeNoUndo':
        applyNudge(Number(data.dx) || 0, Number(data.dy) || 0, Number(data.step) || state.step);
        break;
      case 'batchBegin':
        state.batchBefore = snapshot();
        break;
      case 'batchEnd':
        if (state.batchBefore) {
          pushUndo(state.batchBefore);
          state.batchBefore = null;
        }
        break;
      case 'editBegin':
        state.editBefore = snapshot();
        break;
      case 'editEnd':
        if (state.editBefore) {
          pushUndo(state.editBefore);
          state.editBefore = null;
        }
        break;
      case 'setField':
        applyField(data.field, data.value);
        break;
      case 'select': {
        const el = elementFor(data.selector);
        if (el) select(el);
        else toast('当前界面没有这个元素，先切到它所在的界面', true);
        break;
      }
      case 'crumb': {
        const el = state.chain?.[Number(data.index)];
        if (el && el.isConnected) select(el);
        break;
      }
      case 'parent': {
        const el = state.selected && state.selected.parentElement;
        if (el && el.closest('#app') && el.id !== 'app' && !el.classList.contains('screen')) select(el);
        break;
      }
      case 'child': {
        const el = childUnderPoint();
        if (el) select(el);
        else toast('这一层没有可选的子元素', true);
        break;
      }
      case 'siblings':
        selectSiblings();
        break;
      case 'addparent': {
        const el = state.selected && state.selected.parentElement;
        if (el && el.closest('#app') && el.id !== 'app' && !el.classList.contains('screen')) select(el, true);
        break;
      }
      case 'clearsel':
        state.selection = [];
        state.selected = null;
        renderSel();
        break;
      case 'hide': {
        if (!state.selection.length) break;
        const entry = currentEntry();
        const hidden = !(entry && entry.hidden);
        const before = snapshot();
        for (const el of state.selection) setEntry(profile(), selectorFor(el), { hidden });
        pushUndo(before);
        refresh();
        break;
      }
      case 'zero': {
        if (!state.selection.length) break;
        const before = snapshot();
        for (const el of state.selection) setEntry(profile(), selectorFor(el), { x: 0, y: 0 });
        pushUndo(before);
        refresh();
        break;
      }
      case 'reset': {
        if (!state.selection.length) break;
        const before = snapshot();
        for (const el of state.selection) removeEntry(profile(), selectorFor(el));
        pushUndo(before);
        refresh();
        break;
      }
      case 'dropEntry': {
        const before = snapshot();
        removeEntry(profile(), data.selector);
        pushUndo(before);
        refresh();
        break;
      }
      case 'copyOther':
        copyOther(!!data.confirmed);
        break;
      case 'clearAll':
        clearAll(!!data.confirmed);
        break;
      case 'undo':
        undo();
        break;
      case 'redo':
        redo();
        break;
      case 'save':
        await save();
        break;
      case 'reload':
        await reload();
        break;
      case 'profileSave':
        await saveProfileToDisk(data.name);
        break;
      case 'profileLoad':
        await loadProfileFromDisk(data.id, !!data.confirmed);
        break;
      case 'profileDelete':
        await deleteProfileFromDisk(data.id, !!data.confirmed);
        break;
      case 'profilesRefresh':
        await refreshProfiles();
        break;
      case 'exportCss':
        emitEvent('css', { kind: state.kind, css: toCss(profile()) || '/* 这套方案还没有任何调整 */\n' });
        break;
      case 'setEditing':
        if (!!data.on !== state.editing) toggleEditing();
        break;
      case 'setHandles':
        if (typeof data.on === 'boolean') toggleHandles(data.on);
        break;
      case 'setMulti':
        toggleMultiMode(data.on);
        break;
      case 'setImage': {
        if (!state.selection.length) break;
        const patch = {
          image: data.url || null,
          imageMode: data.mode === 'overlay' ? 'overlay' : 'replace',
          imageFit: ['contain', 'stretch', 'cover'].includes(data.fit) ? data.fit : 'cover',
        };
        const before = snapshot();
        for (const el of state.selection) setEntry(profile(), selectorFor(el), patch);
        pushUndo(before);
        applyLayout(profile());
        refresh();
        toast(patch.image ? `已用图片替换：${labelFor(state.selected)}` : '已清除图片');
        break;
      }
      case 'setImageOption': {
        if (!state.selected) break;
        const entry = currentEntry();
        if (!entry || !entry.image) { toast('当前元素还没有图片', true); break; }
        const patch = {};
        if (data.mode) patch.imageMode = data.mode === 'overlay' ? 'overlay' : 'replace';
        if (data.fit) patch.imageFit = ['contain', 'stretch'].includes(data.fit) ? data.fit : 'cover';
        const before = snapshot();
        setEntry(profile(), selectorFor(state.selected), patch);
        pushUndo(before);
        applyLayout(profile());
        refresh();
        break;
      }
      case 'inspect': {
        // 检查 UI 由什么构成：标签 / 图片 / SVG / Canvas / 背景图 / 子元素数量。
        const el = state.selected || document.getElementById('app');
        if (!el) break;
        const rem = remPx();
        const rect = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const beforeCs = getComputedStyle(el, '::before');
        const afterCs = getComputedStyle(el, '::after');
        emitEvent('inspect', {
          label: labelFor(el),
          selector: selectorFor(el),
          tag: el.tagName,
          size: `${Math.round((rect.width * 100) / rem)} × ${Math.round((rect.height * 100) / rem)}`,
          bgImage: (cs.backgroundImage || 'none').slice(0, 200),
          bgColor: cs.backgroundColor || '',
          border: cs.border || '',
          radius: cs.borderRadius || '',
          before: { content: beforeCs.content, bg: (beforeCs.backgroundImage || 'none').slice(0, 160) },
          after: { content: afterCs.content, bg: (afterCs.backgroundImage || 'none').slice(0, 160) },
          counts: {
            img: el.querySelectorAll('img').length,
            svg: el.querySelectorAll('svg').length,
            canvas: el.querySelectorAll('canvas').length,
            div: el.querySelectorAll('div').length,
            button: el.querySelectorAll('button').length,
          },
          children: [...el.children].slice(0, 12).map((child) => ({
            label: labelFor(child),
            tag: child.tagName,
            img: child.tagName === 'IMG' || !!child.querySelector('img'),
            svg: child.tagName === 'SVG' || !!child.querySelector('svg'),
          })),
        });
        break;
      }
      case 'setStep':
        setStep(Number(data.step) || state.step);
        break;
      case 'captureMode':
        host.classList.toggle('spui--capture', !!data.on);
        break;
      case 'state':
        publishNow();
        break;
      case 'toast':
        toast(String(data.text || ''), !!data.bad);
        break;
      default:
        break;
    }
    schedulePublish();
  }

  /** 舞台被外壳缩放时，把选框/手柄/标签反向缩放，保证屏幕上大小稳定。 */
  function setZoom(zoom) {
    const value = Number(zoom);
    state.zoom = Number.isFinite(value) && value > 0 ? Math.min(3, Math.max(0.2, value)) : 1;
    host.style.setProperty('--spui-inv', String(1 / state.zoom));
    host.style.setProperty('--spui-zoom', String(state.zoom));
    if (state.selected) renderSel();
  }

  let framePending = false;
  function frame() {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      if (!state.editing) {
        // 游戏内点击模式：仍然画出当前选中框（不挡点击），只是不画悬停框和手柄。
        hideBox(boxes.hover.box, boxes.hover.tag);
        const selected = state.selected && state.selected.isConnected ? state.selected : null;
        placeBox(boxes.sel.box, boxes.sel.tag, selected, true);
        for (let i = 0; i < memberBoxes.length; i++) {
          placeBox(memberBoxes[i], null, state.selection[i] || null, false);
        }
        handlesEl.hidden = true;
        requestAnimationFrame(frame); // 别停循环：否则切回 UI 编辑时选框再也不会更新
        return;
      }
      if (state.selected && !state.selected.isConnected) {
        state.selected = null;
        renderSel();
      }
      const selected = state.selected;
      const hover = state.hover && state.hover !== selected && state.hover.isConnected ? state.hover : null;
      const selRect = placeBox(boxes.sel.box, boxes.sel.tag, selected, true);
      placeBox(boxes.hover.box, boxes.hover.tag, hover, false);
      for (let i = 0; i < memberBoxes.length; i++) {
        placeBox(memberBoxes[i], null, state.selection[i] || null, false);
      }
      const multi = isMulti();
      positionHandles(multi ? unionRect() : (selected ? selRect : null), multi);
      requestAnimationFrame(frame);
    });
  }

  // ─────────────────────────────────────────────────────────── 启动
  document.documentElement.classList.add('spui-editing');
  host.classList.add('spui--edit');
  fab.hidden = true;

  // 启动动画 / 全屏蒙层会往 body 末尾追加节点（lobbyIntro.js 用 z-index: 2147483647）。
  // 把面板保持在最后一个兄弟节点，同 z-index 时靠 DOM 顺序压在上面。
  try {
    const keepOnTop = () => {
      if (document.body.lastElementChild !== host) document.body.appendChild(host);
    };
    new MutationObserver(keepOnTop).observe(document.body, { childList: true });
    keepOnTop();
  } catch { /* 老浏览器忽略 */ }

  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', onPointerCancelEnd, true);
  window.addEventListener('lostpointercapture', onPointerCancelEnd, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', (event) => {
    if (event.key === 'Shift' && state.shiftHeld) {
      state.shiftHeld = false;
      schedulePublish();
    }
  }, true);
  // 拾取模式：把这些"会触发游戏动作"的事件也一并吞掉（按钮的 click、链接跳转、表单提交等）。
  // Alt 按住时不吞，用来临时放行一次点击。
  for (const type of ['mousedown', 'mouseup', 'click', 'auxclick', 'submit']) {
    window.addEventListener(type, swallow, true);
  }
  // 触摸事件必须显式 passive:false，否则浏览器忽略 preventDefault、
  // 把拖动当滚动手势接管，然后甩出一个 pointercancel —— 这就是"断触"。
  for (const type of ['touchstart', 'touchmove', 'touchend']) {
    window.addEventListener(type, swallow, { capture: true, passive: false });
  }

  // 双击：选中被点元素的父级（按钮里的文字 → 按钮；按钮 → 它的容器）。
  window.addEventListener('dblclick', (event) => {
    if (!state.editing || isEditorNode(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    // 用普通拾取（而不是最里层）：点在按钮文字上时先落到按钮，再往上选一层容器。
    const picked = pickAt(event.clientX, event.clientY, false, true);
    if (!picked) return;
    let target = picked.parentElement;
    while (target && (target.id === 'app' || target.classList.contains('screen'))) target = target.parentElement;
    if (!target || target.id === 'app' || !target.closest('#app')) target = picked;
    if (target && target.closest('#app') && target.id !== 'app') select(target);
  }, true);
  window.addEventListener('resize', () => { renderDevices(); updateInfo(); });

  refresh();
  requestAnimationFrame(frame);
  void refreshProfiles();
  toast(`UI 布局编辑器已就绪：正在编辑 ${DEVICE_LABEL[state.kind]} 方案，点击元素选中，拖动或方向键微调`);

  return {
    state,
    select,
    save,
    reload,
    undo,
    redo,
    switchKind,
    dispatch,
    setZoom,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setEditing(on) {
      if (!!on !== state.editing) toggleEditing();
    },
  };
}
