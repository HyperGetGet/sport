/* Mon Sport : sauvegarde et synchronisation dans Firebase (projet mon-sport).
   Le téléphone reste la source immédiate : tout est d'abord enregistré sur l'appareil,
   puis envoyé dans le cloud dès que le réseau est là. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut as fbSignOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore, doc, getDoc, getDocs, collection, onSnapshot, writeBatch, setDoc,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const CFG = {
  apiKey: 'AIzaSyCkx5YqjIT20WfPnxLxkQX3M2gxnBOv3FE',
  authDomain: 'mon-sport-b0896.firebaseapp.com',
  projectId: 'mon-sport-b0896',
  storageBucket: 'mon-sport-b0896.firebasestorage.app',
  messagingSenderId: '688909704958',
  appId: '1:688909704958:web:9dc438f42bbc287e478faf',
};
const MAX_DOC = 900 * 1024; // un document Firestore ne peut pas dépasser 1 Mio

let A = null; // passerelle vers l'appli (fonctions fournies par index.html)
let auth, db, uid = null, email = '', timer = null, busy = false, unsubs = [];

const DEV = (() => {
  try {
    let d = localStorage.getItem('sport.device');
    if (!d) { d = Math.random().toString(36).slice(2, 10); localStorage.setItem('sport.device', d); }
    return d;
  } catch (e) { return 'x'; }
})();

const P = {
  state: () => doc(db, 'users', uid, 'meta', 'state'),
  logs: () => collection(db, 'users', uid, 'logs'),
  log: (id) => doc(db, 'users', uid, 'logs', id),
  ideas: () => collection(db, 'users', uid, 'ideas'),
  idea: (id) => doc(db, 'users', uid, 'ideas', id),
  backup: (k) => doc(db, 'users', uid, 'backups', k),
};

const LOCAL_ONLY = ['logs', 'live', 'dirty', 'delLogs', 'syncedAt', 'lastBackup'];
function core(S) { const o = {}; Object.keys(S).forEach((k) => { if (LOCAL_ONLY.indexOf(k) < 0) o[k] = S[k]; }); return o; }
function cleanLog(l) { const o = Object.assign({}, l); delete o.sync; return o; }
function status(st, extra) { A.status(Object.assign({ state: st, email }, extra || {})); }
function errText(e) {
  const c = (e && e.code) || '';
  if (c.indexOf('popup-closed') >= 0 || c.indexOf('cancelled-popup') >= 0) return 'Connexion annulée';
  if (c.indexOf('unauthorized-domain') >= 0) return 'Adresse de l\'appli non autorisée dans Firebase';
  if (c.indexOf('network') >= 0 || c === 'unavailable') return 'Pas de réseau';
  if (c === 'permission-denied') return 'Accès refusé par la base';
  return (e && e.message) || String(e);
}

export function start(api) {
  A = api;
  const app = initializeApp(CFG);
  auth = getAuth(app);
  auth.languageCode = 'fr';
  db = initializeFirestore(app, {});
  getRedirectResult(auth).catch((e) => status('err', { msg: errText(e) }));
  onAuthStateChanged(auth, (u) => {
    unsubs.forEach((f) => f()); unsubs = [];
    if (u) {
      uid = u.uid; email = u.email || '';
      status('sync');
      firstSync().then(listen).catch((e) => status('err', { msg: errText(e) }));
    } else {
      uid = null; email = '';
      status('off');
    }
  });
  window.addEventListener('online', () => schedule(200));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(300); });
}

export function signIn() {
  const pr = new GoogleAuthProvider();
  pr.setCustomParameters({ prompt: 'select_account' });
  return signInWithPopup(auth, pr).catch((e) => {
    const c = (e && e.code) || '';
    if (c.indexOf('popup-blocked') >= 0 || c.indexOf('operation-not-supported') >= 0) return signInWithRedirect(auth, pr);
    status('off', { msg: errText(e) });
    throw e;
  });
}

export function signOut() { return fbSignOut(auth); }

export function schedule(ms) {
  if (!uid) return;
  clearTimeout(timer);
  timer = setTimeout(push, ms == null ? 1500 : ms);
}

export function syncNow() { if (!uid) return Promise.resolve(); return push(); }

/* Première synchro après connexion : on réunit ce qui est sur l'appareil et dans le cloud. */
async function firstSync() {
  const S = A.get();
  const [snap, rl] = await Promise.all([getDoc(P.state()), getDocs(P.logs())]);
  const del = S.delLogs || [];
  const have = {}; S.logs.forEach((l) => { have[l.id] = 1; });
  let added = 0;
  rl.forEach((d) => {
    if (have[d.id] || del.indexOf(d.id) >= 0) return;
    try { const l = JSON.parse(d.data().json); l.sync = 1; S.logs.push(l); added++; } catch (e) { /* document illisible : ignoré */ }
  });
  if (added) S.logs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (snap.exists()) {
    const r = snap.data();
    // Appareil jamais synchronisé : le cloud fait foi pour le programme et les réglages.
    const adopt = !S.syncedAt || (!S.dirty && r.updatedAt > (S.updatedAt || 0)) || (S.dirty && r.updatedAt > (S.updatedAt || 0) && r.device !== DEV);
    if (adopt) applyRemote(S, r);
    else S.dirty = true;
  } else {
    S.dirty = true;
  }
  S.logs.forEach((l) => { if (l.sync === undefined) l.sync = 0; });
  A.replace(S);
  await pullIdeas();
  await push(true);
}

function applyRemote(S, r) {
  let c;
  try { c = JSON.parse(r.json); } catch (e) { return; }
  const keep = { logs: S.logs, live: S.live, delLogs: S.delLogs || [], lastBackup: S.lastBackup, syncedAt: Date.now() };
  Object.keys(S).forEach((k) => { if (LOCAL_ONLY.indexOf(k) < 0) delete S[k]; });
  Object.assign(S, c, keep, { updatedAt: r.updatedAt, dirty: false });
}

async function pullIdeas() {
  try {
    const qs = await getDocs(P.ideas());
    const local = await A.ideas.all();
    const have = {}; local.forEach((x) => { have[x.id] = 1; });
    const adds = [];
    qs.forEach((d) => { if (!have[d.id]) adds.push(Object.assign({}, d.data(), { cloud: true })); });
    for (const x of adds) await A.ideas.put(x);
    if (adds.length) A.ideas.reload();
  } catch (e) { /* les idées se rattraperont à la prochaine synchro */ }
}

/* Envoi vers le cloud de tout ce qui n'y est pas encore. */
async function push(force) {
  if (!uid) return;
  if (busy) { schedule(1500); return; }
  if (!navigator.onLine) { status('offline'); return; }
  busy = true;
  status('sync');
  const S = A.get();
  const u0 = S.updatedAt;
  try {
    const ops = [];
    if (S.dirty || force) ops.push(['set', P.state(), { json: JSON.stringify(core(S)), updatedAt: S.updatedAt || Date.now(), device: DEV, v: A.version }]);
    const pend = S.logs.filter((l) => !l.sync);
    pend.forEach((l) => ops.push(['set', P.log(l.id), { json: JSON.stringify(cleanLog(l)), date: l.date, name: l.name || '', updatedAt: Date.now() }]));
    const dels = (S.delLogs || []).slice();
    dels.forEach((id) => ops.push(['del', P.log(id)]));
    // Sauvegarde complète une fois par semaine (copie de secours en plus des données vivantes).
    const wk = A.weekKey();
    let bk = false;
    if (S.lastBackup !== wk) {
      const j = JSON.stringify({ core: core(S), logs: S.logs.map(cleanLog) });
      if (j.length < MAX_DOC) { ops.push(['set', P.backup(wk), { json: j, at: Date.now(), v: A.version }]); bk = true; }
    }
    for (let i = 0; i < ops.length; i += 400) {
      const b = writeBatch(db);
      ops.slice(i, i + 400).forEach((o) => { if (o[0] === 'set') b.set(o[1], o[2]); else b.delete(o[1]); });
      await b.commit();
    }
    const S2 = A.get();
    if (S2.updatedAt === u0) S2.dirty = false;
    pend.forEach((l) => { l.sync = 1; });
    S2.delLogs = (S2.delLogs || []).filter((id) => dels.indexOf(id) < 0);
    if (bk) S2.lastBackup = wk;
    S2.syncedAt = Date.now();
    A.saveLocal();
    await pushIdeas();
    status('ok', { at: Date.now() });
  } catch (e) {
    status('err', { msg: errText(e) });
    clearTimeout(timer); timer = setTimeout(push, 30000); // nouvel essai automatique
  } finally {
    busy = false;
    const S3 = A.get();
    if (S3.dirty && S3.updatedAt !== u0) schedule(1500);
  }
}

async function pushIdeas() {
  const all = await A.ideas.all();
  for (const x of all) {
    if (x.cloud) continue;
    const o = Object.assign({}, x);
    delete o.cloud;
    // Si les captures dépassent la taille d'un document, on retire les dernières.
    while (o.imgs && o.imgs.length && JSON.stringify(o).length > MAX_DOC) o.imgs = o.imgs.slice(0, -1);
    await setDoc(P.idea(x.id), o);
    x.cloud = true;
    await A.ideas.put(x);
  }
}

/* Changements faits sur un autre appareil (téléphone, écran du sous-sol…). */
function listen() {
  unsubs.push(onSnapshot(P.state(), (snap) => {
    if (!snap.exists() || snap.metadata.hasPendingWrites) return;
    const r = snap.data(), S = A.get();
    if (r.device === DEV || S.dirty || S.live) return;
    if (r.updatedAt > (S.updatedAt || 0)) { applyRemote(S, r); A.replace(S); }
  }, () => {}));
  unsubs.push(onSnapshot(P.logs(), (qs) => {
    if (qs.metadata.hasPendingWrites) return;
    const S = A.get();
    let ch = false;
    qs.docChanges().forEach((c) => {
      const i = S.logs.findIndex((l) => l.id === c.doc.id);
      if (c.type === 'removed') { if (i >= 0) { S.logs.splice(i, 1); ch = true; } return; }
      if (i >= 0 || (S.delLogs || []).indexOf(c.doc.id) >= 0) return;
      try { const l = JSON.parse(c.doc.data().json); l.sync = 1; S.logs.push(l); ch = true; } catch (e) { /* ignoré */ }
    });
    if (ch) { S.logs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)); A.replace(S); }
  }, () => {}));
}

export async function delIdea(id) {
  if (!uid) return;
  const { deleteDoc } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
  await deleteDoc(P.idea(id));
}
