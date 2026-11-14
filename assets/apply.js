// UI 布局编辑器 · 运行时入口
//
// 每次载入游戏时（public/index.html 末尾由 UI-Editor/install.bat 加了一行 <script type="module">）：
//   1. 判断当前设备（电脑版 / 手机端），读取 data/ui-layout.json 里对应的那套方案，编译成 CSS 立刻套用；
//      正常游玩时只有这一套生效；窗口尺寸/输入设备变化时自动切到对应方案（转屏、插鼠标都能跟上）。
//   2. 需要编辑时加载 editor.js，把编辑面板挂到页面上。两种入口：
//      · 地址栏带 ?ui-edit=1（UI-Editor\start-editor.bat 或手动加参数）
//      · 启动器里点了「UI 布局编辑器」——服务器上留了一个一次性标记，这里读到就自动打开，
//        这样即使启动器那边被宿主先跳转到了普通游戏地址，编辑器也会自动出现。
//
// 编辑器不依赖游戏内部模块，只操作 DOM，所以游戏更新后依然可用。

import { applyLayout, currentDeviceKind, fetchLayout, profileOf } from './layout.js';

const PARAMS = new URLSearchParams(location.search);
const EMBED = PARAMS.get('embed') === '1';
const FORCED_KIND = PARAMS.get('device') === 'mobile' ? 'mobile' : 'desktop';
const EDIT_MODE = /(?:^|[?&])ui-edit(?:=(?:1|true|yes))?(?:&|$)/i.test(location.search);

const debounce = (fn, ms) => {
  let timer = 0;
  return () => { clearTimeout(timer); timer = setTimeout(fn, ms); };
};

/** 启动器留下的一次性「打开编辑器」标记（读到即清除）。 */
async function consumeOpenRequest() {
  try {
    const res = await fetch('/ui-editor/open', { cache: 'no-store' });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.open === true;
  } catch {
    return false;
  }
}

function markUrlAsEdit() {
  try {
    const url = new URL(location.href);
    url.searchParams.set('ui-edit', '1');
    history.replaceState(history.state, '', url);
  } catch { /* 忽略 */ }
}

async function boot() {
  const result = await fetchLayout();
  let kind = EMBED ? FORCED_KIND : currentDeviceKind();
  const profileNow = () => profileOf(result.layout, kind);
  const applyNow = () => applyLayout(profileNow());
  applyNow();

  const follow = () => {
    const next = currentDeviceKind();
    if (next === kind) return false;
    kind = next;
    applyNow();
    return true;
  };

  // 「边距固定」「母集贴边」都是按实测 rect 反算的：窗口比例变化、界面晚渲染出来、切界面之后
  // 都要重算一遍，否则被锁元素会停在上一次算出来的位置。
  const hasConstraints = () => {
    const current = profileNow();
    if (Array.isArray(current?.anchors) && current.anchors.length > 0) return true;
    return Array.isArray(current?.groups)
      && current.groups.some((group) => Array.isArray(group.edges) && group.edges.length > 0);
  };
  const reanchor = () => { if (hasConstraints()) applyNow(); };

  // 嵌入式编辑台自己控制设备方案（舞台比例固定），不再跟随窗口宽度自动切换。
  if (!EDIT_MODE && !EMBED) {
    window.addEventListener('resize', debounce(() => { follow(); reanchor(); }, 150));
    for (const query of ['(max-width: 767px)', '(pointer: coarse)', '(any-pointer: coarse)']) {
      try {
        window.matchMedia(query).addEventListener('change', () => { follow(); reanchor(); });
      } catch { /* 老浏览器没有 addEventListener */ }
    }
    // 首次载入时界面 / 字体 / 图片还没排好，隔几个时间点补算几次。
    for (const delay of [300, 1200, 3200]) {
      setTimeout(reanchor, delay);
    }
    // 切换界面会重建 DOM：被锁的元素重新出现后再算一次（防抖，避免每帧重排）。
    try {
      const app = document.getElementById('app');
      if (app && typeof MutationObserver === 'function') {
        new MutationObserver(debounce(reanchor, 260)).observe(app, { childList: true, subtree: true });
      }
    } catch { /* 忽略 */ }
  }

  // 方便在控制台里排查：window.__spUiLayout.last / .reload() / .kind()
  globalThis.__spUiLayout = {
    last: result,
    kind: () => kind,
    async reload() {
      const next = await fetchLayout();
      result.layout = next.layout;
      applyNow();
      return next;
    },
    reanchor,
  };

  // 启动器点了「UI 编辑器」会留一个一次性标记：正常地址打开游戏时也自动进编辑器。
  // 已经是 ?ui-edit=1 时也顺手清掉标记，免得残留到下一次普通打开。
  let wantEditor = EDIT_MODE || EMBED;
  if (EDIT_MODE && !EMBED) {
    void consumeOpenRequest();
  } else if (!EDIT_MODE && !EMBED) {
    wantEditor = await consumeOpenRequest();
  }
  if (!wantEditor) return;
  if (!EDIT_MODE) markUrlAsEdit();
  try {
    const mod = await import('./editor.js');
    const editor = mod.startEditor({ ...result, kind, embed: EMBED });
    if (EMBED) setupEmbedBridge(editor, kind);
  } catch (error) {
    console.error('[ui-editor] 编辑器加载失败', error);
  }
}

/** 编辑台外壳 ↔ iframe 编辑引擎的桥。 */
function setupEmbedBridge(editor, kind) {
  const post = (message) => {
    try {
      parent.postMessage({ channel: 'spui', ...message }, location.origin);
    } catch { /* 忽略 */ }
  };

  editor.onEvent((type, payload) => {
    if (!payload) return;
    if (type === 'state') post({ type: 'state', ...payload });
    else if (type === 'toast') post({ type: 'toast', ...payload });
    else if (type === 'profiles') post({ type: 'profiles', ...payload });
    else if (type === 'css') post({ type: 'css', ...payload });
    else if (type === 'inspect') post({ type: 'inspect', ...payload });
    else if (type === 'saved') post({ type: 'saved', ...payload });
  });

  window.addEventListener('message', (event) => {
    if (event.source !== parent) return;
    const message = event.data;
    if (!message || message.channel !== 'spui' || message.type !== 'cmd') return;
    if (message.action === 'zoom') {
      editor.setZoom(message.zoom);
      return;
    }
    try {
      const result = editor.dispatch(message.action, message);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => console.error('[ui-editor] 命令执行失败', error));
      }
    } catch (error) {
      console.error('[ui-editor] 命令执行失败', error);
    }
  });

  post({ type: 'ready', kind });
  // 首帧状态可能在监听注册前就被节流发布掉；这里主动推一次，侧边栏不至于空白。
  try { editor.dispatch('state'); } catch { /* 忽略 */ }
}

boot();
