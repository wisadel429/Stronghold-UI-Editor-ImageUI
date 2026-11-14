// 选择游戏目录 · 内置页逻辑
// 与 C# 宿主通过 chrome.webview.postMessage 通信；目录读取、校验、启动都在宿主侧完成。

(function () {
  'use strict';

  var bridge = window.chrome && window.chrome.webview ? window.chrome.webview : null;
  var el = function (id) { return document.getElementById(id); };

  var ui = {
    nodeTag: el('nodeTag'),
    verTag: el('verTag'),
    drives: el('drives'),
    pathInput: el('pathInput'),
    crumbs: el('crumbs'),
    list: el('list'),
    listState: el('listState'),
    listNote: el('listNote'),
    btnUp: el('btnUp'),
    btnRefresh: el('btnRefresh'),
    detailName: el('detailName'),
    detailBadge: el('detailBadge'),
    detailPath: el('detailPath'),
    checks: el('checks'),
    detailHint: el('detailHint'),
    btnStart: el('btnStart'),
    suggest: el('suggest'),
    suggestItem: el('suggestItem'),
    suggestName: el('suggestName'),
    suggestPath: el('suggestPath'),
    recent: el('recent'),
    recentList: el('recentList'),
    overlay: el('overlay'),
    launchTitle: el('launchTitle'),
    launchPath: el('launchPath'),
    launchSteps: el('launchSteps'),
    launchBar: el('launchBar'),
    launchLog: el('launchLog'),
    launchTip: el('launchTip'),
    launchError: el('launchError'),
    btnCancel: el('btnCancel'),
    btnRetry: el('btnRetry'),
    btnNode: el('btnNode'),
  };

  var state = {
    listing: null,
    selected: '',
    probe: null,
    cursor: -1,
    pendingSelect: '',
    drives: [],
    busy: false,
    busyTimer: 0,
    logLines: [],
    started: false,
  };

  var STEPS = [
    { key: 'validate', label: '校验游戏目录' },
    { key: 'assets', label: '安装编辑器资源' },
    { key: 'server', label: '启动游戏服务端' },
    { key: 'proxy', label: '启动编辑代理' },
  ];
  var stepState = {};

  function post(type, data) {
    if (!bridge) return;
    var message = { type: type };
    if (data) {
      for (var key in data) {
        if (Object.prototype.hasOwnProperty.call(data, key)) message[key] = data[key];
      }
    }
    try { bridge.postMessage(message); } catch (e) { /* 忽略 */ }
  }

  function text(node, value) {
    if (node) node.textContent = value == null ? '' : String(value);
  }

  function baseName(path) {
    if (!path) return '';
    var clean = String(path).replace(/[\\/]+$/, '');
    var cut = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
    return cut >= 0 ? clean.slice(cut + 1) : clean;
  }

  function parentOf(path) {
    if (!path) return '';
    var clean = String(path).replace(/[\\/]+$/, '');
    if (/^[A-Za-z]:$/.test(clean)) return '';
    var cut = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
    if (cut < 0) return '';
    var parent = clean.slice(0, cut);
    if (/^[A-Za-z]:$/.test(parent)) return parent + '\\';
    return parent;
  }

  function isSamePath(a, b) {
    if (!a || !b) return false;
    return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
  }

  // ── 初始化 ─────────────────────────────────────────────
  function onInit(message) {
    state.drives = Array.isArray(message.drives) ? message.drives : [];
    renderDrives();

    if (message.version) text(ui.verTag, 'v' + message.version);
    updateNodeTag(message.node);

    renderSuggestions(message.suggestions, message.lastGame);
    renderRecent(message.recent);

    var start = '';
    if (message.suggestions && message.suggestions.length) {
      start = parentOf(message.suggestions[0]);
    } else if (message.lastGame) {
      start = parentOf(message.lastGame);
    }
    if (!start) start = message.defaultPath || message.toolDir || '';
    // 不自动选中任何目录：进入后由用户点选，避免误把备份目录当成游戏目录。
    state.pendingSelect = '';
    navigate(start, false);
  }

  function updateNodeTag(node) {
    var found = !!(node && node.found);
    ui.nodeTag.classList.toggle('is-ok', found);
    ui.nodeTag.classList.toggle('is-warn', !found);
    text(ui.nodeTag, found ? 'NODE · 就绪' : 'NODE · 未找到');
    ui.nodeTag.title = found ? (node.path || '') : '没有找到 Node.js；可以安装 Node.js 22+，或使用自带 node\\node.exe 的游戏包';
  }

  function renderSuggestions(suggestions, lastGame) {
    var list = (suggestions || []).filter(function (item) { return item; });
    var target = list[0] || lastGame;
    if (!target) { ui.suggest.hidden = true; return; }
    ui.suggest.hidden = false;
    text(ui.suggestName, baseName(target));
    text(ui.suggestPath, target);
    ui.suggestItem.onclick = function () { pickPath(target); };
  }

  function renderRecent(recent) {
    ui.recentList.textContent = '';
    var list = (recent || []).filter(Boolean).slice(0, 6);
    if (!list.length) { ui.recent.hidden = true; return; }
    ui.recent.hidden = false;
    list.forEach(function (path) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'recent__chip';
      chip.textContent = baseName(path);
      chip.title = path;
      chip.onclick = function () { pickPath(path); };
      ui.recentList.appendChild(chip);
    });
  }

  function pickPath(path) {
    var parent = parentOf(path);
    state.pendingSelect = path;
    navigate(parent || path, true);
  }

  // ── 目录列表 ───────────────────────────────────────────
  function navigate(path, selectAfter) {
    if (state.busy) return;
    state.busy = true;
    // 宿主偶发不回包时别把界面永久锁死；7 秒后自动解锁。
    clearTimeout(state.busyTimer);
    state.busyTimer = setTimeout(function () {
      state.busy = false;
      ui.listState.hidden = true;
    }, 7000);
    ui.listState.hidden = false;
    ui.listState.classList.remove('is-error');
    text(ui.listState, '正在读取目录…');
    if (selectAfter) state.pendingSelect = state.pendingSelect || '';
    post('picker:list', { path: path || '' });
  }

  function onListing(message) {
    state.busy = false;
    clearTimeout(state.busyTimer);
    state.listing = message;
    if (message.error && !message.path) {
      ui.listState.hidden = false;
      ui.listState.classList.add('is-error');
      text(ui.listState, message.error);
      return;
    }
    if (message.error) {
      ui.listState.hidden = false;
      ui.listState.classList.add('is-error');
      text(ui.listState, message.error);
    } else if (!message.folders || !message.folders.length) {
      ui.listState.hidden = false;
      text(ui.listState, '这个目录里没有子文件夹');
    } else {
      ui.listState.hidden = true;
    }

    if (Array.isArray(message.drives) && message.drives.length) {
      state.drives = message.drives;
      renderDrives();
    }
    if (message.path) {
      ui.pathInput.value = message.path;
      renderCrumbs(message.path);
    }
    ui.btnUp.disabled = !message.parent;
    renderRows(message);
    updateDriveState(message.path);

    if (state.pendingSelect && message.path) {
      var target = state.pendingSelect;
      state.pendingSelect = '';
      var found = (message.folders || []).some(function (folder) { return isSamePath(folder.path, target); });
      if (found) {
        select(target, true);
        scrollSelectedIntoView();
      } else if (isSamePath(target, message.path)) {
        select(target, true);
      }
    }
    ui.list.focus();
  }

  function renderDrives() {
    ui.drives.textContent = '';
    (state.drives || []).forEach(function (drive) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'drive';
      button.dataset.path = drive.path;
      var name = document.createElement('span');
      name.textContent = drive.name || baseName(drive.path);
      button.appendChild(name);
      if (drive.label) {
        var label = document.createElement('small');
        label.textContent = drive.label;
        button.appendChild(label);
      }
      button.title = drive.path;
      button.onclick = function () { navigate(drive.path, false); };
      ui.drives.appendChild(button);
    });
  }

  function updateDriveState(path) {
    var root = path && path.slice(0, 2).toUpperCase();
    Array.prototype.forEach.call(ui.drives.children, function (button) {
      var driveRoot = (button.dataset.path || '').slice(0, 2).toUpperCase();
      button.classList.toggle('is-on', !!root && driveRoot === root);
    });
  }

  function renderCrumbs(path) {
    ui.crumbs.textContent = '';
    if (!path) return;
    var normalized = String(path).replace(/\//g, '\\');
    var parts = normalized.split('\\').filter(function (part) { return part !== ''; });
    var current = '';
    parts.forEach(function (part, index) {
      if (index === 0) {
        current = part + '\\';
      } else {
        current = current.replace(/\\$/, '') + '\\' + part;
      }
      if (index) {
        var sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = '›';
        ui.crumbs.appendChild(sep);
      }
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'crumb' + (index === parts.length - 1 ? ' is-last' : '');
      button.textContent = part;
      button.title = current;
      // 每次迭代单独捕获路径；否则所有面包屑都会跳到最后一级（原来点击没反应）。
      var targetPath = current;
      button.onclick = function () { navigate(targetPath, false); };
      ui.crumbs.appendChild(button);
    });
  }

  function renderRows(message) {
    ui.list.textContent = '';
    state.cursor = -1;

    if (message.parent) {
      var up = document.createElement('div');
      up.className = 'row row--up';
      up.dataset.path = message.parent;
      up.innerHTML = '<span class="row__icon">↑</span><span class="row__name">.. 上一级</span>';
      up.onclick = function () { select(message.parent, false); };
      up.ondblclick = function () { navigate(message.parent, false); };
      ui.list.appendChild(up);
    }

    var gameCount = 0;
    (message.folders || []).forEach(function (folder) {
      // 能直接载入 = 是游戏目录 + 找到 Node 运行时；整行绿色高亮，一眼挑出来。
      var ready = !!(folder.isGame && folder.hasNode);
      if (folder.isGame) gameCount++;
      var row = document.createElement('div');
      row.className = 'row'
        + (folder.isGame ? ' row--game' : '')
        + (ready ? ' row--ready' : '');
      row.dataset.path = folder.path;
      row.setAttribute('role', 'option');
      row.title = folder.path + (ready ? '\n可直接载入' : folder.isGame ? '\n游戏目录（缺 Node 运行时）' : '');

      var icon = document.createElement('span');
      icon.className = 'row__icon';
      icon.textContent = folder.isGame ? '◆' : '▸';
      row.appendChild(icon);

      var name = document.createElement('span');
      name.className = 'row__name';
      name.textContent = folder.name;
      name.title = folder.path;
      row.appendChild(name);

      var badges = document.createElement('span');
      badges.className = 'row__badges';
      if (folder.isGame) {
        var gameBadge = document.createElement('span');
        gameBadge.className = 'badge badge--game';
        gameBadge.textContent = 'GAME';
        badges.appendChild(gameBadge);
      }
      if (folder.hasNode) {
        var nodeBadge = document.createElement('span');
        nodeBadge.className = 'badge badge--node';
        nodeBadge.textContent = 'NODE';
        badges.appendChild(nodeBadge);
      }
      if (ready) {
        var readyBadge = document.createElement('span');
        readyBadge.className = 'badge badge--ready';
        readyBadge.textContent = '可载入';
        badges.appendChild(readyBadge);
      }
      if (badges.children.length) row.appendChild(badges);

      var enter = document.createElement('span');
      enter.className = 'row__enter';
      enter.textContent = '›';
      row.appendChild(enter);

      row.onclick = function () { select(folder.path, false); };
      row.ondblclick = function () { navigate(folder.path, false); };
      ui.list.appendChild(row);
    });

    // 顶部提示：这个目录下有几个游戏目录（已经置顶并整行标绿）。
    if (ui.listNote) {
      if (gameCount > 0) {
        ui.listNote.hidden = false;
        ui.listNote.textContent = '检测到 ' + gameCount + ' 个游戏目录，已置顶并整行标绿 · 双击进入，单击选中后点右下角载入';
        ui.listNote.classList.remove('is-none');
      } else {
        ui.listNote.hidden = false;
        ui.listNote.classList.add('is-none');
        ui.listNote.textContent = '这一层没有检测到游戏目录：往上返回或直接点进子文件夹找';
      }
    }
  }

  function select(path, probeImmediately) {
    state.selected = path || '';
    state.probe = probeImmediately ? state.probe : null;
    Array.prototype.forEach.call(ui.list.querySelectorAll('.row'), function (row) {
      row.classList.toggle('is-on', isSamePath(row.dataset.path, state.selected));
    });
    var index = Array.prototype.indexOf.call(ui.list.querySelectorAll('.row'), ui.list.querySelector('.row.is-on'));
    state.cursor = index;
    updateDetail(path, null, true);
    if (path) post('picker:probe', { path: path });
  }

  function updateDetail(path, probe, loading) {
    text(ui.detailName, path ? baseName(path) : '未选择目录');
    text(ui.detailPath, path || '在上面的列表里选择一个文件夹');
    ui.detailBadge.hidden = !(probe && probe.valid);
    ui.checks.textContent = '';

    if (!path) {
      text(ui.detailHint, '需要包含 public/index.html 和 server/ 的那一层');
      ui.detailHint.classList.remove('is-warn');
      ui.btnStart.disabled = true;
      return;
    }

    if (!probe) {
      text(ui.detailHint, loading ? '正在检查这个目录…' : '选择后会自动检查');
      ui.detailHint.classList.remove('is-warn');
      ui.btnStart.disabled = true;
      addCheck('public/index.html', null);
      addCheck('server/index.js', null);
      return;
    }

    if (probe.error) {
      text(ui.detailHint, probe.error);
      ui.detailHint.classList.add('is-warn');
      ui.btnStart.disabled = true;
      return;
    }

    addCheck('public/index.html', !!probe.hasIndex);
    addCheck('server/index.js', !!probe.hasServer);
    var pkg = probe.pkgName ? probe.pkgName + (probe.pkgVersion ? '@' + probe.pkgVersion : '') : 'package.json';
    addCheck(pkg + ' · 版本识别', !!probe.hasPkg);
    addCheck(probe.nodeOk ? 'Node 运行时' : '缺少 Node 运行时', !!probe.nodeOk);
    addCheck('webview2 固定运行时（可选）', !!probe.hasWebview2);

    if (!probe.valid) {
      text(ui.detailHint, '这不是游戏目录：需要包含 public/index.html 和 server/ 的那一层。');
      ui.detailHint.classList.add('is-warn');
      ui.btnStart.disabled = true;
    } else if (!probe.nodeOk) {
      text(ui.detailHint, '目录有效，但没有找到 Node.js。装一个 Node.js 22+ 或使用自带 node\\node.exe 的游戏包。');
      ui.detailHint.classList.add('is-warn');
      ui.btnStart.disabled = true;
    } else {
      text(ui.detailHint, '目录有效，可以载入。编辑器只会新增 public/ui-editor/ 和 public/ui-layout.json，并在 index.html 里加一行钩子。');
      ui.detailHint.classList.remove('is-warn');
      ui.btnStart.disabled = false;
    }
    if (probe.nodeOk) updateNodeTag({ found: true, path: probe.nodePath });
  }

  function addCheck(label, ok) {
    var item = document.createElement('span');
    item.className = 'check' + (ok === true ? ' is-ok' : ok === false ? ' is-bad' : '');
    var mark = document.createElement('b');
    mark.textContent = ok === true ? '✓' : ok === false ? '!' : '·';
    item.appendChild(mark);
    item.appendChild(document.createTextNode(label));
    ui.checks.appendChild(item);
  }

  function scrollSelectedIntoView() {
    var row = ui.list.querySelector('.row.is-on');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  // ── 键盘 ───────────────────────────────────────────────
  function rows() { return Array.prototype.slice.call(ui.list.querySelectorAll('.row')); }

  function moveCursor(delta) {
    var list = rows();
    if (!list.length) return;
    state.cursor = Math.max(0, Math.min(list.length - 1, state.cursor + delta));
    list[state.cursor].classList.add('is-cursor');
    list.forEach(function (row, index) { if (index !== state.cursor) row.classList.remove('is-cursor'); });
    list[state.cursor].scrollIntoView({ block: 'nearest' });
    select(list[state.cursor].dataset.path, false);
  }

  ui.list.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveCursor(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveCursor(-1); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      var row = rows()[state.cursor];
      if (row) {
        if (row.classList.contains('row--up')) navigate(row.dataset.path, false);
        else navigate(row.dataset.path, false);
      }
    } else if (event.key === 'Backspace') {
      if (state.listing && state.listing.parent) { event.preventDefault(); navigate(state.listing.parent, false); }
    }
  });

  ui.pathInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      navigate(ui.pathInput.value.trim(), false);
    }
  });

  ui.btnUp.onclick = function () { if (state.listing && state.listing.parent) navigate(state.listing.parent, false); };
  ui.btnRefresh.onclick = function () { if (state.listing && state.listing.path) navigate(state.listing.path, false); };

  ui.btnStart.onclick = function () {
    if (!state.probe || !state.probe.valid || !state.probe.nodeOk) return;
    startLaunch(state.probe.path);
  };

  // ── 启动遮罩 ───────────────────────────────────────────
  function startLaunch(path) {
    state.started = true;
    state.logLines = [];
    stepState = {};
    ui.overlay.hidden = false;
    ui.launchError.hidden = true;
    ui.btnRetry.hidden = true;
    ui.btnNode.hidden = true;
    ui.btnCancel.hidden = false;
    ui.launchTitle.textContent = '正在准备编辑器';
    text(ui.launchPath, path || '');
    text(ui.launchTip, '首次启动需要建立资源索引，请稍候');
    text(ui.launchLog, '');
    ui.launchBar.style.width = '4%';
    renderSteps();
    post('picker:start', { path: path });
  }

  function renderSteps() {
    ui.launchSteps.textContent = '';
    var activeSeen = false;
    STEPS.forEach(function (step, index) {
      var stateName = stepState[step.key] || 'pending';
      var item = document.createElement('div');
      item.className = 'lstep';
      var mark = document.createElement('b');
      var label = document.createElement('span');
      label.textContent = step.label;
      var em = document.createElement('em');

      if (stateName === 'done') { item.classList.add('is-done'); mark.textContent = '✓'; em.textContent = '完成'; }
      else if (stateName === 'error') { item.classList.add('is-error'); mark.textContent = '!'; em.textContent = '失败'; }
      else if (!activeSeen) { item.classList.add('is-on'); mark.textContent = String(index + 1); em.textContent = '进行中'; activeSeen = true; }
      else { mark.textContent = String(index + 1); em.textContent = '等待'; }

      item.appendChild(mark);
      item.appendChild(label);
      item.appendChild(em);
      ui.launchSteps.appendChild(item);
    });
    var done = STEPS.filter(function (step) { return stepState[step.key] === 'done'; }).length;
    var error = STEPS.some(function (step) { return stepState[step.key] === 'error'; });
    if (!error) ui.launchBar.style.width = Math.max(4, Math.round((done / STEPS.length) * 100)) + '%';
  }

  function onStep(message) {
    var key = message.key || '';
    if (!stepState.hasOwnProperty(key)) {
      // 兼容宿主只给中文标签的情况：按顺序落位
      var next = STEPS.filter(function (step) { return !stepState[step.key]; })[0];
      key = next ? next.key : key;
    }
    stepState[key] = message.state === 'done' ? 'done' : message.state === 'error' ? 'error' : 'start';
    renderSteps();
  }

  function onLog(message) {
    var line = message.line || '';
    if (!line) return;
    state.logLines.push(line);
    while (state.logLines.length > 42) state.logLines.shift();
    ui.launchLog.textContent = state.logLines.join('\n');
    ui.launchLog.scrollTop = ui.launchLog.scrollHeight;
  }

  function onReady(message) {
    STEPS.forEach(function (step) { stepState[step.key] = 'done'; });
    renderSteps();
    ui.launchBar.style.width = '100%';
    ui.launchTitle.textContent = '正在打开编辑台';
    text(ui.launchTip, '左侧游戏画面 + 右侧编辑侧边栏');
    ui.btnCancel.hidden = true;
    if (message.url) text(ui.launchPath, message.url);
  }

  function onError(message) {
    ui.launchError.hidden = false;
    ui.launchError.textContent = message.message || '启动失败';
    ui.launchTitle.textContent = '启动失败';
    ui.btnCancel.hidden = true;
    ui.btnRetry.hidden = false;
    ui.btnNode.hidden = message.code !== 'node-missing';
    var current = STEPS.filter(function (step) { return stepState[step.key] !== 'done'; })[0];
    if (current) stepState[current.key] = 'error';
    renderSteps();
    text(ui.launchTip, '可以关闭遮罩、换一个目录再试');
    if (message.code === 'node-missing') {
      ui.launchTip.textContent = '安装 Node.js 后重新载入这个目录即可';
    }
  }

  ui.btnCancel.onclick = function () {
    post('picker:cancel');
    ui.overlay.hidden = true;
    state.started = false;
  };
  ui.btnRetry.onclick = function () {
    ui.overlay.hidden = true;
    state.started = false;
    if (state.probe && state.probe.path) select(state.probe.path, true);
  };
  ui.btnNode.onclick = function () {
    post('app:openUrl', { url: 'https://nodejs.org/' });
  };

  // ── 宿主消息 ───────────────────────────────────────────
  if (bridge) {
    bridge.addEventListener('message', function (event) {
      var message = event.data;
      if (!message || typeof message !== 'object') return;
      switch (message.type) {
        case 'init': onInit(message); break;
        case 'listing': onListing(message); break;
        case 'probe':
          if (state.selected && isSamePath(state.selected, message.path)) {
            state.probe = message;
            updateDetail(state.selected, message, false);
          }
          break;
        case 'starting':
          if (!state.started) startLaunch(message.path);
          else text(ui.launchPath, message.path || '');
          break;
        case 'step': onStep(message); break;
        case 'log': onLog(message); break;
        case 'ready': onReady(message); break;
        case 'error': onError(message); break;
        case 'cancelled':
          ui.overlay.hidden = true;
          state.started = false;
          break;
        case 'autostart':
          if (message.path) startLaunch(message.path);
          break;
        default: break;
      }
    });
    post('picker:ready');
  } else {
    // 在普通浏览器里打开时的兜底提示（正常不会走到这里）
    text(ui.listState, '请用 StrongholdUIEditor.exe 打开（内置浏览器）');
    ui.listState.hidden = false;
    ui.listState.classList.add('is-error');
    ui.nodeTag.textContent = 'NODE · 仅宿主可用';
    ui.nodeTag.classList.add('is-warn');
  }
})();
