// ==UserScript==
// @name         多平台开播提醒（B站 / 抖音 / Kick）
// @namespace    https://github.com/iiiMxy/live-alert
// @version      1.0.1
// @description  监控多个直播间的开播状态，开播时弹出带封面和标题的系统通知，并记录开播历史
// @author       iMxy_
// @license      MIT
// @match        https://live.bilibili.com/*
// @match        https://live.douyin.com/*
// @match        https://kick.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      api.live.bilibili.com
// @connect      live.douyin.com
// @connect      webcast.amemv.com
// @connect      kick.com
// @connect      i0.hdslb.com
// @connect      files.kick.com
// @connect      p3-pc-sign.douyinpic.com
// @noframes
// @run-at       document-idle
// ==/UserScript==

/*
 * 仓库：https://github.com/iiiMxy/live-alert
 * 如需追加强制更新，补 @downloadURL / @updateURL（从 Greasy Fork 或 Raw 链接取）。
 *
 * 设计要点：
 *   1. 直播间列表存在 GM 存储里，通过页面内的「设置」浮层增删，不写死在代码里；
 *   2. 每个平台一个 probe 函数，返回统一结构，新增平台只需再写一个函数；
 *   3. 只在「上次明确未开播 → 这次开播」时提醒，首次运行只建基线不打扰；
 *   4. 抖音页面近 1MB，解析出 roomId 后缓存，之后只调 2KB 的 reflow 接口；
 *   5. 单实例锁：只有抢到锁的标签页在轮询，关页/刷新时主动交还，避免监控空窗。
 */

(function () {
  'use strict';

  /* ================= 1. 配置 ================= */
  const CONFIG = {
    intervalMs: 60 * 1000,      // 轮询间隔；后台标签页会被浏览器节流到约 1 次/分钟
    maxHistory: 200,            // 开播历史最多保留条数
    hudPosition: 'top-left',    // 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
    hudCollapsed: true,         // 默认收成一个小胶囊
    hudMargin: { top: 3, right: 8, bottom: 12, left: 6 }, // 面板到视口四边的距离
  };

  const NS = 'quin-live-alert';           // 存储命名空间；改名会导致旧数据读不到
  const TARGETS_KEY = NS + '.targets.v1';
  const STATE_KEY = NS + '.state.v1';
  const LOCK_KEY = NS + '.leader.v1';
  const HISTORY_KEY = NS + '.history.v1';
  const POS_KEY = NS + '.hudpos.v1';
  const COLLAPSE_KEY = NS + '.hudcollapsed.v1';
  const HUD_ON_KEY = NS + '.hudon.v1';
  const ROOMID_PREFIX = NS + '.roomid.';
  const TAB_ID = Math.random().toString(36).slice(2, 10);

  const PLATFORM_LABEL = { bilibili: 'B站', douyin: '抖音', kick: 'Kick' };
  const PLATFORMS = ['bilibili', 'douyin', 'kick'];

  /* 首次安装时的初始列表：这个脚本本来就是为盯 Mr.Quin 的三路直播写的。
     不关注他也没关系——设置面板里可以逐条删除、停用，也可以一键清空列表。 */
  const DEFAULT_TARGETS = [
    { key: 'bilibili:545318', platform: 'bilibili', id: '545318', label: 'Mr.Quin', enabled: true },
    { key: 'douyin:200525029536', platform: 'douyin', id: '200525029536', label: 'Mr.Quin', enabled: true },
    { key: 'kick:quin3614', platform: 'kick', id: 'quin3614', label: 'Mr.Quin', enabled: true },
  ];

  /* ================= 2. 基础工具 ================= */
  /* 报错里只说域名和路径，避免把整条带参数的 URL 塞进面板 */
  function shortUrl(u) {
    try { const a = new URL(u); return a.host + a.pathname; }
    catch (e) { return String(u).slice(0, 60); }
  }

  function gmFetch(url, extraHeaders) {
    return new Promise(function (resolve, reject) {
      let settled = false;
      const done = function (fn, v) { if (!settled) { settled = true; fn(v); } };
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        headers: Object.assign({ Accept: 'application/json, text/html, */*' }, extraHeaders || {}),
        timeout: 15000,
        onload: function (r) {
          // 4xx/5xx 通常是风控页或 Cloudflare 挑战页，正文根本不是 JSON。
          // 在这里就抛出来，比让后面的 JSON.parse 报 “Unexpected token <” 好排查得多。
          if (r.status >= 400) return done(reject, new Error('HTTP ' + r.status + ' · ' + shortUrl(url)));
          if (!r.status) return done(reject, new Error('无响应状态（被拦截或中断）· ' + shortUrl(url)));
          done(resolve, r);
        },
        onerror: function () { done(reject, new Error('网络错误 · ' + shortUrl(url))); },
        ontimeout: function () { done(reject, new Error('超时 · ' + shortUrl(url))); },
        onabort: function () { done(reject, new Error('已中断')); },
      });
    });
  }

  /* 接口偶尔会返回 HTML（风控/维护页），把这个事实说清楚，而不是丢一个语法错误 */
  function parseJson(res, what) {
    const txt = (res && res.responseText) || '';
    try { return JSON.parse(txt); }
    catch (e) { throw new Error((what || '接口') + '没返回 JSON（' + txt.length + ' 字节）'); }
  }

  function readJson(key, fallback) {
    try {
      const v = JSON.parse(GM_getValue(key, JSON.stringify(fallback)));
      return v === null || v === undefined ? fallback : v;
    } catch (e) { return fallback; }
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtWhen(ms) {
    const d = new Date(ms);
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtDur(ms) {
    if (!ms || ms < 0) return '';
    const m = Math.floor(ms / 60000);
    const h = Math.floor(m / 60);
    return h > 0 ? h + 'h' + (m % 60) + 'm' : m + 'm';
  }
  function pick(re, s) {
    const m = String(s).match(re);
    return m ? m[1] : '';
  }
  function pickCover(c) {
    if (!c) return '';
    if (typeof c === 'string') return c;
    if (c.url_list && c.url_list.length) return c.url_list[0];
    if (typeof c.url === 'string') return c.url;
    return '';
  }

  /* ================= 3. 监控对象（存 GM，可增删） ================= */
  function loadTargets() {
    const raw = GM_getValue(TARGETS_KEY, '');
    if (raw) {
      try {
        const a = JSON.parse(raw);
        if (Array.isArray(a)) return a;   // 空数组也算有效值：用户主动清空了就保持空
      } catch (e) { /* 落到默认列表 */ }
    }
    const seed = JSON.parse(JSON.stringify(DEFAULT_TARGETS));
    saveTargets(seed);
    return seed;
  }
  function saveTargets(list) { GM_setValue(TARGETS_KEY, JSON.stringify(list)); }

  function targetUrl(t) {
    if (t.platform === 'bilibili') return 'https://live.bilibili.com/' + t.id;
    if (t.platform === 'douyin') return 'https://live.douyin.com/' + t.id;
    if (t.platform === 'kick') return 'https://kick.com/' + t.id;
    return '';
  }

  /* 从链接里认出平台和房间号；只给纯数字/slug 时平台留空，由调用方决定 */
  function detectTarget(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    let m = s.match(/live\.bilibili\.com\/(?:h5\/)?(\d+)/i);
    if (m) return { platform: 'bilibili', id: m[1] };
    m = s.match(/live\.douyin\.com\/(\d+)/i);
    if (m) return { platform: 'douyin', id: m[1] };
    m = s.match(/kick\.com\/([A-Za-z0-9_-]+)/i);
    if (m) return { platform: 'kick', id: m[1].toLowerCase() };
    if (/^\d{3,}$/.test(s)) return { id: s };
    if (/^[A-Za-z0-9_-]{2,}$/.test(s)) return { id: s.toLowerCase() };
    return null;
  }

  function addTarget(platform, id, label) {
    if (PLATFORMS.indexOf(platform) < 0) return { ok: false, msg: '未知平台' };
    const list = loadTargets();
    const key = platform + ':' + id;
    if (list.some(function (t) { return t.key === key; })) return { ok: false, msg: '已经加过了' };
    list.push({ key: key, platform: platform, id: id, label: label || id, enabled: true });
    saveTargets(list);
    return { ok: true };
  }

  function removeTarget(key) {
    saveTargets(loadTargets().filter(function (t) { return t.key !== key; }));
    closeOpenLive(activeKeys());   // 删掉的那路若正在播，历史要收尾，否则永远停在「直播中」
  }

  function toggleTarget(key) {
    const list = loadTargets();
    for (let i = 0; i < list.length; i++) {
      if (list[i].key === key) list[i].enabled = list[i].enabled === false;
    }
    saveTargets(list);
    closeOpenLive(activeKeys());   // 停用的那路同理：不再轮询，也就没人替它收尾了
  }

  function activeTargets() {
    return loadTargets().filter(function (t) { return t.enabled !== false; });
  }

  function activeKeys() {
    return activeTargets().map(function (t) { return t.key; });
  }

  /* ================= 4. 单实例锁 ================= */
  /* 同一时刻只有一个标签页真正轮询，避免多个标签页重复弹通知。
     过期阈值取 1.5 个轮询周期：比原来的 2.5 短，标签页崩掉后能更快有人接班；
     正常关页 / 刷新不靠过期，由 releaseLeadership 主动交还。 */
  function lockIsMine(cur) { return !!cur && cur.tab === TAB_ID; }

  function acquireLeadership() {
    const now = Date.now();
    const cur = readJson(LOCK_KEY, null);
    if (cur && cur.tab !== TAB_ID && now - cur.ts < CONFIG.intervalMs * 1.5) return false;
    GM_setValue(LOCK_KEY, JSON.stringify({ tab: TAB_ID, ts: now }));
    return true;
  }

  /* 本轮结束时把时间戳往前推：轮次跑得久（对象多、网慢）也不会被别的标签页误判成“锁已死” */
  function refreshLeadership() {
    const cur = readJson(LOCK_KEY, null);
    if (lockIsMine(cur)) GM_setValue(LOCK_KEY, JSON.stringify({ tab: TAB_ID, ts: Date.now() }));
  }

  /* 关页 / 刷新时主动交还：否则新标签页要干等到锁过期，这段空窗正好会漏掉开播 */
  function releaseLeadership() {
    const cur = readJson(LOCK_KEY, null);
    if (lockIsMine(cur)) GM_setValue(LOCK_KEY, '');
  }

  /* ================= 5. 开播历史 ================= */
  function loadHistory() {
    const h = readJson(HISTORY_KEY, []);
    return Array.isArray(h) ? h : [];
  }
  function saveHistory(h) {
    if (h.length > CONFIG.maxHistory) h.length = CONFIG.maxHistory;
    GM_setValue(HISTORY_KEY, JSON.stringify(h));
  }

  /* 记一次开播；同一场直播重复发现（刷新页面）时不重复记。返回是否有改动 */
  function upsertLive(h, t, info) {
    const startedAt = info.startedAt || Date.now();
    let open = null;
    for (let i = 0; i < h.length; i++) if (h[i].key === t.key && !h[i].endedAt) { open = h[i]; break; }

    if (open) {
      // 平台没给准确开播时间时（抖音兜底路径），继续沿用已有的那条
      if (!info.startedAt || Math.abs((open.startedAt || 0) - startedAt) < 120000) {
        let changed = false;
        if (info.title && info.title !== open.title) { open.title = info.title; changed = true; }
        if (info.cover && info.cover !== open.cover) { open.cover = info.cover; changed = true; }
        return changed;
      }
      open.endedAt = startedAt;
    }

    h.unshift({
      key: t.key, platform: t.platform, label: t.label, url: targetUrl(t),
      title: info.title || '', cover: info.cover || '',
      startedAt: startedAt, endedAt: null, detectedAt: Date.now(),
    });
    return true;
  }

  function closeLive(h, key, at) {
    let changed = false;
    for (let i = 0; i < h.length; i++) {
      if (h[i].key === key && !h[i].endedAt) { h[i].endedAt = at; changed = true; }
    }
    return changed;
  }

  function lastLiveOf(h, key) {
    for (let i = 0; i < h.length; i++) if (h[i].key === key) return h[i];
    return null;
  }

  /* 停用 / 删除 / 清空之后，把「不再监控的那几路」还没闭合的记录收尾。
     不这么做，历史面板会永远停在「直播中」，底部「上次开播」也一直被它占着。
     keepKeys = 仍在监控的 key；传空数组就是全部收尾。
     结束时间沿用最后观测到在播的那次 ts，和 tick 里的口径保持一致。 */
  function closeOpenLive(keepKeys) {
    const keep = keepKeys || [];
    const h = loadHistory();
    const prev = readJson(STATE_KEY, {});
    let changed = false;
    for (let i = 0; i < h.length; i++) {
      if (h[i].endedAt || keep.indexOf(h[i].key) >= 0) continue;
      const p = prev[h[i].key];
      h[i].endedAt = (p && p.ts) || Date.now();
      changed = true;
    }
    if (changed) saveHistory(h);
  }

  /* ================= 6. 各平台探测 ================= */
  async function probeBilibili(t) {
    const res = await gmFetch('https://api.live.bilibili.com/room/v1/Room/get_info?room_id=' + encodeURIComponent(t.id));
    const j = parseJson(res, 'B站接口');
    if (!j || j.code !== 0) throw new Error('接口 code=' + (j && j.code));
    const d = j.data || {};
    let startedAt = null;
    if (d.live_time && d.live_time !== '0000-00-00 00:00:00') {
      const ms = Date.parse(d.live_time.replace(' ', 'T') + '+08:00');
      if (!isNaN(ms)) startedAt = ms;
    }
    return {
      online: d.live_status === 1,
      title: d.title || '',
      cover: d.user_cover || d.keyframe || '',
      startedAt: startedAt,
      detail: 'live_status=' + d.live_status + (d.online ? ' · 人气 ' + d.online : ''),
    };
  }

  async function probeKick(t) {
    const res = await gmFetch('https://kick.com/api/v2/channels/' + encodeURIComponent(t.id));
    const j = parseJson(res, 'Kick 接口');
    const ls = j && j.livestream;
    let startedAt = null;
    if (ls && ls.created_at) {
      const ms = Date.parse(ls.created_at);
      if (!isNaN(ms)) startedAt = ms;
    }
    return {
      online: !!ls,
      title: (ls && ls.session_title) || '',
      cover: ls ? pickCover(ls.thumbnail) : '',
      startedAt: startedAt,
      detail: ls ? '直播中 · 观众 ' + (ls.viewer_count || 0) : 'livestream=null',
    };
  }

  /* 抖音：直播间页面近 1MB，只用来把 web_rid 换成数字 roomId。
     roomId 不会变，首次解析后缓存，之后每次只调 2KB 的 reflow/info。 */
  function roomIdKey(k) { return ROOMID_PREFIX + k; }

  async function douyinPage(t) {
    const res = await gmFetch('https://live.douyin.com/' + encodeURIComponent(t.id), {
      Referer: 'https://live.douyin.com/',
      Accept: 'text/html,application/xhtml+xml',
    });
    return res.responseText || '';
  }

  function unescapeHtmlJson(html) {
    return String(html)
      .replace(/\\+"/g, '"')   // \" -> "
      .replace(/&quot;/g, '"')
      .replace(/\\u002F/gi, '/');
  }

  async function douyinReflow(roomId, t) {
    const res = await gmFetch(
      'https://webcast.amemv.com/webcast/room/reflow/info/?room_id=' + roomId +
      '&type_id=0&live_id=1&app_id=1128&version_code=1'
    );
    const j = parseJson(res, '抖音 reflow');
    if (j && j.status_code && j.status_code !== 0) throw new Error('reflow code=' + j.status_code);
    const room = (j && j.data && (j.data.room || (j.data.data && j.data.data[0]))) || null;
    if (!room || typeof room.status !== 'number') return null;

    // 防串房：接口若回带 web_rid，必须和目标一致
    const wid = (room.owner && room.owner.web_rid) || room.web_rid;
    if (wid && String(wid) !== String(t.id)) throw new Error('房间号不匹配（' + wid + '）');

    let startedAt = null;
    if (room.create_time) {
      const n = Number(room.create_time);
      startedAt = n > 1e12 ? n : n * 1000;
    }
    return {
      online: room.status === 2,
      title: room.title || '',
      cover: pickCover(room.cover),
      startedAt: startedAt,
      detail: 'reflow status=' + room.status,
    };
  }

  async function probeDouyin(t, opts) {
    const debug = !!(opts && opts.debug);
    const cached = debug ? '' : GM_getValue(roomIdKey(t.key), '');

    if (cached) {
      try {
        const r = await douyinReflow(cached, t);
        if (r) return r;
      } catch (e) {
        if (/房间号不匹配/.test(String(e.message))) throw e;
      }
      GM_setValue(roomIdKey(t.key), ''); // 缓存作废，往下重新解析
    }

    const html = await douyinPage(t);
    const flat = unescapeHtmlJson(html);
    const iRoom = flat.indexOf('"roomId"');
    const roomId =
      pick(/"roomId"\s*:\s*"?(\d{8,})/, flat) ||
      pick(/"id_str"\s*:\s*"?(\d{8,})/, flat) ||
      pick(/"room_id"\s*:\s*"?(\d{8,})/, flat);

    if (debug) {
      const diag = {
        len: html.length,
        roomId: roomId || null,
        roomIdSnip: iRoom < 0 ? null : flat.slice(Math.max(0, iRoom - 110), iRoom + 110).replace(/\s+/g, ' '),
      };
      console.info('[LiveAlert][douyin] 诊断 ' + JSON.stringify(diag));
      if (window.prompt) window.prompt('抖音诊断（Ctrl+A 全选 → Ctrl+C 复制）', JSON.stringify(diag, null, 1));
    }

    if (!roomId) throw new Error('页面里没有 roomId（' + html.length + ' 字节）');
    GM_setValue(roomIdKey(t.key), roomId);

    try {
      const r = await douyinReflow(roomId, t);
      if (r) return r;
    } catch (e) {
      console.warn('[LiveAlert][douyin] reflow 失败：' + ((e && e.message) || e));
    }

    // 兜底：解析页面 HTML 内联 JSON
    const scope = iRoom >= 0 ? flat.slice(Math.max(0, iRoom - 6000), iRoom + 6000) : flat;
    const st =
      pick(/"room_status"\s*:\s*"?(\d)/, scope) ||
      pick(/"live_status"\s*:\s*"?(\d)/, scope) ||
      pick(/"status"\s*:\s*"?(\d)/, scope);

    if (!st) throw new Error('拿不到开播状态（roomId=' + roomId + '）');
    return {
      online: Number(st) === 2,
      title: (flat.match(/<title>([^<]*)<\/title>/) || [])[1] || '',
      cover: '',
      startedAt: null,
      detail: 'status=' + st,
    };
  }

  const PROBES = { bilibili: probeBilibili, douyin: probeDouyin, kick: probeKick };

  /* ================= 7. 通知 ================= */
  function notify(items) {
    if (!items || !items.length) return;

    const pf = function (t) { return PLATFORM_LABEL[t.platform] || t.platform; };
    const labels = [];
    items.forEach(function (i) { if (labels.indexOf(i.t.label) < 0) labels.push(i.t.label); });
    const platforms = [];
    items.forEach(function (i) { const p = pf(i.t); if (platforms.indexOf(p) < 0) platforms.push(p); });

    // 同一个主播多平台同时开播 → 合成一条；不同主播 → 用「等 N 路」概括
    const title = labels.length === 1
      ? labels[0] + ' 开播了（' + platforms.join(' / ') + '）'
      : items[0].t.label + ' 等 ' + items.length + ' 路开播';
    const text = items.map(function (i) {
      return (labels.length === 1 ? '' : i.t.label + ' · ') + pf(i.t) + '：' + (i.r.title || '直播中');
    }).join('\n');

    const primary = items[0].t;
    const cover = items.map(function (i) { return i.r.cover; }).filter(Boolean)[0] || '';

    const opts = {
      title: title,
      text: text,
      timeout: 0, // 不自动消失，留在通知中心
      onclick: function () { window.open(targetUrl(primary), '_blank'); },
    };
    if (cover) opts.image = cover;

    try {
      if (typeof GM_notification === 'function') GM_notification(opts);
      else if (window.Notification && Notification.permission === 'granted') {
        new Notification(opts.title, { body: opts.text, icon: cover || undefined });
      }
    } catch (e) {
      console.warn('[LiveAlert] 通知发送失败', e);
    }
  }

  /* ================= 8. 状态面板 ================= */
  let hud = null;
  let hudRows = {};
  let hudFoot1 = null;
  let hudFoot2 = null;
  let collapsed = true;

  function destroyHud() {
    if (hud) { hud.host.remove(); hud = null; }
    hudRows = {};
    hudFoot1 = null;
    hudFoot2 = null;
  }

  function currentPos() {
    const v = GM_getValue(POS_KEY, CONFIG.hudPosition);
    return /^(top|bottom)-(left|right)$/.test(v) ? v : CONFIG.hudPosition;
  }

  function applyPos() {
    if (!hud) return;
    const parts = currentPos().split('-');
    const m = CONFIG.hudMargin;
    const s = hud.host.style;
    s.top = parts[0] === 'top' ? m.top + 'px' : 'auto';
    s.bottom = parts[0] === 'bottom' ? m.bottom + 'px' : 'auto';
    s.left = parts[1] === 'left' ? m.left + 'px' : 'auto';
    s.right = parts[1] === 'right' ? m.right + 'px' : 'auto';
  }

  function ensureHud() {
    if (GM_getValue(HUD_ON_KEY, '1') !== '1') { destroyHud(); return null; }
    if (hud) return hud;

    const targets = loadTargets();
    const host = document.createElement('div');
    host.id = 'live-alert-hud';
    host.style.cssText = 'position:fixed;z-index:2147483000;';
    const root = host.attachShadow({ mode: 'open' });

    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.box{font:12px/1.55 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;background:rgba(18,18,20,.86);color:#eee;' +
      'border-radius:10px;padding:8px 10px;min-width:210px;max-width:340px;box-shadow:0 6px 22px rgba(0,0,0,.35);' +
      'backdrop-filter:blur(6px);cursor:default;user-select:none;transition:padding .12s ease}' +
      '.box.collapsed{padding:4px 8px;min-width:0;max-width:none;border-radius:999px;opacity:.82;cursor:pointer}' +
      '.box.collapsed .rows,.box.collapsed .ft,.box.collapsed .t,.box.collapsed button{display:none}' +
      '.hd{display:flex;align-items:center;gap:6px;font-weight:600}' +
      '.dots{display:flex;gap:4px;align-items:center}' +
      '.hd .t{flex:1;white-space:nowrap}' +
      '.hd button{all:unset;cursor:pointer;opacity:.55;font-size:14px;line-height:1;padding:0 2px}' +
      '.hd button:hover{opacity:1}' +
      '.rows{margin-top:4px}' +
      '.row{display:flex;gap:6px;align-items:baseline;white-space:nowrap}' +
      '.dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;display:inline-block}' +
      '.live{background:#2fd06a;box-shadow:0 0 6px #2fd06a}' +
      '.off{background:#5a5a5f}' +
      '.err{background:#e0564b}' +
      '.nm{flex:0 0 auto;opacity:.9}' +
      '.dt{flex:1;overflow:hidden;text-overflow:ellipsis;opacity:.55;font-size:11px}' +
      '.empty{opacity:.55;font-size:11px;padding:2px 0}' +
      '.ft{margin-top:5px;padding-top:4px;border-top:1px solid rgba(255,255,255,.08);' +
      'opacity:.45;font-size:11px;line-height:1.5}' +
      '.ft div{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '</style>' +
      '<div class="box"><div class="hd">' +
      '<span class="dots"></span><span class="t">开播监控</span>' +
      '<button class="collapse" title="收起/展开">−</button>' +
      '</div><div class="rows"></div>' +
      '<div class="ft"><div class="f1">初始化…</div><div class="f2"></div></div></div>';

    (document.body || document.documentElement).appendChild(host);

    const box = root.querySelector('.box');
    const btn = root.querySelector('.collapse');
    const rowsEl = root.querySelector('.rows');
    const dotsEl = root.querySelector('.dots');

    if (!targets.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = '还没有监控对象，Tampermonkey 图标 → 设置与工具';
      rowsEl.appendChild(e);
    }

    targets.forEach(function (t) {
      const hdot = document.createElement('span');
      hdot.className = 'dot off';
      hdot.title = t.label;
      dotsEl.appendChild(hdot);

      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = '<span class="dot off"></span><span class="nm"></span><span class="dt">等待检查</span>';
      row.querySelector('.nm').textContent = t.label;
      if (t.enabled === false) row.querySelector('.dt').textContent = '已停用';
      rowsEl.appendChild(row);

      hudRows[t.key] = { dot: row.querySelector('.dot'), hdot: hdot, dt: row.querySelector('.dt') };
    });

    function setCollapsed(v, persist) {
      collapsed = v;
      box.classList.toggle('collapsed', v);
      btn.textContent = v ? '+' : '−';
      if (persist) GM_setValue(COLLAPSE_KEY, v ? '1' : '0');
    }

    btn.addEventListener('click', function (e) { e.stopPropagation(); setCollapsed(!collapsed, true); });
    box.addEventListener('click', function () { if (collapsed) setCollapsed(false, true); });

    hud = { host: host, setCollapsed: setCollapsed };
    hudFoot1 = root.querySelector('.f1');
    hudFoot2 = root.querySelector('.f2');

    applyPos();
    setCollapsed(GM_getValue(COLLAPSE_KEY, CONFIG.hudCollapsed ? '1' : '0') === '1', false);
    return hud;
  }

  /* 监控对象变了之后重建面板（行数、点阵都要跟着变） */
  function rebuildHud() {
    destroyHud();
    ensureHud();
  }

  function renderRow(t, rec, history) {
    const r = hudRows[t.key];
    if (!r) return;
    const cls = 'dot ' + (rec.error ? 'err' : rec.online ? 'live' : 'off');
    r.dot.className = cls;
    r.hdot.className = cls;

    if (rec.error) {
      r.dt.textContent = '解析失败：' + rec.error;
      r.dt.title = rec.error;
      return;
    }
    const last = lastLiveOf(history, t.key);
    const dur = rec.online && last && !last.endedAt ? fmtDur(Date.now() - (last.startedAt || last.detectedAt)) : '';
    r.dt.textContent = (rec.online ? '直播中' : '未开播') + (dur ? ' ' + dur : '') + ' · ' + rec.detail;
    r.dt.title = rec.title || '';
  }

  function renderFoot(errCount, nextAt, history, count) {
    if (!hud || !hudFoot1) return;
    hudFoot1.textContent = !count
      ? '还没有监控对象'
      : (errCount ? errCount + ' 个源异常 · ' : '') +
        '下次检查 ' + new Date(nextAt).toLocaleTimeString('zh-CN', { hour12: false });

    const last = history[0];
    hudFoot2.textContent = last
      ? '上次开播 ' + last.label + ' ' + fmtWhen(last.startedAt || last.detectedAt) +
        (last.endedAt ? '（已播 ' + fmtDur(last.endedAt - (last.startedAt || last.detectedAt)) + '）' : '（直播中）')
      : '还没有开播记录';
  }

  /* ================= 9. 主循环 ================= */
  let busy = false;
  let nextAt = 0;

  async function tick() {
    if (busy) return;
    busy = true;
    let leader = false;
    try {
      if (!acquireLeadership()) {
        destroyHud();
        console.info('[LiveAlert] 另一个标签页正在监控，本页待命');
        return;
      }
      leader = true;

      ensureHud();
      const targets = activeTargets();
      const prev = readJson(STATE_KEY, {});
      const history = loadHistory();
      const next = {};
      const justLive = [];
      let errCount = 0;
      let dirty = false;

      for (const t of targets) {
        const rec = { ts: Date.now(), online: null, title: '', detail: '', error: null };
        try {
          const r = await PROBES[t.platform](t);
          rec.online = r.online;
          rec.title = r.title;
          rec.detail = r.detail;

          const p = prev[t.key];
          if (r.online) {
            if (upsertLive(history, t, r)) dirty = true;
            // 只在“上一次明确未开播 → 这次开播”时提醒；首次记录不打扰
            if (p && p.online === false) justLive.push({ t: t, r: r });
          } else if (p && p.online === true) {
            // 用最后观测到在播的时间，而不是“现在”，避免关机几天后记成今天下播
            if (closeLive(history, t.key, p.ts || Date.now())) dirty = true;
          }
        } catch (e) {
          const p = prev[t.key];
          rec.online = p ? p.online : null;
          rec.title = p ? p.title : '';
          rec.detail = p ? p.detail : '';
          rec.error = String((e && e.message) || e);
          errCount++;
        }
        next[t.key] = rec;
        renderRow(t, rec, history);
      }

      if (dirty) saveHistory(history);
      GM_setValue(STATE_KEY, JSON.stringify(next));
      if (justLive.length) notify(justLive);

      nextAt = Date.now() + CONFIG.intervalMs;
      renderFoot(errCount, nextAt, history, targets.length);
    } catch (e) {
      console.warn('[LiveAlert] 检查异常', e);
      if (hudFoot1) hudFoot1.textContent = '异常：' + ((e && e.message) || e);
    } finally {
      // 轮次结束再盖一次时间戳：慢轮次（对象多/网络差）不会被判成锁已死
      if (leader) refreshLeadership();
      busy = false;
    }
  }

  /* ================= 10. 设置浮层 ================= */
  let settingsEl = null;

  const PANEL_CSS =
    ':host{all:initial}' +
    '.wrap{position:fixed;inset:0;background:rgba(0,0,0,.38);display:flex;align-items:center;' +
    'justify-content:center;font:13px/1.6 -apple-system,Segoe UI,Microsoft YaHei,sans-serif}' +
    '.card{width:400px;max-width:92vw;max-height:86vh;overflow:auto;background:#17181b;color:#e8e8ea;' +
    'border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.55);padding:16px 18px}' +
    '.h{display:flex;align-items:center;justify-content:space-between;font-size:15px;font-weight:600;margin-bottom:10px}' +
    '.x{all:unset;cursor:pointer;opacity:.55;font-size:18px;line-height:1}' +
    '.x:hover{opacity:1}' +
    '.sec{margin:14px 0 6px;font-size:11px;letter-spacing:.06em;color:#8a8d95}' +
    '.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}' +
    '.b{all:unset;padding:7px 12px;border-radius:8px;background:#26282d;color:#e8e8ea;cursor:pointer;font-size:12.5px}' +
    '.b:hover{background:#32353b}' +
    '.b.on{background:#2a6df4;color:#fff}' +
    '.b.danger{color:#ff9a90}' +
    '.item{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.07)}' +
    '.item .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.item .pid{color:#8a8d95;font-size:11px;white-space:nowrap}' +
    '.mini{all:unset;cursor:pointer;color:#8a8d95;font-size:11.5px;padding:2px 4px;white-space:nowrap}' +
    '.mini:hover{color:#e8e8ea}' +
    '.mini.danger:hover{color:#ff9a90}' +
    '.in{all:unset;box-sizing:border-box;width:100%;padding:8px 10px;border-radius:8px;background:#24262b;' +
    'color:#e8e8ea;font-size:12.5px;border:1px solid #34363c}' +
    '.in:focus{border-color:#2a6df4}' +
    '.f{margin-bottom:8px}' +
    '.hist{max-height:250px;overflow:auto;font-size:12px;color:#c8cad0;margin-top:4px}' +
    '.hist div{padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06)}' +
    '.st{margin-top:12px;font-size:11.5px;color:#69c97e;min-height:16px}';

  function fmtEntry(e) {
    const base = e.startedAt || e.detectedAt;
    const end = e.endedAt ? fmtWhen(e.endedAt) + '（' + fmtDur(e.endedAt - base) + '）' : '直播中';
    // 标题来自平台，属于不可信内容；这里拼的是 innerHTML，必须转义
    return fmtWhen(base) + ' → ' + end + ' · ' + esc(e.label) +
      (e.title ? '「' + esc(e.title) + '」' : '');
  }

  async function runDouyinDiag() {
    const t = loadTargets().filter(function (x) { return x.platform === 'douyin'; })[0];
    if (!t) return console.warn('[LiveAlert] 没有抖音监控对象');
    try {
      const r = await probeDouyin(t, { debug: true });
      console.info('[LiveAlert][douyin] 解析成功', r);
      if (window.prompt) window.prompt('抖音解析成功（Ctrl+A 复制）', JSON.stringify(r, null, 1));
    } catch (e) {
      const msg = String((e && e.message) || e);
      console.warn('[LiveAlert][douyin] 解析失败', msg);
      if (window.prompt) window.prompt('抖音诊断失败（Ctrl+A 复制）', msg);
    }
  }

  function toggleHud() {
    const on = GM_getValue(HUD_ON_KEY, '1') === '1';
    GM_setValue(HUD_ON_KEY, on ? '0' : '1');
    if (on) destroyHud(); else ensureHud();
    console.info('[LiveAlert] 面板已' + (on ? '隐藏' : '显示'));
  }

  function openSettings() {
    if (settingsEl) return;

    const host = document.createElement('div');
    host.id = 'live-alert-settings';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483600;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + PANEL_CSS + '</style>' +
      '<div class="wrap"><div class="card">' +
      '<div class="h"><span>开播监控 · 设置</span><button class="x" title="关闭">×</button></div>' +
      '<div class="body"></div><div class="st"></div></div></div>';
    (document.body || document.documentElement).appendChild(host);

    const wrap = root.querySelector('.wrap');
    const body = root.querySelector('.body');
    const st = root.querySelector('.st');

    function status(msg) { st.textContent = msg; }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
    function close() {
      document.removeEventListener('keydown', onKey, true);
      host.remove();
      settingsEl = null;
    }

    function renderMain() {
      const list = loadTargets();
      const cur = currentPos();
      const pos = function (p, label) {
        return '<button class="b' + (cur === p ? ' on' : '') + '" data-a="pos:' + p + '">' + label + '</button>';
      };

      const items = list.length
        ? list.map(function (t) {
            return '<div class="item">' +
              '<span class="nm">' + esc(t.label) + '</span>' +
              '<span class="pid">' + (PLATFORM_LABEL[t.platform] || t.platform) + ' · ' + esc(t.id) + '</span>' +
              '<button class="mini" data-a="tog:' + esc(t.key) + '">' + (t.enabled === false ? '启用' : '停用') + '</button>' +
              '<button class="mini danger" data-a="del:' + esc(t.key) + '">删除</button>' +
              '</div>';
          }).join('')
        : '<div class="item" style="color:#8a8d95">还没有监控对象</div>';

      body.innerHTML =
        '<div class="sec">监控对象</div>' + items +
        '<div class="row" style="margin-top:8px">' +
        '<button class="b" data-a="add">+ 添加直播间</button>' +
        '<button class="b" data-a="bulk">批量添加</button></div>' +
        '<div class="sec">快速操作</div><div class="row">' +
        '<button class="b" data-a="check">立即检查一次</button>' +
        '<button class="b" data-a="test">测试通知</button></div>' +
        '<div class="sec">面板位置</div><div class="row">' +
        pos('top-left', '左上') + pos('top-right', '右上') +
        pos('bottom-left', '左下') + pos('bottom-right', '右下') + '</div>' +
        '<div class="sec">开播历史</div><div class="row">' +
        '<button class="b" data-a="hist">查看最近 20 条</button>' +
        '<button class="b danger" data-a="clearHist">清空历史</button></div>' +
        '<div class="sec">诊断</div><div class="row">' +
        '<button class="b" data-a="diag">抖音诊断</button></div>' +
        '<div class="sec">重置</div><div class="row">' +
        '<button class="b" data-a="defaults">恢复默认列表</button>' +
        '<button class="b danger" data-a="clearTargets">清空监控对象</button>' +
        '<button class="b danger" data-a="reset">清除已记录状态</button></div>';
    }

    function renderAdd() {
      body.innerHTML =
        '<div class="sec">添加直播间</div>' +
        '<div class="f"><select class="in" data-f="pf">' +
        '<option value="bilibili">B站</option><option value="douyin">抖音</option><option value="kick">Kick</option>' +
        '</select></div>' +
        '<div class="f"><input class="in" data-f="id" placeholder="直播间链接或房间号"></div>' +
        '<div class="f"><input class="in" data-f="label" placeholder="备注名（可选，默认用房间号）"></div>' +
        '<div class="row"><button class="b on" data-a="doAdd">添加</button>' +
        '<button class="b" data-a="back">返回</button></div>' +
        '<div class="sec">说明</div>' +
        '<div style="font-size:11.5px;color:#8a8d95;line-height:1.7">' +
        'B站填房间号（如 545318）；抖音填 web_rid（如 200525029536）；Kick 填频道名。' +
        '也可以直接粘贴直播间链接，平台会自动识别。</div>';
    }

    function renderBulk() {
      body.innerHTML =
        '<div class="sec">批量添加</div>' +
        '<div class="f"><textarea class="in" data-f="bulk" rows="6" ' +
        'placeholder="每行一个直播间链接，例如：&#10;https://live.bilibili.com/545318&#10;https://kick.com/quin3614"></textarea></div>' +
        '<div class="row"><button class="b on" data-a="doBulk">添加全部</button>' +
        '<button class="b" data-a="back">返回</button></div>';
    }

    function renderHistory() {
      const h = loadHistory().slice(0, 20);
      body.innerHTML =
        '<div class="row" style="margin-bottom:6px"><button class="b" data-a="back">← 返回</button></div>' +
        '<div class="hist">' + (h.length
          ? h.map(function (e) { return '<div>' + fmtEntry(e) + '</div>'; }).join('')
          : '<div>还没有记录</div>') + '</div>';
    }

    function field(name) {
      const el = body.querySelector('[data-f="' + name + '"]');
      return el ? el.value : '';
    }

    body.addEventListener('click', function (e) {
      const btn = e.target.closest && e.target.closest('[data-a]');
      if (!btn) return;
      const a = btn.getAttribute('data-a');

      if (a === 'add') { renderAdd(); status(''); }
      else if (a === 'bulk') { renderBulk(); status(''); }
      else if (a === 'back') { renderMain(); status(''); }
      else if (a === 'hist') { renderHistory(); status(''); }

      else if (a === 'doAdd') {
        const det = detectTarget(field('id'));
        if (!det) return status('没看懂这个房间号或链接');
        const platform = det.platform || field('pf');
        if (PLATFORMS.indexOf(platform) < 0) return status('请选择平台');
        const r = addTarget(platform, det.id, field('label').trim());
        if (!r.ok) return status(r.msg);
        rebuildHud();
        renderMain();
        status('已添加 ' + (PLATFORM_LABEL[platform] || platform) + ' · ' + det.id);
      }

      else if (a === 'doBulk') {
        const lines = field('bulk').split('\n');
        let added = 0, skipped = 0;
        lines.forEach(function (line) {
          const det = detectTarget(line);
          if (!det || !det.platform) { if (line.trim()) skipped++; return; }
          if (addTarget(det.platform, det.id, '').ok) added++; else skipped++;
        });
        rebuildHud();
        renderMain();
        status('添加 ' + added + ' 个' + (skipped ? '，跳过 ' + skipped + ' 行' : ''));
      }

      else if (a.indexOf('tog:') === 0) {
        toggleTarget(a.slice(4));
        rebuildHud();
        renderMain();
        status('已切换启用状态');
      }

      else if (a.indexOf('del:') === 0) {
        const key = a.slice(4);
        if (!window.confirm('删除监控对象 ' + key + ' ？开播历史会保留。')) return;
        removeTarget(key);
        rebuildHud();
        renderMain();
        status('已删除');
      }

      else if (a === 'check') { tick(); status('已触发一次检查'); }
      else if (a === 'test') {
        const t = activeTargets()[0] || { label: '测试', platform: 'bilibili', id: '0' };
        notify([{ t: t, r: { title: '这是一条测试通知', cover: '' } }]);
        status('已发送测试通知');
      }
      else if (a.indexOf('pos:') === 0) {
        GM_setValue(POS_KEY, a.slice(4));
        applyPos();
        renderMain();
        status('面板位置已切换');
      }
      else if (a === 'clearHist') { GM_setValue(HISTORY_KEY, '[]'); renderHistory(); status('历史已清空'); }
      else if (a === 'defaults') {
        saveTargets(JSON.parse(JSON.stringify(DEFAULT_TARGETS)));
        closeOpenLive(activeKeys());   // 被挤掉的旧对象不再监控，历史收尾
        rebuildHud();
        renderMain();
        status('已恢复默认列表');
      }
      else if (a === 'clearTargets') {
        if (!window.confirm('清空所有监控对象？之后可以点「恢复默认列表」找回。')) return;
        saveTargets([]);
        closeOpenLive([]);             // 列表空了，所有未闭合的记录都收尾
        rebuildHud();
        renderMain();
        status('已清空监控对象');
      }
      else if (a === 'reset') { GM_setValue(STATE_KEY, '{}'); status('已清除记录状态，下次开播才提醒'); }
      else if (a === 'diag') { close(); runDouyinDiag(); }
    });

    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    root.querySelector('.x').addEventListener('click', close);
    document.addEventListener('keydown', onKey, true);

    renderMain();
    settingsEl = { close: close };
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ================= 11. 菜单 ================= */
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('显示/隐藏监控面板', toggleHud);
    GM_registerMenuCommand('设置与工具…', openSettings);
  }

  /* ================= 12. 启动 ================= */
  setTimeout(function () {
    ensureHud();
    tick();
    setInterval(tick, CONFIG.intervalMs);

    // 关页 / 刷新时把锁交还出去，下一个标签页 4 秒后就能接班；
    // 只有真的卸载才交还，进 bfcache（persisted）不算，否则页面往返一趟就白让位了。
    window.addEventListener('pagehide', function (e) {
      if (!(e && e.persisted)) releaseLeadership();
    });

    // 从后台切回来时补一次，避免节流造成的空档
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && Date.now() > nextAt - 5000) tick();
    });
  }, 4000);
})();
