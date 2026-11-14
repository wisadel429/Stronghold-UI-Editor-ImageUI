// 编辑器反向代理：把浏览器里的编辑会话代理到游戏服务端，并提供同源的布局读写接口。
//
// 为什么需要它：游戏的 CSP 是 connect-src 'self'，浏览器端没法直接写游戏目录；
// 而改游戏服务端又会绑死版本。代理用"同源"解决：浏览器只跟 127.0.0.1:<proxy> 打交道，
// 代理把其它请求原样转发给 127.0.0.1:3000，只自己接管 /ui-editor/layout 的读写。
// WebSocket（对局联机）走 upgrade 隧道，原样透传。

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const LAYOUT_ROUTE = '/ui-editor/layout';
const MAX_BODY = 512 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_ANCHORS = 400;
const MAX_GROUPS = 200;
const MAX_GROUP_MEMBERS = 200;
const MAX_SELECTOR = 400;
const MAX_ABS = 20000;
const LAYOUT_VERSION = 4;
const DEVICES = ['desktop', 'mobile'];
const ANCHOR_SIDES = ['below', 'above', 'right', 'left'];
const BOUNDARY_TARGET = '@screen';
const BOUNDARY_SIDES = ['left', 'right', 'top', 'bottom', 'centerX', 'centerY'];
const GROUP_ID_RE = /^[A-Za-z0-9._-]{1,40}$/;
const IMAGE_RE = /^\/ui-editor\/images\/[A-Za-z0-9._@-]+$/;
const IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const finite = (v, fallback = null) => {
  const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** 存档文件名 / id 用的安全 slug。 */
function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9.@_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'profile';
}
const clampAbs = (v) => Math.max(-MAX_ABS, Math.min(MAX_ABS, v));
const round2 = (v) => Math.round(v * 100) / 100;

function safeSelector(value) {
  const selector = typeof value === 'string' ? value.trim().slice(0, MAX_SELECTOR) : '';
  if (!selector) return '';
  if (/[{};@\\<]|\/\*/.test(selector)) return '';
  return selector;
}

function sanitizeImage(value) {
  if (typeof value !== 'string') return null;
  const url = value.trim().slice(0, 300);
  return IMAGE_RE.test(url) ? url : null;
}

function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const selector = safeSelector(raw.selector);
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
  const image = sanitizeImage(raw.image);
  if (image) {
    entry.image = image;
    entry.imageMode = raw.imageMode === 'overlay' ? 'overlay' : 'replace';
    entry.imageFit = ['contain', 'stretch'].includes(raw.imageFit) ? raw.imageFit : 'cover';
  }
  const neutral = !entry.x && !entry.y && entry.w == null && entry.h == null
    && (entry.scale == null || entry.scale === 1) && entry.z == null && !entry.hidden && !entry.image;
  return neutral ? null : entry;
}

function sanitizeEntries(list) {
  const items = Array.isArray(list) ? list.slice(0, MAX_ENTRIES) : [];
  const bySelector = new Map();
  for (const item of items) {
    const entry = sanitizeEntry(item);
    if (!entry) continue;
    bySelector.delete(entry.selector);
    bySelector.set(entry.selector, entry);
  }
  return [...bySelector.values()];
}

/**
 * 「边距固定」关系：目标元素 + 参照元素 + 方向 + 间距（设计像素，允许负数表示重叠）。
 * to === '@screen' 表示锁到屏幕边界，方向换成 left/right/top/bottom/centerX/centerY。
 */
function sanitizeAnchor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const selector = safeSelector(raw.selector);
  if (!selector) return null;
  const boundary = raw.to === BOUNDARY_TARGET;
  const to = boundary ? BOUNDARY_TARGET : safeSelector(raw.to);
  if (!to || selector === to) return null;
  const sides = boundary ? BOUNDARY_SIDES : ANCHOR_SIDES;
  if (!sides.includes(raw.side)) return null;
  return { selector, to, side: raw.side, gap: round2(clampAbs(finite(raw.gap, 0))) };
}

function sanitizeAnchors(list) {
  const items = Array.isArray(list) ? list.slice(0, MAX_ANCHORS) : [];
  const bySelector = new Map();
  for (const item of items) {
    const anchor = sanitizeAnchor(item);
    if (!anchor) continue;
    bySelector.delete(anchor.selector);
    bySelector.set(anchor.selector, anchor);
  }
  return [...bySelector.values()];
}

/** 母集：id + 名字 + 成员 + 边界锁定。一个元素只能属于一个母集。 */
function sanitizeGroup(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && GROUP_ID_RE.test(raw.id) ? raw.id : `group-${index + 1}`;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 60) : '';
  const members = [];
  for (const item of Array.isArray(raw.members) ? raw.members.slice(0, MAX_GROUP_MEMBERS) : []) {
    const selector = safeSelector(item);
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

function sanitizeGroups(list) {
  const out = [];
  const claimed = new Set();
  const ids = new Set();
  const items = Array.isArray(list) ? list.slice(0, MAX_GROUPS) : [];
  items.forEach((item, index) => {
    const group = sanitizeGroup(item, index);
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

function sanitizeLayout(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const profilesIn = source.profiles && typeof source.profiles === 'object' ? source.profiles : null;
  const legacy = Array.isArray(source.entries) ? source.entries : null;
  const profiles = {};
  for (const kind of DEVICES) {
    let list = null;
    if (profilesIn) {
      const item = profilesIn[kind];
      list = Array.isArray(item) ? item : (Array.isArray(item?.entries) ? item.entries : []);
    } else if (legacy && kind === 'desktop') {
      list = legacy;
    }
    const anchorsIn = profilesIn
      ? (Array.isArray(profilesIn[kind]) ? null : profilesIn[kind]?.anchors)
      : null;
    const groupsIn = profilesIn
      ? (Array.isArray(profilesIn[kind]) ? null : profilesIn[kind]?.groups)
      : null;
    profiles[kind] = {
      entries: sanitizeEntries(list),
      anchors: sanitizeAnchors(anchorsIn),
      groups: sanitizeGroups(groupsIn),
    };
  }
  return { version: LAYOUT_VERSION, updatedAt: new Date().toISOString(), profiles };
}

function sendJson(req, res, status, obj) {  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function decompress(buffer, encoding) {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buffer);
    if (encoding === 'deflate') return zlib.inflateSync(buffer);
    if (encoding === 'br') return zlib.brotliDecompressSync(buffer);
  } catch { /* 解不开就按原样处理 */ }
  return buffer;
}

/**
 * @param {{ gameDir: string, profilesDir?: string, versionKey?: string, targetPort?: number, listenPort?: number, host?: string, log?: Console }} options
 */
export function createProxy({ gameDir, profilesDir = null, versionKey = 'default', targetPort = 3000, listenPort = 3123, host = '127.0.0.1', log = console }) {
  const layoutFile = path.join(gameDir, 'public', 'ui-layout.json');
  const target = { host: '127.0.0.1', port: targetPort };
  const autoProfileFile = profilesDir ? path.join(profilesDir, `auto-${slug(versionKey)}.json`) : null;

  function readLayout() {
    try {
      const parsed = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return null;
      const safe = sanitizeLayout(parsed);
      return { ...safe, updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null };
    } catch {
      return null;
    }
  }

  function writeLayout(layout) {
    fs.mkdirSync(path.dirname(layoutFile), { recursive: true });
    const text = `${JSON.stringify(layout, null, 2)}\n`;
    const tmp = `${layoutFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, layoutFile);
    // 这台机器上如果之前装过"游戏内编辑器"（读 data/ui-layout.json），顺手保持同步，
    // 免得两份布局各说各话。
    const legacyFile = path.join(gameDir, 'data', 'ui-layout.json');
    if (fs.existsSync(legacyFile)) {
      try {
        const legacyTmp = `${legacyFile}.${process.pid}.tmp`;
        fs.writeFileSync(legacyTmp, text, 'utf8');
        fs.renameSync(legacyTmp, legacyFile);
      } catch { /* 同步失败不影响主流程 */ }
    }
  }

  // ── 存档（按版本分开，存到工具目录的 profiles\） ──────────────────────────
  function metaOfFile(file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const layout = sanitizeLayout(raw);
      return {
        id: path.basename(file, '.json'),
        name: typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim() : path.basename(file, '.json'),
        version: typeof raw?.versionKey === 'string' ? raw.versionKey : '',
        updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
        counts: { desktop: layout.profiles.desktop.entries.length, mobile: layout.profiles.mobile.entries.length },
        auto: autoProfileFile ? path.resolve(file) === path.resolve(autoProfileFile) : false,
      };
    } catch {
      return null;
    }
  }

  function listProfiles() {
    if (!profilesDir || !fs.existsSync(profilesDir)) return [];
    return fs.readdirSync(profilesDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => metaOfFile(path.join(profilesDir, name)))
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  function writeProfileFile(file, name, layout) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = { ...sanitizeLayout(layout), name, versionKey, updatedAt: new Date().toISOString() };
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return metaOfFile(file);
  }

  /** 每次保存都顺手更新「当前版本的自动存档」。 */
  function writeAutoProfile(layout) {
    if (!autoProfileFile) return null;
    try {
      return writeProfileFile(autoProfileFile, `自动存档 · ${versionKey}`, layout);
    } catch (error) {
      log.warn?.('[存档] 写自动存档失败', error);
      return null;
    }
  }

  function profileFileOf(id) {
    const clean = String(id || '').replace(/[^a-z0-9.@_-]/gi, '');
    if (!clean) return null;
    const file = path.join(profilesDir || '', `${clean}.json`);
    return fs.existsSync(file) ? file : null;
  }

  function handleProfiles(req, res) {
    const url = (req.url || '').split('?')[0];
    if (req.method === 'GET' && url === '/ui-editor/profiles') {
      sendJson(req, res, 200, { ok: true, current: versionKey, profiles: listProfiles() });
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'GET, POST' });
      res.end();
      return;
    }
    readBody(req).then((raw) => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { sendJson(req, res, 400, { ok: false, error: 'JSON 解析失败' }); return; }
      const action = url.slice('/ui-editor/profiles/'.length);

      if (action === 'save') {
        if (!profilesDir) { sendJson(req, res, 400, { ok: false, error: '没有配置存档目录' }); return; }
        const name = String(payload.name || '').trim() || `存档 ${new Date().toLocaleString()}`;
        const file = path.join(profilesDir, `${slug(name)}-${Date.now().toString(36)}.json`);
        try {
          const meta = writeProfileFile(file, name, payload.layout);
          sendJson(req, res, 200, { ok: true, profile: meta, profiles: listProfiles() });
        } catch (error) {
          sendJson(req, res, 500, { ok: false, error: `写入存档失败：${error?.message || error}` });
        }
        return;
      }

      if (action === 'load') {
        const file = profileFileOf(payload.id);
        if (!file) { sendJson(req, res, 404, { ok: false, error: '存档不存在' }); return; }
        try {
          const rawProfile = JSON.parse(fs.readFileSync(file, 'utf8'));
          const layout = sanitizeLayout(rawProfile);
          writeLayout(layout);
          writeAutoProfile(layout); // 载入后它就等于"当前版本正在用的布局"
          sendJson(req, res, 200, { ok: true, layout, profiles: listProfiles() });
        } catch (error) {
          sendJson(req, res, 500, { ok: false, error: `读取存档失败：${error?.message || error}` });
        }
        return;
      }

      if (action === 'delete') {
        const file = profileFileOf(payload.id);
        if (!file) { sendJson(req, res, 404, { ok: false, error: '存档不存在' }); return; }
        try {
          fs.rmSync(file, { force: true });
          sendJson(req, res, 200, { ok: true, profiles: listProfiles() });
        } catch (error) {
          sendJson(req, res, 500, { ok: false, error: `删除失败：${error?.message || error}` });
        }
        return;
      }

      sendJson(req, res, 404, { ok: false, error: '未知的存档操作' });
    }).catch((error) => sendJson(req, res, 400, { ok: false, error: String(error?.message || error) }));
  }

  function handleLayout(req, res) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const layout = readLayout();
      sendJson(req, res, 200, { ok: true, saved: !!layout, layout: layout || sanitizeLayout({}) });
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'GET, HEAD, POST' });
      res.end();
      return;
    }
    readBody(req).then((raw) => {
      let payload;
      try { payload = JSON.parse(raw); } catch { sendJson(req, res, 400, { ok: false, error: 'JSON 解析失败' }); return; }
      const layout = sanitizeLayout(payload);
      try {
        writeLayout(layout);
      } catch (error) {
        sendJson(req, res, 500, { ok: false, error: `写入失败：${error?.message || error}` });
        return;
      }
      const counts = { desktop: layout.profiles.desktop.entries.length, mobile: layout.profiles.mobile.entries.length };
      writeAutoProfile(layout);
      log.info?.(`[保存] 电脑版 ${counts.desktop} 项 · 手机端 ${counts.mobile} 项 → ${layoutFile}`);
      sendJson(req, res, 200, { ok: true, counts, savedAt: layout.updatedAt });
    }).catch((error) => sendJson(req, res, 400, { ok: false, error: String(error?.message || error) }));
  }

  function handleMeta(req, res) {
    const layout = readLayout();
    const counts = layout
      ? { desktop: layout.profiles.desktop.entries.length, mobile: layout.profiles.mobile.entries.length }
      : { desktop: 0, mobile: 0 };
    sendJson(req, res, 200, {
      ok: true,
      gameDir,
      versionKey,
      layoutFile,
      profilesDir,
      targetPort,
      proxyPort: listenPort,
      counts,
      profiles: listProfiles().length,
      node: process.version,
      platform: process.platform,
    });
  }

  // 编辑器自己的静态文件由代理直接提供：不依赖各版本游戏服务端的静态文件规则 / CSP / MIME，
  // 也避免不同版本的 index.html 注入逻辑互相干扰。
  const EDITOR_MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  const EDITOR_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'";

  function readBinaryBody(req, max) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > max) {
          reject(new Error('图片超过 20MB'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function sniffImage(body, ext) {
    if (body.length < 12) return false;
    if (ext === 'png') return body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47;
    if (ext === 'jpg') return body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
    if (ext === 'gif') return body.toString('ascii', 0, 3) === 'GIF';
    if (ext === 'webp') return body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP';
    return false;
  }

  function handleImageUpload(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      res.end();
      return;
    }
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = IMAGE_TYPES[type];
    if (!ext) {
      sendJson(req, res, 415, { ok: false, error: '只支持 PNG / JPEG / WEBP / GIF 图片' });
      return;
    }
    readBinaryBody(req, MAX_IMAGE).then((body) => {
      if (!body.length) {
        sendJson(req, res, 400, { ok: false, error: '图片是空的' });
        return;
      }
      if (!sniffImage(body, ext)) {
        sendJson(req, res, 415, { ok: false, error: '文件内容不是有效的 ' + ext.toUpperCase() + ' 图片' });
        return;
      }
      const hash = crypto.createHash('sha1').update(body).digest('hex').slice(0, 16);
      const file = `skin-${hash}.${ext}`;
      const dir = path.join(gameDir, 'public', 'ui-editor', 'images');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, file), body);
      log.info?.(`[图片] ${file}（${Math.round(body.length / 1024)} KB）`);
      sendJson(req, res, 200, {
        ok: true,
        url: `/ui-editor/images/${file}`,
        bytes: body.length,
      });
    }).catch((error) => {
      sendJson(req, res, 400, { ok: false, error: String(error?.message || error) });
    });
  }

  function serveEditorFile(req, res) {
    const urlPath = decodeURIComponent(String(req.url || '/').split('?')[0]);
    if (!urlPath.startsWith('/ui-editor/')) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return true;
    }
    const root = path.join(gameDir, 'public', 'ui-editor');
    const rel = urlPath.slice('/ui-editor/'.length);
    const file = path.resolve(root, rel);
    if (!rel || rel.includes('\0') || !file.startsWith(path.resolve(root) + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return true;
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`编辑器资源不存在：${rel}（重新运行工具会重新安装 public/ui-editor/）`);
        return;
      }
      const ext = path.extname(file).toLowerCase();
      const headers = {
        'Content-Type': EDITOR_MIME[ext] || 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
      };
      if (ext === '.html') headers['Content-Security-Policy'] = EDITOR_CSP;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : data);
    });
    return true;
  }

  function forward(req, res) {
    const accept = String(req.headers.accept || '');
    const wantsHtml = accept.includes('text/html') || req.url === '/' || req.url === '/index.html';
    const shellPath = String(req.url || '').startsWith('/ui-editor/') || String(req.url || '').startsWith('/studio/');
    const headers = { ...req.headers };
    if (wantsHtml) delete headers['accept-encoding'];
    headers.host = `${target.host}:${target.port}`;

    const upstream = http.request({ host: target.host, port: target.port, method: req.method, path: req.url, headers }, (up) => {
      const type = String(up.headers['content-type'] || '');
      if (!type.includes('text/html')) {
        const outHeaders = { ...up.headers };
        if (shellPath) outHeaders['cache-control'] = 'no-store';
        res.writeHead(up.statusCode || 200, outHeaders);
        up.pipe(res);
        return;
      }
      const chunks = [];
      up.on('data', (chunk) => chunks.push(chunk));
      up.on('end', () => {
        let body = Buffer.concat(chunks);
        if (up.headers['content-encoding']) body = decompress(body, up.headers['content-encoding']);
        let text = body.toString('utf8');
        // 编辑台 / 游戏自带工作台本身不是游戏页面，不能再注入 apply.js
        if (!shellPath && !text.includes('/ui-editor/apply.js')) {
          const tag = '  <script type="module" src="/ui-editor/apply.js"></script>\n';
          text = text.includes('</body>') ? text.replace('</body>', `${tag}</body>`) : `${text}\n${tag}`;
        }
        const out = Buffer.from(text, 'utf8');
        const headers2 = { ...up.headers };
        delete headers2['content-encoding'];
        delete headers2.etag;
        delete headers2['last-modified'];
        if (shellPath) headers2['cache-control'] = 'no-store';
        headers2['content-length'] = String(out.length);
        res.writeHead(up.statusCode || 200, headers2);
        res.end(req.method === 'HEAD' ? undefined : out);
      });
    });

    upstream.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`代理无法连到游戏服务端（127.0.0.1:${target.port}）：${error.message}`);
      } else {
        res.end();
      }
    });

    req.pipe(upstream);
  }

  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url === LAYOUT_ROUTE || url.startsWith(`${LAYOUT_ROUTE}?`)) {
      handleLayout(req, res);
      return;
    }
    if (url === '/ui-editor/meta' || url.startsWith('/ui-editor/meta?')) {
      handleMeta(req, res);
      return;
    }
    if (url === '/ui-editor/open' || url.startsWith('/ui-editor/open?')) {
      sendJson(req, res, 200, { ok: true, open: false });
      return;
    }
    if (url === '/ui-editor/profiles' || url.startsWith('/ui-editor/profiles/')) {
      handleProfiles(req, res);
      return;
    }
    if (url === '/ui-editor/images' || url.startsWith('/ui-editor/images?')) {
      handleImageUpload(req, res);
      return;
    }
    if (serveEditorFile(req, res)) return;
    forward(req, res);
  });

  // WebSocket 隧道：对局联机必须走这里
  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(target.port, target.host, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [key, value] of Object.entries(req.headers)) lines.push(`${key}: ${value}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, host, () => {
      resolve({
        port: listenPort,
        url: `http://${host}:${listenPort}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
