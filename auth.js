/* Les recettes de Lucie — porte d'entrée.
   1. Connexion Google (Firebase Auth), gardée sur l'appareil : on ne se connecte qu'une fois.
   2. Lecture des recettes dans Firestore. Les règles Firestore n'acceptent que les comptes autorisés :
      un autre compte Google ne voit rien, même en fouillant le code du site.
   3. Lancement du site (app.js), avec la base partagée pour enregistrer dossiers et modifications. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserPopupRedirectResolver,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut,
  connectAuthEmulator
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, setDoc, deleteDoc, getDoc, getDocs, getDocsFromCache, onSnapshot, writeBatch,
  terminate, clearIndexedDbPersistence, connectFirestoreEmulator
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const card = document.getElementById('gate-card');
const STORE_KEY = 'recettes-lucie-v1';

// ---------- Petits outils d'affichage ----------
function h(tag, attrs, kids) {
  const n = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (v == null || v === false) return;
    if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  });
  (kids || []).forEach((c) => c != null && n.append(c));
  return n;
}
const G_LOGO = '<svg class="gate-g" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.2 1.5-5 2.3-8.2 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';
function googleButton(label, onclick) {
  const b = h('button', { type: 'button', class: 'btn', onclick });
  b.innerHTML = G_LOGO;
  b.append(label);
  return b;
}
function show(...kids) {
  card.replaceChildren(
    h('h1', { text: 'Les recettes de Lucie' }),
    h('p', { class: 'kicker', text: 'Fiches techniques' }),
    ...kids.filter(Boolean)
  );
}
const say = (text, cls) => h('p', { text, class: cls });

// ---------- Firebase ----------
if (!firebaseConfig || !firebaseConfig.apiKey || /A_REMPLACER/.test(firebaseConfig.apiKey)) {
  show(say('Le site n’est pas encore relié à Firebase.', 'err'),
    say('Remplissez le fichier firebase-config.js avec la configuration de votre projet Firebase (voir le guide).', 'small'));
  throw new Error('firebase-config.js non rempli');
}
const app = initializeApp(firebaseConfig);
const auth = initializeAuth(app, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence],
  popupRedirectResolver: browserPopupRedirectResolver
});
auth.languageCode = 'fr';
let db;
try {
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
} catch (e) { db = getFirestore(app); }

// Essais en local uniquement : http://localhost:…/?emulateur
const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
if (local && new URLSearchParams(location.search).has('emulateur')) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

// ---------- Connexion ----------
async function login(chooseAccount) {
  const provider = new GoogleAuthProvider();
  if (chooseAccount) provider.setCustomParameters({ prompt: 'select_account' });
  show(say('Connexion…'));
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    const code = e && e.code;
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
      return signInWithRedirect(auth, provider);
    }
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request' || code === 'auth/user-cancelled') {
      return askLogin();
    }
    askLogin(loginError(e));
  }
}
function loginError(e) {
  const code = (e && e.code) || '';
  console.warn('Connexion Google impossible', e);
  if (code === 'auth/unauthorized-domain') return 'Cette adresse de site n’est pas autorisée dans Firebase (Authentication > Paramètres > Domaines autorisés).';
  if (code === 'auth/operation-not-allowed') return 'La connexion Google n’est pas activée dans Firebase (Authentication > Mode de connexion).';
  if (code === 'auth/network-request-failed') return 'Pas de connexion internet. Réessayez dans un instant.';
  return 'La connexion n’a pas abouti. Réessayez.';
}
function askLogin(error) {
  show(
    error ? say(error, 'err') : null,
    say('Ce carnet est réservé à Lucie et Max. Connectez-vous avec votre compte Google : cet appareil s’en souviendra, il n’y aura plus besoin de le refaire.'),
    googleButton('Continuer avec Google', () => login(false))
  );
}
async function logout() {
  try { localStorage.removeItem(STORE_KEY); } catch (e) {}
  try { await signOut(auth); } catch (e) {}
  try { await terminate(db); await clearIndexedDbPersistence(db); } catch (e) {}
  location.reload();
}
function denied(user) {
  show(
    say('Le compte ' + (user.email || 'Google') + ' n’a pas accès à ces recettes.', 'err'),
    say('Choisissez le compte Google de Lucie ou de Max.'),
    googleButton('Utiliser un autre compte Google', async () => {
      try { await signOut(auth); } catch (e) {}
      login(true);
    })
  );
}

// ---------- Recettes ----------
// Les fiches d'origine sont rangées par paquets : base/p01, base/p02… { ordre, recettes: [...] }
async function loadBase() {
  const ref = collection(db, 'base');
  let snap;
  try { snap = await getDocs(ref); }
  catch (e) {
    if (e && e.code === 'permission-denied') throw e;
    snap = await getDocsFromCache(ref); // hors ligne : la copie gardée sur l'appareil
  }
  const parts = snap.docs.map((d) => d.data()).sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
  return parts.flatMap((p) => p.recettes || []);
}

// Import unique des fiches d'origine (fichier recettes-initiales.json), quand la base est vide.
function askImport() {
  const bar = h('i');
  const msg = say('', 'err');
  const input = h('input', { type: 'file', id: 'seed', accept: '.json,application/json', class: 'visually-hidden' });
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    msg.textContent = '';
    try {
      const d = JSON.parse(await f.text());
      if (!d || d.format !== 'recettes-lucie-depart' || !Array.isArray(d.recettes)) throw new Error('format');
      const size = 40, n = Math.ceil(d.recettes.length / size);
      for (let i = 0; i < n; i++) {
        const id = 'p' + String(i + 1).padStart(2, '0');
        await setDoc(doc(db, 'base', id), { ordre: i + 1, recettes: d.recettes.slice(i * size, (i + 1) * size) });
        bar.style.width = Math.round(((i + 1) / n) * 100) + '%';
      }
      location.reload();
    } catch (e) {
      console.warn(e);
      msg.textContent = e && e.message === 'format'
        ? 'Ce fichier n’est pas recettes-initiales.json.'
        : 'L’envoi a échoué (' + ((e && e.code) || 'erreur') + '). Réessayez.';
    }
  });
  show(
    say('La base de recettes est vide. Pour la remplir, choisissez le fichier recettes-initiales.json. À faire une seule fois.'),
    h('label', { class: 'btn', for: 'seed', text: 'Choisir recettes-initiales.json' }),
    input,
    h('div', { class: 'bar' }, [bar]),
    msg
  );
}

// ---------- Adaptateur de base pour app.js ----------
const wrapDoc = (s) => ({ id: s.id, exists: s.exists(), data: () => s.data(), metadata: s.metadata });
const wrapQuery = (q) => ({ docs: q.docs.map(wrapDoc), metadata: q.metadata });
function docApi(ref) {
  return {
    set: (data) => setDoc(ref, data),
    delete: () => deleteDoc(ref),
    get: () => getDoc(ref).then(wrapDoc),
    onSnapshot: (cb, err) => onSnapshot(ref, { includeMetadataChanges: true }, (s) => cb(wrapDoc(s)), err)
  };
}
function colApi(ref) {
  return {
    doc: (id) => docApi(doc(ref, id)),
    get: () => getDocs(ref).then(wrapQuery),
    onSnapshot: (cb, err) => onSnapshot(ref, { includeMetadataChanges: true }, (s) => cb(wrapQuery(s)), err)
  };
}
const RL_DB = { doc: (path) => docApi(doc(db, path)), collection: (path) => colApi(collection(db, path)) };

// ---------- Démarrage ----------
let started = false;
async function start(user) {
  show(say('Chargement des recettes…'));
  let recettes;
  try { recettes = await loadBase(); }
  catch (e) {
    if (e && e.code === 'permission-denied') return denied(user);
    console.warn(e);
    return show(say('Impossible de joindre la base de recettes. Vérifiez la connexion internet.', 'err'),
      h('button', { type: 'button', class: 'btn', text: 'Réessayer', onclick: () => start(user) }));
  }
  if (!recettes.length) return askImport();
  window.RECETTES = recettes;
  window.RL_DB = RL_DB;
  window.RL_USER = { email: user.email, signOut: logout };
  started = true;
  document.getElementById('gate').hidden = true;
  document.getElementById('app').hidden = false;
  document.body.append(h('script', { src: 'app.js' }));
}

getRedirectResult(auth).catch((e) => askLogin(loginError(e)));
onAuthStateChanged(auth, (user) => {
  if (started) { if (!user) location.reload(); return; }
  if (user) start(user); else askLogin();
});
