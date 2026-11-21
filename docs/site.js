/* Retranslation browser: a single page driven by the URL hash. No libraries, no network calls except this site's own data/ files.
     #/                         home (file types)           #/type/<pack>/<type>     the files of one type
     #/file/<file>?line=<id>    one file's lines            #/search?jp=&en=&off=&spk=&rx=1&cs=1   across all files
   Data: data/manifest.json (files, counts, features) and data/shard-NNNN.json (lines: [id, speaker#, jp, en, official, romaji]). */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const enc = encodeURIComponent;
const CHUNK = 100;                                  // result lines drawn per "show more"
const FIELDS = ['jp', 'en', 'off', 'spk'];

let M = null;                                       // manifest
const shards = new Map();                           // shard index -> Promise<{spk, files:{name: lines}}>
let token = 0;                                      // newest render wins when pages load slowly

/* ---------------------------------------------------------------- data */
async function getJSON(path) {
  const r = await fetch(path + '?v=' + (M ? M.version : ''));
  if (!r.ok) throw new Error(path + ': ' + r.status);
  return r.json();
}
function shard(i) {
  if (!shards.has(i)) {
    shards.set(i, getJSON(M.shards[i].file).then(d => {
      const files = {};
      d.files.forEach(f => { files[f.f] = f.l; });
      return {spk: d.spk, files};
    }));
  }
  return shards.get(i);
}
const typesOf = pack => {
  const t = new Map();
  M.files.filter(f => f.p === pack).forEach(f => {
    const x = t.get(f.t) || {t: f.t, files: 0, c: 0, d: 0};
    x.files++; x.c += f.c; x.d += f.d; t.set(f.t, x);
  });
  const order = (M.sections || []).map(x => x.id);
  return [...t.values()].sort((a, b) => (order.indexOf(a.t) + 1 || 99) - (order.indexOf(b.t) + 1 || 99) || a.t.localeCompare(b.t));
};
const section = id => (M.sections || []).find(x => x.id === id) || {id, name: id, desc: ''};
const pct = (d, c) => c ? Math.round(100 * d / c) : 0;

/* ---------------------------------------------------------------- filters */
function routeParts() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = h.split('?');
  return {path, q: new URLSearchParams(qs || '')};
}
function readFilters(q) {
  const on = !M || M.features.filters;               // a site built without --filters ignores filter parameters
  const f = {rx: on && q.get('rx') === '1', cs: on && q.get('cs') === '1'};
  FIELDS.forEach(k => { f[k] = on ? q.get(k) || '' : ''; });
  return f;
}
const hasFilter = f => FIELDS.some(k => f[k]);

function makeMatcher(f) {                           // -> {test(rec, speaker), hl:{jp,en,off}} or {error}
  const flags = f.cs ? 'g' : 'gi';
  const rxs = {};
  try {
    FIELDS.forEach(k => { if (f[k]) rxs[k] = new RegExp(f.rx ? f[k] : f[k].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags); });
  } catch (e) { return {error: 'That regular expression is not valid: ' + e.message}; }
  const t = (rx, s) => { rx.lastIndex = 0; return rx.test(s); };
  return {
    hl: {jp: rxs.jp, en: rxs.en, off: rxs.off},
    test: (rec, spk) => (!rxs.jp || t(rxs.jp, rec[2])) && (!rxs.en || t(rxs.en, rec[3])) && (!rxs.off || t(rxs.off, rec[4])) && (!rxs.spk || t(rxs.spk, spk)),
  };
}
function syncInputs(f) {
  const form = $('#filters');
  FIELDS.forEach(k => { form.elements[k].value = f[k]; });
  form.elements.rx.checked = f.rx; form.elements.cs.checked = f.cs;
}
function filterQuery(extra = {}) {
  const form = $('#filters'), q = new URLSearchParams();
  FIELDS.forEach(k => { const v = form.elements[k].value.trim(); if (v) q.set(k, v); });
  if (form.elements.rx.checked) q.set('rx', '1');
  if (form.elements.cs.checked) q.set('cs', '1');
  Object.entries(extra).forEach(([k, v]) => v && q.set(k, v));
  return q;
}
let typing = null, fromTyping = false;               // while the reader types, the boxes keep their text (the URL holds it trimmed)
function onFilterInput() {
  clearTimeout(typing);
  typing = setTimeout(() => {
    fromTyping = true;
    const {path, q} = routeParts();
    const keep = path.startsWith('/file/') ? {line: q.get('line')} : {};
    const qs = filterQuery(keep).toString();
    const target = path.startsWith('/file/') ? path : '/search';
    const next = '#' + target + (qs ? '?' + qs : '');
    if (path === target) history.replaceState(null, '', next), render(); else location.hash = next;
  }, 220);
}

/* ---------------------------------------------------------------- line markup */
function hl(s, rx) {
  if (!rx) return esc(s);
  let out = '', last = 0, m;
  rx.lastIndex = 0;
  while ((m = rx.exec(s))) {
    if (m[0] === '') { rx.lastIndex++; continue; }
    out += esc(s.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}
const rich = (text, rx) => text.split(/<br>|\n/).map(p => hl(p, rx)).join('<br>');

function lineHTML(file, rec, spk, m, hit) {
  const [id, , jp, en, off, rom] = rec;
  const link = '#/file/' + enc(file) + '?line=' + id;
  const F = M.features, h = (m && m.hl) || {};
  return `<article class="line${hit ? ' hit' : ''}" id="L${id}">`
    + `<div class="c-spk">${F.filters ? `<a class="who" href="#/search?spk=${enc(spk)}" title="All lines by this speaker">${esc(spk || '?')}</a>` : `<span class="who">${esc(spk || '?')}</span>`}<a href="${link}" title="Link to this line">#${id}</a></div>`
    + (F.japanese ? `<div class="c-jp"><span class="tag">Japanese</span>${rich(jp, h.jp)}${F.romaji && rom ? `<div class="rom">${esc(rom)}</div>` : ''}</div>` : '')
    + `<div class="c-en"><span class="tag">Retranslation</span>${en ? rich(en, h.en) : '<span class="none">not translated yet</span>'}</div>`
    + (F.official ? `<div class="c-off"><span class="tag">Official English</span>${off ? rich(off, h.off) : ''}</div>` : '')
    + '</article>';
}

const COLHEAD = () => '<div class="line colhead" aria-hidden="true"><div class="c-spk">Speaker</div>' + (M.features.japanese ? '<div class="c-jp">Japanese</div>' : '')
  + '<div class="c-en">Retranslation</div>' + (M.features.official ? '<div class="c-off">Official English</div>' : '') + '</div>';
const plural = (n, one, many = one + 's') => n.toLocaleString('en-US') + ' ' + (n === 1 ? one : many);

/* ---------------------------------------------------------------- views */
const app = () => $('#app');
function crumbs(parts) { return '<div class="crumbs">' + parts.map(([t, h]) => h ? `<a href="${h}">${esc(t)}</a>` : esc(t)).join(' / ') + '</div>'; }
function failed(e) { app().innerHTML = `<p class="note">Could not load the data (${esc(e.message)}). If you opened this page as a file, run <code>python -m ffxvi_tl site --serve</code> or publish it on a web server.</p>`; }

function viewOpts() {                               // "Show: Japanese / Romaji / Official English" switches, only on pages that list lines
  const F = M.features, o = [];
  if (F.japanese) o.push(['jp', 'Japanese']);
  if (F.japanese && F.romaji) o.push(['rom', 'Romaji']);
  if (F.official) o.push(['off', 'Official English']);
  return o.length ? '<div class="viewopts"><span class="lbl">Show</span>' + o.map(([k, n]) => `<label class="chk"><input data-col="${k}" type="checkbox"> ${n}</label>`).join('') + '</div>' : '';
}

function aboutBand() {                               // full-width strip under the banner: what the project is, the AI notice, link to the full page
  const H = M.hero;
  if (!H.blurb && !H.notice && !M.about) return '';
  return '<div class="band-in"><h2 class="sec-title">About this project</h2>' + (H.blurb ? `<p class="band-lead">${esc(H.blurb)}</p>` : '') + (H.notice ? `<p class="notice">${esc(H.notice)}</p>` : '')
    + (M.about ? '<p><a class="more" href="#/about">Read more about the project →</a></p>' : '') + '</div>';
}

async function aboutPage(my) {
  const html = await (await fetch('data/about.html?v=' + M.version)).text();
  if (my !== token) return;
  app().innerHTML = crumbs([['Browse', '#/'], ['About']]) + '<article class="prose">' + html + '</article>';
  document.title = 'About · ' + M.title;
}

function home(q) {
  const pack = q.get('pack') || M.default_pack, H = M.hero, T = M.totals;
  const tabs = '<div class="tabs" role="group" aria-label="Game content">' + M.packs.map(p => `<a class="${p.id === pack ? 'on' : ''}" href="#/?pack=${enc(p.id)}"${p.id === pack ? ' aria-current="true"' : ''}>${esc(p.name)}</a>`).join('') + '</div>';
  const info = M.packs.find(p => p.id === pack);
  const cards = typesOf(pack).map(t => {
    const sec = section(t.t);
    return `<a class="card" href="#/type/${enc(pack)}/${enc(t.t)}"><div class="ct"><b>${esc(sec.name)}</b>${sec.name !== t.t ? `<span class="code">${esc(t.t)}</span>` : ''}</div>`
      + (sec.desc ? `<p>${esc(sec.desc)}</p>` : '') + `<small>${plural(t.files, 'file')} · ${plural(t.c, 'line')}</small>`
      + `<div class="bar" title="${pct(t.d, t.c)}% translated"><i style="width:${pct(t.d, t.c)}%"></i></div></a>`;
  }).join('');
  const hero = $('#hero');
  hero.hidden = false; hero.classList.toggle('img', !!H.banner);
  if (H.banner) hero.style.setProperty('--banner', `url("${H.banner}?v=${M.version}")`);
  hero.innerHTML = `<div class="hero-in"><h1>${esc(M.title)}</h1><p>${esc(H.tagline)}</p><div class="hero-actions">`
    + (H.download_url ? `<a class="btn-dl" href="${esc(H.download_url)}" target="_blank" rel="noopener">${esc(H.download_label)}</a>` : '')
    + '<a class="btn-alt" href="#/" data-scroll="browse">Browse the script</a></div></div>';
  app().innerHTML = `<section class="browse" id="browse"><div class="stats"><div><b>${T.lines.toLocaleString('en-US')}</b><span>lines</span></div><div><b>${T.files.toLocaleString('en-US')}</b><span>files</span></div><div><b>${pct(T.translated, T.lines)}%</b><span>retranslated</span></div></div>`
    + `<h2 class="sec-title">Browse the script</h2>`
    + `<p class="lead">Read the retranslation line by line${M.features.japanese ? ', next to the Japanese' : ''}${M.features.romaji ? ', its romaji' : ''}${M.features.official ? ' and the official English' : ''}. `
    + `Choose a category of script files to open it${M.features.filters ? ', or use the filters above to search every file' : ''}.</p>`
    + tabs + (info && info.note ? `<p class="note">${esc(info.note)}</p>` : '') + `<div class="cards">${cards}</div></section>`
    ;
  const band = $('#band'), bh = aboutBand(); band.innerHTML = bh; band.hidden = !bh;
  document.title = M.title;
}

function typePage(pack, type) {
  const files = M.files.filter(f => f.p === pack && f.t === type), sec = section(type);
  app().innerHTML = crumbs([['Browse', '#/?pack=' + enc(pack)], [sec.name]]) + `<h1>${esc(sec.name)}${sec.name !== type ? ` <span class="muted" style="font-size:.6em">${esc(type)}</span>` : ''}</h1>` + (sec.desc ? `<p class="lead">${esc(sec.desc)}</p>` : '')
    + `<p><input id="fname" type="search" placeholder="Filter ${files.length.toLocaleString('en-US')} files by name" style="padding:7px 10px;width:min(100%,360px);border:1px solid var(--line);border-radius:6px;background:var(--surface)"></p><div id="flist"></div>`;
  const draw = () => {
    const needle = $('#fname').value.trim().toLowerCase();
    const rows = files.filter(f => f.n.toLowerCase().includes(needle)).map(f => `<tr><td><a href="#/file/${enc(f.n)}">${esc(f.n)}</a></td><td class="n">${f.c}</td><td class="n">${pct(f.d, f.c)}%</td></tr>`).join('');
    $('#flist').innerHTML = `<table class="files"><tr><th>File</th><th class="n">Lines</th><th class="n">Done</th></tr>${rows || '<tr><td colspan="3" class="muted">No file matches.</td></tr>'}</table>`;
  };
  $('#fname').addEventListener('input', draw); draw();
  document.title = sec.name + ' · ' + M.title;
}

async function filePage(name, q, my) {
  const meta = M.files.find(f => f.n === name);
  if (!meta) { app().innerHTML = crumbs([['Browse', '#/']]) + `<p class="note">There is no file called ${esc(name)}.</p>`; return; }
  const sibs = M.files.filter(f => f.p === meta.p && f.t === meta.t), i = sibs.findIndex(f => f.n === name);
  const f = readFilters(q), m = makeMatcher(f), line = q.get('line') || '';
  const sh = await shard(meta.s); if (my !== token) return;
  const lines = sh.files[name] || [];
  const nav = (j, label, id) => j >= 0 && j < sibs.length ? `<a id="${id}" href="#/file/${enc(sibs[j].n)}" title="${label} file (${id === 'prevfile' ? 'left' : 'right'} arrow)">${id === 'prevfile' ? '← previous' : 'next →'}</a>` : '';
  const opts = sibs.map(s => `<option value="${esc(s.n)}"${s.n === name ? ' selected' : ''}>${esc(s.n.split('/').pop())}</option>`).join('');
  app().innerHTML = crumbs([['Browse', '#/?pack=' + enc(meta.p)], [section(meta.t).name, '#/type/' + enc(meta.p) + '/' + enc(meta.t)]])
    + `<div class="filehead"><h1>${esc(name)}</h1><span class="muted">(${i + 1}/${sibs.length})</span><select id="jump" aria-label="Jump to another file">${opts}</select></div>`
    + `<div class="pager">${nav(i - 1, 'previous', 'prevfile')}${nav(i + 1, 'next', 'nextfile')}</div><div id="out"></div>`;
  $('#jump').addEventListener('change', e => { location.hash = '#/file/' + enc(e.target.value); });
  if (m.error) { $('#out').innerHTML = `<p class="note">${esc(m.error)}</p>`; return; }
  const rows = lines.filter(r => !hasFilter(f) || m.test(r, sh.spk[r[1]]));
  const qs = filterQuery().toString();
  $('#out').innerHTML = `<p class="count">${rows.length.toLocaleString('en-US')}${hasFilter(f) ? ' of ' + lines.length.toLocaleString('en-US') : ''} lines`
    + (hasFilter(f) && M.features.filters ? ` · <a href="#/search?${qs}">search every file instead</a>` : '') + '</p>' + viewOpts() + COLHEAD() + '<div id="rows"></div><div id="more"></div>';
  applyCols();
  drawChunks(rows, r => lineHTML(name, r, sh.spk[r[1]], hasFilter(f) ? m : null, String(r[0]) === line), line ? rows.findIndex(r => String(r[0]) === line) + 1 : 0);
  const el = line && document.getElementById('L' + line);
  if (el) el.scrollIntoView({block: 'center'});
  document.title = name + ' · ' + M.title;
}

function drawChunks(items, html, minimum = 0) {        // CHUNK items at a time, with a "show more" button; `minimum` draws at least that many
  let shown = 0;
  const rowsEl = $('#rows'), moreEl = $('#more');
  const next = n => {
    const end = Math.min(items.length, Math.max(shown + CHUNK, n));
    rowsEl.insertAdjacentHTML('beforeend', items.slice(shown, end).map(html).join(''));
    shown = end;
    moreEl.innerHTML = shown < items.length ? `<button class="ghost more" type="button">Show ${Math.min(CHUNK, items.length - shown)} more (${(items.length - shown).toLocaleString('en-US')} left)</button>` : '';
    const b = $('button', moreEl); if (b) b.onclick = () => next(0);
  };
  next(minimum);
}

async function searchPage(q, my) {
  const f = readFilters(q), m = makeMatcher(f);
  app().innerHTML = crumbs([['Browse', '#/'], ['Search']]) + '<h1>Search</h1><div id="out"></div>';
  document.title = 'Search · ' + M.title;
  if (m.error) { $('#out').innerHTML = `<p class="note">${esc(m.error)}</p>`; return; }
  if (!hasFilter(f)) { $('#out').innerHTML = '<p class="note">Type in any of the boxes above to search every file. Tick “Regular expression” for patterns.</p>'; return; }
  const out = $('#out'), results = [];
  const n = M.shards.length;
  for (let s = 0; s < n; s++) {
    out.innerHTML = `<p class="count">Searching… ${s}/${n} data files</p>`;
    const sh = await shard(s); if (my !== token) return;
    for (const [file, lines] of Object.entries(sh.files)) {
      for (const r of lines) if (m.test(r, sh.spk[r[1]])) results.push({file, r, spk: sh.spk[r[1]]});
    }
  }
  const files = new Set(results.map(x => x.file)).size;
  out.innerHTML = `<p class="count">${plural(results.length, 'line')} in ${plural(files, 'file')}</p>${viewOpts()}${COLHEAD()}<div id="rows"></div><div id="more"></div>`;
  applyCols();
  let last = '';
  drawChunks(results, x => {
    const head = x.file !== last ? `<div class="group"><h3><a href="#/file/${enc(x.file)}">${esc(x.file)}</a></h3></div>` : '';
    last = x.file;
    return head + lineHTML(x.file, x.r, x.spk, m, false);
  });
}

/* ---------------------------------------------------------------- router */
async function render() {
  const my = ++token, {path, q} = routeParts();
  const f = readFilters(q);
  if (path !== '/') { $('#hero').hidden = true; $('#band').hidden = true; }
  document.body.classList.toggle('home', path === '/');
  if (!fromTyping) {
    if (path.startsWith('/search') || path.startsWith('/file/')) syncInputs(f);
    else syncInputs({rx: false, cs: false, jp: '', en: '', off: '', spk: ''});
  }
  fromTyping = false;
  document.querySelectorAll('.top nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + (path.startsWith('/search') ? '/search' : path === '/about' ? '/about' : '/')));
  try {
    if (!M) { M = await getJSON('data/manifest.json'); applyFeatures(); if (my !== token) return; }
    if (!M.features.filters && path.startsWith('/search')) { location.replace('#/'); return; }
    if (path.startsWith('/file/')) await filePage(decodeURIComponent(path.slice(6)), q, my);
    else if (path.startsWith('/type/')) { const [pack, type] = path.slice(6).split('/').map(decodeURIComponent); typePage(pack, type); }
    else if (path === '/about' && M.about) await aboutPage(my);
    else if (path.startsWith('/search')) await searchPage(q, my);
    else home(q);
    if (my === token && !location.hash.includes('line=')) window.scrollTo(0, 0);
  } catch (e) { if (my === token) failed(e); }
}

/* ---------------------------------------------------------------- chrome: columns, theme, keys */
function applyFeatures() {
  const F = M.features, b = document.body.classList;
  b.toggle('no-jp', !F.japanese); b.toggle('no-off', !F.official); b.toggle('no-rom', !F.romaji); b.toggle('no-filters', !F.filters);
  $('.nav-about').hidden = !M.about; $('#filters').hidden = !F.filters;
  const dl = $('#dl-top'); if (M.hero.download_url) { dl.href = M.hero.download_url; dl.textContent = M.hero.download_label; dl.hidden = false; }
}
function applyCols() {                              // the saved choice drives the body classes; the switches exist only on pages that list lines
  let c = {jp: true, rom: true, off: true};
  try { c = Object.assign(c, JSON.parse(localStorage.getItem('cols') || '{}')); } catch (e) {}
  ['jp', 'rom', 'off'].forEach(k => document.body.classList.toggle('hide-' + k, !c[k]));
  document.querySelectorAll('[data-col]').forEach(i => { i.checked = c[i.dataset.col]; i.disabled = i.dataset.col === 'rom' && !c.jp; });
}
function headerHeight() { document.documentElement.style.setProperty('--hh', document.querySelector('.topbar').offsetHeight + 'px'); }
function init() {
  headerHeight(); addEventListener('resize', headerHeight);
  applyCols();
  const form = $('#filters');
  form.addEventListener('input', e => { if (!e.target.dataset.col) onFilterInput(); });
  form.addEventListener('submit', e => { e.preventDefault(); onFilterInput(); });
  document.addEventListener('change', e => {
    if (!e.target.dataset || !e.target.dataset.col) return;
    let c = {};
    try { c = JSON.parse(localStorage.getItem('cols') || '{}'); } catch (x) {}
    document.querySelectorAll('[data-col]').forEach(x => { c[x.dataset.col] = x.checked; });
    try { localStorage.setItem('cols', JSON.stringify(c)); } catch (x) {}
    applyCols();
  });
  $('#clear').addEventListener('click', () => { form.reset(); const {path} = routeParts(); location.hash = path.startsWith('/file/') ? '#' + path : '#/search'; });
  $('#theme').addEventListener('click', () => {
    document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('theme', document.documentElement.dataset.theme); } catch (e) {}
  });
  document.addEventListener('keydown', e => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === '/' && M && M.features.filters) { e.preventDefault(); const i = M && M.features.japanese ? form.elements.jp : form.elements.en; i.focus(); i.select(); return; }
    const a = document.getElementById(e.key === 'ArrowLeft' ? 'prevfile' : e.key === 'ArrowRight' ? 'nextfile' : '');
    if (a) location.hash = a.getAttribute('href');
  });
  document.addEventListener('click', e => {         // "Browse the script" scrolls to the file types instead of changing the page
    const a = e.target.closest('[data-scroll]'); if (!a) return;
    e.preventDefault(); document.getElementById(a.dataset.scroll).scrollIntoView({behavior: 'smooth'});
  });
  addEventListener('hashchange', render);
  render();
}
init();