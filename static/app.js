'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const dialog = $('#downloads');

const FORMATS = {
  video: [['mp4', 'MP4'], ['webm', 'WebM'], ['mkv', 'MKV']],
  audio: [['mp3', 'MP3'], ['m4a', 'M4A'], ['opus', 'Opus'], ['aac', 'AAC'], ['wav', 'WAV'], ['flac', 'FLAC']],
};
const AUDIO_SET = new Set(FORMATS.audio.map(([v]) => v));
const BITRATE_FORMATS = new Set(['mp3', 'aac', 'opus']);
const AUDIO_NOTES = {
  m4a: 'Kualitas mengikuti sumber asli.',
  wav: 'Tanpa kompresi, ukuran file besar.',
  flac: 'Lossless, lebih kecil dari WAV.',
};
const HOME_IDEAS = ['lagu indonesia populer', 'tutorial masak nasi goreng', 'podcast teknologi', 'musik lofi untuk belajar'];
const LIVE_TOPICS = ['musik', 'gaming', 'berita', 'podcast', 'olahraga'];   // topik pintas di beranda untuk siaran langsung
// Topik cadangan untuk rekomendasi beranda bila riwayat pencarian masih sedikit (4 pertama sama dengan HOME_IDEAS).
const RECO_DEFAULTS = [...HOME_IDEAS, 'berita terbaru hari ini', 'film pendek indonesia', 'tips belajar bahasa inggris', 'highlight pertandingan sepak bola'];
const RECO_REUSE_MS = 10 * 60 * 1000;   // buka beranda lagi dalam rentang ini: tampilkan rekomendasi yang sama, tanpa memuat ulang
const ACTIVE = new Set(['queued', 'downloading', 'processing']);
const CHANNEL_TABS = [
  { key: 'videos', label: 'Video', empty: 'Channel ini belum punya video.' },
  { key: 'shorts', label: 'Shorts', empty: 'Channel ini tidak punya Shorts.' },
  { key: 'live', label: 'Live', empty: 'Channel ini tidak punya siaran langsung.' },
  { key: 'playlists', label: 'Playlist', empty: 'Channel ini belum punya playlist.' },
];

const state = {
  mode: 'video',
  format: 'mp4',
  quality: '720',
  lastFormat: { video: 'mp4', audio: 'mp3' },
  current: null,     // video yang sedang dibuka (layar "watch")
  activeJobId: null,
  jobs: new Map(),
  saved: new Set(),
  desktop: false,    // server yang menyimpan file ke folder (desktop, atau Android dengan izin penyimpanan)
  embedded: false,   // dibungkus jendela pywebview (Windows)
  android: false,    // berjalan di Termux (Android)
  saveDir: '',
  trim: { on: false, start: '', end: '' },   // pengaturan potong durasi video yang sedang dibuka
  feed: null,        // daftar yang sedang tampil, dipakai untuk memuat bertahap
  chat: false,       // chat siaran langsung tampil di panel samping
  recs: null,        // rekomendasi beranda yang sedang dipakai ulang
};
const stack = [];    // riwayat layar untuk tombol Kembali

/* ---------- Helpers ---------- */
// Membuat elemen lewat DOM (bukan innerHTML) supaya judul dari luar tidak bisa menyisipkan HTML.
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

async function api(path, opts) {
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error('Server tidak bisa dihubungi. Pastikan aplikasi masih berjalan.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Terjadi kesalahan di server.');
  return data;
}

const pad = (n) => String(n).padStart(2, '0');
function fmtDuration(sec) {
  if (!sec) return '';
  sec = Math.round(sec);
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}
const compact = (n) => new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const fmtViews = (n) => (n == null ? '' : `${compact(n)} tontonan`);
const fmtSubs = (n) => (n == null ? '' : `${compact(n)} subscriber`);
const fmtWatching = (n) => (n == null ? '' : `${compact(n)} sedang menonton`);
const fmtSchedule = (ts) => new Intl.DateTimeFormat('id-ID', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ts * 1000));
const fmtBytes = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1).replace('.', ',')} MB`);
const fmtSpeed = (bps) => (bps ? `${(bps / 1048576).toFixed(1).replace('.', ',')} MB/dtk` : '');
const fmtEta = (s) => (s == null ? '' : s >= 60 ? `sisa ${Math.ceil(s / 60)} mnt` : `sisa ${s} dtk`);
const isYouTubeId = (id) => /^[\w-]{11}$/.test(id || '');
const withOffset = (base, offset) => (offset ? `${base}${base.includes('?') ? '&' : '?'}offset=${offset}` : base);

/* ---------- Navigasi: tumpukan layar ---------- */
// Layar: { type: 'home' | 'results' | 'watch' | 'channel' | 'playlist', ... }
function remember() {
  const top = stack.at(-1);
  if (top) top.scrollY = window.scrollY;
}

function push(screen) {            // pindah ke layar baru, layar lama bisa dikembalikan
  ensureAppEntry();
  remember();
  stack.push(screen);
  if (stack.length > 40) stack.shift();
  render(screen);
  window.scrollTo({ top: 0 });
}

function reset(screen) {           // mulai dari awal (pencarian baru, beranda)
  ensureAppEntry();
  stack.length = 0;
  stack.push(screen);
  render(screen);
  window.scrollTo({ top: 0 });
}

/* ---------- Tombol/gestur Kembali milik sistem (Android) ---------- */
// Tonton punya tumpukan layar sendiri, bukan riwayat browser, jadi tanpa ini gestur Kembali di ponsel langsung
// keluar dari Tonton. Dua entri riwayat dipakai terus: [dasar][aplikasi]. Kembali dari [aplikasi] = mundur satu layar.
function ensureAppEntry() {
  try {
    if (history.state?.tonton === 'base') history.pushState({ tonton: 'app' }, '');   // entri aplikasi hilang: buat lagi
  } catch { /* riwayat tidak tersedia */ }
}

// Dipakai pembungkus Android (APK) untuk tombol Kembali sistem. 'handled' = Tonton sendiri yang mundur,
// 'exit' = sudah di beranda, pembungkus boleh menutup aplikasi.
window.tontonBack = () => {
  if (dialog.open) {
    dialog.close();
    return 'handled';
  }
  if (stack.length === 1 && stack[0].type === 'home') return 'exit';
  goBack();
  return 'handled';
};

function initBackButton() {
  try {
    history.replaceState({ tonton: 'base' }, '');
    history.pushState({ tonton: 'app' }, '');
  } catch {
    return;
  }
  window.addEventListener('popstate', () => {
    const atHome = stack.length === 1 && stack[0].type === 'home';
    if (atHome) {
      history.back();                                  // hanya dari beranda: biarkan keluar seperti biasa
      return;
    }
    goBack();                                          // satu layar mundur; dari layar akar (mis. hasil pencarian): ke beranda
    try { history.pushState({ tonton: 'app' }, ''); } catch { /* riwayat tidak tersedia */ }
  });
}

function goBack() {
  if (stack.length <= 1) return showHome();
  stack.pop();
  const screen = stack.at(-1);
  render(screen);
  window.scrollTo({ top: screen.scrollY || 0 });
}

function render(screen) {
  stopObserving();
  cancelAutoNext();
  state.current = screen.type === 'watch' ? screen.item : null;
  state.feed = screen.type === 'channel' ? screen.feeds[screen.tab] : screen.feed || null;
  if (screen.type === 'watch') {
    state.activeJobId = screen.activeJobId || null;
    state.trim = screen.trim ||= { on: false, start: '', end: '' };
  }
  ({ home: renderHome, results: renderResults, watch: renderWatch, channel: renderChannel, playlist: renderPlaylist })[screen.type](screen);
}

/* ---------- Beranda, kartu, pesan ---------- */
function showHome() {
  const recs = recFeed();
  reset({ type: 'home', recs, feed: recs.feed });
}

/* ---------- Rekomendasi beranda ---------- */
// Tanpa login YouTube, "rekomendasi" = hasil pencarian untuk beberapa topik: pencarian terbarumu (riwayat tersimpan di
// komputer ini), diisi topik populer bila riwayat belum cukup. Diatur server di /api/recommend.
const shuffled = (list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function recTopics(shuffle = false) {
  const history = loadHistory();
  const mine = (shuffle ? shuffled(history.slice(0, 12)) : history).slice(0, 3);
  const taken = new Set(mine.map((x) => x.toLowerCase()));
  const fill = (shuffle ? shuffled(RECO_DEFAULTS) : RECO_DEFAULTS).filter((x) => !taken.has(x.toLowerCase()));
  return { topics: [...mine, ...fill].slice(0, 3), personal: mine.length };
}

function recFeed(force = false) {
  const { topics, personal } = recTopics(force);
  const key = topics.join('\n');
  const cur = state.recs;
  if (!force && cur && cur.key === key && !cur.feed.error && Date.now() - cur.at < RECO_REUSE_MS) return cur;
  const query = topics.map((t) => `q=${encodeURIComponent(t)}`).join('&');
  const feed = newFeed((offset) => withOffset(`/api/recommend?${query}`, offset), {
    emptyText: 'Belum ada rekomendasi. Coba cari sesuatu dulu.',
    doneText: 'Itu semua rekomendasi untuk saat ini.',
  });
  return (state.recs = { key, topics, personal, feed, at: Date.now() });
}

const recsNote = (r) => (r.personal
  ? `Berdasarkan pencarianmu: ${r.topics.slice(0, r.personal).join(', ')}${r.personal < r.topics.length ? ', dan topik populer' : ''}.`
  : 'Topik populer untuk memulai. Makin sering kamu mencari, makin pas rekomendasinya.');

function refreshRecs(screen) {
  const recs = recFeed(true);
  screen.recs = recs;
  screen.feed = recs.feed;
  render(screen);
  const head = $('.recs');
  if (head && head.getBoundingClientRect().top < 0) head.scrollIntoView?.({ block: 'start' });   // jangan tertinggal di bawah
}

function renderHome(screen) {
  const { recs } = screen;
  view.replaceChildren(
    h('section', { class: 'home' },
      h('h1', {}, 'Cari video, simpan dalam format yang kamu mau.'),
      h('p', {}, 'Ketik kata kunci atau tempel tautan video. Setelah video terbuka, pilih MP4, MP3, atau format lain lalu unduh.'),
      h('div', { class: 'suggest' },
        HOME_IDEAS.map((s) => h('button', { class: 'chip', type: 'button', 'aria-checked': 'false', onclick: () => { $('#q').value = s; runSearch(s); } }, s)),
      ),
      h('div', { class: 'live-row' },
        h('h2', { class: 'home-sub' }, 'Sedang live sekarang'),
        h('div', { class: 'suggest' },
          LIVE_TOPICS.map((t) => h('button', { class: 'chip live-chip', type: 'button', 'aria-checked': 'false', onclick: () => { $('#q').value = t; runSearch(t, { live: true }); } }, t)),
        ),
      ),
    ),
    h('section', { class: 'recs', 'aria-labelledby': 'recs-title' },
      h('div', { class: 'recs-head' },
        h('div', {},
          h('h2', { id: 'recs-title' }, 'Rekomendasi untukmu'),
          h('p', { class: 'recs-sub' }, recsNote(recs)),
        ),
        h('button', { class: 'ghost', type: 'button', onclick: () => refreshRecs(screen) }, 'Segarkan'),
      ),
      ...feedBody(recs.feed),
    ),
  );
  paintGrid(recs.feed);
  renderMore(recs.feed);
  if (!recs.feed.started && !recs.feed.loading) loadMore(recs.feed);
}

function message(title, text, action) {
  return h('section', { class: 'message', role: 'alert' },
    h('h2', {}, title),
    h('p', {}, text),
    action ? h('button', { class: 'ghost', type: 'button', onclick: action.run }, action.label) : null,
  );
}

const skeletonCards = (n = 8) =>
  Array.from({ length: n }, () =>
    h('div', { class: 'card skeleton' }, h('span', { class: 'thumb' }), h('div', { class: 'line' }), h('div', { class: 'line short' })));

// Nama pembuat konten yang bisa diklik untuk membuka halaman channel-nya.
function channelLink(src) {
  const name = src.channel || src.name;
  if (!name) return null;
  if (!(src.channel_id || src.channel_url)) return name;
  return h('button', { class: 'chan', type: 'button', onclick: (e) => { e.stopPropagation(); openChannel(src); } }, name);
}

function cardMeta(item, hideChannel) {
  let stats;
  if (item.kind === 'playlist') stats = item.count ? `${item.count} video` : '';
  else if (item.live_status === 'live') stats = fmtWatching(item.views);
  else if (item.live_status === 'upcoming') stats = item.scheduled ? `Mulai ${fmtSchedule(item.scheduled)}` : 'Belum dimulai';
  else stats = fmtViews(item.views);
  const link = hideChannel ? null : channelLink(item);
  return [link, link && stats ? ', ' : null, stats || null].filter(Boolean);
}

function videoCard(item, { hideChannel = false, items = null } = {}) {   // items: daftar asal kartu ini (untuk "Berikutnya")
  const open = item.kind === 'playlist' ? () => openPlaylist(item) : item.kind === 'channel' ? () => openChannel(item) : () => openVideo(item, items);
  const live = item.kind === 'video' ? item.live_status : null;
  const badge = item.kind === 'playlist' ? 'Playlist'
    : live === 'live' ? 'LIVE' : live === 'upcoming' ? 'Dijadwalkan'
    : item.short ? 'Shorts' : fmtDuration(item.duration);
  return h('div', { class: 'card' },
    h('button', { class: 'card-open', type: 'button', onclick: open },
      h('span', { class: 'thumb' },
        item.thumbnail ? h('img', { src: item.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
        badge ? h('span', { class: `dur${live === 'live' ? ' live' : ''}` }, badge) : null,
      ),
      h('span', { class: 'card-title' }, item.title),
    ),
    h('p', { class: 'card-meta' }, ...cardMeta(item, hideChannel)),
  );
}

function avatar(url, name, cls = 'avatar') {
  const initial = h('span', { class: cls }, (name || '?').trim().charAt(0).toUpperCase());
  if (!url) return initial;
  const img = h('img', { class: cls, src: url, alt: '', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(initial));
  return img;
}

/* ---------- Daftar yang dimuat bertahap (hasil pencarian, isi channel, isi playlist) ---------- */
let moreObserver = null;

function stopObserving() {
  moreObserver?.disconnect();
  moreObserver = null;
}

const newFeed = (urlFor, extra = {}) => ({
  urlFor, items: [], seen: new Set(), nextOffset: 0, loading: false, error: null, started: false,
  emptyText: 'Belum ada video.', doneText: 'Itu semua yang tersedia.', hideChannel: false, ...extra,
});

// Menambahkan hasil baru tanpa duplikat; mengembalikan hanya yang benar-benar baru.
function addItems(feed, data) {
  const fresh = data.items.filter((item) => {
    const key = item.id || item.url;
    if (feed.seen.has(key)) return false;
    feed.seen.add(key);
    return true;
  });
  feed.items.push(...fresh);
  feed.nextOffset = data.next_offset ?? null;
  return fresh;
}

// grid + teks kosong + area "muat lebih banyak"; isinya diisi oleh paintGrid dan renderMore
const feedBody = (feed) => [
  h('div', { class: 'grid', id: 'grid' }),
  h('p', { class: 'empty', id: 'empty', hidden: true }, feed.emptyText),
  h('div', { class: 'more', id: 'more' }),
];

function paintGrid(feed, fresh) {
  if (state.feed !== feed) return;
  const grid = $('#grid');
  if (!grid) return;
  const waiting = !feed.items.length && !feed.error && (feed.loading || !feed.started);
  if (fresh && !waiting) grid.append(...fresh.map((it) => videoCard(it, feed)));
  else grid.replaceChildren(...(waiting ? skeletonCards() : feed.items.map((it) => videoCard(it, feed))));
  grid.setAttribute('aria-busy', String(waiting));
  const empty = $('#empty');
  if (empty) empty.hidden = !(feed.started && !feed.items.length && !feed.loading && !feed.error);
}

// Bagian di bawah grid: status memuat, tombol muat lagi, atau penanda selesai.
function renderMore(feed) {
  const box = $('#more');
  if (!box || state.feed !== feed) return;
  let content = [];
  if (feed.error) {
    content = [
      h('p', { class: 'more-note error', role: 'alert' }, feed.error),
      h('button', { class: 'ghost', type: 'button', onclick: () => loadMore(feed) }, 'Coba lagi'),
    ];
  } else if (feed.loading) {
    if (feed.items.length) content = [h('p', { class: 'more-note', role: 'status' }, 'Memuat video lainnya...')];
  } else if (feed.started && feed.nextOffset != null) {
    content = [h('button', { class: 'ghost', type: 'button', onclick: () => loadMore(feed) }, 'Muat lebih banyak')];
  } else if (feed.started && feed.items.length) {
    content = [h('p', { class: 'more-note' }, feed.doneText)];
  }
  box.replaceChildren(...content);
  observeMore(feed);
}

// Muat otomatis saat bagian bawah mendekati layar. Tombol "Muat lebih banyak" tetap ada sebagai cadangan.
function observeMore(feed) {
  stopObserving();
  const target = $('#more');
  if (state.feed !== feed || !target || feed.loading || feed.error || !feed.started || feed.nextOffset == null) return;
  if (!('IntersectionObserver' in window)) return;
  moreObserver = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) loadMore(feed);
  }, { rootMargin: '600px 0px' });
  moreObserver.observe(target);
}

async function loadMore(feed) {
  if (!feed || feed.loading || feed.nextOffset == null) return;
  const wasEmpty = !feed.items.length;
  feed.loading = true;
  feed.error = null;
  if (wasEmpty) paintGrid(feed);                      // percobaan ulang setelah gagal: kerangka memuat tampil lagi
  renderMore(feed);
  try {
    const data = await api(feed.urlFor(feed.nextOffset));
    feed.started = true;
    feed.onData?.(data);
    const fresh = addItems(feed, data);               // tetap dicatat walau pengguna sudah pindah layar
    paintGrid(feed, wasEmpty ? undefined : fresh);
    feed.afterPaint?.();
  } catch (err) {
    feed.error = err.message;
  } finally {
    feed.loading = false;
    if (!feed.items.length) paintGrid(feed);          // lepas kerangka memuat: tampilkan teks kosong
    renderMore(feed);                                 // juga memasang ulang pengamat bila masih terlihat
  }
}

/* ---------- Hasil pencarian ---------- */
const headText = (feed) => {
  if (!feed.started) return `Mencari "${feed.q}"...`;
  return feed.live ? `Siaran langsung untuk "${feed.q}", ${feed.items.length} siaran` : `Hasil untuk "${feed.q}", ${feed.items.length} video`;
};

// Pilihan Semua / Sedang live untuk kata kunci yang sama.
function liveFilter(feed) {
  return h('div', { class: 'filters', role: 'radiogroup', 'aria-label': 'Jenis hasil' },
    chip('Semua', !feed.live, () => { if (feed.live) runSearch(feed.q); }),
    chip('Sedang live', !!feed.live, () => { if (!feed.live) runSearch(feed.q, { live: true }); }),
  );
}

function renderResults(screen) {
  const feed = screen.feed;
  if (feed.started && !feed.items.length) {
    view.replaceChildren(feed.live
      ? message(`Tidak ada siaran langsung untuk "${feed.q}"`, 'Belum ada yang sedang tayang untuk kata kunci ini. Coba kata kunci lain, atau lihat semua hasilnya.', { label: 'Lihat semua hasil', run: () => runSearch(feed.q) })
      : message(`Tidak ada hasil untuk "${feed.q}"`, 'Coba kata kunci lain, atau tempel tautan video langsung.'));
    return;
  }
  view.replaceChildren(
    ...[
      h('p', { class: 'results-head', id: 'results-head' }, headText(feed)),
      liveFilter(feed),
      screen.creators?.length ? creatorStrip(screen.creators, feed.live) : null,
      ...feedBody(feed),
    ].filter(Boolean),
  );
  paintGrid(feed);
  renderMore(feed);
}

async function runSearch(q, { live = false } = {}) {
  closeSuggest();
  rememberQuery(q);
  const feed = newFeed((offset) => withOffset(`/api/search?q=${encodeURIComponent(q)}${live ? '&live=1' : ''}`, offset), {
    q, live, doneText: live ? 'Itu semua siaran langsung yang tersedia untuk pencarian ini.' : 'Itu semua hasil yang tersedia untuk pencarian ini.',
    emptyText: live ? 'Belum ada siaran langsung.' : 'Belum ada video.',
  });
  feed.afterPaint = () => {
    const head = $('#results-head');
    if (head) head.textContent = headText(feed);
  };
  const screen = { type: 'results', feed, creators: [] };
  feed.loading = true;
  reset(screen);
  try {
    const data = await api(feed.urlFor(0));
    feed.loading = false;
    feed.started = true;
    if (data.kind === 'video') {                     // tautan langsung: buka videonya
      if (stack.at(-1) === screen) reset({ type: 'watch', item: data.item, activeJobId: null });
      return;
    }
    addItems(feed, data);
    screen.creators = creatorsFor(q, feed.items);
    if (stack.at(-1) === screen) renderResults(screen);
  } catch (err) {
    feed.loading = false;
    if (stack.at(-1) === screen) {
      view.replaceChildren(message('Pencarian gagal', err.message, { label: 'Coba lagi', run: () => runSearch(q, { live }) }));
    }
  }
}

/* ---------- Kreator yang cocok dengan pencarian ---------- */
const normName = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Jarak sunting; dua huruf bertukar tempat (mis. "cobruzier" vs "corbuzier") dihitung satu kesalahan.
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function tokenMatches(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4) return false;                 // kata pendek harus persis sama
  if (a.startsWith(b) || b.startsWith(a)) return true;
  return editDistance(a, b) <= (Math.max(a.length, b.length) >= 6 ? 2 : 1);
}

// Menebak kreator dari hasil pencarian: channel yang namanya mirip kata kunci (toleran salah ketik).
function creatorsFor(q, items) {
  const wanted = normName(q).split(' ').filter((t) => t.length >= 2);
  if (!wanted.length) return [];
  const groups = new Map();
  for (const it of items) {
    if (!it.channel || !(it.channel_id || it.channel_url)) continue;
    const key = it.channel_id || it.channel_url;
    const g = groups.get(key) || { name: it.channel, channel_id: it.channel_id, channel_url: it.channel_url, count: 0 };
    g.count += 1;
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => {
      const words = normName(g.name).split(' ').filter(Boolean);
      const hits = wanted.filter((t) => words.some((w) => tokenMatches(t, w))).length;
      return { ...g, score: hits / wanted.length };
    })
    .filter((g) => g.score >= 0.5)
    .sort((a, b) => b.score - a.score || b.count - a.count)
    .slice(0, 4);
}

function creatorStrip(creators, live = false) {
  return h('div', { class: 'creators' },
    creators.map((c) =>
      h('button', { class: 'creator', type: 'button', onclick: () => openChannel(c) },
        avatar(null, c.name, 'avatar sm'),
        h('span', { class: 'creator-text' },
          h('span', { class: 'creator-name' }, c.name),
          h('span', { class: 'creator-sub' }, live ? 'Sedang live' : 'Lihat semua video'),
        ),
      )),
  );
}

/* ---------- Halaman channel ---------- */
function openChannel(src) {
  const ref = src.channel_id || src.channel_url;
  if (!ref) return;
  const top = stack.at(-1);
  if (top?.type === 'channel' && top.ref === ref) return;
  const screen = { type: 'channel', ref, name: src.channel || src.name || '', meta: null, tab: 'videos', feeds: {} };
  for (const tab of CHANNEL_TABS) {
    const feed = newFeed((offset) => withOffset(`/api/channel?ref=${encodeURIComponent(ref)}&tab=${tab.key}`, offset), {
      emptyText: tab.empty, hideChannel: true,
    });
    feed.onData = (data) => {
      if (data.channel && !screen.meta) {
        screen.meta = data.channel;
        paintChannelHead(screen);
      }
      if (tab.key === 'live') noteLive(screen, data);
    };
    screen.feeds[tab.key] = feed;
  }
  push(screen);
  // Tab Live dimuat di latar belakang supaya langsung ketahuan kalau creator ini sedang tayang.
  loadMore(screen.feeds.live);
}

// Mencatat siaran yang sedang tayang dari channel ini, lalu menampilkannya di kepala halaman dan tab Live.
function noteLive(screen, data) {
  const known = screen.liveNow || [];
  const fresh = data.items.filter((it) => it.live_status === 'live' && !known.some((x) => x.id === it.id));
  if (!fresh.length) return;
  screen.liveNow = [...known, ...fresh];
  paintChannelHead(screen);
  paintTabs(screen);
}

function paintTabs(screen) {
  const box = $('#channel-tabs');
  if (!box || stack.at(-1) !== screen) return;
  box.replaceChildren(...CHANNEL_TABS.map((t) =>
    h('button', { type: 'button', role: 'tab', 'aria-selected': String(screen.tab === t.key), onclick: () => switchTab(screen, t.key) },
      t.label,
      t.key === 'live' && screen.liveNow?.length ? h('span', { class: 'tab-live', role: 'img', 'aria-label': 'sedang live' }) : null,
    )));
}

function paintChannelHead(screen) {
  const box = $('#channel-head');
  if (!box || stack.at(-1) !== screen) return;
  const meta = screen.meta || {};
  const name = meta.name || screen.name || 'Channel';
  const subs = [meta.handle, meta.followers != null ? fmtSubs(meta.followers) : null].filter(Boolean).join(', ');
  box.replaceChildren(
    ...[
      meta.banner ? h('div', { class: 'chan-banner' }, h('img', { src: meta.banner, alt: '', referrerpolicy: 'no-referrer' })) : null,
      h('div', { class: 'chan-head' },
        avatar(meta.avatar, name),
        h('div', { class: 'chan-info' },
          h('h1', {}, name),
          subs ? h('p', { class: 'chan-sub' }, subs) : null,
          meta.description ? h('details', { class: 'chan-about' }, h('summary', {}, 'Tentang channel'), h('p', {}, meta.description)) : null,
        ),
      ),
      ...(screen.liveNow || []).slice(0, 3).map((it) =>
        h('button', { class: 'live-now', type: 'button', onclick: () => openVideo(it) },
          h('span', { class: 'live-pill' }, 'LIVE'),
          h('span', { class: 'live-now-title' }, it.title),
          it.views != null ? h('span', { class: 'live-now-meta' }, fmtWatching(it.views)) : null,
        )),
    ].filter(Boolean),
  );
}

function renderChannel(screen) {
  const feed = screen.feeds[screen.tab];
  view.replaceChildren(
    h('section', { class: 'channel' },
      h('button', { class: 'back', type: 'button', onclick: goBack }, 'Kembali'),
      h('div', { id: 'channel-head' }),
      h('div', { class: 'tabs', id: 'channel-tabs', role: 'tablist', 'aria-label': 'Isi channel' }),
      ...feedBody(feed),
    ),
  );
  paintTabs(screen);
  paintChannelHead(screen);
  paintGrid(feed);
  renderMore(feed);
  if (!feed.started && !feed.loading) loadMore(feed);
}

function switchTab(screen, key) {
  if (screen.tab === key) return;
  screen.tab = key;
  render(screen);
  window.scrollTo({ top: 0 });
}

/* ---------- Halaman playlist ---------- */
function openPlaylist(item) {
  const ref = item.id || item.url;
  const feed = newFeed((offset) => withOffset(`/api/playlist?ref=${encodeURIComponent(ref)}`, offset), { emptyText: 'Playlist ini kosong.' });
  const screen = { type: 'playlist', ref, title: item.title, meta: null, feed };
  feed.onData = (data) => {
    if (data.playlist) {
      screen.meta = data.playlist;
      paintPlaylistHead(screen);
    }
  };
  push(screen);
}

function paintPlaylistHead(screen) {
  const box = $('#playlist-head');
  if (!box || stack.at(-1) !== screen) return;
  const meta = screen.meta || {};
  const link = channelLink({ name: meta.channel, channel_id: meta.channel_id });
  box.replaceChildren(
    ...[
      h('h1', { class: 'pl-title' }, meta.title || screen.title || 'Playlist'),
      h('p', { class: 'chan-sub' }, ...[link, link && meta.count ? ', ' : null, meta.count ? `${meta.count} video` : null].filter(Boolean)),
    ].filter(Boolean),
  );
}

function renderPlaylist(screen) {
  const feed = screen.feed;
  view.replaceChildren(
    h('section', { class: 'channel' },
      h('button', { class: 'back', type: 'button', onclick: goBack }, 'Kembali'),
      h('div', { id: 'playlist-head' }),
      ...feedBody(feed),
    ),
  );
  paintPlaylistHead(screen);
  paintGrid(feed);
  renderMore(feed);
  if (!feed.started && !feed.loading) loadMore(feed);
}

/* ---------- Halaman tonton ---------- */
async function openVideo(item, queue = null) {
  push({ type: 'watch', item, activeJobId: null, queue });
  if (!item.heights) await loadInfo(item);
}

async function loadInfo(item) {
  try {
    Object.assign(item, await api(`/api/info?url=${encodeURIComponent(item.url)}`));
  } catch {
    item.heights = [];
  }
  if (state.current === item) {
    renderByline();
    renderPanel();
    renderAbout();
    renderPlayerNote();
    renderNextUp();
  }
}

// Nama channel (bisa diklik) + jumlah tontonan di bawah judul video.
function renderByline() {
  const box = $('#watch-byline');
  const item = state.current;
  if (!box || !item) return;
  const canOpen = item.channel && (item.channel_id || item.channel_url);
  box.replaceChildren(
    ...[
      item.live_status === 'live' ? h('span', { class: 'live-pill' }, 'LIVE') : null,
      item.live_status === 'upcoming' ? h('span', { class: 'live-pill soon' }, 'Dijadwalkan') : null,
      h('p', { class: 'watch-meta' }, ...cardMeta(item, false)),
      canOpen ? h('button', { class: 'ghost', type: 'button', onclick: () => openChannel(item) }, 'Buka channel') : null,
    ].filter(Boolean),
  );
}

function renderWatch() {
  const item = state.current;
  const canEmbed = item.youtube && isYouTubeId(item.id);
  const player = canEmbed
    ? h('iframe', {
        src: `https://www.youtube-nocookie.com/embed/${item.id}?autoplay=1&rel=0&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`,
        title: item.title,
        allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
        allowfullscreen: true,
        referrerpolicy: 'strict-origin-when-cross-origin',
      })
    : h('div', { class: 'no-embed' },
        item.thumbnail ? h('img', { src: item.thumbnail, alt: '', referrerpolicy: 'no-referrer' }) : null,
        h('p', {}, 'Pratinjau hanya tersedia untuk video YouTube. Unduhan tetap bisa dipakai.'),
      );

  view.replaceChildren(
    h('section', { class: 'watch' },
      h('div', {},
        h('button', { class: 'back', type: 'button', onclick: goBack }, 'Kembali'),
        h('div', { class: 'player' }, player),
        h('div', { class: 'notice', id: 'player-note', hidden: true }),
        h('div', { class: 'next-up', id: 'next-up', hidden: true }),
        h('h1', { class: 'watch-title' }, item.title),
        h('div', { class: 'watch-byline', id: 'watch-byline' }),
        h('div', { id: 'about', class: 'about', hidden: true }),
      ),
      h('aside', { class: 'panel', id: 'panel' }),
    ),
  );
  renderByline();
  renderPanel();
  renderAbout();
  renderPlayerNote();
  renderNextUp();
  if (canEmbed) watchForEnd($('.player iframe'), item);
}

/* ---------- Lanjut ke video berikutnya ---------- */
const AUTOPLAY_KEY = 'tonton.autoplay';
const NEXT_DELAY = 5;   // detik hitung mundur sebelum berpindah otomatis
let autoNext = null;    // hitung mundur yang sedang berjalan: { box, timer }
let ytApi = null;

function autoplayOn() {
  try {
    return localStorage.getItem(AUTOPLAY_KEY) !== '0';   // bawaan: aktif
  } catch {
    return true;
  }
}

function setAutoplay(on) {
  try { localStorage.setItem(AUTOPLAY_KEY, on ? '1' : '0'); } catch { /* penyimpanan tidak tersedia: berlaku sesi ini saja */ }
  if (!on) cancelAutoNext();
}

const currentWatch = () => (stack.at(-1)?.type === 'watch' ? stack.at(-1) : null);

// Video yang diputar sesudah video ini: yang berikutnya di daftar tempat video dibuka (rekomendasi beranda, hasil
// pencarian, channel, playlist). Habis atau dibuka dari tautan: ambil dari rekomendasi beranda.
function nextUp(screen) {
  const cur = screen?.item;
  if (!cur) return null;
  const playable = (x) => x.kind === 'video' && x.youtube && isYouTubeId(x.id) && x.id !== cur.id
    && x.live_status !== 'upcoming' && (cur.short || !x.short);   // Shorts hanya mengikuti Shorts
  for (const list of [screen.queue, state.recs?.feed.items]) {
    if (!list) continue;
    const next = list.slice(list.findIndex((x) => x.id === cur.id) + 1).find(playable);   // tidak ketemu: dari awal
    if (next) return { item: next, list };
  }
  return null;
}

function renderNextUp() {
  const box = $('#next-up');
  const screen = currentWatch();
  if (!box || !screen) return;
  const next = nextUp(screen);
  box.hidden = !next;
  if (!next) return box.replaceChildren();
  const { item } = next;
  box.replaceChildren(
    h('button', { class: 'next-card', type: 'button', onclick: () => playNext(next), 'aria-label': `Putar sekarang: ${item.title}` },
      h('span', { class: 'next-thumb' }, item.thumbnail ? h('img', { src: item.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null),
      h('span', { class: 'next-text' },
        h('span', { class: 'next-label' }, 'Berikutnya'),
        h('span', { class: 'next-title' }, item.title),
        h('span', { class: 'next-meta' }, ...cardMeta(item, false).map((p) => (typeof p === 'string' ? p : p.textContent))),
      ),
    ),
    h('label', { class: 'trim-toggle autoplay-toggle' },
      h('input', { type: 'checkbox', id: 'autoplay', checked: autoplayOn(), onchange: (e) => setAutoplay(e.target.checked) }),
      h('span', {}, 'Putar otomatis'),
    ),
  );
}

function cancelAutoNext() {
  if (!autoNext) return;
  clearInterval(autoNext.timer);
  autoNext.box.remove();
  autoNext = null;
}

// Berpindah ke video berikutnya. Layar tonton diganti (bukan ditumpuk) supaya "Kembali" tetap ke daftar asal.
function playNext(next) {
  cancelAutoNext();
  const screen = { type: 'watch', item: next.item, activeJobId: null, queue: next.list };
  if (currentWatch()) stack[stack.length - 1] = screen;
  else stack.push(screen);
  render(screen);
  window.scrollTo({ top: 0 });
  if (!next.item.heights) loadInfo(next.item);
}

// Video selesai: tampilkan hitung mundur di atas pemutar (menutup layar akhir YouTube).
function onVideoEnded(item) {
  const screen = currentWatch();
  const holder = $('.player');
  if (!screen || screen.item !== item || !holder || !autoplayOn()) return;
  const next = nextUp(screen);
  if (!next) return;
  cancelAutoNext();
  let left = NEXT_DELAY;
  const count = h('span', {}, String(left));
  const box = h('div', { class: 'end-card', role: 'group', 'aria-label': 'Video berikutnya' },
    h('div', { class: 'end-inner' },
      h('p', { class: 'end-label' }, 'Berikutnya dalam ', count, ' detik'),
      h('p', { class: 'end-title' }, next.item.title),
      h('div', { class: 'end-actions' },
        h('button', { class: 'end-go', type: 'button', onclick: () => playNext(next) }, 'Putar sekarang'),
        h('button', { class: 'ghost', type: 'button', onclick: cancelAutoNext }, 'Batal'),
      ),
    ),
  );
  holder.append(box);
  autoNext = {
    box,
    timer: setInterval(() => {
      left -= 1;
      if (left <= 0) playNext(next);
      else count.textContent = String(left);
    }, 1000),
  };
}

// IFrame API resmi YouTube dipakai hanya untuk tahu kapan video selesai. Bila skrip tidak bisa dimuat,
// pemutar tetap berjalan seperti biasa dan kartu "Berikutnya" tetap bisa dipakai manual.
function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  ytApi ||= new Promise((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { previous?.(); resolve(window.YT); };
    const script = h('script', { src: 'https://www.youtube.com/iframe_api' });
    script.addEventListener('error', () => { ytApi = null; resolve(null); });
    document.head.append(script);
  });
  return ytApi;
}

function watchForEnd(iframe, item) {
  loadYouTubeApi().then((YT) => {
    if (!YT?.Player || !iframe?.isConnected) return;
    try {
      new YT.Player(iframe, {
        events: {
          onStateChange: (e) => {
            if (e.data === (YT.PlayerState?.ENDED ?? 0) && iframe.isConnected && state.current === item) onVideoEnded(item);
          },
        },
      });
    } catch { /* tanpa deteksi selesai: hanya kartu "Berikutnya" manual */ }
  });
}

/* ---------- Panel samping: unduh (video biasa) atau info siaran langsung ---------- */
function renderPanel() {
  const panel = $('#panel');
  const item = state.current;
  if (!panel || !item) return;
  if (item.live_status) {                           // sedang tayang / terjadwal: tidak ada yang bisa diunduh
    panel.setAttribute('aria-label', 'Siaran langsung');
    panel.replaceChildren(...livePanel(item));
    return;
  }
  panel.setAttribute('aria-label', 'Unduh video');
  if (!$('#options')) {                             // baru berpindah dari panel live, atau render pertama
    panel.replaceChildren(
      h('h2', {}, 'Simpan video ini'),
      h('div', { id: 'options' }),
      h('div', { id: 'status', role: 'status', 'aria-live': 'polite' }),
    );
  }
  renderOptions();
  renderStatus();
}

const chatUrl = (id) => `https://www.youtube.com/live_chat?v=${encodeURIComponent(id)}&embed_domain=${encodeURIComponent(location.hostname)}`;

function livePanel(item) {
  const upcoming = item.live_status === 'upcoming';
  const canChat = !upcoming && item.youtube && isYouTubeId(item.id);
  const note = upcoming
    ? `Siaran ini belum dimulai${item.scheduled ? `: ${fmtSchedule(item.scheduled)}` : ''}. Unduhan baru tersedia setelah siarannya selesai.`
    : 'Siaran ini sedang berlangsung, jadi belum bisa diunduh. Setelah selesai, buka lagi videonya di sini untuk mengunduh rekamannya.';
  return [
    h('h2', {}, upcoming ? 'Siaran dijadwalkan' : 'Siaran langsung'),
    h('p', { class: 'live-note' }, note),
    canChat
      ? h('button', { class: 'ghost wide', type: 'button', 'aria-expanded': String(state.chat), onclick: () => { state.chat = !state.chat; renderPanel(); } },
          state.chat ? 'Sembunyikan chat' : 'Tampilkan chat')
      : null,
    canChat && state.chat
      ? h('iframe', { class: 'chat-frame', src: chatUrl(item.id), title: 'Chat siaran langsung', referrerpolicy: 'strict-origin-when-cross-origin' })
      : null,
    canChat && state.chat
      ? h('p', { class: 'note' }, 'Chat dimuat dari youtube.com. Kalau kosong, pemilik siaran mungkin membatasinya.')
      : null,
  ].filter(Boolean);   // replaceChildren mengubah null menjadi teks "null"; h() sudah menyaringnya sendiri
}

// Pemilik video bisa mematikan pemutaran di luar YouTube (sering pada siaran langsung). Beri jalan keluar.
function renderPlayerNote() {
  const box = $('#player-note');
  const item = state.current;
  if (!box || !item) return;
  const blocked = item.youtube && isYouTubeId(item.id) && item.embeddable === false;
  box.hidden = !blocked;
  box.replaceChildren(...(blocked
    ? [
        h('p', {}, 'Pemilik video ini mematikan pemutaran di luar YouTube, jadi pemutar di atas kemungkinan kosong.'),
        h('button', { class: 'ghost', type: 'button', onclick: () => openOnYouTube(item) }, 'Buka di YouTube'),
      ]
    : []));
}

async function openOnYouTube(item) {
  const url = `https://www.youtube.com/watch?v=${item.id}`;
  if (window.TontonAndroid?.openUrl) return void window.TontonAndroid.openUrl(url);   // pembungkus APK: dibuka di aplikasi/browser HP
  if (!state.embedded) return void window.open(url, '_blank', 'noopener');
  try {
    await api('/api/open-youtube', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }) });
  } catch (err) {
    $('#player-note')?.append(h('p', { class: 'job-line error' }, err.message));
  }
}

function renderAbout() {
  const box = $('#about');
  if (!box) return;
  const text = (state.current.description || '').trim();
  box.hidden = !text;
  box.replaceChildren(...(text ? [h('details', {}, h('summary', {}, 'Deskripsi'), h('p', {}, text))] : []));
}

/* ---------- Panel unduh ---------- */
function qualityChoices() {
  if (state.mode === 'video') {
    const heights = state.current?.heights || [];
    const opts = [['best', 'Terbaik']];
    const tallest = Math.max(0, ...heights);
    for (const v of [1080, 720, 480, 360]) {
      // Tawarkan resolusi hanya bila ada format pada/di bawahnya dan tidak melebihi resolusi tertinggi.
      // Tanpa ini, memilih 360p pada video 720p+ diam-diam akan mengunduh resolusi lebih tinggi.
      const reachable = heights.some((x) => x <= v * 1.05) && v <= tallest * 1.05;
      if (!heights.length || reachable) opts.push([String(v), `${v}p`]);
    }
    return opts;
  }
  return BITRATE_FORMATS.has(state.format) ? ['128', '192', '256', '320'].map((b) => [b, `${b} kbps`]) : [];
}

function ensureQuality() {
  const choices = qualityChoices();
  if (!choices.length) return (state.quality = '');
  if (choices.some(([v]) => v === state.quality)) return;
  state.quality = state.mode === 'video'
    ? (choices.some(([v]) => v === '720') ? '720' : 'best')
    : '192';
}

function qualityLabel() {
  const found = qualityChoices().find(([v]) => v === state.quality);
  return found ? (found[0] === 'best' ? 'terbaik' : found[1]) : '';
}

function isBusy() {
  const job = state.jobs.get(state.activeJobId);
  return !!job && ACTIVE.has(job.status);
}

function chip(label, selected, onclick) {
  return h('button', { class: 'chip', type: 'button', role: 'radio', 'aria-checked': String(selected), onclick }, label);
}

function setMode(mode) {
  state.lastFormat[state.mode] = state.format;
  state.mode = mode;
  state.format = state.lastFormat[mode];
  renderOptions();
}

/* ---------- Potong durasi ---------- */
// "90" = 90 detik, "1:30" = 1 menit 30 detik, "1:02:03" = 1 jam 2 menit 3 detik. Kosong = null, tidak valid = NaN.
function parseClock(text) {
  const t = String(text ?? '').trim().replace(',', '.');
  if (!t) return null;
  if (!/^\d+(\.\d+)?$/.test(t) && !/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(t)) return NaN;
  const parts = t.split(':').map(Number);
  if (parts.length > 1 && parts.slice(1).some((n) => n >= 60)) return NaN;           // detik (dan menit pada format jam) harus 0-59
  return parts.reduce((total, n) => total * 60 + n, 0);
}

function fmtClock(sec) {
  const whole = Math.floor(sec);
  const frac = sec - whole;
  const hh = Math.floor(whole / 3600), mm = Math.floor((whole % 3600) / 60), ss = whole % 60;
  const tail = frac >= 0.05 ? `.${Math.round(frac * 10)}` : '';
  return `${hh ? `${hh}:${pad(mm)}` : mm}:${pad(ss)}${tail}`;
}

// Memeriksa isian waktu. Hasil: { on, ok, whole?, start?, end?, length?, error? }
//   whole = seluruh video (tidak ada yang dipotong); end = null berarti sampai akhir video.
function validateTrim() {
  const t = state.trim;
  if (!t?.on) return { on: false, ok: true };
  const duration = state.current?.duration || null;
  const s = parseClock(t.start);
  const e = parseClock(t.end);
  const bad = (error) => ({ on: true, ok: false, error });
  if (Number.isNaN(s) || Number.isNaN(e)) {
    return bad('Tulis waktu sebagai menit:detik, misalnya 1:30. Boleh juga jam:menit:detik atau detik saja.');
  }
  const start = s ?? 0;
  const end = e ?? null;
  if (duration && start >= duration) return bad(`Waktu mulai harus sebelum akhir video (${fmtClock(duration)}).`);
  if (duration && end != null && end > duration + 0.5) return bad(`Waktu selesai melebihi durasi video (${fmtClock(duration)}).`);
  if (end != null && end - start < 1) return bad('Waktu selesai harus setidaknya 1 detik setelah waktu mulai.');

  const toEnd = end == null || (duration && end >= duration - 0.5);      // sampai akhir video
  if (start === 0 && toEnd) return { on: true, ok: true, whole: true };
  const finish = toEnd ? duration : end;
  return { on: true, ok: true, start, end: toEnd ? null : end, length: finish != null ? finish - start : null };
}

function trimSummary(v) {
  const duration = state.current?.duration || null;
  if (!v.ok) return '';
  if (v.whole) return 'Seluruh video akan diunduh.';
  if (v.length != null) return `Hasil ${fmtClock(v.length)}${duration ? ` dari ${fmtClock(duration)}` : ''}`;
  return `Dari ${fmtClock(v.start)} sampai akhir video`;
}

// Memperbarui bagian yang bergantung pada isian, tanpa membuat ulang kolom (fokus ketikan tidak hilang).
function updateTrimUi() {
  const v = validateTrim();
  const duration = state.current?.duration || null;
  const summary = $('#trim-summary');
  if (summary) summary.textContent = trimSummary(v);
  const err = $('#trim-error');
  if (err) {
    err.hidden = v.ok;
    err.textContent = v.ok ? '' : v.error;
  }
  for (const id of ['trim-start', 'trim-end']) $(`#${id}`)?.setAttribute('aria-invalid', String(!v.ok));
  const range = $('#trim-range');
  if (range && duration) {
    const from = v.ok && !v.whole ? v.start : 0;
    const to = v.ok && !v.whole ? (v.end ?? duration) : duration;
    range.style.left = `${Math.min(100, (from / duration) * 100)}%`;
    range.style.width = `${Math.max(0, Math.min(100, ((to - from) / duration) * 100))}%`;
  }
  syncGoButton();
}

function goLabel() {
  const v = validateTrim();
  const detail = [state.format.toUpperCase(), qualityLabel()].filter(Boolean).join(' ');
  return `Unduh ${v.ok && v.on && !v.whole ? 'potongan ' : ''}${detail}`;
}

function syncGoButton() {
  const go = $('#options .primary');
  if (!go) return;
  const busy = isBusy();
  go.disabled = busy || !validateTrim().ok;
  go.textContent = busy ? 'Sedang diproses...' : goLabel();
}

function trimBlock() {
  const t = state.trim;
  const duration = state.current?.duration || null;
  const field = (id, label, key, placeholder) =>
    h('div', { class: 'field' },
      h('label', { for: id }, label),
      h('input', {
        id, type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder, value: t[key],
        'aria-describedby': 'trim-summary trim-error',
        oninput: (e) => { t[key] = e.target.value; updateTrimUi(); },
      }),
    );

  const toggle = h('label', { class: 'trim-toggle' },
    h('input', { type: 'checkbox', id: 'trim-on', checked: t.on, onchange: (e) => { t.on = e.target.checked; renderOptions(); } }),
    h('span', {}, 'Potong durasi'),
  );
  if (!t.on) return h('div', { class: 'trim' }, toggle);

  return h('div', { class: 'trim' },
    toggle,
    h('div', { class: 'trim-fields' },
      field('trim-start', 'Mulai', 'start', '0:00'),
      field('trim-end', 'Selesai', 'end', duration ? fmtClock(duration) : 'akhir'),
    ),
    duration ? h('div', { class: 'trim-bar', 'aria-hidden': 'true' }, h('span', { class: 'trim-range', id: 'trim-range' })) : null,
    h('div', { class: 'trim-row' },
      h('p', { class: 'trim-summary', id: 'trim-summary', 'aria-live': 'polite' }),
      h('button', { class: 'text-btn', type: 'button', onclick: () => { t.start = ''; t.end = ''; renderOptions(); } }, 'Atur ulang'),
    ),
    h('p', { class: 'trim-error', id: 'trim-error', role: 'alert', hidden: true }),
  );
}

function renderOptions() {
  const box = $('#options');
  if (!box) return;
  ensureQuality();

  const tabs = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Jenis unduhan' },
    [['video', 'Video'], ['audio', 'Audio']].map(([m, label]) =>
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(state.mode === m), onclick: () => setMode(m) }, label),
    ),
  );

  const formats = h('div', { class: 'chips', role: 'radiogroup', 'aria-labelledby': 'f-label' },
    FORMATS[state.mode].map(([v, label]) =>
      chip(label, state.format === v, () => { state.format = v; renderOptions(); }),
    ),
  );

  const choices = qualityChoices();
  const qualityBlock = choices.length
    ? [
        h('p', { class: 'label', id: 'q-label' }, state.mode === 'video' ? 'Resolusi' : 'Bitrate'),
        h('div', { class: 'chips', role: 'radiogroup', 'aria-labelledby': 'q-label' },
          choices.map(([v, label]) => chip(label, state.quality === v, () => { state.quality = v; renderOptions(); })),
        ),
      ]
    : [h('p', { class: 'note' }, AUDIO_NOTES[state.format] || '')];

  const go = h('button', { class: 'primary', type: 'button', onclick: startDownload });
  box.replaceChildren(tabs, h('p', { class: 'label', id: 'f-label' }, 'Format'), formats, ...qualityBlock, trimBlock(), go);
  updateTrimUi();                                   // mengisi ringkasan, bilah waktu, dan status tombol
}

/* ---------- Unduhan & status ---------- */
async function startDownload() {
  const item = state.current;
  if (!item || isBusy()) return;
  const trim = validateTrim();
  if (!trim.ok) return updateTrimUi();
  const body = { url: item.url, format: state.format, quality: state.quality, title: item.title };
  if (trim.on && !trim.whole) {                       // seluruh video: tidak ada yang dikirim
    body.start = trim.start;
    body.end = trim.end;
  }
  try {
    const job = await api('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    state.jobs.set(job.id, job);
    state.activeJobId = job.id;
    const top = stack.at(-1);
    if (top?.type === 'watch' && top.item === item) top.activeJobId = job.id;
    renderOptions();
    renderStatus();
    renderDrawer();
    poll(job.id);
  } catch (err) {
    $('#status')?.replaceChildren(h('p', { class: 'job-line error' }, err.message));
  }
}

async function poll(id) {
  const wasBusy = isBusy();
  try {
    const job = await api(`/api/jobs/${id}`);
    state.jobs.set(id, job);
    if (job.status === 'done' && !state.saved.has(id)) {
      state.saved.add(id);
      if (!state.desktop) triggerSave(job);
    }
  } catch (err) {
    state.jobs.set(id, { ...state.jobs.get(id), status: 'error', error: err.message });
  }
  renderStatus();
  renderDrawer();
  if (wasBusy !== isBusy()) renderOptions();
  if (ACTIVE.has(state.jobs.get(id).status)) setTimeout(() => poll(id), 900);
}

function triggerSave(job) {
  const a = h('a', { href: `/api/jobs/${job.id}/file`, download: job.filename || '' });
  document.body.append(a);
  a.click();
  a.remove();
}

async function revealJob(id) {
  try {
    await api(`/api/jobs/${id}/reveal`, { method: 'POST' });
  } catch (err) {
    const note = h('p', { class: 'job-line error' }, err.message);
    document.querySelectorAll('#status, #downloads-list').forEach((box) => box.append(note.cloneNode(true)));
  }
}

function statusText(job) {
  switch (job.status) {
    case 'queued': return 'Menunggu antrean...';
    case 'downloading':
      if (job.indeterminate) return [job.clip ? 'Mengunduh potongan' : 'Mengunduh', job.bytes ? fmtBytes(job.bytes) : null, fmtSpeed(job.speed)].filter(Boolean).join(', ');
      return [`${job.clip ? 'Mengunduh potongan' : 'Mengunduh'} ${Math.round(job.progress || 0)}%`, fmtSpeed(job.speed), fmtEta(job.eta)].filter(Boolean).join(', ');
    case 'processing':
      return AUDIO_SET.has(job.format) ? `Mengonversi ke ${job.format.toUpperCase()}...` : 'Menggabungkan video dan audio...';
    case 'done':
      if (!(state.desktop && job.saved_path)) return `Selesai: ${job.filename}`;
      return state.android ? `Tersimpan di ${androidSaveDir()}: ${job.filename}` : `Tersimpan: ${job.saved_path}`;
    default: return job.error || 'Unduhan gagal.';
  }
}

// Folder simpan bawaan di Android dipendekkan menjadi nama yang dikenal di aplikasi File.
const androidSaveDir = () => (/\/storage\/downloads\/Tonton$/.test(state.saveDir) ? 'Download/Tonton' : state.saveDir);

function clipText(job) {
  if (!job.clip) return '';
  return `potongan ${fmtClock(job.clip.start)}-${job.clip.end == null ? 'akhir' : fmtClock(job.clip.end)}`;
}

function jobQuality(job) {
  if (!job.quality) return '';
  if (job.quality === 'best') return 'terbaik';
  return AUDIO_SET.has(job.format) ? `${job.quality} kbps` : `${job.quality}p`;
}

function jobBlock(job) {
  const done = job.status === 'done';
  const failed = job.status === 'error';
  const pct = done ? 100 : job.progress || 0;
  const parts = [
    h('div', {
      class: `bar${done ? ' ok' : ''}${failed ? ' bad' : ''}${job.status === 'downloading' && job.indeterminate ? ' indeterminate' : ''}`,
      role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)),
    }, h('span', { style: `width:${failed ? 100 : pct}%` })),
    h('p', { class: `job-line${failed ? ' error' : ''}` }, statusText(job)),
  ];
  if (done) {
    parts.push(state.desktop
      ? h('button', { class: 'save', type: 'button', onclick: () => revealJob(job.id) }, state.android ? 'Buka file' : 'Tampilkan di folder')
      : h('a', { class: 'save', href: `/api/jobs/${job.id}/file`, download: job.filename || '' }, 'Simpan file'));
  }
  return h('div', { class: 'job' }, ...parts);
}

function renderStatus() {
  const box = $('#status');
  if (!box) return;
  const job = state.jobs.get(state.activeJobId);
  box.replaceChildren(...(job ? [jobBlock(job)] : []));
}

function renderDrawer() {
  const list = $('#downloads-list');
  const jobs = [...state.jobs.values()].reverse();
  list.replaceChildren(...(jobs.length
    ? jobs.map((j) =>
        h('article', { class: 'dl-item' },
          h('h3', {}, j.title || j.filename || 'Video'),
          h('p', { class: 'tag' }, [[j.format?.toUpperCase(), jobQuality(j)].filter(Boolean).join(' '), clipText(j)].filter(Boolean).join(', ')),
          jobBlock(j),
        ))
    : [h('p', { class: 'note' }, 'Belum ada unduhan. Buka sebuah video lalu tekan Unduh.')]));

  const active = jobs.filter((j) => ACTIVE.has(j.status)).length;
  const badge = $('#dl-badge');
  badge.textContent = String(active);
  badge.hidden = !active;
}

/* ---------- Saran pencarian ---------- */
const sg = { items: [], active: -1, timer: null, ctrl: null, cache: new Map() };
const HISTORY_KEY = 'tonton.history';
const ICONS = {
  search: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  history: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
};

function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY));
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveHistory(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 20)));
  } catch { /* penyimpanan tidak tersedia: riwayat dilewati */ }
}

function rememberQuery(q) {
  if (/^https?:\/\//i.test(q)) return;                       // tautan tidak dicatat sebagai riwayat
  saveHistory([q, ...loadHistory().filter((x) => x.toLowerCase() !== q.toLowerCase())]);
}

const forgetQuery = (q) => saveHistory(loadHistory().filter((x) => x !== q));

// Riwayat yang cocok tampil lebih dulu, disusul saran dari YouTube (tanpa duplikat).
function composeSuggestions(text, remote) {
  const t = text.trim().toLowerCase();
  const past = loadHistory()
    .filter((x) => !t || x.toLowerCase().includes(t))
    .slice(0, t ? 3 : 8)
    .map((x) => ({ text: x, kind: 'history' }));
  const seen = new Set(past.map((x) => x.text.toLowerCase()));
  const fresh = remote.filter((x) => !seen.has(x.toLowerCase())).map((x) => ({ text: x, kind: 'suggest' }));
  return [...past, ...fresh].slice(0, 8);
}

function closeSuggest() {
  clearTimeout(sg.timer);
  sg.ctrl?.abort();
  sg.active = -1;
  const list = $('#suggest');
  if (list) list.hidden = true;
  $('#q')?.setAttribute('aria-expanded', 'false');
  $('#q')?.removeAttribute('aria-activedescendant');
}

function renderSuggest(items) {
  const list = $('#suggest');
  const input = $('#q');
  sg.items = items;
  sg.active = -1;
  input.removeAttribute('aria-activedescendant');
  if (!items.length) return closeSuggest();
  list.replaceChildren(...items.map((it, i) => {
    const icon = h('span', { class: 'sg-icon' });
    icon.innerHTML = ICONS[it.kind === 'history' ? 'history' : 'search'];        // ikon statis milik aplikasi
    const row = h('li', { class: 'sg-item', id: `sg-${i}`, role: 'option', 'aria-selected': 'false', 'data-i': String(i) },
      icon, h('span', { class: 'sg-text' }, it.text));
    if (it.kind === 'history') {
      row.append(h('button', { class: 'sg-del', type: 'button', tabindex: '-1', 'data-del': it.text, 'aria-label': `Hapus "${it.text}" dari riwayat` }, '×'));
    }
    return row;
  }));
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function refreshSuggest() {
  const text = $('#q').value;
  renderSuggest(composeSuggestions(text, sg.cache.get(text.trim().toLowerCase()) || []));
}

function setActive(i) {
  sg.active = i;
  document.querySelectorAll('#suggest .sg-item').forEach((el, idx) => el.setAttribute('aria-selected', String(idx === i)));
  const input = $('#q');
  if (i < 0) return input.removeAttribute('aria-activedescendant');
  input.setAttribute('aria-activedescendant', `sg-${i}`);
  $(`#sg-${i}`)?.scrollIntoView?.({ block: 'nearest' });
}

function choose(i) {
  const item = sg.items[i];
  if (!item) return;
  $('#q').value = item.text;
  runSearch(item.text);
}

async function fetchSuggest(text) {
  sg.ctrl?.abort();
  sg.ctrl = new AbortController();
  try {
    const data = await api(`/api/suggest?q=${encodeURIComponent(text)}`, { signal: sg.ctrl.signal });
    sg.cache.set(text.trim().toLowerCase(), data.items || []);
    if ($('#q').value === text && document.activeElement === $('#q')) refreshSuggest();
  } catch { /* saran bersifat opsional: galat diabaikan */ }
}

function onType() {
  clearTimeout(sg.timer);
  refreshSuggest();                                           // riwayat langsung tampil, tanpa menunggu jaringan
  const text = $('#q').value;
  if (text.trim().length >= 2 && !sg.cache.has(text.trim().toLowerCase())) {
    sg.timer = setTimeout(() => fetchSuggest(text), 180);     // tunggu pengguna berhenti mengetik
  }
}

function onSuggestKey(e) {
  const open = !$('#suggest').hidden;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!open) refreshSuggest();
    const n = sg.items.length;
    if (!n) return;
    e.preventDefault();
    setActive(e.key === 'ArrowDown' ? (sg.active + 1) % n : (sg.active - 1 + n) % n);
  } else if (e.key === 'Enter' && open && sg.active >= 0) {
    e.preventDefault();
    choose(sg.active);
  } else if (e.key === 'Escape' && open) {
    e.preventDefault();
    closeSuggest();
  }
}

function initSuggest() {
  const input = $('#q');
  const list = $('#suggest');
  input.addEventListener('input', onType);
  input.addEventListener('focus', refreshSuggest);
  input.addEventListener('click', () => { if ($('#suggest').hidden) refreshSuggest(); });   // klik pada kolom yang sudah terfokus
  input.addEventListener('blur', closeSuggest);
  input.addEventListener('keydown', onSuggestKey);
  // mousedown (bukan click) + preventDefault: kolom cari tidak kehilangan fokus sebelum pilihan terbaca
  list.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const del = e.target.closest('[data-del]');
    if (del) {
      forgetQuery(del.dataset.del);
      return refreshSuggest();
    }
    const row = e.target.closest('.sg-item');
    if (row) choose(Number(row.dataset.i));
  });
  list.addEventListener('mousemove', (e) => {
    const row = e.target.closest('.sg-item');
    if (row && Number(row.dataset.i) !== sg.active) setActive(Number(row.dataset.i));
  });
}

/* ---------- Event & inisialisasi ---------- */
$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (q) runSearch(q);
});
$('#brand').addEventListener('click', (e) => { e.preventDefault(); $('#q').value = ''; showHome(); });
$('#open-dl').addEventListener('click', () => { renderDrawer(); dialog.showModal(); });
$('#close-dl').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

api('/api/health').then((info) => {
  state.desktop = !!info.desktop;
  state.embedded = !!info.embedded;
  state.android = !!info.android;
  state.saveDir = info.save_dir || '';
  if (!info.ffmpeg) {
    const banner = $('#banner');
    banner.textContent = 'FFmpeg belum terpasang. Unduhan MP3 dan penggabungan video butuh FFmpeg, lihat README untuk cara memasangnya.';
    banner.hidden = false;
  }
}).catch(() => {});

initBackButton();
initSuggest();
renderDrawer();
showHome();
