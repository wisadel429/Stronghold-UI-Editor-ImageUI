// UI 布局编辑器 · 编辑台外壳
//
// 左侧是固定比例的舞台（电脑版 1280×720 / 16:9，手机端 767×329 / 21:9），里面是同源 iframe 的游戏页；
// 右侧侧边栏通过 postMessage 驱动 iframe 里的编辑引擎。游戏页里的编辑器不再显示悬浮面板。

(function () {
  'use strict';

  var CHANNEL = 'spui';
  var KIND = {
    // 1920×1080 是游戏的设计分辨率：按它渲染再缩小到预览区，文字/界面更清晰。
    desktop: { label: '电脑版', w: 1920, h: 1080, ratio: '16:9' },
    mobile: { label: '手机端', w: 767, h: 329, ratio: '21:9' },
  };
  var POS_KEY = 'spui.studio.kind';
  var STEP_VALUES = [0.5, 1, 5, 10];

  var el = function (id) { return document.getElementById(id); };
  var ui = {
    metaVersion: el('metaVersion'),
    metaDir: el('metaDir'),
    status: el('status'),
    deviceSeg: el('deviceSeg'),
    btnMode: el('btnMode'),
    btnMulti: el('btnMulti'),
    btnShot: el('btnShot'),
    imgFile: el('imgFile'),
    btnImgPick: el('btnImgPick'),
    btnImgClear: el('btnImgClear'),
    imgThumb: el('imgThumb'),
    imgHint: el('imgHint'),
    imgModeGroup: el('imgModeGroup'),
    imgFitGroup: el('imgFitGroup'),
    btnInspect: el('btnInspect'),
    inspect: el('inspect'),
    zoomLabel: el('zoomLabel'),
    stageArea: el('stageArea'),
    stage: el('stage'),
    game: el('game'),
    stageLoading: el('stageLoading'),
    stageText: el('stageText'),
    stageSize: el('stageSize'),
    hint: el('hint'),
    crumbs: el('crumbs'),
    selCount: el('selCount'),
    selInfo: el('selInfo'),
    selName: el('selName'),
    selSize: el('selSize'),
    selSelector: el('selSelector'),
    multiRow: el('multiRow'),
    fields: el('fields'),
    entryCount: el('entryCount'),
    entries: el('entries'),
    profileSelect: el('profileSelect'),
    profileHint: el('profileHint'),
    footStatus: el('footStatus'),
    stepBtn: el('stepBtn'),
    toast: el('toast'),
    switching: el('switching'),
    switchingTitle: el('switchingTitle'),
    switchingText: el('switchingText'),
    modal: el('modal'),
    dialogTitle: el('dialogTitle'),
    dialogText: el('dialogText'),
    dialogActions: el('dialogActions'),
    dialogClose: el('dialogClose'),
    cssModal: el('cssModal'),
    cssTitle: el('cssTitle'),
    cssText: el('cssText'),
    cssCopy: el('cssCopy'),
    cssDownload: el('cssDownload'),
    cssClose: el('cssClose'),
    stopped: el('stopped'),
    stoppedText: el('stoppedText'),
    stoppedReselect: el('stoppedReselect'),
    stoppedQuit: el('stoppedQuit'),
    btnSave: el('btnSave'),
    btnUndo: el('btnUndo'),
    btnRedo: el('btnRedo'),
    btnReloadLayout: el('btnReloadLayout'),
    btnCss: el('btnCss'),
    btnClearAll: el('btnClearAll'),
    btnProfileSave: el('btnProfileSave'),
    btnProfileLoad: el('btnProfileLoad'),
    btnProfileDelete: el('btnProfileDelete'),
    btnReloadGame: el('btnReloadGame'),
    btnReselect: el('btnReselect'),
    btnQuit: el('btnQuit'),
    btnFit: el('btnFit'),
    btnParent: el('btnParent'),
    btnChild: el('btnChild'),
    btnSiblings: el('btnSiblings'),
    btnClearSel: el('btnClearSel'),
    btnAddParent: el('btnAddParent'),
    btnAllSiblings: el('btnAllSiblings'),
    btnClearMulti: el('btnClearMulti'),
    btnZero: el('btnZero'),
    btnHide: el('btnHide'),
    btnReset: el('btnReset'),
    btnCopyOther: el('btnCopyOther'),
  };

  var host = window.chrome && window.chrome.webview ? window.chrome.webview : null;
  var fieldEls = {};
  Array.prototype.forEach.call(document.querySelectorAll('#fields input'), function (input) {
    fieldEls[input.dataset.field] = input;
  });
  var nudgeButtons = Array.prototype.slice.call(document.querySelectorAll('.nudge__dir'));

  var state = {
    kind: (function () {
      try { return localStorage.getItem(POS_KEY) === 'mobile' ? 'mobile' : 'desktop'; } catch (e) { return 'desktop'; }
    })(),
    ready: false,
    scale: 1,
    last: null,
    entriesSig: '',
    profiles: [],
    profileId: '',
    dirty: false,
    step: 1,
    meta: null,
    waiters: [],
    askResolver: null,
    toastTimer: 0,
    shotTimer: 0,
    imgMode: 'replace',
    imgFit: 'cover',
    loadTimer: 0,
    hold: null,
    editingField: false,
  };

  // ── 工具 ───────────────────────────────────────────────
  function text(node, value) {
    if (node) node.textContent = value == null ? '' : String(value);
  }

  function post(action, data) {
    if (!state.ready) return false;
    var frame = ui.game.contentWindow;
    if (!frame) return false;
    var message = { channel: CHANNEL, type: 'cmd', action: action };
    if (data) {
      for (var key in data) {
        if (Object.prototype.hasOwnProperty.call(data, key)) message[key] = data[key];
      }
    }
    try { frame.postMessage(message, location.origin); return true; } catch (e) { return false; }
  }

  function postHost(type, data) {
    if (!host) return false;
    var message = { type: type };
    if (data) {
      for (var key in data) {
        if (Object.prototype.hasOwnProperty.call(data, key)) message[key] = data[key];
      }
    }
    try { host.postMessage(message); return true; } catch (e) { return false; }
  }

  function showToast(message, bad) {
    ui.toast.textContent = message || '';
    ui.toast.classList.toggle('is-bad', !!bad);
    ui.toast.classList.add('is-on');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { ui.toast.classList.remove('is-on'); }, 2800);
  }

  function showSwitching(title, message) {
    text(ui.switchingTitle, title || '正在切换');
    text(ui.switchingText, message || '');
    ui.switching.hidden = false;
  }

  function waitersFor(type) {
    return state.waiters.filter(function (waiter) { return waiter.type === type; });
  }

  function resolveWaiters(type, payload) {
    state.waiters = state.waiters.filter(function (waiter) {
      if (waiter.type !== type) return true;
      waiter.resolve(payload);
      return false;
    });
  }

  function waitFor(type, ms) {
    return new Promise(function (resolve) {
      var waiter = { type: type, resolve: resolve };
      state.waiters.push(waiter);
      setTimeout(function () {
        if (state.waiters.indexOf(waiter) < 0) return;
        state.waiters = state.waiters.filter(function (item) { return item !== waiter; });
        resolve(null);
      }, ms || 4000);
    });
  }

  // ── 弹窗 ───────────────────────────────────────────────
  function ask(title, body, buttons) {
    if (state.askResolver) {
      var previous = state.askResolver;
      state.askResolver = null;
      previous(null);
    }
    return new Promise(function (resolve) {
      state.askResolver = resolve;
      text(ui.dialogTitle, title || '确认');
      text(ui.dialogText, body || '');
      ui.dialogActions.textContent = '';
      (buttons || [{ label: '取消', value: null }]).forEach(function (button) {
        var node = document.createElement('button');
        node.type = 'button';
        node.textContent = button.label;
        if (button.kind) node.className = 'is-' + button.kind;
        node.onclick = function () { closeAsk(button.value); };
        ui.dialogActions.appendChild(node);
      });
      ui.modal.hidden = false;
    });
  }

  function closeAsk(value) {
    ui.modal.hidden = true;
    var resolve = state.askResolver;
    state.askResolver = null;
    if (resolve) resolve(value);
  }

  ui.dialogClose.onclick = function () { closeAsk(null); };
  ui.modal.addEventListener('click', function (event) {
    if (event.target === ui.modal) closeAsk(null);
  });

  function showCss(kind, css) {
    text(ui.cssTitle, '生成的 CSS · ' + (KIND[kind] || KIND.desktop).label);
    ui.cssText.value = css || '/* 这套方案还没有任何调整 */\n';
    ui.cssModal.hidden = false;
    ui.cssText.focus();
    ui.cssText.select();
  }

  function closeCss() {
    ui.cssModal.hidden = true;
  }

  ui.cssClose.onclick = closeCss;
  ui.cssModal.addEventListener('click', function (event) {
    if (event.target === ui.cssModal) closeCss();
  });

  ui.cssCopy.onclick = function () {
    var copy = function () { showToast('CSS 已复制到剪贴板'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ui.cssText.value).then(copy).catch(function () {
        ui.cssText.select();
        try { document.execCommand('copy'); copy(); } catch (e) { showToast('复制失败，请手动全选复制', true); }
      });
    } else {
      ui.cssText.select();
      try { document.execCommand('copy'); copy(); } catch (e) { showToast('复制失败，请手动全选复制', true); }
    }
  };

  ui.cssDownload.onclick = function () {
    try {
      var blob = new Blob([ui.cssText.value], { type: 'text/css;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = 'ui-layout-' + state.kind + '.css';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      showToast('已导出 CSS');
    } catch (error) {
      showToast('下载被拦截，请手动复制', true);
    }
  };

  // ── 舞台缩放 ───────────────────────────────────────────
  function fitStage() {
    var area = ui.stageArea;
    var spec = KIND[state.kind] || KIND.desktop;
    var availW = Math.max(120, area.clientWidth - 18);
    var availH = Math.max(90, area.clientHeight - 18);
    var scale = Math.min(availW / spec.w, availH / spec.h);
    scale = Math.max(0.05, Math.min(3, scale));
    state.scale = scale;
    var x = Math.max(9, (area.clientWidth - spec.w * scale) / 2);
    var y = Math.max(9, (area.clientHeight - spec.h * scale) / 2);
    ui.stage.style.width = spec.w + 'px';
    ui.stage.style.height = spec.h + 'px';
    ui.stage.style.transform = 'translate3d(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px,0) scale(' + scale.toFixed(5) + ')';
    text(ui.zoomLabel, Math.round(scale * 100) + '%');
    text(ui.stageSize, spec.w + ' × ' + spec.h + ' · ' + spec.ratio);
    sendZoom();
  }

  var fitRaf = 0;
  function scheduleFit() {
    if (fitRaf) return;
    fitRaf = requestAnimationFrame(function () {
      fitRaf = 0;
      fitStage();
    });
  }

  function sendZoom() {
    if (!state.ready) return;
    post('zoom', { zoom: state.scale });
  }

  /** 手机端舞台只有 767×329，放大显示时让宿主把渲染 DPR 提到 2；电脑端恢复 1。 */
  function applyDsf(kind) {
    if (!host) return;
    postHost('app:dsf', {
      dsf: kind === 'mobile' ? 2 : 1,
      width: window.innerWidth,
      height: window.innerHeight,
    });
  }

  var dsfTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(dsfTimer);
    dsfTimer = setTimeout(function () { applyDsf(state.kind); }, 220);
  });

  if (window.ResizeObserver) {
    new ResizeObserver(scheduleFit).observe(ui.stageArea);
  } else {
    window.addEventListener('resize', scheduleFit);
  }
  window.addEventListener('resize', scheduleFit);

  // ── 游戏画面 ───────────────────────────────────────────
  function gameUrl(kind) {
    return '/?ui-edit=1&embed=1&device=' + encodeURIComponent(kind) + '&t=' + Date.now();
  }

  function loadGame(showOverlay) {
    state.ready = false;
    state.last = null;
    state.entriesSig = '';
    text(ui.stageText, '正在启动游戏画面…');
    ui.stageLoading.classList.remove('is-off');
    clearTimeout(state.loadTimer);
    state.loadTimer = setTimeout(function () {
      if (!state.ready) text(ui.stageText, '游戏画面载入较慢…首次启动要建立资源索引，请再等一会');
    }, 16000);
    try { ui.game.src = gameUrl(state.kind); } catch (e) { /* 忽略 */ }
    if (showOverlay !== false) fitStage();
  }

  ui.game.addEventListener('load', function () {
    // 编辑器会自己 post ready；这里只做兜底，避免一直停在空白页
    setTimeout(function () {
      if (!state.ready) text(ui.stageText, '正在等待编辑器就绪…');
    }, 1200);
  });

  // ── 状态渲染 ───────────────────────────────────────────
  function setStatus() {
    var s = state.last;
    var node = ui.status;
    node.classList.remove('is-dirty', 'is-bad');
    if (!s) { text(node.querySelector('span'), '正在载入'); return; }
    var label = '已同步';
    if (!s.apiOk) { label = '接口未安装'; node.classList.add('is-bad'); }
    else if (s.saving) label = '保存中…';
    else if (s.dirty) { label = '有未保存修改'; node.classList.add('is-dirty'); }
    text(node.querySelector('span'), label);

    state.dirty = !!s.dirty;
    var spec = KIND[s.kind] || KIND[state.kind];
    var count = s.entries ? s.entries.length : 0;
    text(ui.footStatus, spec.label + ' · 已调整 ' + count + ' 项 · 窗口 ' + s.winW + '×' + s.winH);
    ui.footStatus.classList.toggle('is-dirty', !!s.dirty);
    text(ui.entryCount, String(count));
    text(ui.selCount, s.selected ? (s.selectionCount > 1 ? '已选 ' + s.selectionCount + ' 个' : '已选中') : '未选中');
    text(ui.stepBtn, String(s.step || 1));
  }

  function renderDevice() {
    Array.prototype.forEach.call(ui.deviceSeg.querySelectorAll('button'), function (button) {
      button.classList.toggle('is-on', button.dataset.kind === state.kind);
    });
  }

  function renderMode(s) {
    if (!s) { ui.btnMode.disabled = true; return; }
    ui.btnMode.disabled = false;
    var picking = !!s.editing;
    ui.btnMode.classList.toggle('is-pick', picking);
    ui.btnMode.classList.toggle('is-op', !picking);
    text(ui.btnMode.querySelector('span'), picking ? '切换为游戏内点击' : '切换为UI编辑');
    ui.btnMode.title = picking
      ? '当前：UI 编辑（点击只选中，不触发游戏按钮）→ 点击切换为游戏内点击'
      : '当前：游戏内点击（点击直接操作游戏）→ 点击切换为UI编辑';
  }

  function renderMulti(s) {
    if (!s) { ui.btnMulti.disabled = true; return; }
    ui.btnMulti.disabled = false;
    var on = !!s.multiMode || !!s.shiftHeld;
    ui.btnMulti.classList.toggle('is-on', on);
    text(ui.btnMulti.querySelector('span'), s.multiMode ? '多选 · 开' : '多选');
    ui.btnMulti.title = on
      ? '多选进行中：点击元素加入/移出选择；拖动已选元素整组移动，拖四角整组缩放 → 点按钮关闭并取消选择'
      : '点击开启多选模式；或按住 Shift 直接临时多选（Shift+点击加选）';
  }

  function renderImage(s) {
    var sel = s && s.selected;
    var has = !!sel;
    var image = has ? sel.image : null;
    ui.btnImgPick.disabled = !has;
    ui.btnImgClear.disabled = !image;
    ui.btnInspect.disabled = !has;
    ui.imgThumb.style.backgroundImage = image ? 'url("' + image + '")' : '';
    text(ui.imgHint, !has ? '选中元素后可用' : (image ? '已替换为图片' : '可以替换成图片'));
    Array.prototype.forEach.call(ui.imgModeGroup.querySelectorAll('button'), function (button) {
      button.disabled = !image;
      button.classList.toggle('is-on', !!image && (sel.imageMode || 'replace') === button.dataset.imgmode);
    });
    Array.prototype.forEach.call(ui.imgFitGroup.querySelectorAll('button'), function (button) {
      button.disabled = !image;
      button.classList.toggle('is-on', !!image && (sel.imageFit || 'cover') === button.dataset.imgfit);
    });
  }

  function renderInspect(message) {
    var rows = [];
    rows.push(['元素', message.label + ' · ' + message.tag, '']);
    rows.push(['尺寸', message.size + ' 设计像素', '']);
    var imgBits = message.counts
      ? '图片 ' + message.counts.img + ' · SVG ' + message.counts.svg + ' · Canvas ' + message.counts.canvas + ' · div ' + message.counts.div
      : '';
    rows.push(['内容', imgBits, '']);
    var isCss = (message.bgImage && message.bgImage !== 'none') || message.bgColor !== 'rgba(0, 0, 0, 0)';
    rows.push(['背景', message.bgImage === 'none' ? (message.bgColor || '无') : '图片/CSS 渐变', isCss ? 'is-css' : '']);
    if (message.before && message.before.content !== 'none') {
      rows.push(['::before', '有装饰层', 'is-css']);
    }
    if (message.after && message.after.content !== 'none') {
      rows.push(['::after', '有装饰层', 'is-css']);
    }
    var tips = [];
    if (message.counts && message.counts.img > 0) tips.push('含 <img>，可以直接换图');
    if (message.counts && message.counts.canvas > 0) tips.push('含 Canvas，图片替换无效');
    if (!tips.length && isCss) tips.push('纯 CSS 绘制，适合「替换原样式」');
    rows.push(['结论', tips.join('；') || '可尝试覆盖', 'is-img']);
    ui.inspect.textContent = '';
    rows.forEach(function (row) {
      var line = document.createElement('div');
      line.className = 'inspect__row';
      var k = document.createElement('span');
      k.className = 'inspect__k';
      k.textContent = row[0];
      var v = document.createElement('span');
      v.className = 'inspect__v ' + (row[2] || '');
      v.textContent = row[1];
      v.title = row[1];
      line.appendChild(k);
      line.appendChild(v);
      ui.inspect.appendChild(line);
    });
  }

  function uploadImage(file) {
    if (!file) return;
    if (!state.last || !state.last.selected) { showToast('先选中一个元素', true); return; }
    if (file.size > 20 * 1024 * 1024) { showToast('图片超过 20MB', true); return; }
    text(ui.imgHint, '正在上传 ' + file.name + '…');
    fetch('/ui-editor/images', {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'image/png' },
      body: file,
    })
      .then(function (response) { return response.json(); })
      .then(function (body) {
        if (!body || !body.ok) throw new Error((body && body.error) || '上传失败');
        post('setImage', {
          url: body.url,
          mode: state.imgMode || 'replace',
          fit: state.imgFit || 'cover',
        });
        showToast('图片已应用：' + Math.round((body.bytes || 0) / 1024) + ' KB');
      })
      .catch(function (error) { showToast('上传失败：' + (error.message || error), true); });
  }

  function renderSelection(s) {
    var selected = s.selected;
    var multi = s.selectionCount > 1;
    var has = !!selected;
    var entry = has ? selected : null;

    // 字段
    var fieldEnabled = {
      x: has && !multi, y: has && !multi, w: has && !multi, h: has && !multi,
      scale: has, z: has && !multi,
    };
    Object.keys(fieldEls).forEach(function (name) {
      var input = fieldEls[name];
      input.disabled = !fieldEnabled[name];
      if (document.activeElement === input) return;
      if (!has || (multi && name !== 'scale')) { input.value = ''; return; }
      if (name === 'x') input.value = String(entry.x || 0);
      else if (name === 'y') input.value = String(entry.y || 0);
      else if (name === 'w') input.value = entry.w == null ? '' : String(entry.w);
      else if (name === 'h') input.value = entry.h == null ? '' : String(entry.h);
      else if (name === 'scale') input.value = entry.scale == null ? '' : String(Math.round(entry.scale * 100));
      else if (name === 'z') input.value = entry.z == null ? '' : String(entry.z);
    });

    // 按钮
    [ui.btnParent, ui.btnChild, ui.btnSiblings, ui.btnClearSel].forEach(function (button) { button.disabled = !has; });
    [ui.btnAddParent, ui.btnAllSiblings, ui.btnClearMulti].forEach(function (button) { button.disabled = !has; });
    [ui.btnZero, ui.btnHide, ui.btnReset].forEach(function (button) { button.disabled = !has; });
    nudgeButtons.forEach(function (button) { button.disabled = !has; });
    ui.btnHide.textContent = entry && entry.hidden ? '显示' : '隐藏';
    ui.btnHide.classList.toggle('is-on', !!(entry && entry.hidden));

    // 选中信息
    ui.selInfo.hidden = !has;
    if (!has) {
      ui.crumbs.textContent = '';
      var hint = document.createElement('span');
      hint.className = 'crumbs__hint';
      hint.textContent = '点击左侧画面里的元素开始调整';
      ui.crumbs.appendChild(hint);
      ui.multiRow.hidden = true;
      return;
    }

    text(ui.selName, multi ? '已选 ' + s.selectionCount + ' 个元素' : selected.label);
    text(ui.selSize, selected.actualW + ' × ' + selected.actualH + ' 设计像素');
    text(ui.selSelector, selected.selector);
    ui.selSelector.title = selected.selector;

    // 面包屑
    ui.crumbs.textContent = '';
    if (multi) {
      var badge = document.createElement('span');
      badge.className = 'crumb-count';
      badge.textContent = '已选 ' + s.selectionCount + ' 个';
      ui.crumbs.appendChild(badge);
      var sep0 = document.createElement('span');
      sep0.className = 'crumb-sep';
      sep0.textContent = '›';
      ui.crumbs.appendChild(sep0);
    }
    (selected.chain || []).forEach(function (item, index) {
      if (index) {
        var sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = '›';
        ui.crumbs.appendChild(sep);
      }
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'crumb' + (index === selected.chain.length - 1 ? ' is-current' : '');
      button.textContent = item.label;
      button.title = item.selector;
      button.onclick = function () { post('crumb', { index: index }); };
      ui.crumbs.appendChild(button);
    });
    ui.crumbs.scrollLeft = ui.crumbs.scrollWidth;
    ui.multiRow.hidden = !(multi || s.multiMode || s.shiftHeld);
  }

  function describe(entry) {
    var bits = [];
    if (entry.hidden) bits.push('隐藏');
    if (entry.image) bits.push(entry.imageMode === 'overlay' ? '覆盖图' : '图片');
    if (entry.x || entry.y) bits.push(entry.x + ',' + entry.y);
    if (entry.w != null || entry.h != null) bits.push((entry.w == null ? '自动' : entry.w) + '×' + (entry.h == null ? '自动' : entry.h));
    if (entry.scale != null && entry.scale !== 1) bits.push(Math.round(entry.scale * 100) + '%');
    if (entry.z != null) bits.push('z' + entry.z);
    return bits.join(' · ') || '已记录';
  }

  function renderEntries(s) {
    var entries = s.entries || [];
    var sig = JSON.stringify(entries);
    text(ui.entryCount, String(entries.length));
    if (sig === state.entriesSig) return;
    state.entriesSig = sig;
    ui.entries.textContent = '';
    if (!entries.length) {
      var empty = document.createElement('div');
      empty.className = 'entries__empty';
      empty.textContent = (KIND[s.kind] || KIND.desktop).label + '还没有调整任何元素';
      ui.entries.appendChild(empty);
      return;
    }
    entries.slice().reverse().forEach(function (entry) {
      var row = document.createElement('div');
      row.className = 'entry';
      var name = document.createElement('button');
      name.type = 'button';
      name.className = 'entry__name';
      name.textContent = shortSelector(entry.selector);
      name.title = entry.selector;
      name.onclick = function () { post('select', { selector: entry.selector }); };
      var meta = document.createElement('span');
      meta.className = 'entry__meta';
      meta.textContent = describe(entry);
      var drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'entry__drop';
      drop.textContent = '↺';
      drop.title = '删除这一项的调整';
      drop.onclick = function () { post('dropEntry', { selector: entry.selector }); };
      row.appendChild(name);
      row.appendChild(meta);
      row.appendChild(drop);
      ui.entries.appendChild(row);
    });
  }

  function shortSelector(selector) {
    var parts = String(selector || '').split(' > ');
    return parts.slice(-2).join(' › ');
  }

  function renderProfiles(message) {
    var list = message.list || [];
    state.profiles = list;
    ui.profileSelect.textContent = '';
    if (!list.length) {
      var option = document.createElement('option');
      option.value = '';
      option.textContent = '（还没有存档，按「存」新建）';
      ui.profileSelect.appendChild(option);
      text(ui.profileHint, '按游戏版本');
      return;
    }
    list.forEach(function (item) {
      var option = document.createElement('option');
      option.value = item.id;
      var counts = item.counts ? '（电脑版 ' + item.counts.desktop + ' · 手机端 ' + item.counts.mobile + '）' : '';
      option.textContent = item.name + counts;
      ui.profileSelect.appendChild(option);
    });
    var target = message.selectedId || (list.filter(function (item) { return item.auto; })[0] || list[0]).id;
    ui.profileSelect.value = target;
    state.profileId = target;
    text(ui.profileHint, message.current ? '当前 ' + message.current : '按游戏版本');
  }

  function applyState(s) {
    state.last = s;
    state.dirty = !!s.dirty;
    if (s.kind && s.kind !== state.kind) {
      // 正常情况下舞台和设备方案一致；不一致时以编辑器为准
      state.kind = s.kind;
      renderDevice();
    }
    renderDevice();
    renderMode(s);
    renderMulti(s);
    renderImage(s);
    renderSelection(s);
    renderEntries(s);
    setStatus();
  }

  // ── 消息 ───────────────────────────────────────────────
  function onEditorMessage(event) {
    if (event.source !== ui.game.contentWindow) return;
    var message = event.data;
    if (!message || message.channel !== CHANNEL) return;
    switch (message.type) {
      case 'ready':
        state.ready = true;
        clearTimeout(state.loadTimer);
        ui.stageLoading.classList.add('is-off');
        ui.btnShot.disabled = !host;
        sendZoom();
        break;
      case 'state':
        applyState(message);
        break;
      case 'toast':
        showToast(message.text, message.bad);
        break;
      case 'inspect':
        renderInspect(message);
        break;
      case 'profiles':
        renderProfiles(message);
        break;
      case 'saved':
        resolveWaiters('saved', message);
        break;
      case 'css':
        showCss(message.kind || state.kind, message.css);
        break;
      default:
        break;
    }
  }

  window.addEventListener('message', onEditorMessage);

  // ── 设备切换 ───────────────────────────────────────────
  function switchKind(kind) {
    if (!KIND[kind] || kind === state.kind) return;
    var proceed = function () {
      state.kind = kind;
      try { localStorage.setItem(POS_KEY, kind); } catch (e) { /* 忽略 */ }
      applyDsf(kind);
      renderDevice();
      state.entriesSig = '';
      text(ui.selCount, '未选中');
      ui.footStatus.textContent = '—';
      loadGame(true);
    };
    if (!state.dirty) { proceed(); return; }
    ask('切换设备方案', '切换会重新载入左侧游戏画面。当前有未保存的修改，先保存再切换吗？', [
      { label: '保存并切换', value: 'save', kind: 'primary' },
      { label: '直接切换', value: 'discard' },
      { label: '取消', value: null },
    ]).then(function (answer) {
      if (answer === 'save') {
        var saved = waitFor('saved', 5000);
        post('save');
        saved.then(proceed);
      } else if (answer === 'discard') {
        proceed();
      }
    });
  }

  Array.prototype.forEach.call(ui.deviceSeg.querySelectorAll('button'), function (button) {
    button.onclick = function () { switchKind(button.dataset.kind); };
  });

  ui.btnMode.onclick = function () {
    if (!state.last) return;
    post('setEditing', { on: !state.last.editing });
  };

  ui.btnMulti.onclick = function () {
    if (!state.last) return;
    post('setMulti', { on: !state.last.multiMode });
  };

  // ── 操作 ───────────────────────────────────────────────
  Array.prototype.forEach.call(document.querySelectorAll('[data-action]'), function (button) {
    button.onclick = function () {
      var action = button.dataset.action;
      if (action === 'copy') {
        ask('复制另一设备方案', '用另一套设备的布局覆盖当前设备？可用「撤销」恢复。', [
          { label: '复制', value: 'copy', kind: 'primary' },
          { label: '取消', value: null },
        ]).then(function (answer) {
          if (answer === 'copy') post('copyOther', { confirmed: true });
        });
        return;
      }
      post(action);
    };
  });

  ui.btnSave.onclick = function () { post('save'); };
  ui.btnUndo.onclick = function () { post('undo'); };
  ui.btnRedo.onclick = function () { post('redo'); };
  ui.btnReloadLayout.onclick = function () { post('reload'); };
  ui.btnCss.onclick = function () { post('exportCss'); };
  ui.btnClearAll.onclick = function () {
    ask('清空当前设备方案', '清空当前设备方案的全部调整？保存前不影响磁盘，可用撤销恢复。', [
      { label: '清空', value: 'clear', kind: 'danger' },
      { label: '取消', value: null },
    ]).then(function (answer) { if (answer === 'clear') post('clearAll', { confirmed: true }); });
  };

  ui.btnFit.onclick = function () { fitStage(); };

  ui.btnReloadGame.onclick = function () {
    var proceed = function () {
      showSwitching('正在刷新页面', '重新载入编辑器与游戏画面…');
      setTimeout(function () { location.reload(); }, 80);
    };
    if (!state.dirty) { proceed(); return; }
    ask('刷新页面', '刷新会重新载入编辑器和游戏，当前未保存的修改会丢失，继续吗？', [
      { label: '刷新页面', value: 'reload', kind: 'primary' },
      { label: '取消', value: null },
    ]).then(function (answer) { if (answer === 'reload') proceed(); });
  };

  function reselect() {
    var go = function () { postHost('app:reselect'); };
    if (!state.dirty) { go(); return; }
    ask('更换游戏目录', '更换目录会关闭当前编辑服务，未保存的修改会丢失，继续吗？', [
      { label: '更换目录', value: 'go', kind: 'primary' },
      { label: '取消', value: null },
    ]).then(function (answer) { if (answer === 'go') go(); });
  }

  function quit() {
    var go = function () {
      showSwitching('正在退出编辑器', '保存设置并关闭窗口…');
      if (host) postHost('app:quit');
      else setTimeout(function () { window.close(); }, 80);
    };
    // 关闭始终先二次确认（不只是有未保存修改时）。
    ask('退出编辑器', state.dirty
      ? '还有未保存的修改，确定退出吗？'
      : '确定关闭编辑器吗？', [
      { label: '退出', value: 'quit', kind: 'danger' },
      { label: '取消', value: null },
    ]).then(function (answer) { if (answer === 'quit') go(); });
  }

  ui.btnReselect.onclick = reselect;
  ui.btnQuit.onclick = quit;
  ui.stoppedReselect.onclick = reselect;
  ui.stoppedQuit.onclick = quit;

  // ── 字段 ───────────────────────────────────────────────
  Object.keys(fieldEls).forEach(function (name) {
    var input = fieldEls[name];
    input.addEventListener('focus', function () {
      state.editingField = true;
      post('editBegin');
    });
    input.addEventListener('input', function () {
      post('setField', { field: name, value: input.value });
    });
    var end = function () {
      if (!state.editingField) return;
      state.editingField = false;
      post('editEnd');
    };
    input.addEventListener('change', end);
    input.addEventListener('blur', end);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
    });
  });

  // ── 微调（长按连发，整段一个撤销点） ───────────────────
  function stopHold() {
    var hold = state.hold;
    if (!hold) return;
    state.hold = null;
    clearTimeout(hold.timer);
    clearInterval(hold.repeat);
    window.removeEventListener('pointerup', stopHold, true);
    window.removeEventListener('pointercancel', stopHold, true);
    post('batchEnd');
  }

  nudgeButtons.forEach(function (button) {
    button.addEventListener('pointerdown', function (event) {
      if (button.disabled || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      stopHold();
      var parts = String(button.dataset.nudge || '').split(',').map(Number);
      if (!Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return;
      post('batchBegin');
      post('nudgeNoUndo', { dx: parts[0], dy: parts[1], step: state.step });
      state.hold = {
        timer: setTimeout(function () {
          if (!state.hold) return;
          state.hold.repeat = setInterval(function () {
            post('nudgeNoUndo', { dx: parts[0], dy: parts[1], step: state.step });
          }, 80);
        }, 420),
        repeat: 0,
      };
      window.addEventListener('pointerup', stopHold, true);
      window.addEventListener('pointercancel', stopHold, true);
    });
    button.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); });
  });

  ui.stepBtn.onclick = function () {
    var index = STEP_VALUES.indexOf(state.step);
    var next = STEP_VALUES[(index + 1) % STEP_VALUES.length];
    state.step = next;
    text(ui.stepBtn, String(next));
    post('setStep', { step: next });
    showToast('微调步长：' + next + ' 设计像素');
  };

  // ── 存档 ───────────────────────────────────────────────
  ui.btnProfileSave.onclick = function () {
    var name = window.prompt('存档名字（换版本 / 换机器时，把工具目录的 profiles 文件夹一起带走就能继续用）',
      '存档 ' + new Date().toLocaleString());
    if (!name) return;
    post('profileSave', { name: name });
  };

  ui.btnProfileLoad.onclick = function () {
    var id = ui.profileSelect.value;
    if (!id) { showToast('还没有可载入的存档', true); return; }
    ask('载入存档', '载入后当前布局会被覆盖（可用撤销回退），继续吗？', [
      { label: '载入', value: 'load', kind: 'primary' },
      { label: '取消', value: null },
    ]).then(function (answer) { if (answer === 'load') post('profileLoad', { id: id, confirmed: true }); });
  };

  ui.btnProfileDelete.onclick = function () {
    var id = ui.profileSelect.value;
    if (!id) return;
    ask('删除存档', '删掉就找不回来了，确定删除选中的存档？', [
      { label: '删除', value: 'delete', kind: 'danger' },
      { label: '取消', value: null },
    ]).then(function (answer) { if (answer === 'delete') post('profileDelete', { id: id, confirmed: true }); });
  };

  // ── 键盘 ───────────────────────────────────────────────
  var typing = function (target) {
    return target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
  };

  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      if (!ui.cssModal.hidden) { closeCss(); return; }
      if (!ui.modal.hidden) { closeAsk(null); return; }
    }
    if (event.key === 'Tab' && state.last && !typing(event.target) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      post('setEditing', { on: !state.last.editing });
      return;
    }
    if (event.key === 'Shift' && state.last && !typing(event.target) && !state.last.editing) {
      // 从游戏内点击模式按住 Shift 时自动回到 UI 编辑，Shift+点击才能加选。
      post('setEditing', { on: true });
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      var key = String(event.key || '').toLowerCase();
      if (key === 's') { event.preventDefault(); post('save'); return; }
      if (!typing(event.target) && key === 'z') {
        event.preventDefault();
        post(event.shiftKey ? 'redo' : 'undo');
        return;
      }
      if (!typing(event.target) && key === 'y') { event.preventDefault(); post('redo'); return; }
      return;
    }
    if (typing(event.target)) return;
    var dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    var dir = dirs[event.key];
    if (dir && state.last && state.last.selected) {
      event.preventDefault();
      post('nudge', { dx: dir[0], dy: dir[1], step: event.shiftKey ? 10 : 1 });
      return;
    }
    if ((event.key === 'h' || event.key === 'H') && state.last) {
      event.preventDefault();
      post('setHandles', { on: !state.last.handles });
      return;
    }
  });

  // ── 元信息 ─────────────────────────────────────────────
  function loadMeta() {
    fetch('/ui-editor/meta', { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (meta) {
        state.meta = meta;
        text(ui.metaVersion, meta.versionKey || '游戏版本未知');
        text(ui.metaDir, meta.gameDir || '');
        ui.metaDir.title = meta.gameDir || '';
        ui.profileHint.textContent = '当前 ' + (meta.versionKey || '默认');
      })
      .catch(function () {
        text(ui.metaVersion, '游戏信息不可用');
        text(ui.metaDir, '');
      });
  }

  function captureGame() {
    if (!host) { showToast('截图需要在宿主窗口中使用', true); return; }
    if (!state.ready) { showToast('游戏画面还没准备好', true); return; }
    var rect = ui.game.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) { showToast('游戏画面尺寸异常', true); return; }
    clearTimeout(state.shotTimer);
    // 先隐藏选框/手柄，截出来只有游戏界面。
    post('captureMode', { on: true });
    setTimeout(function () {
      postHost('app:screenshot', {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
      state.shotTimer = setTimeout(function () {
        post('captureMode', { on: false });
        showToast('截图没有响应，请重试', true);
      }, 6000);
    }, 120);
  }

  ui.btnShot.onclick = captureGame;

  // ── 图片替换 ───────────────────────────────────────────
  ui.btnImgPick.onclick = function () { ui.imgFile.click(); };
  ui.imgFile.addEventListener('change', function () {
    var file = ui.imgFile.files && ui.imgFile.files[0];
    ui.imgFile.value = '';
    uploadImage(file);
  });
  ui.btnImgClear.onclick = function () {
    post('setImage', { url: null });
    ui.imgThumb.style.backgroundImage = '';
  };
  Array.prototype.forEach.call(ui.imgModeGroup.querySelectorAll('button'), function (button) {
    button.onclick = function () {
      state.imgMode = button.dataset.imgmode;
      post('setImageOption', { mode: state.imgMode });
    };
  });
  Array.prototype.forEach.call(ui.imgFitGroup.querySelectorAll('button'), function (button) {
    button.onclick = function () {
      state.imgFit = button.dataset.imgfit;
      post('setImageOption', { fit: state.imgFit });
    };
  });
  ui.btnInspect.onclick = function () { post('inspect'); };

  if (host) {
    host.addEventListener('message', function (event) {
      var message = event.data;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'app:screenshot:done') {
        clearTimeout(state.shotTimer);
        post('captureMode', { on: false });
        if (message.ok) showToast('截图已复制到剪贴板' + (message.file ? ' · ' + message.file : ''));
        else showToast('截图失败：' + (message.message || '未知错误'), true);
      }
    });
  }

  // ── 启动 ───────────────────────────────────────────────
  renderDevice();
  if (!host) {
    // 在普通浏览器里打开时，“更换目录 / 退出 / 截图”没有宿主可通知，隐藏掉
    ui.btnReselect.hidden = true;
    ui.btnQuit.hidden = true;
    ui.btnShot.hidden = true;
  }
  loadMeta();
  applyDsf(state.kind);
  fitStage();
  loadGame(true);
})();
