/* Les recettes de Lucie — fiches techniques et recalcul des grammages.
   Données de base : window.RECETTES, chargées depuis Firestore par auth.js après la connexion Google.
   Recettes ajoutées ou modifiées, dossiers : base Firestore partagée (window.RL_DB),
   avec une copie dans le navigateur ; exportables depuis l'écran « Sauvegarde ». */
(function () {
  'use strict';

  var CATS = [
    ['entremets', 'Entremets'],
    ['buches', 'Bûches'],
    ['tartes', 'Tartes'],
    ['choux', 'Choux'],
    ['viennoiseries', 'Viennoiseries'],
    ['glaces', 'Glaces et assiettes'],
    ['gateaux', 'Gâteaux de voyage'],
    ['sale', 'Salé'],
    ['bases', 'Bases']
  ];
  var CAT_LABEL = {};
  CATS.forEach(function (c) { CAT_LABEL[c[0]] = c[1]; });
  var STORE_KEY = 'recettes-lucie-v1';

  // ---------- Stockage local ----------
  function loadStore() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (s && typeof s === 'object') return { mine: s.mine || {}, hidden: s.hidden || [], folders: s.folders || [], place: s.place || {} };
    } catch (e) {}
    return { mine: {}, hidden: [], folders: [], place: {} };
  }
  function saveLocal() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); return true; } catch (e) { return false; }
  }
  // Le navigateur garde-t-il vraiment ce qu'on lui confie ? (non dans certains aperçus ou en navigation privée)
  var localOk = (function () {
    try { localStorage.setItem('rl-test', '1'); var ok = localStorage.getItem('rl-test') === '1'; localStorage.removeItem('rl-test'); return ok; } catch (e) { return false; }
  })();
  // Après une modification : enregistre, et prévient franchement si ce ne sera pas gardé.
  function saveStore() {
    var ok = saveLocal();
    if (sync.db && !sync.readOnly) { schedulePush(); return true; }
    var why = notSavedReason(ok);
    if (why) warn(why);
    return true;
  }
  function notSavedReason(localWorked) {
    if (sync.readOnly) return 'Pas enregistré : ce compte Google n\u2019est pas autorisé à modifier les recettes.';
    if (sync.remote && !sync.db) return 'Pas enregistré : la base de recettes ne répond pas. Rechargez la page.';
    if (!localWorked || !localOk) return 'Pas enregistré : ce navigateur refuse de garder les données (navigation privée ?).';
    return '';
  }
  var store = loadStore();
  var BASE = {};
  (window.RECETTES || []).forEach(function (r) { BASE[r.id] = r; });

  function allRecipes() {
    var out = [];
    Object.keys(BASE).forEach(function (id) {
      if (store.hidden.indexOf(id) !== -1) return;
      out.push(store.mine[id] || BASE[id]);
    });
    Object.keys(store.mine).forEach(function (id) { if (!BASE[id]) out.push(store.mine[id]); });
    return out.sort(function (a, b) { return a.title.localeCompare(b.title, 'fr'); });
  }
  function getRecipe(id) {
    if (store.mine[id]) return store.mine[id];
    if (BASE[id] && store.hidden.indexOf(id) === -1) return BASE[id];
    return null;
  }

  // ---------- Dossiers (onglet « Toutes ») ----------
  // store.folders : [{ id, name, parent }] (parent '' = racine) ; store.place : { idRecette: idDossier }.
  function folderById(id) {
    for (var i = 0; i < store.folders.length; i++) if (store.folders[i].id === id) return store.folders[i];
    return null;
  }
  function childFolders(pid) {
    return store.folders.filter(function (f) { return (f.parent || '') === pid; })
      .sort(function (a, b) { return a.name.localeCompare(b.name, 'fr'); });
  }
  function folderPath(id) {
    var out = [], f = folderById(id), guard = 0;
    while (f && guard++ < 50) { out.unshift(f); f = folderById(f.parent); }
    return out;
  }
  function folderOf(rid) { var f = store.place[rid]; return f && folderById(f) ? f : ''; }
  function isInside(id, ancestor) {
    return folderPath(id).some(function (f) { return f.id === ancestor; });
  }
  function folderCount(id, all) {
    var n = 0;
    all.forEach(function (r) { var f = folderOf(r.id); if (f && isInside(f, id)) n++; });
    return n;
  }
  function folderTree() { // liste à plat, dans l'ordre de l'arbre, avec la profondeur
    var out = [];
    (function walk(pid, d) { childFolders(pid).forEach(function (f) { out.push({ f: f, depth: d }); walk(f.id, d + 1); }); })('', 0);
    return out;
  }
  function deleteFolder(here) { // le contenu remonte d'un niveau, aucune recette n'est effacée
    var pid = here.parent || '';
    store.folders.forEach(function (f) { if (f.parent === here.id) f.parent = pid; });
    Object.keys(store.place).forEach(function (rid) { if (store.place[rid] === here.id) { if (pid) store.place[rid] = pid; else delete store.place[rid]; } });
    store.folders = store.folders.filter(function (f) { return f !== here; });
  }
  function newFolderId() { return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function cleanFolderName(s) { return String(s || '').trim().replace(/\s+/g, ' ').slice(0, 80); }

  // ---------- Base de données ----------
  // Une fois connecté avec Google, tout ce qui change (dossiers, rangement, recettes ajoutées, modifiées ou retirées)
  // est enregistré dans la base de données du site, partagée entre appareils :
  //   site/dossiers  { folders, place }      site/masquees { hidden }      recettes/<id> { recette }
  // Le navigateur en garde une copie (localStorage) pour s'ouvrir vite et fonctionner sans la base.
  // Ouvert comme simple fichier (sans base), le site enregistre seulement dans le navigateur.
  var sync = { db: null, remote: !!window.RL_DB, readOnly: false, live: false, pushed: { folders: null, hidden: null, mine: {} }, timer: null, busy: false, again: false };
  var $sync = document.getElementById('sync');
  function showSync(state, msg) {
    if (!$sync) return;
    $sync.textContent = msg; $sync.setAttribute('data-state', state); $sync.hidden = false;
  }
  function folderDoc() { return { folders: store.folders, place: store.place }; }
  function schedulePush() {
    if (!sync.db) return;
    if (!sync.live) { showSync('saving', 'Modification en attente : envoi dès que la base répond…'); return; } // envoyée par goLive
    clearTimeout(sync.timer);
    showSync('saving', 'Enregistrement…');
    sync.timer = setTimeout(push, 350);
  }
  function retryOnce(fn) {
    return fn().catch(function (e) {
      if (!e || (e.code !== 'unavailable' && e.code)) throw e;
      return new Promise(function (r) { setTimeout(r, 400 + Math.random() * 600); }).then(fn);
    });
  }
  async function pushOnce() {
    var db = sync.db;
    var f = JSON.stringify(folderDoc());
    if (f !== sync.pushed.folders) { await retryOnce(function () { return db.doc('site/dossiers').set(JSON.parse(f)); }); sync.pushed.folders = f; }
    var h = JSON.stringify(store.hidden);
    if (h !== sync.pushed.hidden) { await retryOnce(function () { return db.doc('site/masquees').set({ hidden: JSON.parse(h) }); }); sync.pushed.hidden = h; }
    var ids = Object.keys(store.mine);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i], r = JSON.stringify(store.mine[id]);
      if (r === sync.pushed.mine[id]) continue;
      await retryOnce(function () { return db.collection('recettes').doc(id).set({ recette: JSON.parse(r) }); });
      sync.pushed.mine[id] = r;
    }
    var gone = Object.keys(sync.pushed.mine).filter(function (k) { return !store.mine[k]; });
    for (var j = 0; j < gone.length; j++) {
      var g = gone[j];
      await retryOnce(function () { return db.collection('recettes').doc(g).delete(); });
      delete sync.pushed.mine[g];
    }
  }
  async function push() {
    if (sync.busy) { sync.again = true; return; }
    sync.busy = true;
    try {
      do { sync.again = false; await pushOnce(); } while (sync.again);
      showSync('ok', 'Tout est enregistré');
    } catch (e) {
      if (window.console) console.warn('Enregistrement refusé par la base', e);
      var ro = e && (e.code === 'permission-denied' || e.code === 'unauthenticated');
      if (ro) sync.readOnly = true;
      var m = e && e.code === 'quota_exceeded'
        ? 'Base pleine : la modification n\u2019a pas été enregistrée.'
        : ro ? 'Pas enregistré : ce compte Google n\u2019est pas autorisé à modifier les recettes.'
          : 'Base injoignable : la modification n\u2019est pas encore enregistrée. Nouvel essai dans un instant.';
      showSync('err', m); warn(m);
      if (!ro && !(e && e.code === 'quota_exceeded')) { clearTimeout(sync.timer); sync.timer = setTimeout(push, 8000); }
    } finally { sync.busy = false; }
  }
  function refreshViews(recipesChanged) {
    renderList();
    if (location.hash === '#ranger' && org.redraw) org.redraw();
    else if (recipesChanged && currentId()) route();
  }
  async function connectDb() {
    if (!sync.remote) { if (!localOk) showSync('err', 'Ce navigateur ne garde pas les modifications (navigation privée ?).'); return; }
    showSync('loading', 'Connexion à la base…');
    var db = window.RL_DB;
    sync.db = db;
    var first = { f: null, h: null, r: null };   // première réponse de chaque source
    var refs = { f: db.doc('site/dossiers'), h: db.doc('site/masquees'), r: db.collection('recettes') };
    // Si les abonnements tardent, on lit une fois directement pour ne pas rester bloqué hors ligne.
    var slow = setTimeout(function () {
      if (sync.live) return;
      Promise.all(['f', 'h', 'r'].map(function (k) { return first[k] ? first[k] : refs[k].get(); })).then(function (s) {
        if (sync.live) return;
        first.f = s[0]; first.h = s[1]; first.r = s[2]; goLive();
      }, function () { if (!sync.live) showSync('err', 'Base injoignable pour l\u2019instant : les modifications ne sont pas encore enregistrées.'); });
    }, 8000);
    function onErr() { if (!sync.live) { clearTimeout(slow); showSync('err', 'Base injoignable : les modifications ne sont pas encore enregistrées.'); } }

    function goLive() {
      if (sync.live || !first.f || !first.h || !first.r) return;
      clearTimeout(slow);
      // Premier contact : on réunit la base et ce que ce navigateur avait (la base l'emporte en cas de doublon).
      var rf = first.f.exists ? first.f.data() : null, rh = first.h.exists ? first.h.data() : null;
      sync.pushed.folders = rf ? JSON.stringify({ folders: rf.folders || [], place: rf.place || {} }) : null;
      sync.pushed.hidden = rh ? JSON.stringify(rh.hidden || []) : null;
      if (rf) {
        var byId = {};
        (rf.folders || []).forEach(function (x) { byId[x.id] = 1; });
        store.folders = (rf.folders || []).map(function (x) { return { id: x.id, name: x.name, parent: x.parent || '' }; })
          .concat(store.folders.filter(function (x) { return !byId[x.id]; }));
        var pl = {}; Object.keys(store.place).forEach(function (k) { pl[k] = store.place[k]; });
        Object.keys(rf.place || {}).forEach(function (k) { pl[k] = rf.place[k]; });
        store.place = pl;
      }
      if (rh) (rh.hidden || []).forEach(function (k) { if (store.hidden.indexOf(k) === -1) store.hidden.push(k); });
      sync.pushed.mine = {};
      first.r.docs.forEach(function (d) {
        var b = d.data(); if (!b || !b.recette) return;
        var local = store.mine[d.id];
        // Une modification faite ici avant que la base réponde (plus récente) l'emporte et sera envoyée.
        if (local && (local.updatedAt || 0) > (b.recette.updatedAt || 0)) return;
        store.mine[d.id] = JSON.parse(JSON.stringify(b.recette));
        sync.pushed.mine[d.id] = JSON.stringify(store.mine[d.id]);
      });
      clearTimeout(slow);
      sync.live = true;
      saveLocal();
      refreshViews(true);
      push();
    }
    function applyLater(kind, snap) {
      var before;
      if (kind === 'f') {
        var d = snap.exists ? snap.data() : { folders: [], place: {} };
        var nd = { folders: (d.folders || []).map(function (x) { return { id: x.id, name: x.name, parent: x.parent || '' }; }), place: JSON.parse(JSON.stringify(d.place || {})) };
        if (JSON.stringify(nd) === JSON.stringify(folderDoc())) return;
        if (sync.busy || sync.pushed.folders !== JSON.stringify(folderDoc())) return; // une modification locale part : elle gagnera
        store.folders = nd.folders; store.place = nd.place; sync.pushed.folders = JSON.stringify(folderDoc());
        saveLocal(); refreshViews(false);
      } else if (kind === 'h') {
        var hh = snap.exists ? (snap.data().hidden || []).slice() : [];
        if (JSON.stringify(hh) === JSON.stringify(store.hidden) || sync.busy || sync.pushed.hidden !== JSON.stringify(store.hidden)) return;
        store.hidden = hh; sync.pushed.hidden = JSON.stringify(hh);
        saveLocal(); refreshViews(true);
      } else {
        if (sync.busy || Object.keys(store.mine).some(function (k) { return sync.pushed.mine[k] !== JSON.stringify(store.mine[k]); })) return;
        var mine = {}, pushed = {};
        snap.docs.forEach(function (doc) { var b = doc.data(); if (b && b.recette) { mine[doc.id] = JSON.parse(JSON.stringify(b.recette)); pushed[doc.id] = JSON.stringify(mine[doc.id]); } });
        before = JSON.stringify(store.mine);
        if (JSON.stringify(mine) === before) return;
        store.mine = mine; sync.pushed.mine = pushed;
        saveLocal(); refreshViews(true);
      }
    }
    function listen(kind, ref) {
      ref.onSnapshot(function (snap) {
        if (!sync.live) {
          if (snap.metadata && snap.metadata.fromCache) return;
          first[kind] = snap; goLive();
        } else applyLater(kind, snap);
      }, onErr);
    }
    listen('f', refs.f);
    listen('h', refs.h);
    listen('r', refs.r);
  }

  // ---------- Outils ----------
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) {
      if (c == null || c === false) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }
  function norm(s) {
    return String(s).toLowerCase().replace(/œ/g, 'oe').replace(/æ/g, 'ae').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  function slug(s) { return norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'recette'; }
  function parseNum(s) {
    if (s == null) return NaN;
    var t = String(s).replace(/[\s  ]/g, '').replace(',', '.');
    if (!/^\d*\.?\d+$/.test(t)) return NaN;
    return parseFloat(t);
  }
  var nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
  var nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  var nf2 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
  function fmtQty(q) {
    var a = Math.abs(q);
    if (a >= 100) return nf0.format(Math.round(q));
    if (a >= 10) return nf1.format(Math.round(q * 2) / 2);
    if (a >= 1) return nf1.format(q);
    return nf2.format(q);
  }
  function fmtFactor(f) { return nf2.format(f); }
  function isWeight(ing) { return ing.qty != null && (!ing.unit || ing.unit === 'g' || /^g\b/.test(ing.unit)); }
  function unitLabel(ing) { return !ing.unit ? '' : ing.unit; }
  function compTotal(c) {
    return c.ingredients.reduce(function (s, i) { return s + (isWeight(i) ? i.qty : 0); }, 0);
  }
  function recipeTotal(r) { return r.components.reduce(function (s, c) { return s + compTotal(c); }, 0); }
  var toastTimer, toastLock = 0;
  function toast(msg, warning) {
    if (!warning && Date.now() < toastLock) return; // un avertissement reste lisible
    var t = document.querySelector('.toast');
    if (!t) { t = el('div', { class: 'toast', role: 'status' }); document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false;
    t.classList.toggle('warn', !!warning);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, warning ? 7000 : 2600);
  }
  function warn(msg) { toast(msg, true); toastLock = Date.now() + 7000; }

  var coarse = window.matchMedia ? window.matchMedia('(pointer: coarse)') : { matches: false };

  // ---------- Index ----------
  var ui = { q: '', cat: '', folder: '', form: null };
  try { ui.cat = sessionStorage.getItem('rl-cat') || ''; ui.folder = sessionStorage.getItem('rl-folder') || ''; } catch (e) {}
  function openFolder(id) {
    ui.folder = id; ui.form = null;
    try { sessionStorage.setItem('rl-folder', id); } catch (e) {}
    renderList();
    $list.scrollTop = 0;
  }
  var $list = document.getElementById('list');
  var $cats = document.getElementById('cats');
  var $q = document.getElementById('q');
  var $main = document.getElementById('main');
  var $app = document.getElementById('app');

  function renderCats() {
    $cats.textContent = '';
    [['', 'Toutes']].concat(CATS).forEach(function (c) {
      $cats.appendChild(el('button', {
        type: 'button', 'aria-pressed': String(ui.cat === c[0]), text: c[1],
        onclick: function () {
          ui.cat = c[0]; ui.form = null;
          try { sessionStorage.setItem('rl-cat', ui.cat); } catch (e) {}
          renderCats(); renderList();
        }
      }));
    });
  }
  function matches(r, q) {
    if (!q) return true;
    var hay = norm(r.title) + ' ' + r.components.map(function (c) {
      return c.name + ' ' + c.ingredients.map(function (i) { return i.name; }).join(' ');
    }).map(norm).join(' ');
    return q.split(/\s+/).every(function (w) { return hay.indexOf(w) !== -1; });
  }
  function recipeLink(r, cur, draggable) {
    var m = r.yield ? fmtQty(r.yield.qty) + ' ' + r.yield.unit.replace(/\s*\(.*\)/, '') : r.components.length + ' prép.';
    return el('li', null, [el('a', { href: '#' + r.id, 'aria-current': r.id === cur ? 'page' : null, draggable: 'false', 'data-dragkey': draggable ? 'r:' + r.id : null }, [
      el('span', { class: 't' }, [r.title, store.mine[r.id] ? el('span', { class: 'mine', text: BASE[r.id] ? 'modifiée' : 'ajoutée' }) : null]),
      el('span', { class: 'm num', text: m })
    ])]);
  }
  function appendGroups(rs, row, prefix) {
    CATS.forEach(function (c) {
      var items = rs.filter(function (r) { return r.category === c[0]; });
      if (!items.length) return;
      $list.appendChild(el('section', { class: 'group' }, [
        el('h2', null, [el('span', { text: (prefix || '') + c[1] }), el('span', { class: 'num', text: String(items.length) })]),
        el('ul', null, items.map(row))
      ]));
    });
  }
  function renderList() {
    var cur = currentId();
    var q = norm(ui.q.trim());
    var all = allRecipes();
    document.getElementById('count').textContent = all.length + ' fiches techniques';
    $list.textContent = '';
    if (!ui.cat) {
      if (ui.folder && !folderById(ui.folder)) ui.folder = '';
      if (!q) { renderFolderView(all, cur); return; }
    }
    var rs = all.filter(function (r) { return (!ui.cat || r.category === ui.cat) && matches(r, q); });
    if (!rs.length) {
      $list.appendChild(el('p', { class: 'empty-list', text: 'Aucune recette ne contient « ' + ui.q.trim() + ' ».' }));
      return;
    }
    appendGroups(rs, function (r) { return recipeLink(r, cur); });
  }

  // Vue « Toutes » : on se déplace dans les dossiers comme dans un classeur.
  function renderFolderView(all, cur) {
    var here = ui.folder ? folderById(ui.folder) : null;
    var path = here ? folderPath(here.id) : [];
    var bar = el('div', { class: 'folder-bar' });
    $list.appendChild(bar);

    // Fil d'Ariane
    var crumbs = el('nav', { class: 'crumbs', 'aria-label': 'Dossier ouvert' });
    crumbs.appendChild(here
      ? el('button', { type: 'button', class: 'crumb', 'data-drop': '', text: 'Toutes', onclick: function () { openFolder(''); } })
      : el('span', { class: 'crumb here', text: 'Toutes les recettes' }));
    path.forEach(function (f, i) {
      crumbs.appendChild(el('span', { class: 'sep', 'aria-hidden': 'true', text: '/' }));
      crumbs.appendChild(i === path.length - 1
        ? el('span', { class: 'crumb here', 'aria-current': 'location', text: f.name })
        : el('button', { type: 'button', class: 'crumb', 'data-drop': f.id, text: f.name, onclick: function () { openFolder(f.id); } }));
    });
    bar.appendChild(crumbs);

    // Actions sur le dossier courant
    function act(label, form) {
      return el('button', { type: 'button', class: 'link' + (ui.form === form ? ' on' : ''), text: label, 'aria-expanded': String(ui.form === form),
        onclick: function () { ui.form = ui.form === form ? null : form; renderList(); } });
    }
    var acts = el('div', { class: 'folder-acts' }, [
      el('button', { type: 'button', class: 'link', text: here ? 'Nouveau sous-dossier' : 'Nouveau dossier', onclick: function () { org.pendingNew = true; goOrganizer(); } }),
      el('button', { type: 'button', class: 'link', text: 'Ranger les recettes', onclick: goOrganizer })
    ]);
    if (here) {
      acts.appendChild(act('Renommer', 'rename'));
      acts.appendChild(act('Déplacer', 'move'));
      acts.appendChild(act('Supprimer', 'delete'));
    }
    bar.appendChild(acts);
    if (store.folders.length) bar.appendChild(el('p', { class: 'drag-hint', text: coarse.matches
      ? 'Restez appuyé sur une fiche puis glissez-la sur un dossier.'
      : 'Glissez une fiche sur un dossier pour la ranger.' }));
    if (ui.form) bar.appendChild(folderForm(here, all));

    // Sous-dossiers
    var subs = childFolders(here ? here.id : '');
    if (subs.length) {
      $list.appendChild(el('ul', { class: 'folders', 'aria-label': 'Dossiers' }, subs.map(function (f) {
        var n = folderCount(f.id, all), k = childFolders(f.id).length;
        return el('li', null, [el('button', { type: 'button', 'data-drop': f.id, 'data-dragkey': 'f:' + f.id, onclick: function () { openFolder(f.id); } }, [
          el('span', { class: 'fname', text: f.name }),
          el('span', { class: 'm num', text: n + (k ? ' · ' + k + ' doss.' : '') }),
          el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' })
        ])]);
      })));
    }

    // Recettes posées directement ici
    var rs = all.filter(function (r) { return folderOf(r.id) === (here ? here.id : ''); });
    if (here && !rs.length && !subs.length) {
      $list.appendChild(el('p', { class: 'empty-list', text: 'Dossier vide. Touchez « Ranger les recettes » pour y glisser des fiches, ou ouvrez une fiche et choisissez ce dossier en bas de page.' }));
      return;
    }
    if (here && rs.length) {
      $list.appendChild(el('section', { class: 'group' }, [
        el('h2', null, [el('span', { text: 'Dans ce dossier' }), el('span', { class: 'num', text: String(rs.length) })]),
        el('ul', null, rs.map(function (r) { return recipeLink(r, cur, true); }))
      ]));
      return;
    }
    appendGroups(rs, function (r) { return recipeLink(r, cur, true); }, store.folders.length ? 'Hors dossier · ' : '');
  }

  function folderForm(here, all) {
    var box = el('div', { class: 'folder-form' });
    function close() { ui.form = null; renderList(); }
    if (ui.form === 'new' || ui.form === 'rename') {
      var isNew = ui.form === 'new';
      var inp = el('input', { type: 'text', class: 'search', value: isNew ? '' : here.name, maxlength: '80',
        'aria-label': isNew ? 'Nom du nouveau dossier' : 'Nouveau nom du dossier', placeholder: isNew ? 'Nom du dossier' : '' });
      var f = el('form', { class: 'folder-form-row' }, [inp,
        el('button', { type: 'submit', class: 'btn', text: isNew ? 'Créer' : 'Renommer' }),
        el('button', { type: 'button', class: 'btn ghost', text: 'Annuler', onclick: close })]);
      inp.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        var name = cleanFolderName(inp.value);
        if (!name) { inp.focus(); return; }
        var pid = here ? here.id : '';
        var twin = childFolders(isNew ? pid : (here.parent || '')).some(function (x) { return x !== here && norm(x.name) === norm(name); });
        if (twin && (isNew || norm(name) !== norm(here.name))) { toast('Un dossier « ' + name + ' » existe déjà ici.'); inp.focus(); return; }
        if (isNew) store.folders.push({ id: newFolderId(), name: name, parent: pid });
        else here.name = name;
        ui.form = null;
        if (saveStore()) toast(isNew ? 'Dossier « ' + name + ' » créé' : 'Dossier renommé');
        renderList();
      });
      box.appendChild(f);
      setTimeout(function () { inp.focus(); if (!isNew) inp.select(); }, 0);
    } else if (ui.form === 'move') {
      var sel = el('select', { class: 'search', 'aria-label': 'Déplacer dans' }, [el('option', { value: '', text: 'Toutes (premier niveau)', selected: !here.parent })]
        .concat(folderTree().filter(function (t) { return !isInside(t.f.id, here.id); }).map(function (t) {
          return el('option', { value: t.f.id, selected: here.parent === t.f.id, text: ' '.repeat(t.depth) + t.f.name });
        })));
      var mf = el('form', { class: 'folder-form-row' }, [sel,
        el('button', { type: 'submit', class: 'btn', text: 'Déplacer' }),
        el('button', { type: 'button', class: 'btn ghost', text: 'Annuler', onclick: close })]);
      mf.addEventListener('submit', function (e) {
        e.preventDefault();
        here.parent = sel.value; ui.form = null;
        if (saveStore()) toast('Dossier déplacé');
        renderList();
      });
      box.appendChild(el('p', { text: 'Déplacer « ' + here.name + ' » et tout son contenu dans :' }));
      box.appendChild(mf);
    } else if (ui.form === 'delete') {
      var parent = folderById(here.parent);
      var n = folderCount(here.id, all);
      var yes = el('button', { type: 'button', class: 'btn danger-solid', text: 'Supprimer le dossier', onclick: function () {
        var pid = here.parent || '';
        deleteFolder(here);
        if (saveStore()) toast('Dossier « ' + here.name + ' » supprimé');
        openFolder(pid);
      } });
      box.classList.add('confirm');
      box.setAttribute('role', 'alertdialog');
      box.appendChild(el('p', { text: 'Supprimer le dossier « ' + here.name + ' » ? ' +
        (n || childFolders(here.id).length ? 'Son contenu remonte dans « ' + (parent ? parent.name : 'Toutes') + ' ». ' : '') +
        'Aucune recette n’est effacée.' }));
      box.appendChild(el('div', { class: 'ed-actions' }, [yes, el('button', { type: 'button', class: 'btn ghost', text: 'Annuler', onclick: close })]));
      setTimeout(function () { yes.focus(); }, 0);
    }
    return box;
  }

  $q.addEventListener('input', function () { ui.q = $q.value; renderList(); });

  // ---------- Routage ----------
  function currentId() {
    var h = decodeURIComponent(location.hash.slice(1));
    return h && h !== 'nouvelle' && h !== 'sauvegarde' && h !== 'ranger' && h.indexOf('modifier~') !== 0 ? h : '';
  }
  function route() {
    var h = decodeURIComponent(location.hash.slice(1));
    $main.textContent = '';
    ui.form = null;
    if (h === 'nouvelle') renderEditor(null);
    else if (h.indexOf('modifier~') === 0) renderEditor(getRecipe(h.slice(9)));
    else if (h === 'sauvegarde') renderBackup();
    else if (h === 'ranger') renderOrganizer();
    else if (h && getRecipe(h)) renderRecipe(getRecipe(h));
    else renderWelcome();
    $app.classList.toggle('organizing', h === 'ranger');
    $app.classList.toggle('reading', h === 'nouvelle' || h === 'sauvegarde' || h === 'ranger' || h.indexOf('modifier~') === 0 || !!(h && getRecipe(h)));
    renderList();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  function backLink() {
    return el('a', { class: 'back link', href: '#', text: '← Toutes les recettes' });
  }

  // ---------- Accueil ----------
  function renderWelcome() {
    var picks = ['brownies', 'creme-patissiere', 'le-satin', 'tarte-citron-magasin', 'pate-a-choux-mark-ii', 'madeleines-au-citron']
      .map(getRecipe).filter(Boolean);
    $main.appendChild(el('div', { class: 'welcome' }, [
      el('h2', { text: 'Choisir une fiche, puis indiquer la quantité voulue.' }),
      el('p', { text: "Chaque fiche se recalcule par rendement (nombre de cadres, de pièces), par nombre de personnes, par coefficient ou par poids total. Il suffit aussi de toucher une quantité pour tout recalculer à partir d'un ingrédient : avec 600 g d'œufs, la préparation s'ajuste à ces 600 g." }),
      el('div', { class: 'picks' }, picks.map(function (r) { return el('a', { href: '#' + r.id, text: r.title }); }))
    ]));
  }

  // ---------- Fiche recette ----------
  function renderRecipe(r) {
    var total = recipeTotal(r);
    var modes = [];
    var peopleYield = r.yield && /personne|part|portion|convive/i.test(r.yield.unit);
    if (r.yield && !peopleYield) modes.push(['yield', 'Rendement']);
    modes.push(['people', 'Personnes'], ['coef', 'Coefficient'], ['weight', 'Poids total']);
    var st = { mode: modes[0][0], global: 1, comp: {}, people: peopleYield ? r.yield.qty : 8 };
    try { var savedP = parseNum(localStorage.getItem('rl-pers-' + r.id)); if (savedP > 0) st.people = savedP; } catch (e) {}

    var sheet = el('article', { class: 'sheet' });
    $main.appendChild(sheet);

    var barFactor = el('button', { type: 'button', class: 'bar-factor num', onclick: function () { scale.scrollIntoView({ behavior: 'smooth', block: 'start' }); } });
    sheet.appendChild(el('div', { class: 'phonebar' }, [
      el('a', { class: 'bar-back', href: '#', 'aria-label': 'Toutes les recettes', text: '←' }),
      el('span', { class: 'bar-title', text: r.title }),
      barFactor
    ]));
    sheet.appendChild(backLink());
    sheet.appendChild(el('div', { class: 'eyebrow' }, [
      el('span', { text: CAT_LABEL[r.category] || '' }),
      r.source ? el('span', { class: 'src', text: r.source }) : null,
      store.mine[r.id] ? el('span', { text: BASE[r.id] ? 'Version modifiée' : 'Recette ajoutée' }) : null,
      folderOf(r.id) ? el('button', { type: 'button', class: 'in-folder', title: 'Ouvrir ce dossier dans la liste', text: folderPath(folderOf(r.id)).map(function (f) { return f.name; }).join(' / '),
        onclick: function () { ui.cat = ''; try { sessionStorage.setItem('rl-cat', ''); } catch (e) {} renderCats(); openFolder(folderOf(r.id)); if (window.matchMedia('(max-width: 700px)').matches) location.hash = ''; } }) : null
    ]));
    sheet.appendChild(el('h1', { class: 'title', text: r.title }));
    sheet.appendChild(el('p', { class: 'yield' }, r.yield
      ? ['Fiche d’origine : ', el('strong', { class: 'num', text: fmtQty(r.yield.qty) }), ' ' + r.yield.unit + ' · ', el('span', { class: 'num', text: nf0.format(total) + '\u202fg' }), ' au total']
      : ['Fiche d’origine : ', el('span', { class: 'num', text: nf0.format(total) + '\u202fg' }), ' au total, ' + r.components.length + (r.components.length > 1 ? ' préparations' : ' préparation')]));

    // Bloc de calcul
    var scale = el('section', { class: 'scale', 'aria-label': 'Recalculer les quantités' });
    var modeBox = el('div', { class: 'modes', role: 'group', 'aria-label': 'Mode de calcul' });
    var input = el('input', { id: 'scale-input', type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': 'Quantité voulue' });
    var unit = el('span', { class: 'qty-unit' });
    var baseInput = el('input', { id: 'people-base', type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': 'Nombre de personnes prévu par la fiche' });
    var baseField = el('div', { class: 'people-base' }, [
      el('label', { for: 'people-base', text: 'Fiche prévue pour' }), baseInput, el('span', { class: 'qty-unit', text: 'pers., je veux' })
    ]);
    var factorOut = el('span', { class: 'factor', 'aria-live': 'polite' });
    var minus = el('button', { type: 'button', class: 'step', 'aria-label': 'Diminuer', text: '−' });
    var plus = el('button', { type: 'button', class: 'step', 'aria-label': 'Augmenter', text: '+' });
    scale.appendChild(el('div', { class: 'scale-head' }, [el('h2', { text: 'Recalculer' }), modeBox]));
    scale.appendChild(el('div', { class: 'scale-row' }, [baseField, el('div', { class: 'qty-field' }, [minus, input, plus]), unit, factorOut]));
    scale.appendChild(el('p', { class: 'hint', text: 'Toucher une quantité dans la fiche pour ajuster la préparation à ce que vous avez.' }));
    sheet.appendChild(scale);

    function modeValue() {
      if (st.mode === 'yield') return r.yield.qty * st.global;
      if (st.mode === 'weight') return total * st.global;
      if (st.mode === 'people') return st.people * st.global;
      return st.global;
    }
    function toGlobal(v) {
      if (st.mode === 'yield') return v / r.yield.qty;
      if (st.mode === 'weight') return v / total;
      if (st.mode === 'people') return v / st.people;
      return v;
    }
    function syncInput() {
      var v = modeValue();
      input.value = st.mode === 'weight' ? nf0.format(Math.round(v)) : fmtFactor(Math.round(v * 100) / 100);
      unit.textContent = st.mode === 'yield' ? r.yield.unit.replace(/\s*\(.*\)/, '') : st.mode === 'weight' ? 'g' : st.mode === 'people' ? 'personnes' : '× la fiche';
      baseField.hidden = st.mode !== 'people';
      baseInput.value = fmtFactor(st.people);
      input.setAttribute('aria-label', st.mode === 'people' ? 'Nombre de personnes voulu' : 'Quantité voulue');
    }
    function renderModes() {
      modeBox.textContent = '';
      modes.forEach(function (m) {
        modeBox.appendChild(el('button', {
          type: 'button', 'aria-pressed': String(st.mode === m[0]), text: m[1],
          onclick: function () { st.mode = m[0]; renderModes(); syncInput(); }
        }));
      });
    }
    function applyInput() {
      var v = parseNum(input.value);
      if (!(v > 0)) return;
      setGlobal(toGlobal(v), false);
    }
    function setGlobal(g, sync) {
      st.global = g; st.comp = {};
      if (sync) syncInput();
      renderComponents();
    }
    function stepBy(dir) {
      var v = modeValue(), next;
      if (st.mode === 'yield' || st.mode === 'people') next = Math.max(1, Math.round(v) + dir);
      else if (st.mode === 'weight') next = Math.max(100, Math.round(v / 100) * 100 + dir * 100);
      else next = Math.max(0.25, Math.round(v * 4) / 4 + dir * 0.25);
      setGlobal(toGlobal(next), true);
    }
    input.addEventListener('input', applyInput);
    input.addEventListener('blur', syncInput);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { applyInput(); syncInput(); input.blur(); } });
    baseInput.addEventListener('input', function () {
      var b = parseNum(baseInput.value);
      if (!(b > 0)) return;
      var target = st.people * st.global;
      st.people = b;
      try { localStorage.setItem('rl-pers-' + r.id, String(b)); } catch (e) {}
      setGlobal(target / b, false);
    });
    baseInput.addEventListener('blur', syncInput);
    minus.addEventListener('click', function () { stepBy(-1); });
    plus.addEventListener('click', function () { stepBy(1); });

    if (r.notes && r.notes.length) sheet.appendChild(el('ul', { class: 'notes' }, r.notes.map(function (n) { return el('li', { text: n }); })));

    var comps = el('div', { class: 'components' });
    sheet.appendChild(comps);

    function factorOf(i) { return st.comp[i] != null ? st.comp[i] : st.global; }
    function renderFactor() {
      var adjusted = Object.keys(st.comp).length;
      factorOut.textContent = '';
      barFactor.textContent = adjusted && Math.abs(st.global - 1) < 1e-9 ? 'ajusté' : '× ' + fmtFactor(st.global);
      barFactor.classList.toggle('on', adjusted > 0 || Math.abs(st.global - 1) > 1e-9);
      if (Math.abs(st.global - 1) < 1e-9 && !adjusted) { factorOut.textContent = 'Quantités de la fiche d’origine'; return; }
      if (Math.abs(st.global - 1) < 1e-9) factorOut.appendChild(document.createTextNode('Préparations ajustées une à une'));
      else {
        factorOut.appendChild(document.createTextNode('Coefficient '));
        factorOut.appendChild(el('b', { text: '× ' + fmtFactor(st.global) }));
      }
      factorOut.appendChild(document.createTextNode(' · '));
      factorOut.appendChild(el('button', { type: 'button', class: 'link', text: 'Revenir à la fiche', onclick: function () { setGlobal(1, true); } }));
    }

    function amountButton(ing, i, f) {
      var q = ing.qty * f;
      var btn = el('button', { type: 'button', class: 'amt', title: 'Ajuster la préparation à partir de cette quantité' }, [
        fmtQty(q), unitLabel(ing) ? el('span', { class: 'u', text: unitLabel(ing) }) : null
      ]);
      btn.addEventListener('click', function () {
        var inp = el('input', { class: 'amt-input', type: 'text', inputmode: 'decimal', value: fmtQty(q), 'aria-label': 'Quantité de ' + ing.name });
        btn.replaceWith(inp); inp.focus(); inp.select();
        var done = false;
        function commit(apply) {
          if (done) return; done = true;
          var v = parseNum(inp.value);
          if (apply && v > 0 && Math.abs(v - q) > 1e-9) {
            var nf = v / ing.qty;
            if (r.components.length === 1) setGlobal(nf, true);
            else { st.comp[i] = nf; renderComponents(); }
          } else renderComponents();
        }
        inp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') commit(true);
          if (e.key === 'Escape') commit(false);
        });
        inp.addEventListener('blur', function () { commit(true); });
      });
      return btn;
    }

    function renderComponents() {
      comps.textContent = '';
      renderFactor();
      r.components.forEach(function (c, i) {
        var f = factorOf(i);
        var scaled = Math.abs(f - 1) > 1e-9;
        var head = el('div', { class: 'comp-head' }, [
          el('h3', { text: c.name }),
          c.info ? el('span', { class: 'comp-info', text: c.info }) : null
        ]);
        if (st.comp[i] != null) {
          head.appendChild(el('div', { class: 'comp-adjust' }, [
            el('span', { class: 'num', text: 'Préparation ajustée × ' + fmtFactor(f) }),
            el('button', { type: 'button', class: 'link', text: 'Suivre le coefficient général', onclick: function () { delete st.comp[i]; renderComponents(); } })
          ]));
        }
        var rows = c.ingredients.map(function (ing) {
          if (ing.qty == null) {
            return el('tr', null, [el('td', { class: 'n', text: ing.name }), el('td', { class: 'o' }), el('td', { class: 'q' }, [el('span', { class: 'txt', text: ing.text || '' })])]);
          }
          return el('tr', null, [
            el('td', { class: 'n', text: ing.name }),
            el('td', { class: 'o num', text: scaled ? fmtQty(ing.qty) : '' }),
            el('td', { class: 'q' }, [amountButton(ing, i, f)])
          ]);
        });
        var t = compTotal(c);
        if (t > 0 && c.ingredients.length > 1) {
          rows.push(el('tr', { class: 'total' }, [
            el('td', { class: 'n', text: 'Total' }),
            el('td', { class: 'o num', text: scaled ? nf0.format(t) : '' }),
            el('td', { class: 'q' }, [amountButton({ name: 'total ' + c.name, qty: t, unit: 'g' }, i, f)])
          ]));
        }
        comps.appendChild(el('section', { class: 'comp' + (scaled ? ' scaled' : '') }, [
          head,
          el('table', { class: 'ing' }, [
            el('caption', { class: 'visually-hidden', text: c.name }),
            el('tbody', null, rows)
          ]),
          c.notes && c.notes.length ? el('p', { class: 'comp-notes', text: c.notes.join(' ') }) : null
        ]));
      });
    }

    var actions = el('div', { class: 'sheet-actions' }, [
      el('a', { class: 'btn ghost', href: '#modifier~' + r.id, text: 'Modifier la fiche' })
    ]);
    if (store.mine[r.id] && BASE[r.id]) {
      actions.appendChild(el('button', { type: 'button', class: 'btn ghost', text: 'Revenir à la version d’origine', onclick: function () {
        delete store.mine[r.id]; saveStore(); toast('Version d’origine rétablie'); route();
      } }));
    }
    actions.appendChild(deleteControl(r));
    sheet.appendChild(actions);
    sheet.appendChild(folderPicker(r));
    if (r.source) sheet.appendChild(el('p', { class: 'foot-src', text: 'Transcrit depuis ' + r.source + '. Les quantités sont en grammes sauf mention contraire.' }));

    renderModes(); syncInput(); renderComponents();
    keepAwake();
  }

  // Choix du dossier depuis la fiche
  function folderPicker(r) {
    var box = el('div', { class: 'folder-pick' });
    var tree = folderTree();
    if (!tree.length) {
      box.appendChild(el('p', { class: 'hint', text: 'Pour ranger cette fiche, créez d’abord un dossier dans l’onglet « Toutes ».' }));
      return box;
    }
    var cur = folderOf(r.id);
    var sel = el('select', { id: 'rec-folder' }, [el('option', { value: '', text: 'Aucun dossier', selected: !cur })].concat(tree.map(function (t) {
      return el('option', { value: t.f.id, selected: cur === t.f.id, text: ' '.repeat(t.depth) + t.f.name });
    })));
    sel.addEventListener('change', function () {
      if (sel.value) store.place[r.id] = sel.value; else delete store.place[r.id];
      if (saveStore()) toast(sel.value ? 'Rangée dans « ' + folderById(sel.value).name + ' »' : 'Retirée du dossier');
      route();
    });
    box.appendChild(el('label', { for: 'rec-folder', text: 'Dossier' }));
    box.appendChild(sel);
    return box;
  }

  // Écran allumé pendant la lecture d'une fiche (tablette posée en cuisine).
  var wakeLock = null;
  function keepAwake() {
    try {
      if (wakeLock || !navigator.wakeLock || document.visibilityState !== 'visible') return;
      navigator.wakeLock.request('screen').then(function (l) {
        wakeLock = l; l.addEventListener('release', function () { wakeLock = null; });
      }, function () {});
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', function () { if (currentId()) keepAwake(); });

  // ---------- Suppression avec confirmation ----------
  function deleteRecipe(r) {
    if (BASE[r.id] && store.hidden.indexOf(r.id) === -1) store.hidden.push(r.id);
    delete store.mine[r.id];
    if (saveStore()) { toast('« ' + r.title + ' » supprimée'); location.hash = ''; }
  }
  function deleteControl(r) {
    var box = el('div', { class: 'delete-ctl' });
    function idle() {
      box.textContent = '';
      box.appendChild(el('button', { type: 'button', class: 'btn danger', text: 'Supprimer la recette', onclick: ask }));
    }
    function ask() {
      box.textContent = '';
      var yes = el('button', { type: 'button', class: 'btn danger-solid', text: 'Oui, supprimer', onclick: function () { deleteRecipe(r); } });
      box.appendChild(el('div', { class: 'confirm', role: 'alertdialog', 'aria-label': 'Confirmer la suppression' }, [
        el('p', { text: 'Supprimer « ' + r.title + ' » ? ' + (BASE[r.id]
          ? 'La fiche d\u2019origine pourra être rétablie depuis l\u2019écran Sauvegarde.'
          : 'Cette recette ajoutée sera effacée définitivement.') }),
        el('div', { class: 'ed-actions' }, [yes, el('button', { type: 'button', class: 'btn ghost', text: 'Annuler', onclick: idle })])
      ]));
      yes.focus();
    }
    idle();
    return box;
  }

  // ---------- Éditeur ----------
  // ---------- Lecture tolérante d'une ligne d'ingrédient ----------
  // Accepte « sucre200g », « 200g sucre », « 200 g de sucre », « Farine : 1,5 kg »,
  // « 2 gousses de vanille », « colorant qs »… et rend toujours { name, qty, unit } ou { name, text }.
  var UNITS = [
    [/^(g|gr|grs|gramme|grammes)$/, 'g', 1],
    [/^(kg|kgs|kilo|kilos|kilogramme|kilogrammes)$/, 'g', 1000],
    [/^(ml|millilitre|millilitres)$/, 'ml', 1],
    [/^(cl|centilitre|centilitres)$/, 'ml', 10],
    [/^(l|litre|litres)$/, 'ml', 1000],
    [/^(gousse|gousses)$/, 'gousses', 1],
    [/^(feuille|feuilles|f)$/, 'feuilles', 1],
    [/^(sachet|sachets)$/, 'sachets', 1],
    [/^(botte|bottes)$/, 'bottes', 1],
    [/^(piece|pieces|pc|pcs|u|unite|unites)$/, 'pièces', 1],
    [/^(cas|cs|soupe)$/, 'c. à soupe', 1],
    [/^(cac|cc|cafe)$/, 'c. à café', 1]
  ];
  function findUnit(tok) {
    var t = norm(tok || '').replace(/[.\s]/g, '');
    for (var i = 0; i < UNITS.length; i++) if (UNITS[i][0].test(t)) return { unit: UNITS[i][1], mul: UNITS[i][2] };
    return null;
  }
  var KNOWN = null;
  function knownWord(w) {
    if (!KNOWN) {
      KNOWN = {};
      Object.keys(BASE).forEach(function (id) { BASE[id].components.forEach(function (c) { c.ingredients.forEach(function (i) {
        norm(i.name).split(/[^a-z]+/).forEach(function (x) { if (x.length > 2) KNOWN[x] = 1; });
      }); }); });
    }
    return !!KNOWN[norm(w)];
  }
  function cleanName(s) {
    s = s.replace(/^[\s:=|,;\-–—•*]+|[\s:=|,;\-–—•*]+$/g, '').replace(/^(de|d'|d’|du|des)\s*/i, '').replace(/\s+/g, ' ');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }
  var NUM = '(\\d{1,3}(?: \\d{3})+(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)?|[.,]\\d+)';
  var UNIT_WORDS = "(c\\.? ?à\\.? ?s\\.?|c\\.? ?à\\.? ?c\\.?|cuill[eè]res? à (?:soupe|caf[eé])|[A-Za-zÀ-ÿ.]+)?";
  function lineToIng(line) {
    var s = String(line || '').replace(/[  \t]/g, ' ').trim();
    if (!s) return null;
    s = s.replace(/^[-–—•*]\s*/, '');
    if (/(^|[\s:=|])(q\.?\s?s\.?|quantit[eé] suffisante)$/i.test(s)) {
      return { name: cleanName(s.replace(/(q\.?\s?s\.?|quantit[eé] suffisante)$/i, '')) || 'Ingrédient', text: 'QS' };
    }
    // Espaces manquants entre lettres et chiffres : « sucre200g » → « sucre 200 g »
    var t = s.replace(/([A-Za-zÀ-ÿœŒ)])(\d)/g, '$1 $2').replace(/(\d)([A-Za-zÀ-ÿœŒ(])/g, '$1 $2').replace(/\s+/g, ' ');
    var cuil = function (u) { return /soupe|s\.?$/i.test(u) ? 'cas' : 'cac'; };
    function build(name, num, unitTok) {
      var q = parseNum(num), u = { unit: 'g', mul: 1 }, extra = '';
      if (isNaN(q)) return null;
      if (unitTok) {
        var tok = /^c\.? ?à|^cuill/i.test(unitTok) ? cuil(unitTok) : unitTok;
        var f = findUnit(tok);
        if (f) u = f; else extra = unitTok;          // pas une unité : fait partie du nom
      }
      name = cleanName((extra ? extra + ' ' : '') + name);
      if (!name) return null;
      if (!unitTok && q <= 30) {                     // « 3 oeufs », « gousse de vanille 2 » : des pièces, pas des grammes
        var nn = norm(name);
        if (/\b(oeufs?|œufs?)\b/.test(nn) && !/jaune|blanc/.test(nn)) u = { unit: 'pièces', mul: 1 };
        else if (/gousse/.test(nn)) u = { unit: 'gousses', mul: 1 };
        else if (/sachet/.test(nn)) u = { unit: 'sachets', mul: 1 };
        else if (/botte/.test(nn)) u = { unit: 'bottes', mul: 1 };
      }
      return { name: name, qty: Math.round(q * u.mul * 1000) / 1000, unit: u.unit };
    }
    // 1) Nom puis quantité : « Farine 1 000 g », « sucre : 200 »
    var m = t.match(new RegExp('^(.*?\\D)[\\s:=|-]*' + NUM + ' ?' + UNIT_WORDS + '\\.?$', 'i'));
    if (m && /[A-Za-zÀ-ÿ]/.test(m[1])) {
      var r1 = build(m[1], m[2], m[3]);
      if (r1 && (!m[3] || findUnit(/^c\.? ?à|^cuill/i.test(m[3]) ? cuil(m[3]) : m[3]))) return r1;
    }
    // 1 bis) Unité collée au nom : « 200gsucre » → 200 g + sucre (sauf si le mot entier est un ingrédient connu : « 200glucose »)
    m = s.match(/^\s*(\d+(?:[.,]\d+)?)\s?(kg|gr|g|ml|cl|l)([A-Za-zÀ-ÿœŒ][^\d]*)$/i);
    if (m) {
      var word = (m[2] + m[3]).split(/\s/)[0];
      if (!knownWord(word) && !findUnit(word) && m[3].trim().length >= 2) { var rg = build(m[3], m[1], m[2]); if (rg) return rg; }
    }
    // 2) Quantité puis nom : « 200 g de sucre », « 2 gousses vanille »
    m = t.match(new RegExp('^' + NUM + ' ?' + UNIT_WORDS + '\\s+(.+)$', 'i'));
    if (m) {
      var r2 = build(m[3], m[1], m[2]);
      if (r2) return r2;
    }
    if (m === null) {
      m = t.match(new RegExp('^' + NUM + '\\s+(.+)$'));
      if (m) { var r3 = build(m[2], m[1], ''); if (r3) return r3; }
    }
    // 3) Quantité en texte : « Beurre : non précisé »
    var p = s.split(/\s*[:|]\s*/);
    if (p.length > 1 && p[0]) return { name: cleanName(p[0]), text: p.slice(1).join(' ') };
    return { name: cleanName(s), text: '' };
  }
  function fmtLineQty(i) {
    var n = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 }).format(i.qty).replace(/[\u202f\u00a0]/g, ' ');
    return n + ' ' + i.unit;
  }
  function ingToLine(i) {
    if (i.qty == null) return i.name + (i.text ? ' : ' + i.text : '');
    return i.name + ' ' + fmtLineQty(i);
  }

  function renderEditor(r) {
    var isNew = !r;
    var draft = r ? JSON.parse(JSON.stringify(r)) : { id: '', title: '', category: 'entremets', yield: null, source: '', notes: [], components: [{ name: '', info: '', notes: [], ingredients: [] }] };
    var form = el('form', { class: 'editor', novalidate: true });
    $main.appendChild(el('div', null, [backLink(), form]));

    var fTitle = el('input', { id: 'ed-title', type: 'text', value: draft.title, required: true });
    var fCat = el('select', { id: 'ed-cat' }, CATS.map(function (c) { return el('option', { value: c[0], selected: draft.category === c[0], text: c[1] }); }));
    var fYq = el('input', { id: 'ed-yq', type: 'text', inputmode: 'decimal', value: draft.yield ? String(draft.yield.qty).replace('.', ',') : '', placeholder: 'ex. 8' });
    var fYu = el('input', { id: 'ed-yu', type: 'text', value: draft.yield ? draft.yield.unit : '', placeholder: 'ex. personnes, cadres, madeleines' });
    var fNotes = el('textarea', { id: 'ed-notes', rows: '3' });
    fNotes.value = (draft.notes || []).join('\n');
    var compBox = el('div');
    var err = el('p', { class: 'err', role: 'alert' });

    form.appendChild(el('h2', { text: isNew ? 'Nouvelle recette' : 'Modifier « ' + draft.title + ' »' }));
    form.appendChild(el('div', { class: 'field' }, [el('label', { for: 'ed-title', text: 'Nom' }), fTitle]));
    form.appendChild(el('div', { class: 'row2' }, [
      el('div', { class: 'field' }, [el('label', { for: 'ed-cat', text: 'Catégorie' }), fCat]),
      el('div', { class: 'field' }, [el('label', { for: 'ed-yq', text: 'Rendement (facultatif)' }), fYq]),
      el('div', { class: 'field' }, [el('label', { for: 'ed-yu', text: 'Unité du rendement' }), fYu])
    ]));
    form.appendChild(el('div', { class: 'field' }, [el('label', { for: 'ed-notes', text: 'Notes (une par ligne)' }), fNotes, el('p', { class: 'help', text: 'Cuisson, montage, décor…' })]));
    form.appendChild(compBox);

    var compFields = [];
    function addComp(c) {
      var idx = compFields.length;
      var name = el('input', { id: 'ed-c' + idx + '-name', type: 'text', value: c.name, placeholder: 'ex. Biscuit chocolat' });
      var info = el('input', { id: 'ed-c' + idx + '-info', type: 'text', value: c.info || '', placeholder: 'ex. 1 600 g par cadre' });
      var ings = el('textarea', { id: 'ed-c' + idx + '-ing', rows: String(Math.max(6, c.ingredients.length + 1)), placeholder: 'farine 336\nbeurre672\n200g de sucre\n2 gousses de vanille\ncolorant qs' });
      ings.value = c.ingredients.map(ingToLine).join('\n');
      var preview = el('ul', { class: 'parse-preview', 'aria-live': 'polite', 'aria-label': 'Ingrédients compris' });
      function renderPreview() {
        preview.textContent = '';
        ings.value.split('\n').map(lineToIng).filter(Boolean).forEach(function (i) {
          var miss = i.qty == null && !i.text;
          preview.appendChild(el('li', { class: miss ? 'miss' : null }, [
            el('span', { class: 'pn', text: i.name }),
            el('span', { class: 'pq num', text: i.qty != null ? fmtQty(i.qty) + ' ' + i.unit : (i.text || 'quantité manquante') })
          ]));
        });
        preview.hidden = !preview.childNodes.length;
      }
      function tidy() {
        var lines = ings.value.split('\n').map(lineToIng).filter(Boolean).map(ingToLine);
        var v = lines.join('\n');
        if (v !== ings.value.trim()) ings.value = v;
        renderPreview();
      }
      ings.addEventListener('input', renderPreview);
      ings.addEventListener('blur', tidy);
      renderPreview();
      var notes = el('input', { id: 'ed-c' + idx + '-notes', type: 'text', value: (c.notes || []).join(' '), placeholder: 'facultatif' });
      var block = el('div', { class: 'ed-comp' });
      var entry = { name: name, info: info, ings: ings, notes: notes, block: block, removed: false };
      block.appendChild(el('div', { class: 'ed-comp-head' }, [
        el('h3', { text: 'Préparation' }),
        el('button', { type: 'button', class: 'link', text: 'Retirer', onclick: function () { entry.removed = true; block.remove(); } })
      ]));
      block.appendChild(el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [el('label', { for: name.id, text: 'Nom de la préparation' }), name]),
        el('div', { class: 'field' }, [el('label', { for: info.id, text: 'Précision' }), info])
      ]));
      block.appendChild(el('div', { class: 'field' }, [
        el('label', { for: ings.id, text: 'Ingrédients' }), ings,
        el('p', { class: 'help', text: 'Une ligne par ingrédient, écrit comme il vient : «\u00a0sucre200\u00a0», «\u00a0200g de farine\u00a0», «\u00a01,5 kg beurre\u00a0», «\u00a02 gousses vanille\u00a0», «\u00a0colorant qs\u00a0». Sans unité, c\u2019est en grammes. Le site remet chaque ligne au propre quand vous quittez le champ.' }),
        el('p', { class: 'lbl', text: 'Ce que le site a compris' }),
        preview
      ]));
      block.appendChild(el('div', { class: 'field' }, [el('label', { for: notes.id, text: 'Remarque' }), notes]));
      compBox.appendChild(block);
      compFields.push(entry);
    }
    draft.components.forEach(addComp);

    var del = isNew ? null : deleteControl(draft);
    form.appendChild(el('div', { class: 'ed-actions' }, [
      el('button', { type: 'button', class: 'btn ghost', text: 'Ajouter une préparation', onclick: function () { addComp({ name: '', info: '', ingredients: [] }); } })
    ]));
    form.appendChild(err);
    form.appendChild(el('div', { class: 'ed-actions' }, [
      el('button', { type: 'submit', class: 'btn', text: 'Enregistrer' }),
      el('a', { class: 'btn ghost', href: isNew ? '#' : '#' + draft.id, text: 'Annuler' }),
      del
    ]));

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var title = fTitle.value.trim().replace(/\s+/g, ' ');
      if (title) title = title.charAt(0).toUpperCase() + title.slice(1);
      if (!title) { err.textContent = 'Donnez un nom à la recette.'; fTitle.focus(); return; }
      var comps = compFields.filter(function (c) { return !c.removed; }).map(function (c) {
        return {
          name: c.name.value.trim() || 'Préparation',
          info: c.info.value.trim(),
          notes: c.notes.value.trim() ? [c.notes.value.trim()] : [],
          ingredients: c.ings.value.split('\n').map(lineToIng).filter(Boolean)
        };
      }).filter(function (c) { return c.ingredients.length; });
      if (!comps.length) { err.textContent = 'Ajoutez au moins un ingrédient.'; return; }
      var missing = [];
      comps.forEach(function (c) { c.ingredients.forEach(function (i) { if (i.qty == null && !i.text) missing.push(i.name); }); });
      var sig = missing.join('|');
      if (missing.length && form.dataset.confirmedMissing !== sig) {
        form.dataset.confirmedMissing = sig;
        err.textContent = 'Il manque la quantité pour : ' + missing.join(', ') + '. Ajoutez-la, ou touchez « Enregistrer » encore une fois pour garder la recette ainsi.';
        return;
      }
      var yq = parseNum(fYq.value);
      var id = draft.id;
      if (!id) {
        id = slug(title); var base = id, n = 2;
        while (BASE[id] || store.mine[id]) id = base + '-' + n++;
      }
      var rec = {
        id: id, title: title, category: fCat.value,
        yield: yq > 0 ? { qty: yq, unit: fYu.value.trim() || 'portions' } : null,
        source: draft.source || '', notes: fNotes.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
        components: comps,
        updatedAt: Date.now()
      };
      store.mine[id] = rec;
      if (isNew && !ui.cat && ui.folder && folderById(ui.folder)) store.place[id] = ui.folder;
      var h = store.hidden.indexOf(id); if (h !== -1) store.hidden.splice(h, 1);
      if (saveStore()) { toast('Recette enregistrée'); location.hash = id; }
    });
    fTitle.focus();
  }

  // ---------- Ranger (fenêtre façon Finder) ----------
  // Arbre des dossiers à gauche, contenu du dossier en icônes à droite.
  // Souris : clic = sélectionner (Cmd/Ctrl pour en ajouter, Maj pour une plage), glisser sur un dossier = ranger,
  // double-clic = ouvrir. Tactile : toucher une fiche la coche, puis « Déplacer vers… ».
  var org = { sel: [], anchor: null, editing: null, q: '', open: {}, moving: false, confirm: false, pendingNew: false, focus: null };
  var ICON_FOLDER = '<svg viewBox="0 0 48 38" aria-hidden="true"><path class="ff" d="M2.5 6.5a3 3 0 0 1 3-3h12.2l4 4.5h20.8a3 3 0 0 1 3 3v22.5a3 3 0 0 1-3 3H5.5a3 3 0 0 1-3-3z"/><path class="fl" d="M2.5 12.5h43"/></svg>';
  var ICON_SHEET = '<svg viewBox="0 0 36 44" aria-hidden="true"><path class="ff" d="M4 2.5h19.5l8.5 8.5v30.5H4z"/><path class="fl" d="M23.5 2.5V11H32M9.5 19h17M9.5 24.5h17M9.5 30h11"/></svg>';

  function goOrganizer() {
    if (ui.cat) { ui.cat = ''; try { sessionStorage.setItem('rl-cat', ''); } catch (e) {} renderCats(); }
    if (location.hash === '#ranger') route(); else location.hash = 'ranger';
  }
  function setOrgFolder(id) {
    ui.folder = id; org.sel = []; org.anchor = null; org.editing = null; org.moving = false; org.confirm = false;
    try { sessionStorage.setItem('rl-folder', id); } catch (e) {}
    folderPath(id).forEach(function (f) { org.open[f.id] = true; });
  }
  function keyFolder(k) { return k.charAt(0) === 'f' ? folderById(k.slice(2)) : null; }
  function canMoveKey(k, fid) {
    if (k.charAt(0) === 'r') return folderOf(k.slice(2)) !== fid;
    var f = keyFolder(k);
    return !!f && (f.parent || '') !== fid && !(fid && isInside(fid, f.id));
  }
  function moveKeys(keys, fid) {
    var nr = 0, nf = 0;
    keys.forEach(function (k) {
      if (!canMoveKey(k, fid)) return;
      if (k.charAt(0) === 'r') { if (fid) store.place[k.slice(2)] = fid; else delete store.place[k.slice(2)]; nr++; }
      else { keyFolder(k).parent = fid; nf++; }
    });
    if (!nr && !nf) return false;
    var dest = fid ? '« ' + folderById(fid).name + ' »' : 'Toutes (hors dossier)';
    var what = [nr ? nr + ' fiche' + (nr > 1 ? 's' : '') : '', nf ? nf + ' dossier' + (nf > 1 ? 's' : '') : ''].filter(Boolean).join(' et ');
    if (saveStore()) toast(what + ' → ' + dest);
    return true;
  }
  function uniqueFolderName(pid, base) {
    var names = childFolders(pid).map(function (f) { return norm(f.name); });
    var n = base, i = 2;
    while (names.indexOf(norm(n)) !== -1) n = base + ' ' + i++;
    return n;
  }

  function renderOrganizer() {
    if (ui.folder && !folderById(ui.folder)) ui.folder = '';
    setOrgFolder(ui.folder);
    org.q = '';

    var search = el('input', { type: 'search', class: 'search f-search', placeholder: 'Chercher une fiche…', 'aria-label': 'Chercher une fiche dans tous les dossiers', autocomplete: 'off' });
    var crumbs = el('nav', { class: 'f-crumbs', 'aria-label': 'Dossier ouvert' });
    var acts = el('div', { class: 'f-acts' });
    var side = el('nav', { class: 'f-side', 'aria-label': 'Dossiers' });
    var pane = el('div', { class: 'f-pane' });
    var status = el('div', { class: 'f-status', 'aria-live': 'polite' });
    var sheet = el('div', { class: 'f-sheet-wrap' });
    var win = el('div', { class: 'finder' }, [
      el('div', { class: 'f-head' }, [
        el('a', { class: 'link f-back', href: '#', text: '← Retour aux recettes' }),
        el('h2', { text: 'Ranger les recettes' }),
        el('p', { class: 'f-tip', text: coarse.matches
          ? 'Restez appuyé sur une fiche puis glissez-la sur un dossier. Ou touchez les fiches pour les cocher, puis « Déplacer vers… ». Touchez un dossier pour l’ouvrir.'
          : 'Glissez les fiches sur un dossier, à droite ou dans la colonne de gauche. Cmd ou Ctrl pour en choisir plusieurs, Maj pour une suite. Double-clic pour ouvrir.' })
      ]),
      el('div', { class: 'f-window' }, [
        el('div', { class: 'f-toolbar' }, [crumbs, search, acts]),
        el('div', { class: 'f-body' }, [side, pane]),
        status
      ]),
      sheet
    ]);
    $main.appendChild(win);

    search.addEventListener('input', function () { org.q = search.value; org.sel = []; draw(); });
    pane.addEventListener('click', function (e) { if (e.target === pane || e.target.classList.contains('f-grid')) { org.sel = []; draw(); } });
    win.addEventListener('keydown', function (e) {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); }
      if (e.key === 'Escape') { org.sel = []; org.moving = false; org.confirm = false; draw(); }
    });

    var keys = [];
    function selectAll() { org.sel = keys.slice(); draw(); }
    function isSel(k) { return org.sel.indexOf(k) !== -1; }

    function dropTarget(node, fid) { node.setAttribute('data-drop', fid); }

    function itemNode(k, name, meta, isFolder) {
      var editing = isFolder && org.editing === k.slice(2);
      var icon = el('span', { class: 'f-icon' }); icon.innerHTML = isFolder ? ICON_FOLDER : ICON_SHEET;
      var node = el('div', { class: 'f-item' + (isFolder ? ' is-folder' : '') + (isSel(k) ? ' sel' : ''), role: 'option', tabindex: '0',
        'aria-selected': String(isSel(k)), draggable: 'false', 'data-dragkey': editing ? null : k, 'data-key': k, title: name });
      node.appendChild(icon);
      if (editing) {
        var f = keyFolder(k);
        var inp = el('input', { type: 'text', class: 'f-rename', value: f.name, maxlength: '80', 'aria-label': 'Nom du dossier' });
        var done = false;
        var commit = function (keep) {
          if (done) return; done = true;
          var nm = cleanFolderName(inp.value);
          if (keep && nm && norm(nm) !== norm(f.name)) {
            if (childFolders(f.parent || '').some(function (x) { return x !== f && norm(x.name) === norm(nm); })) toast('Un dossier « ' + nm + ' » existe déjà ici.');
            else f.name = nm;
          }
          org.editing = null; saveStore(); org.focus = k; draw(); renderList();
        };
        inp.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') commit(true); if (e.key === 'Escape') commit(false); });
        inp.addEventListener('blur', function () { commit(true); });
        inp.addEventListener('click', function (e) { e.stopPropagation(); });
        node.appendChild(inp);
        setTimeout(function () { inp.focus(); inp.select(); }, 0);
      } else {
        node.appendChild(el('span', { class: 'f-name', text: name }));
      }
      if (meta) node.appendChild(el('span', { class: 'f-meta', text: meta }));

      function open() {
        if (isFolder) { setOrgFolder(k.slice(2)); org.q = ''; search.value = ''; draw(); renderList(); }
        else location.hash = k.slice(2);
      }
      node.addEventListener('click', function (e) {
        if (editing) return;
        if (coarse.matches && isFolder && !e.metaKey && !e.ctrlKey && !e.shiftKey) { open(); return; }
        if (e.shiftKey && org.anchor && keys.indexOf(org.anchor) !== -1) {
          var a = keys.indexOf(org.anchor), b = keys.indexOf(k);
          var range = keys.slice(Math.min(a, b), Math.max(a, b) + 1);
          org.sel = (e.metaKey || e.ctrlKey) ? org.sel.concat(range.filter(function (x) { return !isSel(x); })) : range;
        } else if (e.metaKey || e.ctrlKey || coarse.matches) {
          org.sel = isSel(k) ? org.sel.filter(function (x) { return x !== k; }) : org.sel.concat([k]);
          org.anchor = k;
        } else { org.sel = [k]; org.anchor = k; }
        org.confirm = false; org.focus = k; draw();
      });
      node.addEventListener('dblclick', function () { if (!editing) open(); });
      node.addEventListener('keydown', function (e) {
        if (editing) return;
        if (e.key === 'Enter') { e.preventDefault(); open(); }
        if (e.key === ' ') { e.preventDefault(); org.sel = isSel(k) ? org.sel.filter(function (x) { return x !== k; }) : org.sel.concat([k]); org.anchor = k; org.focus = k; draw(); }
      });
      if (isFolder) dropTarget(node, k.slice(2));
      return node;
    }

    function treeList(pid, all) {
      var ul = el('ul', { role: 'group' });
      childFolders(pid).forEach(function (f) {
        var kids = childFolders(f.id).length;
        var row = el('div', { class: 'f-node' + (ui.folder === f.id ? ' cur' : '') });
        row.appendChild(kids
          ? el('button', { type: 'button', class: 'f-tog', 'aria-expanded': String(!!org.open[f.id]), 'aria-label': (org.open[f.id] ? 'Replier ' : 'Déplier ') + f.name,
              text: org.open[f.id] ? '▾' : '▸', onclick: function () { org.open[f.id] = !org.open[f.id]; draw(); } })
          : el('span', { class: 'f-tog' }));
        var lab = el('button', { type: 'button', class: 'f-lab', 'aria-current': ui.folder === f.id ? 'location' : null, onclick: function () { setOrgFolder(f.id); org.q = ''; search.value = ''; draw(); renderList(); } }, [
          el('span', { class: 'f-mini', 'aria-hidden': 'true' }), el('span', { class: 'f-lt', text: f.name }), el('span', { class: 'f-c num', text: String(folderCount(f.id, all)) })
        ]);
        row.appendChild(lab);
        dropTarget(row, f.id);
        var li = el('li', null, [row]);
        if (kids && org.open[f.id]) li.appendChild(treeList(f.id, all));
        ul.appendChild(li);
      });
      return ul;
    }

    function draw() {
      var paneTop = pane.scrollTop;
      var all = allRecipes();
      var cur = ui.folder;
      var q = norm(org.q.trim());
      var words = q ? q.split(/\s+/) : [];
      var hit = function (s) { var n = norm(s); return words.every(function (w) { return n.indexOf(w) !== -1; }); };
      var folders = q ? store.folders.filter(function (f) { return hit(f.name); }).sort(function (a, b) { return a.name.localeCompare(b.name, 'fr'); }) : childFolders(cur);
      var recs = q ? all.filter(function (r) { return hit(r.title); }) : all.filter(function (r) { return folderOf(r.id) === cur; });
      keys = folders.map(function (f) { return 'f:' + f.id; }).concat(recs.map(function (r) { return 'r:' + r.id; }));
      org.sel = org.sel.filter(function (k) { return keys.indexOf(k) !== -1; });
      var selFolders = org.sel.map(keyFolder).filter(Boolean);

      // Fil d'Ariane (chaque niveau reçoit aussi les fiches glissées)
      crumbs.textContent = '';
      var rootC = el('button', { type: 'button', class: 'f-crumb' + (!cur && !q ? ' here' : ''), text: 'Toutes', onclick: function () { setOrgFolder(''); org.q = ''; search.value = ''; draw(); renderList(); } });
      dropTarget(rootC, ''); crumbs.appendChild(rootC);
      if (q) crumbs.appendChild(el('span', { class: 'f-crumb here', text: '/ Recherche' }));
      else folderPath(cur).forEach(function (f, i, arr) {
        crumbs.appendChild(el('span', { class: 'sep', 'aria-hidden': 'true', text: '/' }));
        var c = el('button', { type: 'button', class: 'f-crumb' + (i === arr.length - 1 ? ' here' : ''), text: f.name, onclick: function () { setOrgFolder(f.id); draw(); renderList(); } });
        dropTarget(c, f.id); crumbs.appendChild(c);
      });

      // Boutons
      acts.textContent = '';
      acts.appendChild(el('button', { type: 'button', class: 'btn', text: 'Nouveau dossier', onclick: newFolder }));
      acts.appendChild(el('button', { type: 'button', class: 'btn ghost', text: 'Déplacer vers…', disabled: !org.sel.length, onclick: function () { org.moving = true; org.confirm = false; draw(); } }));
      if (selFolders.length === 1 && org.sel.length === 1) acts.appendChild(el('button', { type: 'button', class: 'btn ghost', text: 'Renommer', onclick: function () { org.editing = selFolders[0].id; draw(); } }));
      if (selFolders.length) acts.appendChild(el('button', { type: 'button', class: 'btn ghost', text: selFolders.length > 1 ? 'Supprimer les dossiers' : 'Supprimer le dossier', onclick: function () { org.confirm = true; draw(); } }));

      // Colonne de gauche
      side.textContent = '';
      var rootRow = el('div', { class: 'f-node root' + (!cur && !q ? ' cur' : '') }, [
        el('button', { type: 'button', class: 'f-lab', 'aria-current': !cur && !q ? 'location' : null, onclick: function () { setOrgFolder(''); org.q = ''; search.value = ''; draw(); renderList(); } }, [
          el('span', { class: 'f-lt', text: 'Toutes les recettes' }), el('span', { class: 'f-c num', text: String(all.length) })
        ])
      ]);
      dropTarget(rootRow, '');
      side.appendChild(el('p', { class: 'f-side-h', text: 'Dossiers' }));
      side.appendChild(rootRow);
      if (store.folders.length) side.appendChild(treeList('', all));
      else side.appendChild(el('p', { class: 'f-empty-side', text: 'Aucun dossier pour l’instant.' }));

      // Contenu
      pane.textContent = '';
      var grid = el('div', { class: 'f-grid', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Contenu du dossier' });
      folders.forEach(function (f) {
        var n = folderCount(f.id, all);
        grid.appendChild(itemNode('f:' + f.id, f.name, q ? folderPath(f.id).slice(0, -1).map(function (x) { return x.name; }).join(' / ') || 'Toutes' : n + ' fiche' + (n > 1 ? 's' : ''), true));
      });
      recs.forEach(function (r) {
        var meta = q ? (folderOf(r.id) ? folderPath(folderOf(r.id)).map(function (x) { return x.name; }).join(' / ') : 'Hors dossier') : CAT_LABEL[r.category] || '';
        grid.appendChild(itemNode('r:' + r.id, r.title, meta, false));
      });
      if (!keys.length) pane.appendChild(el('p', { class: 'f-empty', text: q ? 'Aucune fiche ne s’appelle ainsi.' : 'Dossier vide. Glissez-y des fiches, ou cherchez-les ci-dessus pour les sélectionner.' }));
      else pane.appendChild(grid);
      pane.scrollTop = paneTop;

      // Barre d'état
      status.textContent = '';
      if (org.confirm && selFolders.length) {
        var box = el('div', { class: 'confirm', role: 'alertdialog' }, [
          el('p', { text: 'Supprimer ' + (selFolders.length > 1 ? selFolders.length + ' dossiers' : 'le dossier « ' + selFolders[0].name + ' »') + ' ? Leur contenu remonte d’un niveau, aucune recette n’est effacée.' }),
          el('div', { class: 'ed-actions' }, [
            el('button', { type: 'button', class: 'btn danger-solid', text: 'Supprimer', onclick: function () {
              selFolders.forEach(deleteFolder); saveStore(); toast(selFolders.length > 1 ? 'Dossiers supprimés' : 'Dossier supprimé');
              org.confirm = false; org.sel = []; draw(); renderList();
            } }),
            el('button', { type: 'button', class: 'btn ghost', text: 'Annuler', onclick: function () { org.confirm = false; draw(); } })
          ])
        ]);
        status.appendChild(box);
      } else {
        var nSel = org.sel.length;
        status.appendChild(el('span', { class: 'num', text: keys.length + ' élément' + (keys.length > 1 ? 's' : '') + (nSel ? ' · ' + nSel + ' sélectionné' + (nSel > 1 ? 's' : '') : '') }));
        if (keys.length) status.appendChild(el('button', { type: 'button', class: 'link', text: nSel === keys.length ? 'Tout désélectionner' : 'Tout sélectionner',
          onclick: function () { if (nSel === keys.length) org.sel = []; else org.sel = keys.slice(); draw(); } }));
      }

      // Feuille « Déplacer vers… »
      sheet.textContent = '';
      if (org.moving && org.sel.length) {
        var dests = [{ id: '', name: 'Toutes (hors dossier)', depth: 0 }].concat(folderTree().map(function (t) { return { id: t.f.id, name: t.f.name, depth: t.depth + 1 }; }));
        var close = function () { org.moving = false; draw(); };
        var panel = el('div', { class: 'f-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Déplacer vers' }, [
          el('h3', { text: 'Déplacer ' + org.sel.length + ' élément' + (org.sel.length > 1 ? 's' : '') + ' vers' }),
          el('ul', null, dests.map(function (d) {
            var ok = org.sel.some(function (k) { return canMoveKey(k, d.id); });
            return el('li', null, [el('button', { type: 'button', class: 'f-dest', disabled: !ok, style: '--d:' + d.depth, onclick: function () {
              if (moveKeys(org.sel, d.id)) { org.sel = []; }
              org.moving = false; draw(); renderList();
            } }, [d.id ? el('span', { class: 'f-mini', 'aria-hidden': 'true' }) : null, el('span', { text: d.name })])]);
          })),
          el('div', { class: 'ed-actions' }, [
            el('button', { type: 'button', class: 'btn ghost', text: 'Nouveau dossier ici', onclick: function () {
              var pid = ui.folder; var f = { id: newFolderId(), name: uniqueFolderName(pid, 'Nouveau dossier'), parent: pid };
              store.folders.push(f); saveStore(); org.open[pid] = true; draw();
            } }),
            el('button', { type: 'button', class: 'btn ghost', text: 'Annuler', onclick: close })
          ])
        ]);
        sheet.appendChild(el('div', { class: 'f-scrim', onclick: close }));
        sheet.appendChild(panel);
        setTimeout(function () { var b = panel.querySelector('.f-dest:not([disabled])'); if (b) b.focus(); }, 0);
      }

      if (org.focus) {
        var fn = pane.querySelector('[data-key="' + org.focus + '"]');
        if (fn && !org.editing && !org.moving) fn.focus({ preventScroll: true });
        org.focus = null;
      }
    }

    function newFolder() {
      var pid = org.q ? '' : ui.folder;
      if (org.q) { org.q = ''; search.value = ''; }
      var f = { id: newFolderId(), name: uniqueFolderName(pid, 'Nouveau dossier'), parent: pid };
      store.folders.push(f); saveStore();
      if (pid) org.open[pid] = true;
      org.sel = ['f:' + f.id]; org.anchor = 'f:' + f.id; org.editing = f.id;
      draw(); renderList();
      var n = pane.querySelector('[data-key="f:' + f.id + '"]');
      if (n) n.scrollIntoView({ block: 'nearest' });
    }

    org.redraw = draw;
    draw();
    if (org.pendingNew) { org.pendingNew = false; newFolder(); }
  }

  // ---------- Glisser-déposer (souris et doigt) ----------
  // Tout élément [data-dragkey] (« r:id » fiche, « f:id » dossier) se glisse sur un [data-drop] (id du dossier, '' = hors dossier).
  // Souris : on attrape et on bouge. Doigt : appui long (≈ 0,35 s), puis on glisse ; un glissé rapide fait défiler normalement.
  var drag = null, swallowClick = false;
  function dragKeysFor(src) {
    var k = src.getAttribute('data-dragkey');
    if (src.classList.contains('f-item')) {
      if (org.sel.indexOf(k) === -1) { org.sel = [k]; org.anchor = k; src.classList.add('sel'); }
      return org.sel.slice();
    }
    return [k];
  }
  function dragLabel(keys) {
    if (keys.length > 1) return keys.length + ' éléments';
    var k = keys[0], id = k.slice(2);
    if (k.charAt(0) === 'f') { var f = folderById(id); return f ? f.name : ''; }
    var r = getRecipe(id); return r ? r.title : '';
  }
  function dropAt(x, y) {
    var n = document.elementFromPoint(x, y);
    n = n && n.closest('[data-drop]');
    if (!n) return null;
    var fid = n.getAttribute('data-drop');
    return drag.keys.some(function (k) { return canMoveKey(k, fid); }) ? n : null;
  }
  function scrollerAt(x, y) {
    var n = document.elementFromPoint(x, y);
    while (n && n !== document.body) {
      var oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
      n = n.parentElement;
    }
    return null;
  }
  function beginDrag() {
    drag.keys = dragKeysFor(drag.src);
    drag.active = true;
    drag.src.classList.add('dragged');
    var n = drag.keys.length;
    drag.ghost = el('div', { class: 'drag-ghost', 'aria-hidden': 'true' }, [
      el('span', { class: 'drag-ghost-t', text: dragLabel(drag.keys) }),
      n > 1 ? el('span', { class: 'drag-ghost-n num', text: String(n) }) : null
    ]);
    document.body.appendChild(drag.ghost);
    document.documentElement.classList.add('is-dragging');
    if (drag.touch && navigator.vibrate) try { navigator.vibrate(12); } catch (e) {}
    drag.tick = setInterval(autoScroll, 30);
    moveDrag(drag.x, drag.y);
  }
  function moveDrag(x, y) {
    drag.x = x; drag.y = y;
    drag.ghost.style.transform = 'translate(' + (x + 14) + 'px,' + (y + 10) + 'px)';
    var t = dropAt(x, y);
    if (t !== drag.over) {
      if (drag.over) drag.over.classList.remove('drop');
      drag.over = t;
      if (t) t.classList.add('drop');
    }
  }
  function autoScroll() {
    if (!drag || !drag.active) return;
    var y = drag.y, edge = 48, sp = 0;
    var sc = scrollerAt(drag.x, y);
    if (sc) {
      var r = sc.getBoundingClientRect();
      if (y < r.top + edge) sp = -Math.ceil((r.top + edge - y) / 4);
      else if (y > r.bottom - edge) sp = Math.ceil((y - r.bottom + edge) / 4);
      if (sp) { sc.scrollTop += sp; moveDrag(drag.x, drag.y); return; }
    }
    if (y < edge) sp = -Math.ceil((edge - y) / 4);
    else if (y > window.innerHeight - edge) sp = Math.ceil((y - window.innerHeight + edge) / 4);
    if (sp) { window.scrollBy(0, sp); moveDrag(drag.x, drag.y); }
  }
  function endDrag(drop) {
    var d = drag; drag = null;
    if (!d) return;
    clearTimeout(d.timer);
    if (!d.active) return;
    clearInterval(d.tick);
    d.ghost.remove();
    d.src.classList.remove('dragged');
    document.documentElement.classList.remove('is-dragging');
    swallowClick = true; setTimeout(function () { swallowClick = false; }, 60);
    if (d.over) d.over.classList.remove('drop');
    if (drop && d.over && moveKeys(d.keys, d.over.getAttribute('data-drop'))) {
      org.sel = [];
      renderList();
      if (location.hash === '#ranger' && org.redraw) org.redraw();
      else if (currentId() && d.keys.indexOf('r:' + currentId()) !== -1) route();
    }
  }
  function dragSource(t) {
    if (!t || !t.closest || t.closest('input, textarea, select')) return null;
    return t.closest('[data-dragkey]');
  }
  // Souris / stylet
  document.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'touch' || e.button !== 0 || drag) return;
    var src = dragSource(e.target); if (!src) return;
    drag = { src: src, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, active: false };
  });
  document.addEventListener('pointermove', function (e) {
    if (!drag || drag.touch) return;
    if (!drag.active) {
      if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) < 6) return;
      drag.x = e.clientX; drag.y = e.clientY; beginDrag();
    }
    e.preventDefault();
    moveDrag(e.clientX, e.clientY);
  });
  document.addEventListener('pointerup', function () { if (drag && !drag.touch) endDrag(true); });
  document.addEventListener('pointercancel', function () { if (drag && !drag.touch) endDrag(false); });
  // Doigt
  document.addEventListener('touchstart', function (e) {
    if (drag || e.touches.length !== 1) { if (drag && !drag.active) endDrag(false); return; }
    var src = dragSource(e.target); if (!src) return;
    var t = e.touches[0];
    drag = { src: src, touch: true, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY, active: false };
    drag.timer = setTimeout(function () { if (drag && !drag.active) beginDrag(); }, 350);
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    if (!drag || !drag.touch) return;
    var t = e.touches[0];
    if (!drag.active) {
      if (Math.abs(t.clientX - drag.x0) + Math.abs(t.clientY - drag.y0) > 10) endDrag(false); // c'est un défilement
      return;
    }
    e.preventDefault();
    moveDrag(t.clientX, t.clientY);
  }, { passive: false });
  document.addEventListener('touchend', function (e) {
    if (!drag || !drag.touch) return;
    if (drag.active) e.preventDefault();
    endDrag(true);
  }, { passive: false });
  document.addEventListener('touchcancel', function () { if (drag && drag.touch) endDrag(false); });
  document.addEventListener('click', function (e) { if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopPropagation(); } }, true);
  document.addEventListener('contextmenu', function (e) { if (drag || dragSource(e.target) && coarse.matches) e.preventDefault(); });
  document.addEventListener('dragstart', function (e) { if (dragSource(e.target)) e.preventDefault(); });

  // ---------- Sauvegarde ----------
  function renderBackup() {
    var n = Object.keys(store.mine).length;
    var nf = store.folders.length;
    var data = JSON.stringify({ format: 'recettes-lucie', version: 1, mine: store.mine, hidden: store.hidden, folders: store.folders, place: store.place }, null, 1);
    var out = el('textarea', { id: 'bk-out', readonly: true, 'aria-label': 'Sauvegarde' });
    out.value = data;
    var inp = el('textarea', { id: 'bk-in', 'aria-label': 'Sauvegarde à importer', placeholder: 'Coller ici une sauvegarde…' });
    var file = el('input', { id: 'bk-file', type: 'file', accept: 'application/json,.json,.txt' });
    var msg = el('p', { class: 'err', role: 'status' });

    function importText(txt) {
      try {
        var d = JSON.parse(txt);
        if (!d || d.format !== 'recettes-lucie') throw new Error();
        Object.keys(d.mine || {}).forEach(function (k) { store.mine[k] = d.mine[k]; });
        (d.hidden || []).forEach(function (k) { if (store.hidden.indexOf(k) === -1) store.hidden.push(k); });
        (d.folders || []).forEach(function (f) {
          if (!f || !f.id || !f.name) return;
          var ex = folderById(f.id);
          if (ex) { ex.name = f.name; ex.parent = f.parent || ''; } else store.folders.push({ id: f.id, name: String(f.name), parent: f.parent || '' });
        });
        Object.keys(d.place || {}).forEach(function (k) { store.place[k] = d.place[k]; });
        if (saveStore()) { toast(Object.keys(d.mine || {}).length + ' recette(s) et ' + (d.folders || []).length + ' dossier(s) importé(s)'); route(); }
      } catch (e) { msg.textContent = 'Ce texte n’est pas une sauvegarde des recettes de Lucie.'; }
    }
    file.addEventListener('change', function () {
      var f = file.files && file.files[0]; if (!f) return;
      var fr = new FileReader(); fr.onload = function () { importText(String(fr.result)); }; fr.readAsText(f);
    });

    var dl = el('a', { class: 'btn ghost', href: 'data:application/json;charset=utf-8,' + encodeURIComponent(data), download: 'recettes-lucie.json', text: 'Télécharger le fichier' });

    $main.appendChild(el('div', { class: 'panel' }, [
      backLink(),
      el('h2', { text: 'Sauvegarde' }),
      el('p', { text: n || nf
        ? n + ' recette(s) ajoutée(s) ou modifiée(s) et ' + nf + ' dossier(s) sont enregistrés ' + (sync.live
          ? 'dans la base de données du site : ils se retrouvent sur tous les appareils. La sauvegarde ci-dessous reste une copie de secours.'
          : 'dans ce navigateur. Pour les garder en sécurité ou les retrouver sur un autre appareil, copiez la sauvegarde ci-dessous et importez-la de l’autre côté.')
        : 'Aucune recette ajoutée ou modifiée et aucun dossier pour l’instant. Les fiches d’origine sont toujours là, inutile de les sauvegarder.' }),
      out,
      el('div', { class: 'ed-actions' }, [
        el('button', { type: 'button', class: 'btn', text: 'Copier la sauvegarde', onclick: function () {
          var p = navigator.clipboard && navigator.clipboard.writeText(data);
          if (p) p.then(function () { toast('Sauvegarde copiée'); }, function () { out.select(); toast('Sélectionnée : copiez avec Ctrl+C'); });
          else { out.select(); toast('Sélectionnée : copiez avec Ctrl+C'); }
        } }),
        dl
      ]),
      store.hidden.length ? el('h2', { text: 'Recettes supprimées' }) : null,
      store.hidden.length ? el('p', { text: 'Fiches d\u2019origine retirées de la liste. Elles peuvent être rétablies à tout moment.' }) : null,
      store.hidden.length ? el('ul', { class: 'restore' }, store.hidden.filter(function (id) { return BASE[id]; }).map(function (id) {
        return el('li', null, [
          el('span', { text: BASE[id].title }),
          el('button', { type: 'button', class: 'btn ghost', text: 'Rétablir', onclick: function () {
            store.hidden.splice(store.hidden.indexOf(id), 1);
            if (saveStore()) { toast('« ' + BASE[id].title + ' » rétablie'); route(); }
          } })
        ]);
      })) : null,
      el('h2', { text: 'Importer' }),
      el('p', { text: 'Collez une sauvegarde ou choisissez un fichier. Les recettes importées s’ajoutent à celles déjà présentes.' }),
      inp,
      el('div', { class: 'ed-actions' }, [
        el('button', { type: 'button', class: 'btn', text: 'Importer le texte collé', onclick: function () { importText(inp.value); } }),
        el('label', { class: 'btn ghost', for: 'bk-file' }, ['Choisir un fichier']),
        file
      ]),
      msg,
      window.RL_USER ? el('h2', { text: 'Compte' }) : null,
      window.RL_USER ? el('p', { text: 'Connecté avec ' + window.RL_USER.email + '. La connexion reste active sur cet appareil : inutile de se reconnecter.' }) : null,
      window.RL_USER ? el('div', { class: 'ed-actions' }, [
        el('button', { type: 'button', class: 'btn ghost', text: 'Se déconnecter de cet appareil', onclick: function () { window.RL_USER.signOut(); } })
      ]) : null
    ]));
    file.className = 'visually-hidden';
  }

  renderCats();
  route();
  connectDb();
})();
