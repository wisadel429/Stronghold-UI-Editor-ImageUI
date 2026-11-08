// 独立版 UI 布局编辑器 · 主程序
//
// 流程：选择游戏目录 → 校验 → 拷入编辑器资源 → 在 index.html 里插一行脚本 →
//       检查/启动游戏服务端 → 起一个本机反向代理（提供同源保存接口）→ 打开浏览器进编辑模式。
//
// 设计目标：兼容这个游戏的各个版本，不依赖游戏服务端的任何接口。
// 对游戏目录的改动只有：新增 public/ui-editor/、新增 public/ui-layout.json、index.html 里加一行 <script>。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProxy } from './proxy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, 'assets');

const argv = process.argv.slice(2);
const valueOf = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
};

let GAME_DIR = valueOf('--game') ? path.resolve(valueOf('--game')) : null;
const SERVER_BASE_PORT = Number(valueOf('--port') || process.env.PORT || 3000);
let serverPort = SERVER_BASE_PORT;
const PROXY_PORT = Number(valueOf('--proxy-port') || 3123);
const NO_OPEN = argv.includes('--no-open');
const EMBEDDED = argv.includes('--embedded');
let errorEmitted = false;
let ownedServer = null;

const emit = (event, data = {}) => {
  if (!EMBEDDED) return;
  try { process.stdout.write(`${JSON.stringify({ event, ...data })}\n`); } catch { /* 忽略 */ }
};

const line = (text = '') => {
  if (EMBEDDED) emit('log', { line: text });
  else console.log(text);
};
const ok = (text) => line(`  \u2714 ${text}`);
const skip = (text) => line(`  \u2013 ${text}`);
const fail = (text, code = 'error') => {
  if (EMBEDDED) { errorEmitted = true; emit('error', { message: text, code }); }
  console.error(`\n\u2718 ${text}\n`); process.exitCode = 1; throw new Error(text);
};
const step = (key, label, state, detail = '') => {
  emit('step', { key, label, state, detail });
};

const HTML = () => path.join(GAME_DIR, 'public', 'index.html');
const SERVER_ENTRY = () => findServerEntry();
const LAYOUT_FILE = () => path.join(GAME_DIR, 'public', 'ui-layout.json');

/** 不同版本的服务器入口不完全一样：优先用约定文件名，其次 package.json 的 main。 */
function findServerEntry() {
  const candidates = [
    'server/index.js', 'server/index.mjs', 'server/main.js', 'server/main.mjs',
    'server.js', 'index.js', 'index.mjs', 'app.js',
  ];
  for (const rel of candidates) {
    const file = path.join(GAME_DIR, rel);
    if (fs.existsSync(file)) return file;
  }
  try {
    const pkg = readJson(path.join(GAME_DIR, 'package.json'));
    if (pkg?.main) {
      const file = path.resolve(GAME_DIR, pkg.main);
      if (fs.existsSync(file)) return file;
    }
  } catch { /* 忽略 */ }
  return null;
}

function emptyLayout() {
  return { version: 2, updatedAt: null, profiles: { desktop: { entries: [] }, mobile: { entries: [] } } };
}

/** 存档目录 / 文件名用的安全 slug。 */
function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9.@_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'profile';
}

/** 版本标识：优先 package.json 的 name@version，其次目录名。 */
function gameVersionKey(gameDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(gameDir, 'package.json'), 'utf8'));
    if (pkg?.version) return `${pkg.name || 'stronghold'}@${pkg.version}`;
  } catch { /* 没 package.json 就用目录名 */ }
  return path.basename(gameDir);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function countEntries(layout) {
  const entries = layout?.profiles || {};
  const count = (kind) => (Array.isArray(entries[kind]?.entries) ? entries[kind].entries.length : 0);
  return { desktop: count('desktop'), mobile: count('mobile') };
}

function probe(url, timeout = 1200) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}

function findNode() {
  const candidates = [
    path.join(GAME_DIR, 'node', 'node.exe'),
    path.join(GAME_DIR, 'node', 'node'),
    path.join(HERE, 'node', 'node.exe'),
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return 'node';
}

/** 1. 校验目录 */
function validate() {
  if (!GAME_DIR) fail('没有给游戏目录：请双击“启动.bat”用目录选择框选，或加 --game "D:\\path\\to\\game"');
  if (!fs.existsSync(GAME_DIR)) fail(`目录不存在：${GAME_DIR}`);
  if (!fs.existsSync(HTML())) fail(`不是游戏目录（找不到 public/index.html）：${GAME_DIR}`);

  const looksLikeGame = ['public', 'server', 'shared', 'package.json'].some((name) => fs.existsSync(path.join(GAME_DIR, name)));
  if (!looksLikeGame) fail(`目录里没有游戏文件（public / server / shared / package.json 都没有）：${GAME_DIR}`);
}

/** 2. 拷入编辑器资源到 <game>/public/ui-editor/ */
function installAssets() {
  const dest = path.join(GAME_DIR, 'public', 'ui-editor');
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const name of fs.readdirSync(ASSETS)) {
    const from = path.join(ASSETS, name);
    const to = path.join(dest, name);
    const src = fs.statSync(from);
    const same = fs.existsSync(to) && fs.statSync(to).size === src.size && fs.statSync(to).mtimeMs >= src.mtimeMs;
    if (!same) { fs.copyFileSync(from, to); copied++; }
  }
  ok(copied ? `编辑器资源已更新（${copied} 个文件） → public/ui-editor/` : '编辑器资源已是最新（public/ui-editor/）');
}

/** 3. index.html 插入一行脚本（幂等，首次备份 .ui-editor.orig） */
function patchIndex() {
  const file = HTML();
  let html = fs.readFileSync(file, 'utf8');
  if (html.includes('/ui-editor/apply.js')) {
    skip('index.html 已经装过钩子（跳过）');
    return;
  }
  const backup = `${file}.ui-editor.orig`;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  const tag = '  <script type="module" src="/ui-editor/apply.js"></script>';
  html = html.includes('</body>') ? html.replace('</body>', `${tag}\n</body>`) : `${html}\n${tag}\n`;
  fs.writeFileSync(file, html, 'utf8');
  ok('index.html 已插入 <script src="/ui-editor/apply.js">（原文件备份为 index.html.ui-editor.orig）');
}

/** 4. 布局文件：优先沿用旧版 data/ui-layout.json */
function ensureLayoutFile() {
  const file = LAYOUT_FILE();
  const legacy = path.join(GAME_DIR, 'data', 'ui-layout.json');
  if (fs.existsSync(file)) {
    skip('public/ui-layout.json 已存在');
    // 装过游戏内编辑器的机器上，让 data/ 里那份跟 public/ 保持一致，避免两套布局打架
    if (fs.existsSync(legacy)) {
      try {
        const a = fs.readFileSync(file, 'utf8');
        const b = fs.readFileSync(legacy, 'utf8');
        if (a !== b) { fs.writeFileSync(legacy, a, 'utf8'); ok('已把 public/ui-layout.json 同步到 data/ui-layout.json'); }
      } catch { /* 同步失败忽略 */ }
    }
    return;
  }
  if (fs.existsSync(legacy)) {
    fs.copyFileSync(legacy, file);
    ok('已从 data/ui-layout.json 迁移布局到 public/ui-layout.json');
    return;
  }
  fs.writeFileSync(file, `${JSON.stringify(emptyLayout(), null, 2)}\n`, 'utf8');
  ok('已创建空的 public/ui-layout.json');
}

/** 选一个空闲端口：不抢正在运行的游戏服务端，也不让不同版本的目录共用同一个服务端。 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.listen(port, '127.0.0.1', () => tester.close(() => resolve(true)));
  });
}

/** 端口上是否已经有服务在监听（比 HTTP /healthz 可靠，不依赖对方响应速度）。 */
function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* 忽略 */ }
      resolve(value);
    };
    socket.setTimeout(600);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function findFreePort(base) {
  // Windows 上 0.0.0.0 与 127.0.0.1 的占用检测不可靠：先看 base 端口有没有服务监听，
  // 有的话直接从 base+1 开始，绝不复用别的版本/副本的服务端。
  let first = base;
  if (await isPortOpen(base)) first = base + 1;
  for (let port = first; port < base + 20; port++) {
    if (!(await isPortOpen(port)) && (await isPortFree(port))) return port;
  }
  return null;
}

/** 5. 始终为选中的游戏目录启动它自己的服务端（多版本可共存，已有的 3000 端口不动）。 */
async function ensureServer() {
  const port = await findFreePort(SERVER_BASE_PORT);
  if (!port) fail(`端口 ${SERVER_BASE_PORT}~${SERVER_BASE_PORT + 19} 都被占用了`);
  serverPort = port;
  const health = `http://127.0.0.1:${serverPort}/healthz`;

  const entry = SERVER_ENTRY();
  if (!entry) fail(`找不到服务器入口（server/index.js、server/index.mjs、server/main.js 或 package.json 的 main）`);

  const relativeEntry = path.relative(GAME_DIR, entry);
  const node = findNode();
  line(`  · 正在启动游戏服务端：${node} ${relativeEntry}（端口 ${serverPort}，首次启动要建资源索引，可能等十几秒）`);
  const child = spawn(node, [relativeEntry], {
    cwd: GAME_DIR,
    env: { ...process.env, PORT: String(serverPort) },
    stdio: EMBEDDED ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: EMBEDDED,
  });
  if (EMBEDDED) {
    const forward = (stream) => {
      stream?.on('data', (chunk) => {
        for (const text of String(chunk).split(/\r?\n/)) {
          if (text.trim()) emit('log', { line: text });
        }
      });
    };
    forward(child.stdout);
    forward(child.stderr);
  }
  child.on('error', (error) => line(`  ! 服务端启动失败：${error.message}`));

  for (let i = 0; i < 240; i++) {
    if (await probe(health, 800)) { ok(`游戏服务端已就绪（127.0.0.1:${serverPort}）`); return child; }
    if (!EMBEDDED && i % 10 === 0) process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 500));
  }
  line('');
  fail(`游戏服务端 120 秒内没起来（端口 ${serverPort}）：先手动双击 start-game.bat / Stronghold.exe 试试，看它报什么错`);
  return child;
}

/** 6. 当前版本的自动存档（存在时保持与 public/ui-layout.json 一致） */
function ensureAutoProfile(versionKey, profilesDir) {
  const autoFile = path.join(profilesDir, `auto-${slug(versionKey)}.json`);
  const current = readJson(LAYOUT_FILE()) || emptyLayout();
  const counts = countEntries(current);
  if (fs.existsSync(autoFile)) {
    const saved = readJson(autoFile) || {};
    const sameProfiles = JSON.stringify(saved.profiles || {}) === JSON.stringify(current.profiles || {});
    if (!sameProfiles) {
      const merged = { ...current, name: saved.name || `自动存档 · ${versionKey}`, versionKey, updatedAt: new Date().toISOString() };
      fs.writeFileSync(autoFile, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
      ok(`已把当前布局同步进存档：电脑版 ${counts.desktop} 项 · 手机端 ${counts.mobile} 项`);
    } else {
      skip(`本版本的存档已存在：电脑版 ${counts.desktop} 项 · 手机端 ${counts.mobile} 项`);
    }
    return autoFile;
  }
  const payload = {
    ...current,
    name: `自动存档 · ${versionKey}`,
    versionKey,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(autoFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  ok(`已为当前版本建立存档：电脑版 ${counts.desktop} 项 · 手机端 ${counts.mobile} 项 → ${path.basename(autoFile)}`);
  return autoFile;
}

/** 7. 起代理 */
async function startProxy(versionKey, profilesDir) {
  for (let port = PROXY_PORT; port < PROXY_PORT + 8; port++) {
    try {
      const proxy = await createProxy({ gameDir: GAME_DIR, profilesDir, versionKey, targetPort: serverPort, listenPort: port });
      ok(`编辑代理已启动：${proxy.url}（转发到 127.0.0.1:${serverPort}）`);
      return proxy;
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  fail(`端口 ${PROXY_PORT}~${PROXY_PORT + 7} 都被占用了，换一个：--proxy-port 3133`);
  return null;
}

function openBrowser(url) {
  if (NO_OPEN) { line(`  · 浏览器：${url}`); return; }
  try {
    const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    ok(`已打开浏览器：${url}`);
  } catch {
    line(`  · 浏览器没打开，手动访问：${url}`);
  }
}

/** 没给 --game 时弹目录选择框（PowerShell 写临时文件，避开控制台编码问题）。 */
function askGameFolder() {
  return new Promise((resolve) => {
    const script = path.join(HERE, 'pick-path.ps1');
    if (!fs.existsSync(script)) { resolve(null); return; }
    const outFile = path.join(os.tmpdir(), `sp-ui-editor-pick-${process.pid}-${Date.now()}.txt`);
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-out', outFile], { windowsHide: false }, () => {
      let picked = '';
      try { picked = fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '').trim(); } catch { /* 取消或没写出来 */ }
      try { fs.rmSync(outFile, { force: true }); } catch { /* 忽略 */ }
      resolve(picked || null);
    });
  });
}

async function main() {
  line('\n== Stronghold UI Layout Editor ==\n');
  if (!GAME_DIR) {
    line('  A folder picker will open.');
    line('  Choose the game folder — the one that contains public and server.');
    line('');
    GAME_DIR = await askGameFolder();
    if (!GAME_DIR) fail('No game folder selected.');
  }

  step('validate', '校验游戏目录', 'start');
  validate();
  ok(`游戏目录：${GAME_DIR}`);

  const versionKey = gameVersionKey(GAME_DIR);
  const profilesDir = path.join(HERE, 'profiles');
  fs.mkdirSync(profilesDir, { recursive: true });
  ok(`游戏版本：${versionKey}`);
  step('validate', '校验游戏目录', 'done', versionKey);

  step('assets', '安装编辑器资源', 'start');
  installAssets();
  patchIndex();
  ensureLayoutFile();
  ensureAutoProfile(versionKey, profilesDir);
  step('assets', '安装编辑器资源', 'done');

  step('server', '启动游戏服务端', 'start');
  const serverChild = await ensureServer();
  ownedServer = serverChild;
  step('server', '启动游戏服务端', 'done');

  step('proxy', '启动编辑代理', 'start');
  const proxy = await startProxy(versionKey, profilesDir);
  step('proxy', '启动编辑代理', 'done');

  if (EMBEDDED) {
    emit('ready', {
      url: `${proxy.url}/ui-editor/studio.html`,
      gameDir: GAME_DIR,
      version: versionKey,
      layoutFile: LAYOUT_FILE(),
    });
  } else {
    const url = `${proxy.url}/?ui-edit=1`;
    openBrowser(url);
    const archives = fs.readdirSync(profilesDir).filter((name) => name.endsWith('.json')).length;
    line('');
    line('  编辑方式：内置浏览器里左侧是游戏画面，右侧是编辑侧边栏');
    line('    · 点元素选中，拖动移动；拖四角改尺寸；Shift+点击 / 面板「多选」= 多选');
    line('    · 「电脑版 16:9 / 手机端 21:9」两套方案分开调');
    line('    · Ctrl+S 保存 → 写入 public/ui-layout.json，普通开局也生效');
    line('    · 面板里的「存档」可以给当前布局另存多份，换版本/换机器都能带过去');
    line('');
    line(`  布局文件：${LAYOUT_FILE()}`);
    line(`  存档目录：${profilesDir}（${archives} 份，按游戏版本自动对应）`);
    line('  关闭本窗口即可结束编辑（游戏服务端如果由本工具启动，会一起结束）');
    line('');
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    line('\n正在关闭编辑代理…');
    try { await proxy.close(); } catch { /* 忽略 */ }
    if (serverChild && !serverChild.killed) {
      try { serverChild.kill(); } catch { /* 忽略 */ }
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => {
    if (ownedServer && !ownedServer.killed) {
      try { ownedServer.kill(); } catch { /* 忽略 */ }
    }
  });

  if (EMBEDDED) {
    // 宿主窗口关闭时往 stdin 写 shutdown；父进程意外消失时 stdin 关闭也会走到这里。
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (text) => { if (String(text).trim() === 'shutdown') void shutdown(); });
    rl.on('close', () => void shutdown());
  }
}

main().catch((error) => {
  const message = error?.message || String(error);
  if (EMBEDDED && !errorEmitted) emit('error', { message, code: 'fatal' });
  console.error(message);
  process.exit(1);
});
