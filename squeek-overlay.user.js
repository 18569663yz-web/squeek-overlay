// ==UserScript==
// @name         Squeek 透视标记 (Exsqueektion overlay)
// @namespace    jolly.squeek
// @version      3.0
// @description  精简版：只读游戏下发的数据，只标 400 分以上物品、食物(snack)、砍刀，外加保险库/传送门/地牢入口和地形小地图。不检测敌人、不发任何请求、不自动操作，8 帧/秒绘制，尽量不卡游戏。
// @match        https://squeek.win/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function () {
  'use strict';

  const LS_KEY = 'squeek-overlay-cfg-v3';
  const cfg = Object.assign({
    scale: 0,            // 屏幕圈标定：0 = 1:1 兜底；+/- 调，存这里
    showMinimap: true,
    minimapSize: 300,
  }, JSON.parse(localStorage.getItem(LS_KEY) || '{}'));
  const saveCfg = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch {} };

  const VALUE = { relic: 150, crown: 400, 'sugar-diamond': 250, 'amber-heart': 250, 'sugar-seal': 45, 'fine-sugar-seal': 100, 'pristine-sugar-seal': 220, 'root-idol': 130, 'fine-root-idol': 280, 'pristine-root-idol': 600, 'mill-reliquary': 240, 'fine-mill-reliquary': 480, 'pristine-mill-reliquary': 900, 'royal-crown': 1600 };
  const NAME = { crown: '王冠', 'royal-crown': '皇家王冠', 'pristine-root-idol': '极神像', 'fine-mill-reliquary': '精圣匣', 'pristine-mill-reliquary': '极圣匣', cleaver: '砍刀', snack: '食物' };
  const CHAR = { crown: '冠', 'royal-crown': '皇', 'pristine-root-idol': '像', 'fine-mill-reliquary': '匣', 'pristine-mill-reliquary': '匣', cleaver: '砍', snack: '食' };
  const COLOR = { rich: '#f06595', cleaver: '#ff922b', snack: '#69db7c', vault: '#b197fc', portal: '#63e6be', door: '#ffa94d' };
  // 只检测这三类：400 分以上、食物、砍刀
  const wanted = (kind) => (VALUE[kind] || 0) >= 400 || kind === 'snack' || kind === 'cleaver';
  const colorOf = (kind) => kind === 'cleaver' ? COLOR.cleaver : kind === 'snack' ? COLOR.snack : COLOR.rich;

  // ---------------- 状态（只维护显示需要的东西） ----------------
  const S = {
    state: null, surface: null, inGame: false,
    vaults: new Map(), transitions: new Map(), obstacles: new Map(), mapVer: 0,
    dungeon: null, _featKey: '', _featCanvas: null,
  };
  function scanReveal(reveal) {
    for (const c of reveal || []) {
      for (const pair of c.o || []) {
        const ob = pair[1] || pair;
        if (!ob) continue;
        if (ob.kind === 'vault') {
          const id = ob.vault || (ob.x + ',' + ob.y);
          if (!S.vaults.has(id)) S.vaults.set(id, { ...ob, id });
        }
        if (ob.x != null && ob.width && ob.height && (ob.kind === 'water' || ob.kind === 'hedge' || ob.kind === 'stone' || ob.kind === 'bridge')) {
          const k = c.key + ':' + (Array.isArray(pair) ? pair[0] : ob.x + ',' + ob.y);
          if (!S.obstacles.has(k)) { S.obstacles.set(k, { x: ob.x, y: ob.y, width: ob.width, height: ob.height, kind: ob.kind }); S.mapVer++; }
        }
      }
      for (const pair of c.x || []) {
        const tr = pair[1] || pair;
        if (tr && tr.x != null) S.transitions.set(tr.x + ',' + tr.y, { ...tr });
      }
    }
  }
  function applyDelta(d) {
    const st = S.state; if (!st) return;
    if (d.reveal) scanReveal(d.reveal);
    if (d.reset) st.loot = [];
    if (d.lootLeave) { const s = new Set(d.lootLeave); st.loot = (st.loot || []).filter(o => !s.has(o.id)); }
    for (const n of d.loot || []) {
      st.loot = st.loot || [];
      const i = st.loot.findIndex(a => a.id === n.id);
      if (i >= 0) st.loot[i] = { ...n }; else st.loot.push({ ...n });
    }
    for (const id of d.taken || []) { const o = (st.loot || []).find(a => a.id === id); if (o) o.taken = true; }
    if (d.player) st.player = { ...st.player, ...d.player };
  }
  function onGameMsg(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') {
      S.state = m.state; S.surface = m.surface; S.inGame = true;
      S.vaults.clear(); S.transitions.clear(); S.obstacles.clear(); S.mapVer++; S.dungeon = null;
      scanReveal(m.reveal);
    } else if (m.t === 'snap' && m.state) {
      scanReveal(m.reveal);
      S.state = m.state; S.inGame = true;
    } else if (m.t === 'view' && S.state) {
      for (const d of m.deltas || []) applyDelta(d);
    } else if (m.t === 'ack') {
      if (Array.isArray(m.at) && S.state && S.state.player) { S.state.player.x = m.at[0]; S.state.player.y = m.at[1]; }
    } else if (m.t === 'dungeon') {
      S.dungeon = { location: m.location, world: m.world }; S.mapVer++;
    } else if (m.t === 'end') {
      S.inGame = false;
    }
  }
  window.__squeekOverlay = { S, cfg };

  // 只监听，不拦截、不发送（这是旧版卡顿来源之一，已去掉）
  const NativeWS = window.WebSocket;
  function HookedWS(url, protocols) {
    const ws = protocols ? new NativeWS(url, protocols) : new NativeWS(url);
    if (String(url).includes('/api/account/play')) {
      ws.addEventListener('message', (ev) => { try { onGameMsg(JSON.parse(ev.data)); } catch {} });
    }
    return ws;
  }
  HookedWS.prototype = NativeWS.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) HookedWS[k] = NativeWS[k];
  window.WebSocket = HookedWS;

  // ---------------- 覆盖层（低频绘制，限 DPR，减少合成开销） ----------------
  const cv = document.createElement('canvas');
  Object.assign(cv.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647' });
  const hud = document.createElement('div');
  Object.assign(hud.style, { position: 'fixed', left: '10px', top: '10px', color: '#e8f5e9', font: '12px/1.5 system-ui, sans-serif', background: 'rgba(0,0,0,.45)', padding: '4px 8px', borderRadius: '6px', pointerEvents: 'none', zIndex: '2147483647', whiteSpace: 'pre' });
  let DPR = 1;
  function mount() {
    if (!document.body) return;
    if (!cv.parentNode) document.body.appendChild(cv);
    if (!hud.parentNode) document.body.appendChild(hud);
    DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = window.innerWidth, h = window.innerHeight;
    if (cv.width !== Math.round(w * DPR) || cv.height !== Math.round(h * DPR)) { cv.width = Math.round(w * DPR); cv.height = Math.round(h * DPR); cv.style.width = w + 'px'; cv.style.height = h + 'px'; }
  }
  document.addEventListener('DOMContentLoaded', mount);

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function draw() {
    mount();
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const st = S.state;
    if (!S.inGame || !st || !st.player) { if (hud.textContent) hud.textContent = ''; return; }
    const p = st.player;
    const W = window.innerWidth, H = window.innerHeight;
    const onSurface = (st.location || 'surface') === 'surface';
    const loot = (st.loot || []).filter(l => !l.taken && wanted(l.kind));

    // 标记清单（屏幕圈/箭头共用）
    const items = loot.map(l => ({ x: l.x, y: l.y, label: NAME[l.kind] || l.kind, col: colorOf(l.kind), ch: CHAR[l.kind] || '?' }));
    if (onSurface) {
      for (const v of S.vaults.values()) items.push({ x: v.x + (v.width || 0) / 2, y: v.y + (v.height || 0) / 2, label: '保险库', col: COLOR.vault, ch: '库' });
      if (S.surface && S.surface.portal) items.push({ x: S.surface.portal.x, y: S.surface.portal.y, label: '传送门', col: COLOR.portal, ch: '门' });
      for (const tr of S.transitions.values()) items.push({ x: tr.x, y: tr.y, label: tr.label || '地牢入口', col: COLOR.door, ch: '牢' });
      if (S.surface && S.surface.shortcut && S.surface.shortcut.radius > 0) items.push({ x: S.surface.shortcut.x, y: S.surface.shortcut.y, label: '桥捷径', col: COLOR.door, ch: '桥' });
    } else if (S.dungeon && S.dungeon.world) {
      for (const tr of S.dungeon.world.transitions || []) items.push({ x: tr.x, y: tr.y, label: tr.label || tr.target, col: COLOR.door, ch: tr.target === 'surface' ? '出' : '深' });
      if (S.dungeon.world.portal) items.push({ x: S.dungeon.world.portal.x, y: S.dungeon.world.portal.y, label: '出口', col: COLOR.portal, ch: '门' });
    }

    // 屏幕圈 + 屏幕外箭头
    const scale = (cfg.scale > 0 ? cfg.scale : 1) * DPR;
    const cx = W * DPR / 2, cy = H * DPR / 2;
    ctx.textAlign = 'center';
    for (const it of items) {
      const sx = cx + (it.x - p.x) * scale, sy = cy + (it.y - p.y) * scale;
      const d = Math.round(dist(it, p));
      if (sx >= 0 && sx <= cv.width && sy >= 0 && sy <= cv.height) {
        ctx.strokeStyle = it.col; ctx.fillStyle = it.col; ctx.lineWidth = Math.max(1.5, DPR);
        const r = 8 * DPR;
        ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(sx, sy, 1.8 * DPR, 0, Math.PI * 2); ctx.fill();
        ctx.font = `${11 * DPR}px system-ui, sans-serif`;
        ctx.fillText(`${it.label} ${d}`, sx, sy - r - 4 * DPR);
      } else {
        const ang = Math.atan2(sy - cy, sx - cx);
        const ex = cx + Math.cos(ang) * (W * DPR / 2 - 34 * DPR), ey = cy + Math.sin(ang) * (H * DPR / 2 - 34 * DPR);
        ctx.save(); ctx.translate(ex, ey); ctx.rotate(ang);
        ctx.fillStyle = it.col;
        ctx.beginPath(); ctx.moveTo(10 * DPR, 0); ctx.lineTo(-7 * DPR, 6 * DPR); ctx.lineTo(-7 * DPR, -6 * DPR); ctx.closePath(); ctx.fill();
        ctx.restore();
        ctx.fillStyle = it.col; ctx.font = `${11 * DPR}px system-ui, sans-serif`;
        ctx.fillText(`${it.label} ${d}`, ex, ey - 12 * DPR);
      }
    }

    // 小地图（右上角，地形缓存 + 汉字标记）
    if (cfg.showMinimap) {
      const size = cfg.minimapSize * DPR;
      const mx = cv.width - size - 12 * DPR, my = 12 * DPR;
      const world = (!onSurface && S.dungeon && S.dungeon.world) ? S.dungeon.world : null;
      let minX, minY, span;
      if (world) { minX = -40; minY = -40; span = Math.max(world.width || 1400, world.height || 840) + 80; }
      else {
        const pts = [...loot, ...S.vaults.values(), p];
        if (S.surface && S.surface.portal) pts.push(S.surface.portal);
        let maxX = -Infinity, maxY = -Infinity; minX = Infinity; minY = Infinity;
        for (const q of pts) { minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y); }
        const pad = 300; minX -= pad; minY -= pad; maxX += pad; maxY += pad;
        span = Math.max(maxX - minX, maxY - minY) || 1;
      }
      const ms = size / span;
      const X = (x) => mx + (x - minX) * ms, Y = (y) => my + (y - minY) * ms;
      ctx.fillStyle = 'rgba(10,14,10,.72)'; ctx.fillRect(mx, my, size, size);
      const featKey = [world ? world.id : 'surface', S.mapVer, Math.round(minX), Math.round(minY), Math.round(span), Math.round(size)].join('|');
      if (S._featKey !== featKey) {
        S._featKey = featKey;
        const fc = S._featCanvas || (S._featCanvas = document.createElement('canvas'));
        fc.width = Math.max(2, Math.round(size)); fc.height = Math.max(2, Math.round(size));
        const fx = fc.getContext('2d');
        if (fx) {
          fx.clearRect(0, 0, fc.width, fc.height);
          const RX = (x) => (x - minX) * ms, RY = (y) => (y - minY) * ms;
          const rect = (o, col) => { const w = (o.width || 0) * ms, h = (o.height || 0) * ms; if (w < 0.8 && h < 0.8) return; fx.fillStyle = col; fx.fillRect(RX(o.x), RY(o.y), Math.max(1, w), Math.max(1, h)); };
          if (world) {
            for (const o of world.obstacles || []) rect(o, o.kind === 'seal' ? '#8f6fe8' : '#878d96');
            for (const hz of world.hazards || []) { fx.fillStyle = '#ff6b6b'; fx.beginPath(); fx.arc(RX(hz.x), RY(hz.y), Math.max(1.5, (hz.radius || 20) * ms), 0, Math.PI * 2); fx.fill(); }
          } else {
            for (const o of S.obstacles.values()) rect(o, o.kind === 'water' ? '#2f6fb3' : o.kind === 'hedge' ? '#3e7c43' : o.kind === 'stone' ? '#8d9299' : '#c9a227');
          }
        }
      }
      if (S._featCanvas) ctx.drawImage(S._featCanvas, mx, my, size, size);
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = DPR; ctx.strokeRect(mx, my, size, size);
      const tag = (x, y, ch, col, px, invert) => {
        ctx.font = `bold ${px}px system-ui, sans-serif`;
        const w = px + 5 * DPR;
        ctx.fillStyle = invert ? '#fff' : 'rgba(0,0,0,.62)';
        ctx.fillRect(x - w / 2, y - w / 2, w, w);
        ctx.fillStyle = invert ? '#111' : col;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(ch, x, y + 1);
        ctx.textBaseline = 'alphabetic';
      };
      for (const it of items) tag(X(it.x), Y(it.y), it.ch, it.col, 10.5 * DPR);
      tag(X(p.x), Y(p.y), '我', '#fff', 12 * DPR, true);
      ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 9 * DPR, 0, Math.PI * 2); ctx.stroke();
    }

    // HUD：只报最近的三个目标
    const near = (kind) => loot.filter(l => l.kind === kind).sort((a, b) => dist(a, p) - dist(b, p))[0];
    const nc = loot.filter(l => (VALUE[l.kind] || 0) >= 400).sort((a, b) => dist(a, p) - dist(b, p))[0];
    const nk = near('cleaver'), ns = near('snack');
    hud.textContent = `大货 ${loot.filter(l => (VALUE[l.kind] || 0) >= 400).length} · 砍刀 ${loot.filter(l => l.kind === 'cleaver').length} · 食物 ${loot.filter(l => l.kind === 'snack').length}\n` +
      `最近：${nc ? (NAME[nc.kind] || nc.kind) + ' ' + Math.round(dist(nc, p)) : '无大货'} · ${nk ? '砍刀 ' + Math.round(dist(nk, p)) : '无砍刀'} · ${ns ? '食物 ' + Math.round(dist(ns, p)) : '无食物'}\n` +
      `[M]小地图 [B]大小 [H]隐藏 [+/-]标定`;
  }
  setInterval(draw, 120); // 约 8 帧/秒，够看且不抢游戏性能

  window.addEventListener('keydown', (ev) => {
    if (ev.target && /INPUT|TEXTAREA/.test(ev.target.tagName)) return;
    const k = ev.key.toLowerCase();
    if (k === 'm') { cfg.showMinimap = !cfg.showMinimap; saveCfg(); }
    else if (k === 'b') { const sizes = [240, 300, 420]; cfg.minimapSize = sizes[(sizes.indexOf(cfg.minimapSize) + 1) % sizes.length] || 300; saveCfg(); }
    else if (k === 'h') { cv.style.display = cv.style.display === 'none' ? '' : 'none'; hud.style.display = cv.style.display; }
    else if (k === '+' || k === '=') { cfg.scale = (cfg.scale || 1) * 1.1; saveCfg(); }
    else if (k === '-' || k === '_') { cfg.scale = (cfg.scale || 1) / 1.1; saveCfg(); }
    else if (k === '0') { cfg.scale = 0; saveCfg(); }
  });
})();
