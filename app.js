'use strict';
/* ==========================================================================
   Mark Website — memory album
   Two storage back ends share one interface:
     • remote : Vercel API  -> saves everything to GitHub (the live website)
     • local  : IndexedDB / localStorage in this browser (when opened without the API)
   ========================================================================== */

const CATS = ['pictures', 'videos', 'music', 'messages'];
const LIMIT_REMOTE = 3 * 1024 * 1024;   // Vercel request-size limit (after base64)
const LIMIT_LOCAL = 60 * 1024 * 1024;

const DEFAULT_TEXTS = {
  'login.title': 'Mark Website',
  'login.userLabel': 'Username',
  'login.passLabel': 'Password',
  'login.button': 'Enter',
  'header.brand': 'Mark Website',
  'hero.title': 'Our Memory Album',
  'tab.pictures': 'Pictures',
  'tab.videos': 'Videos',
  'tab.music': 'Music',
  'tab.messages': 'Love Messages',
  'sec.pictures.title': 'Our Pictures',
  'sec.videos.title': 'Our Videos',
  'sec.music.title': 'Our Songs',
  'sec.messages.title': 'Love Messages',
  'music.idle': 'Pick a song to begin',
  'empty.title': 'Nothing here yet',
};
const LOGIN_TEXTS = [
  ['login.title', 'Login title'],
  ['login.userLabel', 'Username label'], ['login.passLabel', 'Password label'], ['login.button', 'Login button'],
];
const ICON_FOR = { pictures: 'image', videos: 'video', music: 'music', messages: 'mail' };
const ADD_LABEL = { pictures: 'Add Picture', videos: 'Add Video', music: 'Add Song', messages: 'Write Message' };

const S = {
  mode: 'local', user: null, texts: {},
  items: { pictures: [], videos: [], music: [], messages: [] },
  tab: 'pictures', edit: false, loadError: '',
};
const isAdmin = () => !!S.user && S.user.role === 'admin';

/* ------------------------------------------------------------ helpers */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}
function icon(name, cls) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#i-' + name);
  s.append(u);
  return s;
}
const tx = (key) => S.texts[key] || DEFAULT_TEXTS[key] || '';
const tEl = (tag, key, cls) => h(tag, { class: cls, 'data-t': key, text: tx(key) });
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } };

function fmtDate(s, short) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return s || '';
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { year: 'numeric', month: short ? 'short' : 'long', day: 'numeric' });
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const fmtTime = (t) => { if (!isFinite(t)) return '0:00'; t = Math.floor(t); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
const limit = () => (S.mode === 'remote' ? LIMIT_REMOTE : LIMIT_LOCAL);

function youtubeId(url) {
  const m = String(url).match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/))([\w-]{11})/);
  return m ? m[1] : '';
}

let toastTimer;
function toast(msg, type = 'ok') {
  const t = h('div', { class: 'toast ' + type }, type === 'ok' ? icon('check') : null, msg);
  $('#toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, type === 'error' ? 4800 : 2400);
}

/* ------------------------------------------------------------ texts */
function applyTexts() {
  $$('[data-t]').forEach((el) => {
    if (el === document.activeElement) return;
    const v = tx(el.dataset.t);
    if (el.textContent !== v) el.textContent = v;
  });
  document.title = tx('login.title') || 'Mark Website';
}
function syncEditable() {
  $$('#app-view [data-t]').forEach((el) => {
    if (S.edit) { el.setAttribute('contenteditable', 'true'); el.setAttribute('spellcheck', 'true'); el.setAttribute('role', el.getAttribute('role') || 'textbox'); }
    else { el.removeAttribute('contenteditable'); if (el.getAttribute('role') === 'textbox') el.removeAttribute('role'); }
  });
}

/* ------------------------------------------------------------ API + stores */
async function api(method, url, body, opts = {}) {
  let r;
  try {
    r = await fetch(url, {
      method, credentials: 'same-origin', keepalive: !!opts.keepalive,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('No connection. Please check your internet and try again.');
  }
  let data = null;
  try { data = await r.json(); } catch { /* not json */ }
  if (r.status === 401 && S.user && url !== '/api/auth') sessionExpired();
  if (r.status === 413) throw new Error('That file is too big for the live site (max 3 MB). Use a smaller file or paste a link instead.');
  if (!r.ok) throw new Error((data && data.error) || `Something went wrong (${r.status}).`);
  return data;
}

const normItems = (it) => { const o = {}; CATS.forEach((c) => { o[c] = Array.isArray(it && it[c]) ? it[c] : []; }); return o; };

const remoteStore = {
  async load() {
    const d = await api('GET', '/api/db');
    return { texts: d.texts || {}, items: normItems(d.items) };
  },
  saveTexts: (patch) => api('POST', '/api/texts', { texts: patch }, { keepalive: true }),
  async addItem(cat, fields, file) {
    const payload = { category: cat, ...fields };
    if (file) payload.file = { name: file.name, type: file.type, data: await toBase64(file) };
    return (await api('POST', '/api/items', payload)).item;
  },
  async deleteItem(cat, id) { await api('DELETE', `/api/items?category=${cat}&id=${encodeURIComponent(id)}`); },
  src(item) {
    if (item.kind === 'url' || item.kind === 'youtube') return item.src;
    return /^uploads\//.test(item.src) ? '/api/file?p=' + item.src : item.src;
  },
};

/* local (browser-only) store: IndexedDB for data + media blobs */
const localStore = {
  db: null, mem: null, urls: new Map(),
  open() {
    return new Promise((res) => {
      if (!window.indexedDB) return res(false);
      const r = indexedDB.open('mark-album', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('blobs'); };
      r.onsuccess = () => { this.db = r.result; res(true); };
      r.onerror = () => res(false);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  },
  async persist() {
    const snapshot = { texts: S.texts, items: S.items };
    if (this.db) await this.tx('kv', 'readwrite', (s) => s.put(snapshot, 'data'));
    else this.mem = snapshot;
  },
  async load() {
    if (this.db === null && this.mem === null && !this.opened) { this.opened = true; await this.open(); }
    let data = this.db ? await this.tx('kv', 'readonly', (s) => s.get('data')) : this.mem;
    if (!data) data = JSON.parse(JSON.stringify(window.MW_SEED || { texts: {}, items: {} }));
    const items = normItems(data.items);
    if (this.db) {
      for (const c of CATS) for (const it of items[c]) {
        if (typeof it.src === 'string' && it.src.startsWith('local:') && !this.urls.has(it.id)) {
          const blob = await this.tx('blobs', 'readonly', (s) => s.get(it.id));
          if (blob) this.urls.set(it.id, URL.createObjectURL(blob));
        }
      }
    }
    return { texts: data.texts || {}, items };
  },
  async saveTexts() { await this.persist(); },
  async addItem(cat, fields, file) {
    const id = Date.now().toString(36) + Math.random().toString(16).slice(2, 6);
    const item = { id, createdAt: new Date().toISOString(), ...fields };
    delete item.url; delete item.category;
    if (file) {
      if (this.db) await this.tx('blobs', 'readwrite', (s) => s.put(file, id));
      this.urls.set(id, URL.createObjectURL(file));
      item.kind = 'file'; item.src = 'local:' + id;
    } else if (fields.url) {
      const yt = cat === 'videos' ? youtubeId(fields.url) : '';
      item.kind = yt ? 'youtube' : 'url'; item.src = fields.url; if (yt) item.ytId = yt;
    }
    S.items[cat].unshift(item);
    await this.persist();
    return item;
  },
  async deleteItem(cat, id) {
    S.items[cat] = S.items[cat].filter((x) => x.id !== id);
    if (this.db) await this.tx('blobs', 'readwrite', (s) => s.delete(id));
    const u = this.urls.get(id); if (u) { URL.revokeObjectURL(u); this.urls.delete(id); }
    await this.persist();
  },
  src(item) { return item.src && item.src.startsWith('local:') ? this.urls.get(item.id) || '' : item.src; },
};
const store = () => (S.mode === 'remote' ? remoteStore : localStore);
const srcOf = (item) => store().src(item);

function toBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(new Error('Could not read that file.'));
    r.readAsDataURL(file);
  });
}

/* tiny hash — only used for the browser-only demo login (the live site checks on the server) */
function h53(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
const LOCAL_ACCOUNTS = { 1895802782839837: { name: 'macky', role: 'admin' }, 4353808718155261: { name: 'Mark', role: 'user' } };

/* ------------------------------------------------------------ modal manager */
const modals = [];
function openModal(build, opts = {}) {
  const prev = document.activeElement;
  const overlay = h('div', { class: 'overlay ' + (opts.cls || ''), role: 'presentation' });
  const ctl = {
    overlay, busy: false,
    close() {
      if (ctl.closed) return; ctl.closed = true;
      overlay.classList.remove('open');
      modals.splice(modals.indexOf(ctl), 1);
      if (!modals.length) document.body.classList.remove('modal-open');
      if (opts.onClose) opts.onClose();
      setTimeout(() => overlay.remove(), 280);
      if (prev && prev.focus && document.contains(prev)) prev.focus({ preventScroll: true });
    },
  };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && !ctl.busy) ctl.close(); });
  overlay.append(...[].concat(build(ctl)));
  document.body.append(overlay);
  document.body.classList.add('modal-open');
  modals.push(ctl);
  requestAnimationFrame(() => {
    overlay.classList.add('open');
    const f = $(opts.focus || '[data-autofocus]', overlay) || $('.dialog-x, .v-close', overlay);
    if (f) f.focus({ preventScroll: true });
  });
  return ctl;
}
document.addEventListener('keydown', (e) => {
  const top = modals[modals.length - 1];
  if (!top) return;
  if (e.key === 'Escape' && !top.busy) { e.preventDefault(); top.close(); return; }
  if (e.key === 'Tab') {
    const f = $$('button:not([disabled]), [href], input:not([disabled]):not(.sr-only), textarea, select, [tabindex]:not([tabindex="-1"])', top.overlay).filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

function confirmDialog(title, message, okLabel = 'Delete') {
  return new Promise((resolve) => {
    let answered = false;
    const done = (v, ctl) => { answered = true; resolve(v); ctl.close(); };
    openModal((ctl) => h('div', { class: 'dialog confirm', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
      h('h3', { text: title }), h('p', { text: message }),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', 'data-autofocus': '', onclick: () => done(false, ctl) }, 'Cancel'),
        h('button', { class: 'btn btn-danger', type: 'button', onclick: () => done(true, ctl) }, okLabel))),
    { onClose: () => { if (!answered) resolve(false); } });
  });
}

/* ------------------------------------------------------------ viewer / lightbox */
function openViewer(cat, startIndex) {
  let idx = startIndex;
  let content = null;
  const list = () => S.items[cat];
  const stage = h('div', { class: 'viewer-stage' });
  let touchX = null;

  const stopMedia = () => $$('video, iframe', stage).forEach((m) => { if (m.pause) m.pause(); m.removeAttribute('src'); if (m.load) m.load(); });

  function build(item) {
    if (cat === 'pictures') {
      const img = h('img', { class: 'v-img', src: srcOf(item), alt: item.caption || 'Picture' });
      const cap = (item.caption || item.date) ? h('div', { class: 'v-cap' },
        item.caption ? h('div', { class: 'cap-text', text: item.caption }) : null,
        item.date ? h('div', { class: 'cap-date', text: fmtDate(item.date) }) : null) : null;
      return h('div', { class: 'v-content' }, img, cap);
    }
    if (cat === 'videos') {
      let media;
      if (item.kind === 'youtube') {
        media = h('iframe', { src: `https://www.youtube-nocookie.com/embed/${item.ytId}?autoplay=1&rel=0`, title: item.title || 'Video', allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen', allowfullscreen: true });
      } else {
        media = h('video', { src: srcOf(item), controls: true, autoplay: true, playsinline: true, preload: 'auto' });
      }
      const cap = (item.title || item.caption) ? h('div', { class: 'v-cap' },
        item.title ? h('div', { class: 'cap-text', text: item.title }) : null,
        item.caption ? h('div', { style: 'color:var(--muted);font-size:.9rem', text: item.caption }) : null) : null;
      return h('div', { class: 'v-content' }, h('div', { class: 'v-video' }, media), cap);
    }
    return h('div', { class: 'v-content' }, h('article', { class: 'paper' },
      item.date ? h('div', { class: 'letter-date', text: fmtDate(item.date) }) : null,
      h('h3', { text: item.title }),
      h('div', { class: 'paper-body', text: item.body })));
  }

  function show(i, dir = 0) {
    const n = list().length;
    if (!n) return ctlRef.close();
    idx = (i + n) % n;
    stopMedia();
    content && content.remove();
    content = build(list()[idx]);
    content.style.setProperty('--dx', dir * 36 + 'px');
    stage.append(content);
    prevBtn.hidden = nextBtn.hidden = n < 2;
  }
  const go = (d) => show(idx + d, d);
  const prevBtn = h('button', { class: 'icon-btn v-nav v-prev', type: 'button', 'aria-label': 'Previous', onclick: () => go(-1) }, icon('left'));
  const nextBtn = h('button', { class: 'icon-btn v-nav v-next', type: 'button', 'aria-label': 'Next', onclick: () => go(1) }, icon('right'));

  const onKey = (e) => {
    if (modals[modals.length - 1] !== ctlRef) return;
    if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1);
  };
  document.addEventListener('keydown', onKey);

  const ctlRef = openModal((ctl) => {
    const x = h('button', { class: 'icon-btn v-close', type: 'button', 'aria-label': 'Close', onclick: () => ctl.close() }, icon('x'));
    ctl.overlay.setAttribute('aria-label', cat);
    if (cat !== 'videos') {
      stage.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
      stage.addEventListener('touchend', (e) => {
        if (touchX == null) return;
        const dx = e.changedTouches[0].clientX - touchX; touchX = null;
        if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1);
      });
    }
    return [x, prevBtn, nextBtn, stage];
  }, { cls: 'viewer', onClose: () => { stopMedia(); document.removeEventListener('keydown', onKey); } });
  ctlRef.overlay.setAttribute('role', 'dialog');
  ctlRef.overlay.setAttribute('aria-modal', 'true');
  show(idx);
}

/* ------------------------------------------------------------ rendering */
function emptyState(cat) {
  return h('div', { class: 'empty reveal' }, icon(ICON_FOR[cat]),
    tEl('h3', 'empty.title'),
    isAdmin() ? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openUpload(cat) }, icon('plus'), ADD_LABEL[cat]) : null);
}
function delBtn(cat, item) {
  if (!isAdmin()) return null;
  return h('button', {
    class: 'del', type: 'button', 'aria-label': 'Delete',
    onclick: (e) => { e.stopPropagation(); removeItem(cat, item); },
    onkeydown: (e) => e.stopPropagation(),
  }, icon('trash'));
}
const activate = (fn) => (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };

function renderPictures() {
  const box = $('#list-pictures'); box.replaceChildren();
  const items = S.items.pictures;
  if (!items.length) return box.append(emptyState('pictures'));
  items.forEach((it, i) => {
    const img = h('img', { src: srcOf(it), alt: it.caption || 'Picture', loading: 'lazy', decoding: 'async' });
    if (it.w && it.h) img.style.aspectRatio = `${it.w} / ${it.h}`;
    img.addEventListener('load', () => img.classList.add('loaded'));
    img.addEventListener('error', () => img.classList.add('loaded'));
    const open = () => openViewer('pictures', i);
    box.append(h('figure', { class: 'photo reveal', style: `--i:${Math.min(i, 12)}`, tabindex: '0', role: 'button', 'aria-label': 'Open ' + (it.caption || 'picture'), onclick: open, onkeydown: activate(open) },
      img,
      (it.caption || it.date) ? h('figcaption', null,
        it.caption ? h('div', { class: 'cap-text', text: it.caption }) : null,
        it.date ? h('div', { class: 'cap-date', text: fmtDate(it.date, true) }) : null) : null,
      delBtn('pictures', it)));
  });
}

function renderVideos() {
  const box = $('#list-videos'); box.replaceChildren();
  const items = S.items.videos;
  if (!items.length) return box.append(emptyState('videos'));
  items.forEach((it, i) => {
    let thumb;
    if (it.kind === 'youtube') thumb = h('img', { src: `https://i.ytimg.com/vi/${it.ytId}/hqdefault.jpg`, alt: '', loading: 'lazy' });
    else thumb = h('video', { src: srcOf(it) + '#t=0.8', preload: 'metadata', muted: true, playsinline: true, tabindex: '-1', 'aria-hidden': 'true' });
    const open = () => openViewer('videos', i);
    box.append(h('article', { class: 'vcard reveal', style: `--i:${Math.min(i, 12)}`, tabindex: '0', role: 'button', 'aria-label': 'Play ' + (it.title || 'video'), onclick: open, onkeydown: activate(open) },
      h('div', { class: 'thumb' }, thumb, h('div', { class: 'play-badge' }, h('span', null, icon('play')))),
      (it.title || it.caption) ? h('div', { class: 'vmeta' },
        it.title ? h('div', { class: 'vtitle', text: it.title }) : null,
        it.caption ? h('div', { class: 'vcap', text: it.caption }) : null) : null,
      delBtn('videos', it)));
  });
}

function renderMessages() {
  const box = $('#list-messages'); box.replaceChildren();
  const items = S.items.messages;
  if (!items.length) return box.append(emptyState('messages'));
  items.forEach((it, i) => {
    const open = () => openViewer('messages', i);
    box.append(h('article', { class: 'letter-card reveal', style: `--i:${Math.min(i, 12)}`, tabindex: '0', role: 'button', 'aria-label': 'Read ' + it.title, onclick: open, onkeydown: activate(open) },
      it.date ? h('div', { class: 'letter-date', text: fmtDate(it.date) }) : null,
      h('h3', { class: 'letter-title', text: it.title }),
      h('p', { class: 'letter-excerpt', text: it.body }),
      h('span', { class: 'letter-more' }, 'Read', icon('right')),
      delBtn('messages', it)));
  });
}

function renderMusic() {
  const box = $('#list-music'); box.replaceChildren();
  const items = S.items.music;
  P.idx = items.findIndex((x) => x.id === P.id);
  if (!items.length) { box.append(emptyState('music')); }
  items.forEach((it, i) => {
    const play = () => playIndex(i);
    box.append(h('div', { class: 'song reveal', 'data-id': it.id, style: `--i:${Math.min(i, 12)}`, tabindex: '0', role: 'button', 'aria-label': 'Play ' + it.title, onclick: play, onkeydown: activate(play) },
      h('div', { class: 'song-num' }, h('span', { class: 'song-num-text', text: String(i + 1) }), h('span', { class: 'eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))),
      h('div', { class: 'song-info' }, h('div', { class: 'song-title', text: it.title }), it.artist ? h('div', { class: 'song-artist', text: it.artist }) : null),
      h('span', { class: 'go' }, icon('play')),
      delBtn('music', it)));
  });
  updatePlayerUI();
}

function updateCounts() { CATS.forEach((c) => { $('#count-' + c).textContent = S.items[c].length; }); }
function renderAll() {
  renderPictures(); renderVideos(); renderMusic(); renderMessages(); updateCounts();
  const err = $('#load-error');
  err.hidden = !S.loadError;
  if (S.loadError) err.replaceChildren(h('span', { text: S.loadError }), h('button', { class: 'btn btn-small', type: 'button', onclick: reloadData }, 'Try again'));
  applyTexts(); syncEditable();
}

/* ------------------------------------------------------------ tabs */
function setTab(name, focus) {
  if (!CATS.includes(name)) name = 'pictures';
  const changed = S.tab !== name;
  S.tab = name; lsSet('mw.tab', name);
  $$('.tab').forEach((t) => {
    const on = t.dataset.tab === name;
    t.setAttribute('aria-selected', on);
    t.tabIndex = on ? 0 : -1;
    if (on && focus) t.focus();
  });
  $$('.panel').forEach((p) => {
    const on = p.id === 'panel-' + name;
    p.hidden = !on;
    p.classList.remove('enter');
    if (on) { void p.offsetWidth; p.classList.add('enter'); }
  });
  if (changed && window.scrollY > 260) window.scrollTo({ top: 0, behavior: 'smooth' });
  updateMini();
}

/* ------------------------------------------------------------ music player */
const audio = new Audio();
audio.preload = 'none';
const P = { idx: -1, id: null, seeking: false };

function playIndex(i) {
  const it = S.items.music[i];
  if (!it) return;
  P.idx = i; P.id = it.id;
  audio.src = srcOf(it);
  audio.play().catch((e) => { if (e && e.name !== 'AbortError') toast("Can't play this song.", 'error'); });
  setMediaSession(it);
  updatePlayerUI();
}
function togglePlay() {
  if (!S.items.music.length) return;
  if (!audio.src || P.idx < 0) return playIndex(0);
  if (audio.paused) audio.play().catch(() => toast("Can't play this song.", 'error')); else audio.pause();
}
function stepTrack(d) {
  const n = S.items.music.length; if (!n) return;
  playIndex(P.idx < 0 ? 0 : (P.idx + d + n) % n);
}
function stopPlayer() { audio.pause(); audio.removeAttribute('src'); audio.load(); P.idx = -1; P.id = null; updatePlayerUI(); }
function setMediaSession(it) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: it.title, artist: it.artist || '' });
    navigator.mediaSession.setActionHandler('previoustrack', () => stepTrack(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => stepTrack(1));
  } catch { /* unsupported */ }
}
function setRangeFill(el, pct) { el.style.setProperty('--pct', pct + '%'); }
function updatePlayerUI() {
  const it = S.items.music[P.idx];
  const playing = !!it && !audio.paused;
  const title = $('#player-title');
  if (document.activeElement !== title) title.textContent = it ? it.title : tx('music.idle');
  if (it) title.removeAttribute('data-t'); else title.setAttribute('data-t', 'music.idle');
  $('#player-artist').textContent = it ? (it.artist || '') : '';
  $('#player').classList.toggle('is-playing', playing);
  const pb = $('#p-play');
  pb.replaceChildren(icon(playing ? 'pause' : 'play'));
  pb.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('#p-seek').disabled = !it;
  if (!it) { $('#p-seek').value = 0; setRangeFill($('#p-seek'), 0); $('#p-cur').textContent = '0:00'; $('#p-dur').textContent = '0:00'; }
  $$('#list-music .song').forEach((row) => {
    const cur = !!it && row.dataset.id === it.id;
    row.classList.toggle('current', cur);
    row.classList.toggle('playing', cur && playing);
  });
  updateMini();
}
function updateMini() {
  const it = S.items.music[P.idx];
  const show = !!it && S.tab !== 'music' && !!S.user;
  $('#mini').hidden = !show;
  if (!show) return;
  $('#mini-title').textContent = it.title;
  const playing = !audio.paused;
  $('#mini-play').replaceChildren(icon(playing ? 'pause' : 'play'));
  $('#mini-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
}
audio.addEventListener('play', updatePlayerUI);
audio.addEventListener('pause', updatePlayerUI);
audio.addEventListener('ended', () => { if (P.idx < S.items.music.length - 1) stepTrack(1); else updatePlayerUI(); });
audio.addEventListener('error', () => { if (audio.getAttribute('src')) toast("This song couldn't be loaded.", 'error'); });
audio.addEventListener('loadedmetadata', () => { $('#p-dur').textContent = fmtTime(audio.duration); });
audio.addEventListener('timeupdate', () => {
  if (P.seeking || !audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  $('#p-seek').value = pct * 10; setRangeFill($('#p-seek'), pct);
  $('#p-cur').textContent = fmtTime(audio.currentTime);
});

/* ------------------------------------------------------------ add / delete */
async function removeItem(cat, item) {
  if (!isAdmin()) return;
  const label = item.title || item.caption || 'this item';
  if (!(await confirmDialog('Delete this?', `"${label}" will be removed for everyone, including Mark.`))) return;
  try {
    await store().deleteItem(cat, item.id);
    S.items[cat] = S.items[cat].filter((x) => x.id !== item.id);
    if (cat === 'music' && P.id === item.id) stopPlayer();
    renderAll();
    toast('Deleted');
  } catch (e) { toast(e.message, 'error'); }
}

const EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg' };
function withType(file) {
  if (file.type) return file;
  const t = EXT_MIME[(file.name.split('.').pop() || '').toLowerCase()];
  return t ? new File([file], file.name, { type: t }) : file;
}

/** Shrinks photos so they upload fast and fit the live-site size limit. */
async function prepareImage(file) {
  const max = limit();
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    bmp = await new Promise((res, rej) => {
      const url = URL.createObjectURL(file); const im = new Image();
      im.onload = () => { URL.revokeObjectURL(url); res(im); };
      im.onerror = () => rej(new Error("This picture can't be read. Please use a JPG, PNG or WebP photo."));
      im.src = url;
    });
  }
  const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight;
  if (file.type === 'image/gif' && file.size <= max) return { blob: file, w: w0, h: h0 };
  let longSide = 1800, q = 0.84, blob;
  for (let tries = 0; tries < 5; tries++) {
    const k = Math.min(1, longSide / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= max * 0.95) return { blob: new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }), w: c.width, h: c.height };
    longSide = Math.round(longSide * 0.8); q = Math.max(0.6, q - 0.06);
  }
  throw new Error('This picture is still too large. Please pick a smaller one.');
}

function dropzone(accept, kind) {
  let file = null, url = null;
  const input = h('input', { type: 'file', accept, class: 'sr-only', tabindex: '0' });
  const preview = h('div', { class: 'dz-preview' });
  const label = h('label', { class: 'dropzone' }, input, icon('upload'), h('strong', { text: 'Choose a file' }), h('span', { text: 'or drag & drop it here' }), preview);
  function set(f) {
    file = f ? withType(f) : null;
    if (url) { URL.revokeObjectURL(url); url = null; }
    preview.replaceChildren();
    if (!f) return;
    if (kind === 'image' && /^image\//.test(file.type) && !/heic|heif/.test(file.type)) { url = URL.createObjectURL(f); preview.append(h('img', { src: url, alt: '' })); }
    preview.append(h('span', { class: 'dz-name', text: `${f.name} · ${fmtSize(f.size)}` }));
  }
  input.addEventListener('change', () => set(input.files[0] || null));
  ['dragenter', 'dragover'].forEach((ev) => label.addEventListener(ev, (e) => { e.preventDefault(); label.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => label.addEventListener(ev, (e) => { e.preventDefault(); label.classList.remove('drag'); }));
  label.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) { set(f); } });
  return { el: label, get file() { return file; } };
}

const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), input, hint ? h('span', { class: 'field-hint', text: hint }) : null);

function openUpload(cat) {
  if (!isAdmin()) return;
  const titles = { pictures: 'Add a picture', videos: 'Add a video', music: 'Add a song', messages: 'Write a love message' };
  openModal((ctl) => {
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const showErr = (m) => { err.textContent = m; err.hidden = !m; if (m) err.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
    const f = {};
    const parts = [];
    const maxTxt = fmtSize(limit());

    if (cat === 'pictures') {
      f.dz = dropzone('image/*', 'image');
      f.caption = h('input', { type: 'text', maxlength: '300', placeholder: 'Optional caption' });
      f.date = h('input', { type: 'date', value: todayStr() });
      parts.push(f.dz.el, field('Caption (optional)', f.caption), field('Date (optional)', f.date));
    } else if (cat === 'videos' || cat === 'music') {
      const isV = cat === 'videos';
      let mode = 'file';
      f.dz = dropzone(isV ? 'video/*' : 'audio/*', 'file');
      f.url = h('input', { type: 'url', placeholder: isV ? 'https://youtube.com/watch?v=…  or a direct .mp4 link' : 'https://… direct link to an .mp3 file', inputmode: 'url' });
      const fileBox = h('div', null, f.dz.el, h('p', { class: 'field-hint', style: 'margin:.5rem 0 1rem', text: `Max ${maxTxt}` }));
      const urlBox = h('div', { hidden: true }, field(isV ? 'Video link' : 'Song link', f.url));
      const bFile = h('button', { type: 'button', 'aria-pressed': 'true' }, 'Upload file');
      const bLink = h('button', { type: 'button', 'aria-pressed': 'false' }, 'Paste link');
      const sw = (m) => { mode = m; f.mode = m; bFile.setAttribute('aria-pressed', m === 'file'); bLink.setAttribute('aria-pressed', m === 'link'); fileBox.hidden = m !== 'file'; urlBox.hidden = m !== 'link'; showErr(''); };
      bFile.onclick = () => sw('file'); bLink.onclick = () => sw('link'); f.mode = 'file';
      parts.push(h('div', { class: 'seg' }, bFile, bLink), fileBox, urlBox);
      if (isV) {
        f.title = h('input', { type: 'text', maxlength: '120', placeholder: 'Optional title' });
        f.caption = h('input', { type: 'text', maxlength: '300', placeholder: 'Optional caption' });
        parts.push(field('Title (optional)', f.title), field('Caption (optional)', f.caption));
      } else {
        f.title = h('input', { type: 'text', maxlength: '120', placeholder: 'Song title', required: true });
        f.artist = h('input', { type: 'text', maxlength: '120', placeholder: 'Artist, or a little note' });
        parts.push(field('Song title', f.title), field('Artist / note (optional)', f.artist));
      }
    } else {
      f.title = h('input', { type: 'text', maxlength: '120', placeholder: 'Title of your letter', required: true });
      f.body = h('textarea', { maxlength: '8000', placeholder: 'Write from the heart…', required: true });
      f.date = h('input', { type: 'date', value: todayStr() });
      parts.push(field('Title', f.title), field('Message', f.body), field('Date', f.date));
    }

    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => !ctl.busy && ctl.close() }, 'Cancel');
    const save = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('check'), h('span', { text: 'Save' }));
    const form = h('form', { novalidate: true }, ...parts, err, h('div', { class: 'form-actions' }, cancel, save));

    form.addEventListener('submit', async (e) => {
      e.preventDefault(); showErr('');
      const fields = {}; let file = null;
      try {
        if (cat === 'messages') {
          fields.title = f.title.value.trim(); fields.body = f.body.value.trim(); fields.date = f.date.value;
          if (!fields.title) throw new Error('Please add a title.');
          if (!fields.body) throw new Error('Please write your message.');
        } else {
          if (cat === 'music') { fields.title = f.title.value.trim(); fields.artist = f.artist.value.trim(); if (!fields.title) throw new Error('Please add the song title.'); }
          if (cat === 'videos') { fields.title = f.title.value.trim(); fields.caption = f.caption.value.trim(); }
          if (cat === 'pictures') { fields.caption = f.caption.value.trim(); fields.date = f.date.value; }
          if (f.mode === 'link') {
            const u = f.url.value.trim();
            if (!/^https?:\/\/\S+$/i.test(u)) throw new Error('Please paste a valid link starting with https://');
            fields.url = u;
          } else {
            if (!f.dz.file) throw new Error(cat === 'pictures' ? 'Please choose a picture.' : 'Please choose a file.');
          }
        }
        ctl.busy = true; save.classList.add('loading'); save.disabled = true; cancel.disabled = true;
        if (f.mode !== 'link' && f.dz) {
          file = f.dz.file;
          if (cat === 'pictures') { const p = await prepareImage(file); file = p.blob; fields.w = p.w; fields.h = p.h; }
          else if (file.size > limit()) throw new Error(`That file is ${fmtSize(file.size)} — the limit is ${maxTxt}. Try a smaller file or use "Paste link".`);
          if (!file.type) throw new Error("This file type isn't supported.");
        }
        const item = await store().addItem(cat, fields, file);
        if (S.mode === 'remote') S.items[cat].unshift(item);
        renderAll(); setTab(cat);
        ctl.busy = false; ctl.close(); toast('Saved ♥');
      } catch (ex) {
        ctl.busy = false; save.classList.remove('loading'); save.disabled = false; cancel.disabled = false;
        showErr(ex.message || 'Something went wrong.');
      }
    });

    const x = h('button', { class: 'icon-btn dialog-x', type: 'button', 'aria-label': 'Close', onclick: () => !ctl.busy && ctl.close() }, icon('x'));
    return h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': titles[cat] }, x, h('h3', { text: titles[cat] }), form);
  });
}

/* ------------------------------------------------------------ edit text mode */
const pending = {}; let saveTimer;
function setSaveState(s) {
  const el = $('#save-state'); el.className = 'save-state ' + s;
  el.textContent = s === 'saving' ? 'Saving…' : s === 'saved' ? '✓ Saved' : s === 'error' ? 'Not saved — will retry' : '';
}
function queueSave(key, raw) {
  const val = raw.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!val || val === DEFAULT_TEXTS[key]) { delete S.texts[key]; pending[key] = ''; }
  else { S.texts[key] = val; pending[key] = val; }
  setSaveState('saving');
  clearTimeout(saveTimer); saveTimer = setTimeout(flushTexts, 700);
}
async function flushTexts() {
  const patch = { ...pending };
  if (!Object.keys(patch).length) return;
  Object.keys(patch).forEach((k) => delete pending[k]);
  try { await store().saveTexts(patch); setSaveState('saved'); }
  catch (e) { Object.assign(pending, patch); setSaveState('error'); toast(e.message, 'error'); }
}
function setEdit(on) {
  S.edit = !!on && isAdmin();
  document.body.classList.toggle('editing', S.edit);
  $('#editbar').hidden = !S.edit;
  $('#btn-edit').setAttribute('aria-pressed', S.edit);
  if (!S.edit) { clearTimeout(saveTimer); flushTexts(); setSaveState(''); }
  syncEditable();
}
document.addEventListener('input', (e) => {
  if (!S.edit) return;
  const el = e.target.closest && e.target.closest('[data-t][contenteditable]');
  if (el) queueSave(el.dataset.t, el.textContent);
});
document.addEventListener('keydown', (e) => {
  if (!S.edit || e.key !== 'Enter') return;
  const el = e.target.closest && e.target.closest('[data-t][contenteditable]');
  if (el) { e.preventDefault(); el.blur(); }
});
document.addEventListener('paste', (e) => {
  const el = e.target.closest && e.target.closest('[data-t][contenteditable]');
  if (!el) return;
  e.preventDefault();
  document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text').replace(/\s+/g, ' '));
});
document.addEventListener('focusout', (e) => {
  const el = e.target.closest && e.target.closest('[data-t][contenteditable]');
  if (!el || !S.edit) return;
  if (!el.textContent.trim()) { queueSave(el.dataset.t, ''); }
  setTimeout(applyTexts, 0);
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushTexts(); });

function openLoginTexts() {
  openModal((ctl) => {
    const inputs = LOGIN_TEXTS.map(([key, label]) => [key, h('input', { type: 'text', maxlength: '300', value: tx(key) })]);
    const save = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('check'), 'Save');
    const form = h('form', null,
            ...inputs.map(([k, inp], i) => field(LOGIN_TEXTS[i][1], inp)),
      h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => ctl.close() }, 'Cancel'), save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); save.classList.add('loading');
      inputs.forEach(([k, inp]) => queueSave(k, inp.value));
      clearTimeout(saveTimer); await flushTexts(); applyTexts(); ctl.close(); toast('Saved ♥');
    });
    const x = h('button', { class: 'icon-btn dialog-x', type: 'button', 'aria-label': 'Close', onclick: () => ctl.close() }, icon('x'));
    return h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Login page texts' }, x, h('h3', { text: 'Login page texts' }), form);
  }, { focus: 'input' });
}
async function resetTexts() {
  if (!(await confirmDialog('Reset all texts?', 'Every title, subtitle and tab name goes back to the original English wording.', 'Reset'))) return;
  const patch = {}; Object.keys(S.texts).forEach((k) => { patch[k] = ''; });
  S.texts = {};
  try { if (Object.keys(patch).length) await store().saveTexts(patch); applyTexts(); toast('Texts reset'); }
  catch (e) { toast(e.message, 'error'); }
}

/* ------------------------------------------------------------ auth + views */
function floaties() {
  const box = $('.floaties');
  if (box.childElementCount) return;
  for (let i = 0; i < 14; i++) {
    const s = 10 + Math.random() * 22;
    const el = h('span', { style: `left:${Math.random() * 100}%;width:${s}px;height:${s}px;animation-duration:${9 + Math.random() * 10}s;animation-delay:${-Math.random() * 14}s` }, icon('heart'));
    box.append(el);
  }
}
function showLogin(message) {
  // drop every thumbnail/video so nothing keeps requesting files after logout
  CATS.forEach((c) => { $('#list-' + c).replaceChildren(); });
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  document.body.classList.remove('role-admin', 'role-user');
  $('#mini').hidden = true;
  $('#login-pass').value = '';
  const err = $('#login-error'); err.hidden = !message; err.textContent = message || '';
  floaties(); applyTexts();
  setTimeout(() => $('#login-user').focus({ preventScroll: true }), 50);
}
function showApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  document.body.classList.toggle('role-admin', isAdmin());
  document.body.classList.toggle('role-user', !isAdmin());
  $('#user-name').textContent = S.user.name;
  $('#user-avatar').textContent = S.user.name.charAt(0);
  $('#user-role').textContent = isAdmin() ? 'Admin' : 'View only';
  renderAll();
  setTab(lsGet('mw.tab') || S.tab);
  window.scrollTo(0, 0);
}
function sessionExpired() {
  S.user = null; lsDel('mw.session'); setEdit(false); stopPlayer(); modals.slice().forEach((m) => m.close());
  showLogin('Your session ended. Please log in again.');
}

async function loadData() {
  S.loadError = '';
  try {
    const d = await store().load();
    S.texts = d.texts; S.items = d.items;
  } catch (e) { S.loadError = e.message; }
}
async function reloadData() { await loadData(); renderAll(); }

async function doLogin(username, password) {
  if (S.mode === 'remote') {
    const d = await api('POST', '/api/auth', { username, password });
    return d.user;
  }
  const acc = LOCAL_ACCOUNTS[h53(username.trim().toLowerCase() + '|' + password)];
  if (!acc) throw new Error('Wrong username or password.');
  return acc;
}

async function logout() {
  setEdit(false); stopPlayer(); modals.slice().forEach((m) => m.close());
  try { if (S.mode === 'remote') await api('DELETE', '/api/auth'); } catch { /* still log out locally */ }
  lsDel('mw.session'); S.user = null;
  S.items = { pictures: [], videos: [], music: [], messages: [] };
  showLogin();
}

function bindStatic() {
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = $('#login-user').value, p = $('#login-pass').value;
    const btn = $('#login-btn'), err = $('#login-error');
    err.hidden = true;
    if (!u.trim() || !p) { err.textContent = 'Please enter your username and password.'; err.hidden = false; return; }
    btn.classList.add('loading');
    try {
      S.user = await doLogin(u, p);
      lsSet('mw.session', JSON.stringify(S.user));
      await loadData();
      $('#login-user').value = '';
      showApp();
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      const card = $('.login-card'); card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
    } finally { btn.classList.remove('loading'); }
  });
  $('#pw-toggle').addEventListener('click', () => {
    const inp = $('#login-pass'), show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('#pw-toggle').setAttribute('aria-pressed', show);
    $('#pw-toggle').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    $('#pw-toggle').replaceChildren(icon(show ? 'eye-off' : 'eye'));
  });
  $('#btn-logout').addEventListener('click', logout);
  $('#btn-edit').addEventListener('click', () => setEdit(!S.edit));
  $('#btn-done').addEventListener('click', () => setEdit(false));
  $('#btn-login-texts').addEventListener('click', openLoginTexts);
  $('#btn-reset-texts').addEventListener('click', resetTexts);
  $$('[data-add]').forEach((b) => b.addEventListener('click', () => openUpload(b.dataset.add)));

  const tabs = $('#tabs');
  tabs.addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) setTab(t.dataset.tab); });
  tabs.addEventListener('keydown', (e) => {
    if (S.edit && e.target.isContentEditable) return;
    const t = e.target.closest('.tab'); if (!t) return;
    const i = CATS.indexOf(t.dataset.tab);
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t.dataset.tab); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); setTab(CATS[(i + (e.key === 'ArrowRight' ? 1 : 3)) % 4], true); }
  });

  $('#p-play').addEventListener('click', togglePlay);
  $('#p-prev').addEventListener('click', () => stepTrack(-1));
  $('#p-next').addEventListener('click', () => stepTrack(1));
  const seek = $('#p-seek');
  seek.addEventListener('input', () => {
    P.seeking = true; setRangeFill(seek, seek.value / 10);
    if (audio.duration) $('#p-cur').textContent = fmtTime((seek.value / 1000) * audio.duration);
  });
  seek.addEventListener('change', () => { if (audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration; P.seeking = false; });
  const vol = $('#p-vol');
  audio.volume = +vol.value; setRangeFill(vol, vol.value * 100);
  vol.addEventListener('input', () => { audio.volume = +vol.value; setRangeFill(vol, vol.value * 100); });

  $('#mini-open').addEventListener('click', () => setTab('music'));
  $('#mini-play').addEventListener('click', togglePlay);
  $('#mini-stop').addEventListener('click', stopPlayer);
}

async function detectMode() {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch('/api/auth', { credentials: 'same-origin', signal: ctl.signal });
    clearTimeout(t);
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) {
      const d = await r.json();
      if (d && d.remote) { S.mode = 'remote'; S.user = d.user || null; return; }
    }
  } catch { /* no API -> local mode */ }
  S.mode = 'local';
  try { const s = JSON.parse(lsGet('mw.session') || 'null'); if (s && (s.role === 'admin' || s.role === 'user')) S.user = s; } catch { /* ignore */ }
}

async function boot() {
  bindStatic();
  await detectMode();
  await loadData();
  if (S.user) { lsSet('mw.session', JSON.stringify(S.user)); showApp(); } else { lsDel('mw.session'); showLogin(); }
  applyTexts();
  const sp = $('#splash'); sp.classList.add('hide'); setTimeout(() => sp.remove(), 600);
}
boot();
