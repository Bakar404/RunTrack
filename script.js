// ============================================================================
// AI PLANNER CONFIGURATION
// ============================================================================
// The AI planner calls the Anthropic Messages API directly with the visitor's
// own API key. The default model can be overridden per browser in Settings.
const DEFAULT_AI_MODEL      = 'claude-sonnet-5-5';
const ANTHROPIC_API_URL     = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';

// ============================================================================
// SESSION AND STORAGE
// ============================================================================
// RunTrack runs in one of two modes:
//   guest   - plans and runs are kept in this browser's localStorage only.
//   account - optional sign-in; plans and runs sync through Cloud Firestore.
// Each mode has its own localStorage namespace (rt_guest_* or rt_<uid>_*), so
// guest data and account data never mix.

const SESSION_KEY      = 'runtrack_session';
const IMPORT_OFFER_KEY = 'runtrack_offer_import';
const GUEST_DATA_KEY   = 'rt_guest_data';
const DATA_VERSION     = 1;

let session = null;   // { mode: 'guest' } or { mode: 'account', uid, username }
let appData = { plans: [], runs: [], whoopRecovery: null };
let storageWarningShown = false;

function isAccountSession() {
  return !!session && session.mode === 'account';
}

function lsKey(key) {
  return `rt_${isAccountSession() ? session.uid : 'guest'}_${key}`;
}

function clearLocalNamespace(owner) {
  const prefix = `rt_${owner}_`;
  try {
    Object.keys(localStorage).filter(k => k.startsWith(prefix)).forEach(k => localStorage.removeItem(k));
  } catch (_) { /* storage unavailable */ }
}

function readGuestData() {
  const raw = storageGet(GUEST_DATA_KEY);
  if (!raw) return { plans: [], runs: [] };
  try {
    const parsed = JSON.parse(raw);
    const isRecord = item => !!item && typeof item === 'object' && typeof item.id === 'string';
    return {
      plans: Array.isArray(parsed?.plans) ? parsed.plans.filter(isRecord) : [],
      runs:  Array.isArray(parsed?.runs)  ? parsed.runs.filter(isRecord)  : []
    };
  } catch (_) {
    // Set unreadable data aside instead of overwriting it.
    storageSet(`${GUEST_DATA_KEY}_unreadable`, raw);
    storageRemove(GUEST_DATA_KEY);
    return { plans: [], runs: [] };
  }
}

function hasGuestData() {
  const guest = readGuestData();
  return guest.plans.length > 0 || guest.runs.length > 0;
}

function writeGuestData(data) {
  const saved = storageSet(GUEST_DATA_KEY, JSON.stringify({ version: DATA_VERSION, plans: data.plans, runs: data.runs }));
  if (!saved && !storageWarningShown) {
    storageWarningShown = true;
    showToast('This browser could not save your changes because its storage is full or turned off. Export your data from Settings to keep a copy.', 'error', 9000);
  }
}

function getStorage() { return appData; }

function setStorage(data) {
  data.plans = sortPlans(data.plans || []);
  data.runs  = data.runs || [];
  appData = data;
  if (isAccountSession()) CloudStore.save(data);
  else if (session) writeGuestData(data);
}

// JSON with sorted object keys, so equal records always serialize the same way.
function stableStringify(value) {
  return JSON.stringify(value, (key, val) => {
    if (!val || typeof val !== 'object' || Array.isArray(val)) return val;
    return Object.keys(val).sort().reduce((out, k) => { out[k] = val[k]; return out; }, {});
  });
}

function snapshotOf(records) {
  return new Map((records || []).map(record => [record.id, stableStringify(record)]));
}

function sameRecords(a, b) {
  const left = snapshotOf(a), right = snapshotOf(b);
  if (left.size !== right.size) return false;
  for (const [id, json] of left) if (right.get(id) !== json) return false;
  return true;
}

function replaceAppData(fresh) {
  appData = { plans: sortPlans(fresh.plans), runs: fresh.runs, whoopRecovery: appData.whoopRecovery };
  renderAll();
  updateHeaderInfo();
}

// ============================================================================
// OPTIONAL ACCOUNTS AND CLOUD SYNC (FIREBASE)
// ============================================================================
// The Firebase SDK loads only when someone signs in, so guest mode sends
// nothing to Google. The Firebase project settings live in config.js.

const FIREBASE_SDK_URL  = 'https://www.gstatic.com/firebasejs/10.12.2';
const USERNAME_PATTERN  = /^[A-Za-z0-9_]{3,24}$/;
const CLOUD_BATCH_LIMIT = 450;        // Firestore allows up to 500 writes per batch
const CLOUD_REFRESH_MS  = 60 * 1000;  // minimum gap between background refreshes
const UNSYNCED          = '';         // snapshot marker for a write that must be retried

let auth = null;
let db   = null;
let firebaseLoading = null;
let signingOut      = false;
let lastCloudLoad   = 0;

function firebaseConfig() {
  const config = window.RUNTRACK_CONFIG && window.RUNTRACK_CONFIG.firebase;
  return config && config.apiKey && config.projectId ? config : null;
}

function accountsEnabled() {
  return !!firebaseConfig();
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => { script.remove(); reject(new Error(`Could not load ${src}`)); };
    document.head.appendChild(script);
  });
}

function ensureFirebase() {
  if (!accountsEnabled()) return Promise.reject(new Error('Accounts are not enabled on this site.'));
  if (!firebaseLoading) {
    firebaseLoading = (async () => {
      if (!window.firebase) await loadScript(`${FIREBASE_SDK_URL}/firebase-app-compat.js`);
      const pending = [];
      if (!firebase.auth)      pending.push(loadScript(`${FIREBASE_SDK_URL}/firebase-auth-compat.js`));
      if (!firebase.firestore) pending.push(loadScript(`${FIREBASE_SDK_URL}/firebase-firestore-compat.js`));
      await Promise.all(pending);
      if (!firebase.apps.length) firebase.initializeApp(firebaseConfig());
      auth = firebase.auth();
      db   = firebase.firestore();
      // Keep an offline copy so changes made without a connection sync later.
      await db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
    })().catch(error => {
      firebaseLoading = null;
      throw error;
    });
  }
  return firebaseLoading;
}

// Plans and runs are stored as users/{uid}/plans/{id} and users/{uid}/runs/{id}.
// Saves compare against the last synced snapshot and only write what changed,
// including deletes.
const CloudStore = {
  uid: null,
  synced: { plans: new Map(), runs: new Map() },
  inflight: new Set(),
  saveCount: 0,
  lastErrorAt: 0,

  ref(name, id) {
    return db.collection('users').doc(this.uid).collection(name).doc(id);
  },

  async fetch(uid) {
    const user = db.collection('users').doc(uid);
    const [plans, runs] = await Promise.all([user.collection('plans').get(), user.collection('runs').get()]);
    const toRecords = snap => snap.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    return { plans: toRecords(plans), runs: toRecords(runs) };
  },

  adopt(uid, data) {
    this.uid = uid;
    this.synced = { plans: snapshotOf(data.plans), runs: snapshotOf(data.runs) };
  },

  hasUnsynced() {
    return [...this.synced.plans.values(), ...this.synced.runs.values()].includes(UNSYNCED);
  },

  busy() {
    return this.inflight.size > 0 || this.hasUnsynced();
  },

  save(data) {
    if (!this.uid || !db) return Promise.resolve(false);
    this.saveCount++;
    const ops = [];
    for (const name of ['plans', 'runs']) {
      const next = snapshotOf(data[name]);
      const prev = this.synced[name];
      next.forEach((json, id) => { if (prev.get(id) !== json) ops.push({ name, id, json }); });
      prev.forEach((_, id) => { if (!next.has(id)) ops.push({ name, id, json: null }); });
      this.synced[name] = next;
    }

    const commits = [];
    for (let i = 0; i < ops.length; i += CLOUD_BATCH_LIMIT) {
      const chunk = ops.slice(i, i + CLOUD_BATCH_LIMIT);
      const batch = db.batch();
      chunk.forEach(op => {
        if (op.json === null) batch.delete(this.ref(op.name, op.id));
        else batch.set(this.ref(op.name, op.id), JSON.parse(op.json));
      });
      const commit = batch.commit().then(() => true, error => {
        chunk.forEach(op => this.synced[op.name].set(op.id, UNSYNCED));
        this.reportError(error);
        return false;
      });
      this.inflight.add(commit);
      commit.then(() => this.inflight.delete(commit));
      commits.push(commit);
    }
    return Promise.all(commits).then(results => results.every(Boolean));
  },

  // Retry failed writes and wait (up to timeoutMs) for the server to confirm.
  flush(data, timeoutMs) {
    this.save(data);
    if (!this.inflight.size) return Promise.resolve(!this.hasUnsynced());
    const confirmed = Promise.all([...this.inflight]).then(results => results.every(Boolean));
    const timedOut  = new Promise(resolve => setTimeout(() => resolve(false), timeoutMs));
    return Promise.race([confirmed, timedOut]);
  },

  reportError(error) {
    if (Date.now() - this.lastErrorAt < 30000) return;
    this.lastErrorAt = Date.now();
    showToast(error && error.code === 'permission-denied'
      ? 'Your account refused these changes. Export your data from Settings to keep a copy.'
      : 'Some changes could not be saved to your account. RunTrack will retry with your next change.', 'error', 8000);
  }
};

async function refreshFromCloud() {
  if (!isAccountSession() || !db || Date.now() - lastCloudLoad < CLOUD_REFRESH_MS) return;
  if (CloudStore.busy() || document.querySelector('.modal.active')) return;
  lastCloudLoad = Date.now();
  const { uid } = session;
  const saves = CloudStore.saveCount;
  try {
    const fresh = await CloudStore.fetch(uid);
    if (!isAccountSession() || session.uid !== uid || CloudStore.saveCount !== saves || CloudStore.busy()) return;
    if (sameRecords(fresh.plans, appData.plans) && sameRecords(fresh.runs, appData.runs)) return;
    CloudStore.adopt(uid, fresh);
    replaceAppData(fresh);
  } catch (_) { /* keep showing the data already on screen */ }
}

// ============================================================================
// SIGN-IN, SIGN-OUT AND GUEST MODE
// ============================================================================

const SIGN_OUT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';

function usernameToEmail(username) {
  return `${username.toLowerCase().trim()}@runtrack.local`;
}

function authErrorMessage(error, action) {
  switch (error && error.code) {
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Incorrect username or password.';
    case 'auth/email-already-in-use':
      return 'That username is taken. Try another one.';
    case 'auth/invalid-email':
      return 'Usernames can only use letters, numbers and underscores.';
    case 'auth/weak-password':
      return 'Use a password with at least 6 characters.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes and try again.';
    case 'auth/network-request-failed':
      return 'Could not reach the sign-in service. Check your connection and try again.';
    case 'auth/operation-not-allowed':
      return 'Username sign-in is not enabled for this site.';
    default:
      if (!error || !error.code) return 'Could not reach the sign-in service. Check your connection and try again.';
      return action === 'register' ? 'Could not create your account. Please try again.' : 'Could not sign you in. Please try again.';
  }
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.textContent = label;
}

async function handleLogin(event) {
  event.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl    = document.getElementById('loginError');
  const button   = document.getElementById('loginBtn');
  errEl.textContent = '';
  if (!username || !password) { errEl.textContent = 'Enter your username and password.'; return; }

  setBusy(button, true, 'Signing in…');
  try {
    await ensureFirebase();
    await auth.signInWithEmailAndPassword(usernameToEmail(username), password);
    finishSignIn();
  } catch (error) {
    errEl.textContent = authErrorMessage(error, 'sign-in');
    setBusy(button, false, 'Sign in');
  }
}

async function handleRegister(event) {
  event.preventDefault();
  const username     = document.getElementById('registerUsername').value.trim();
  const password     = document.getElementById('registerPassword').value;
  const confirmation = document.getElementById('registerConfirm').value;
  const errEl        = document.getElementById('registerError');
  const button       = document.getElementById('registerBtn');
  errEl.textContent = '';
  if (!USERNAME_PATTERN.test(username)) { errEl.textContent = 'Choose a username of 3 to 24 letters, numbers or underscores.'; return; }
  if (password.length < 6)              { errEl.textContent = 'Use a password with at least 6 characters.'; return; }
  if (password !== confirmation)        { errEl.textContent = 'The passwords do not match.'; return; }

  setBusy(button, true, 'Creating account…');
  try {
    await ensureFirebase();
    const credential = await auth.createUserWithEmailAndPassword(usernameToEmail(username), password);
    try {
      await db.collection('users').doc(credential.user.uid).set({
        username,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (_) { /* the profile only holds the display name */ }
    finishSignIn();
  } catch (error) {
    errEl.textContent = authErrorMessage(error, 'register');
    setBusy(button, false, 'Create account');
  }
}

// Reload after signing in so account data never shares memory with guest data.
function finishSignIn() {
  storageSet(SESSION_KEY, 'account');
  if (hasGuestData()) {
    try { sessionStorage.setItem(IMPORT_OFFER_KEY, '1'); } catch (_) { /* the offer is optional */ }
  }
  location.reload();
}

function toggleAuthMode() {
  const loginForm    = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');
  const showRegister = !loginForm.hidden;
  loginForm.hidden    = showRegister;
  registerForm.hidden = !showRegister;
  document.getElementById(showRegister ? 'registerUsername' : 'loginUsername').focus();
}

async function signOut() {
  if (!isAccountSession() || signingOut) return;
  if (!confirm('Sign out on this device? You will need your password to sign back in.')) return;
  showSplash('Signing out…');
  const synced = await CloudStore.flush(appData, 5000);
  if (!synced) {
    hideSplash();
    if (!confirm('Some changes have not reached your account yet, probably because you are offline. Sign out anyway and lose them?')) return;
    showSplash('Signing out…');
  }

  signingOut = true;
  const uid = session.uid;
  try { await auth.signOut(); } catch (_) { /* still clear local state */ }
  clearLocalNamespace(uid);
  storageRemove(SESSION_KEY);
  try {
    await db.terminate();
    await db.clearPersistence();
  } catch (_) { /* another open tab may still use the offline cache */ }
  location.reload();
}

function showSplash(message) {
  const splash = document.getElementById('bootSplash');
  splash.querySelector('.boot-splash-text').textContent = message || 'Loading…';
  splash.hidden = false;
}

function hideSplash() {
  document.getElementById('bootSplash').hidden = true;
}

function showApp() {
  hideSplash();
  document.getElementById('authOverlay').hidden = true;
  document.getElementById('appShell').style.removeProperty('display');
}

function showLanding({ focusSignIn = false } = {}) {
  hideSplash();
  document.getElementById('appShell').style.display = 'none';
  const overlay = document.getElementById('authOverlay');
  overlay.hidden = false;
  overlay.scrollTop = 0;
  document.getElementById('accountPanel').hidden = !accountsEnabled();
  document.getElementById('guestStartBtn').textContent =
    session || hasGuestData() ? 'Continue as guest' : 'Start without an account';
  if (focusSignIn && accountsEnabled()) {
    const loginHidden = document.getElementById('loginForm').hidden;
    const field = document.getElementById(loginHidden ? 'registerUsername' : 'loginUsername');
    field.scrollIntoView({ block: 'center' });
    field.focus({ preventScroll: true });
  }
}

function showSignIn() {
  document.querySelectorAll('.modal.active').forEach(modal => closeModal(modal.id));
  showLanding({ focusSignIn: true });
}

function continueAsGuest() {
  if (session && session.mode === 'guest') showApp();
  else startGuestSession();
}

function startGuestSession() {
  session = { mode: 'guest' };
  storageSet(SESSION_KEY, 'guest');
  const guest = readGuestData();
  appData = { plans: sortPlans(guest.plans), runs: guest.runs, whoopRecovery: null };
  enterApp();
}

async function startAccountSession() {
  showSplash('Loading your account…');
  try {
    await ensureFirebase();
  } catch (_) {
    showLanding();
    showToast('Could not reach the sync service. Check your connection and reload, or continue without an account.', 'error', 8000);
    return;
  }
  auth.onAuthStateChanged(handleAuthStateChange);
}

async function handleAuthStateChange(user) {
  if (signingOut) return;
  if (!user) {
    const wasSignedIn = isAccountSession();
    session = null;
    storageRemove(SESSION_KEY);
    if (wasSignedIn) location.reload();
    else showLanding();
    return;
  }
  if (isAccountSession()) {
    // A different account signed in from another tab.
    if (session.uid !== user.uid) location.reload();
    return;
  }

  session = { mode: 'account', uid: user.uid, username: (user.email || '').split('@')[0] };
  storageSet(SESSION_KEY, 'account');
  showSplash('Loading your plans…');

  const [profile, cloud] = await Promise.allSettled([
    db.collection('users').doc(user.uid).get(),
    CloudStore.fetch(user.uid)
  ]);
  if (profile.status === 'fulfilled' && profile.value.exists) {
    const name = profile.value.data().username;
    if (typeof name === 'string' && name) session.username = name;
  }
  const loaded = cloud.status === 'fulfilled' ? cloud.value : { plans: [], runs: [] };
  CloudStore.adopt(user.uid, loaded);
  appData = { plans: sortPlans(loaded.plans), runs: loaded.runs, whoopRecovery: null };
  lastCloudLoad = Date.now();

  await enterApp();
  if (cloud.status === 'rejected') {
    showToast('Could not load your synced data. Check your connection and reload the page.', 'error', 9000);
  } else {
    offerGuestImport();
  }
}

async function enterApp() {
  showApp();
  updateAccountChrome();

  // Each handler returns null when the page was not opened by its OAuth
  // redirect, otherwise whether the connection succeeded.
  let fitbitResult = null, whoopResult = null;
  try { fitbitResult = await handleFitbitCallback(); } catch (_) { fitbitResult = false; }
  try { whoopResult  = await handleWhoopCallback();  } catch (_) { whoopResult = false; }

  renderAll();
  updateHeaderInfo();
  if (fitbitResult !== null)     openDeviceSettings('fitbit', false);
  else if (whoopResult !== null) openDeviceSettings('whoop', false);
  if (isFitbitConnected()) syncFitbitRuns({ notify: fitbitResult === true }).catch(() => {});
  if (isWhoopConnected())  syncWhoopData({ notify: whoopResult === true }).catch(() => {});
}

function updateAccountChrome() {
  const header  = document.getElementById('headerAccount');
  const sidebar = document.getElementById('sidebarUser');
  if (isAccountSession()) {
    header.innerHTML = `
      <span class="header-username">${escapeHtml(session.username)}</span>
      <button class="btn-icon" onclick="signOut()" title="Sign out" aria-label="Sign out">${SIGN_OUT_ICON}</button>`;
    sidebar.textContent = `Signed in as ${session.username}`;
  } else {
    header.innerHTML = `
      <span class="session-chip" title="Your data is saved in this browser only">Guest</span>
      ${accountsEnabled() ? '<button class="btn btn-secondary btn-sm" onclick="showSignIn()"><span>Sign in<span class="hide-on-phone"> to sync</span></span></button>' : ''}`;
    sidebar.textContent = 'Guest, saved in this browser';
  }
}

// Counts what a guest import would add, without changing anything.
function previewGuestImport() {
  const target = { plans: [...appData.plans], runs: [...appData.runs] };
  return mergeRunTrackData(target, readGuestData());
}

function offerGuestImport() {
  let requested = false;
  try {
    requested = sessionStorage.getItem(IMPORT_OFFER_KEY) === '1';
    sessionStorage.removeItem(IMPORT_OFFER_KEY);
  } catch (_) { /* the offer is optional */ }
  if (requested) showGuestImportModal(false);
}

function showGuestImportModal(fromSettings = true) {
  const { addedPlans, addedRuns } = previewGuestImport();
  if (!addedPlans && !addedRuns) {
    if (fromSettings) showToast('Everything from guest mode is already in your account.');
    return;
  }
  document.getElementById('guestImportSummary').textContent =
    `This browser has ${plural(addedPlans, 'plan')} and ${plural(addedRuns, 'run')} from guest mode that are not in your account. ` +
    'Import them so they sync to your other devices? Nothing in your account is overwritten.';
  openModal('guestImportModal');
}

function importGuestData() {
  const { addedPlans, addedRuns } = mergeRunTrackData(appData, readGuestData());
  setStorage(appData);
  closeModal('guestImportModal');
  renderAll();
  updateHeaderInfo();
  showToast(`Imported ${plural(addedPlans, 'plan')} and ${plural(addedRuns, 'run')} into your account.`, 'success');
}

function deleteGuestData() {
  if (!confirm('Delete everything saved in this browser in guest mode, including plans, runs and settings? Your account is not affected.')) return;
  clearLocalNamespace('guest');
  renderSettings();
  showToast('Guest data was deleted from this browser.');
}

function handleStorageEvent(event) {
  if (event.key !== GUEST_DATA_KEY || !session || session.mode !== 'guest') return;
  const fresh = readGuestData();
  if (sameRecords(fresh.plans, appData.plans) && sameRecords(fresh.runs, appData.runs)) return;
  replaceAppData(fresh);
}

function handleGlobalKeydown(event) {
  if (event.key !== 'Escape') return;
  const open = document.querySelectorAll('.modal.active');
  if (open.length) closeModal(open[open.length - 1].id);
}

function boot() {
  setTheme(getTheme());
  updateThemeIcon();
  restoreSidebarState();
  setupNavListeners();
  document.addEventListener('keydown', handleGlobalKeydown);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshFromCloud();
  });
  window.addEventListener('storage', handleStorageEvent);

  const mode = storageGet(SESSION_KEY);
  if (mode === 'guest') {
    startGuestSession();
  } else if (mode === 'account' && accountsEnabled()) {
    startAccountSession();
  } else {
    storageRemove(SESSION_KEY);
    showLanding();
  }
}

document.addEventListener('DOMContentLoaded', boot);

function getTheme() { return localStorage.getItem('runtrack_theme') || 'dark'; }

function setTheme(theme) {
  localStorage.setItem('runtrack_theme', theme);
  if (theme === 'light') document.documentElement.classList.add('light-mode');
  else document.documentElement.classList.remove('light-mode');
}

// ============================================================================
// UTILITIES
// ============================================================================

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// All plan dates are calendar dates (YYYY-MM-DD) in the visitor's local time zone.
function getToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function formatDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day   = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function parseDate(dateStr) {
  const [year, month, day] = dateStr.split('-');
  return new Date(year, parseInt(month) - 1, day);
}

function isValidDateString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && formatDate(parseDate(value)) === value;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

// Whole days from one YYYY-MM-DD date to another (rounding absorbs DST shifts).
function daysBetween(fromStr, toStr) {
  return Math.round((parseDate(toStr) - parseDate(fromStr)) / 86400000);
}

function formatDisplayDate(dateStr, options = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) {
  return isValidDateString(dateStr) ? parseDate(dateStr).toLocaleDateString(undefined, options) : '';
}

// Parses "mm:ss", "h:mm:ss" or whole minutes ("45"). Returns NaN if invalid.
function timeStringToSeconds(timeStr) {
  const value = String(timeStr || '').trim();
  if (/^\d{1,4}$/.test(value)) return Number(value) * 60;
  const match = value.match(/^(?:(\d{1,2}):)?(\d{1,4}):(\d{2})$/);
  if (!match) return NaN;
  const [, h, m, sec] = match;
  if (Number(sec) > 59 || (h !== undefined && Number(m) > 59)) return NaN;
  return Number(h || 0) * 3600 + Number(m) * 60 + Number(sec);
}

function secondsToTimeString(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function calculatePace(distanceMiles, timeSeconds) {
  if (!distanceMiles || !timeSeconds) return '';
  const paceSeconds = Math.round(timeSeconds / distanceMiles);
  return secondsToTimeString(paceSeconds);
}

function dayOfWeek(date) {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][date.getDay()];
}

function raceTypeLabel(raceType) {
  const labels = { '5k': '5K', '10k': '10K', 'half_marathon': 'Half Marathon', 'marathon': 'Marathon', 'custom': 'Custom' };
  return labels[raceType] || raceType;
}

function runTypeLabel(type) {
  if (type === 'long') return 'Long Run';
  if (type === 'race') return 'Race';
  return 'Easy Run';
}

function getCSSVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const RACE_TYPES   = ['5k', '10k', 'half_marathon', 'marathon', 'custom'];
const WEEKDAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEK_ORDER   = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_SHORT    = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' };

const RACE_DISTANCE_MI = { '5k': 3.1, '10k': 6.2, half_marathon: 13.1, marathon: 26.2, custom: 13.1 };
const PACE_SEC_PER_MI  = { easy: 600, long: 660, race: 600 };
const PLAN_MAX_WEEKS   = 30;
// Week counts and distances (miles) used to build template plans for each race.
const PLAN_RULES = {
  '5k':          { minWeeks: 4,  recWeeks: 10, longStart: 3, longPeak: 6,  easyStart: 2, easyMax: 4 },
  '10k':         { minWeeks: 6,  recWeeks: 12, longStart: 4, longPeak: 9,  easyStart: 2, easyMax: 5 },
  half_marathon: { minWeeks: 8,  recWeeks: 16, longStart: 4, longPeak: 12, easyStart: 2, easyMax: 6 },
  marathon:      { minWeeks: 12, recWeeks: 18, longStart: 6, longPeak: 20, easyStart: 3, easyMax: 8 },
  custom:        { minWeeks: 4,  recWeeks: 12, longStart: 4, longPeak: 10, easyStart: 2, easyMax: 6 }
};

function capitalize(word) {
  return word ? word[0].toUpperCase() + word.slice(1) : '';
}

// The active plan is always plans[0]: the most recently activated or created plan.
function sortPlans(plans) {
  const rank = plan => Number(plan.activatedAt) || Date.parse(plan.createdAt) || 0;
  return [...plans].sort((a, b) => rank(b) - rank(a));
}

function daysToRaceText(raceDate) {
  const days = daysBetween(formatDate(getToday()), raceDate);
  if (days > 1)  return `${days} days to race`;
  if (days === 1) return '1 day to race';
  if (days === 0) return 'Race day';
  return 'Race complete';
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// localStorage can throw (quota exceeded, storage disabled), so wrap access.
function storageGet(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
}

function storageRemove(key) {
  try { localStorage.removeItem(key); } catch (_) { /* storage unavailable */ }
}

function showToast(message, type = 'info', timeoutMs = 4500) {
  let host = document.getElementById('toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    host.className = 'toast-host';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  host.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 300);
  }, timeoutMs);
}

// ============================================================================
// PLAN GENERATION
// ============================================================================

function planWeekCount(startDate, raceDate) {
  return Math.floor(daysBetween(startDate, raceDate) / 7) + 1;
}

// Build a template plan. Week N covers the 7 days starting at
// startDate + 7 * (N - 1), and the last week ends with the race on raceDate.
function generatePlanWeeks(startDate, raceDate, raceType, runDays, longRunDay) {
  const rules      = PLAN_RULES[raceType] || PLAN_RULES.custom;
  const raceDist   = RACE_DISTANCE_MI[raceType] || RACE_DISTANCE_MI.custom;
  const start      = parseDate(startDate);
  const totalWeeks = Math.max(1, planWeekCount(startDate, raceDate));
  const taperWeeks = totalWeeks >= 12 ? 3 : totalWeeks >= 6 ? 2 : 1;
  const buildWeeks = totalWeeks - taperWeeks;
  const peakWeek   = buildWeeks - 1;

  const makeRun = (date, type, distance) => ({
    id: generateUUID(), date, type, plannedDistance: distance,
    plannedTime: Math.round(distance * PACE_SEC_PER_MI[type]),
    actualDistance: null, actualTime: null, effort: null, notes: ''
  });

  const weeks = [];
  for (let w = 0; w < totalWeeks; w++) {
    const weekStart  = addDays(start, w * 7);
    const isRaceWeek = w === totalWeeks - 1;
    const isTaper    = w >= buildWeeks;
    const isRecovery = w > 0 && w < peakWeek && (w + 1) % 4 === 0;
    const progress   = Math.min(w / Math.max(peakWeek, 1), 1);
    const taperStep  = w - buildWeeks + 1;
    const runs = [];

    for (let offset = 0; offset < 7; offset++) {
      const date    = addDays(weekStart, offset);
      const dateStr = formatDate(date);
      if (dateStr === raceDate) { runs.push(makeRun(dateStr, 'race', raceDist)); break; }
      if (dateStr > raceDate) break;

      const day = WEEKDAY_KEYS[date.getDay()];
      if (!runDays.includes(day)) continue;

      let type = 'easy', distance;
      if (isRaceWeek) {
        distance = daysBetween(dateStr, raceDate) <= 2 ? 2 : 3;
      } else if (day === longRunDay) {
        type = 'long';
        distance = isTaper
          ? rules.longPeak * (1 - 0.25 * taperStep)
          : (rules.longStart + progress * (rules.longPeak - rules.longStart)) * (isRecovery ? 0.75 : 1);
      } else {
        const easy = rules.easyStart + progress * (rules.easyMax - rules.easyStart);
        distance = easy * (isTaper ? 1 - 0.2 * taperStep : isRecovery ? 0.75 : 1);
      }
      runs.push(makeRun(dateStr, type, Math.max(1, Math.round(distance * 2) / 2)));
    }

    weeks.push({ weekNumber: w + 1, startDate: formatDate(weekStart), runs });
  }
  return weeks;
}

function defaultPlanName(raceType, raceDate) {
  const when = formatDisplayDate(raceDate, { month: 'short', year: 'numeric' });
  return `${when} ${raceTypeLabel(raceType)}`.trim();
}

// Suggested race day: the recommended number of weeks out, on a weekend day.
function recommendedRaceDate(startDate, raceType, longRunDay) {
  const rules  = PLAN_RULES[raceType] || PLAN_RULES.custom;
  const target = WEEKDAY_KEYS.indexOf(['saturday', 'sunday'].includes(longRunDay) ? longRunDay : 'sunday');
  let date = addDays(parseDate(startDate), 7 * (rules.recWeeks - 1));
  while (date.getDay() !== target) date = addDays(date, 1);
  return formatDate(date);
}

const RACE_PHRASE = { '5k': '5K', '10k': '10K', half_marathon: 'half marathon', marathon: 'marathon', custom: 'custom' };

function planScheduleChanged(plan, input) {
  return plan.raceType !== input.raceType || plan.startDate !== input.startDate ||
    plan.raceDate !== input.raceDate || plan.longRunDay !== input.longRunDay ||
    [...plan.runDays].sort().join() !== [...input.runDays].sort().join();
}

// Returns a user-facing error message, or '' when the input is valid. When
// editing, the schedule rules only apply if the schedule would be rebuilt.
function validatePlanInput(input, original = null) {
  if (!RACE_TYPES.includes(input.raceType)) return 'Choose a race distance.';
  if (original && !planScheduleChanged(original, input)) return '';
  if (!isValidDateString(input.startDate)) return 'Choose the date your plan starts.';
  if (!isValidDateString(input.raceDate)) return 'Choose your race day.';
  if (input.raceDate <= input.startDate) return 'Race day must be after the plan start date.';
  if ((!original || original.raceDate !== input.raceDate) && input.raceDate < formatDate(getToday())) {
    return 'Race day is in the past. Choose an upcoming date.';
  }
  const weeks   = planWeekCount(input.startDate, input.raceDate);
  const minimum = (PLAN_RULES[input.raceType] || PLAN_RULES.custom).minWeeks;
  if (weeks < minimum) return `A ${RACE_PHRASE[input.raceType]} plan needs at least ${minimum} weeks. Move race day later or start earlier.`;
  if (weeks > PLAN_MAX_WEEKS) return `Plans can be up to ${PLAN_MAX_WEEKS} weeks long. Start closer to race day.`;
  if (input.runDays.length < 2) return 'Pick at least 2 days you can run.';
  if (!input.runDays.includes(input.longRunDay)) return 'Pick a long run day from your run days.';
  return '';
}

function planStatsMarkup(weeks) {
  const runs     = weeks.flatMap(w => w.runs);
  const longest  = runs.filter(r => r.type !== 'race').reduce((max, r) => Math.max(max, r.plannedDistance), 0);
  const peakWeek = weeks.reduce((max, w) => Math.max(max, w.runs.reduce((sum, r) => sum + r.plannedDistance, 0)), 0);
  return `
    <div><strong>${weeks.length}</strong><span>weeks</span></div>
    <div><strong>${runs.length}</strong><span>runs</span></div>
    <div><strong>${longest}</strong><span>longest run (mi)</span></div>
    <div><strong>${Math.round(peakWeek)}</strong><span>peak week (mi)</span></div>`;
}

function savePlanFromInput(input, existing) {
  const data = getStorage();
  const name = input.name || defaultPlanName(input.raceType, input.raceDate);
  const schedule = () => generatePlanWeeks(input.startDate, input.raceDate, input.raceType, input.runDays, input.longRunDay);

  if (existing) {
    const plan = data.plans.find(p => p.id === existing.id);
    if (!plan) return null;
    const rebuild = planScheduleChanged(plan, input);
    Object.assign(plan, {
      name, raceType: input.raceType, startDate: input.startDate, raceDate: input.raceDate,
      runDays: input.runDays, longRunDay: input.longRunDay
    });
    if (rebuild) { plan.weeks = schedule(); delete plan.source; }
    setStorage(data);
    return plan;
  }

  const plan = {
    id: generateUUID(), name, raceType: input.raceType, startDate: input.startDate, raceDate: input.raceDate,
    runDays: input.runDays, longRunDay: input.longRunDay,
    createdAt: new Date().toISOString(), activatedAt: Date.now(),
    weeks: schedule()
  };
  data.plans.unshift(plan);
  setStorage(data);
  return plan;
}

const PLAN_DISTANCE_CHOICES = [['5k', '5K'], ['10k', '10K'], ['half_marathon', 'Half marathon'], ['marathon', 'Marathon']];
const DEFAULT_RUN_DAYS = ['tuesday', 'thursday', 'saturday'];
let planFormSeq = 0;

// Plan form shared by onboarding, "New plan" and "Edit plan".
function mountPlanForm(host, { plan = null, submitLabel = 'Create plan', onSaved, onCancel, onDelete } = {}) {
  if (!host) return;
  const uid     = `planform${++planFormSeq}`;
  const choices = [...PLAN_DISTANCE_CHOICES];
  if (plan && !choices.some(([value]) => value === plan.raceType)) choices.push([plan.raceType, raceTypeLabel(plan.raceType)]);

  const state = {
    raceType:    plan ? plan.raceType : 'half_marathon',
    runDays:     plan ? WEEK_ORDER.filter(d => plan.runDays.includes(d)) : [...DEFAULT_RUN_DAYS],
    longRunDay:  plan ? plan.longRunDay : 'saturday',
    raceTouched: !!plan
  };

  host.innerHTML = `
    <form class="plan-form" novalidate>
      <div class="form-group">
        <span class="form-label" id="${uid}-dist">Race distance</span>
        <div class="pill-group" role="radiogroup" aria-labelledby="${uid}-dist">
          ${choices.map(([value, label]) => `<button type="button" class="pill" role="radio" data-race="${value}">${label}</button>`).join('')}
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="${uid}-start">Plan starts</label>
          <input type="date" class="form-input" id="${uid}-start" required />
        </div>
        <div class="form-group">
          <label class="form-label" for="${uid}-race">Race day</label>
          <input type="date" class="form-input" id="${uid}-race" required />
        </div>
      </div>
      <div class="form-group">
        <span class="form-label" id="${uid}-days">Days you can run</span>
        <div class="pill-group day-pills" role="group" aria-labelledby="${uid}-days">
          ${WEEK_ORDER.map(day => `<button type="button" class="pill" data-day="${day}" aria-label="${capitalize(day)}">${DAY_SHORT[day]}</button>`).join('')}
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="${uid}-long">Long run day</label>
          <select class="form-input" id="${uid}-long"></select>
        </div>
        <div class="form-group">
          <label class="form-label" for="${uid}-name">Plan name (optional)</label>
          <input type="text" class="form-input" id="${uid}-name" maxlength="80" autocomplete="off" />
        </div>
      </div>
      <div class="stat-strip plan-summary" aria-live="polite"></div>
      <div class="form-error" role="alert"></div>
      ${plan ? `<p class="form-note">Changing the distance, dates or run days rebuilds the schedule${plan.source === 'ai' ? ' from RunTrack\'s template' : ''}. Runs you have already logged are kept.</p>` : ''}
      <div class="modal-actions">
        ${onCancel ? '<button type="button" class="btn btn-secondary" data-action="cancel">Cancel</button>' : ''}
        ${onDelete ? '<button type="button" class="btn btn-danger" data-action="delete">Delete plan</button>' : ''}
        <button type="submit" class="btn btn-primary">${escapeHtml(submitLabel)}</button>
      </div>
    </form>`;

  const form      = host.querySelector('form');
  const startEl   = form.querySelector(`#${uid}-start`);
  const raceEl    = form.querySelector(`#${uid}-race`);
  const longEl    = form.querySelector(`#${uid}-long`);
  const nameEl    = form.querySelector(`#${uid}-name`);
  const summaryEl = form.querySelector('.plan-summary');
  const errorEl   = form.querySelector('.form-error');

  startEl.value = plan ? plan.startDate : formatDate(getToday());
  raceEl.value  = plan ? plan.raceDate : recommendedRaceDate(startEl.value, state.raceType, state.longRunDay);
  nameEl.value  = plan ? plan.name : '';

  const readInput = () => ({
    name: nameEl.value.trim().slice(0, 80),
    raceType: state.raceType,
    startDate: startEl.value,
    raceDate: raceEl.value,
    runDays: [...state.runDays],
    longRunDay: state.longRunDay
  });

  const suggestRaceDate = () => {
    if (!state.raceTouched && isValidDateString(startEl.value)) {
      raceEl.value = recommendedRaceDate(startEl.value, state.raceType, state.longRunDay);
    }
  };

  const refresh = () => {
    if (!state.runDays.includes(state.longRunDay)) {
      state.longRunDay = ['saturday', 'sunday'].find(d => state.runDays.includes(d)) || state.runDays[state.runDays.length - 1] || '';
    }
    form.querySelectorAll('[data-race]').forEach(btn => {
      const on = btn.dataset.race === state.raceType;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-checked', String(on));
    });
    form.querySelectorAll('[data-day]').forEach(btn => {
      const on = state.runDays.includes(btn.dataset.day);
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
    });
    longEl.innerHTML = state.runDays.length
      ? state.runDays.map(d => `<option value="${d}">${capitalize(d)}</option>`).join('')
      : '<option value="">Pick your run days first</option>';
    longEl.value = state.longRunDay;
    nameEl.placeholder = isValidDateString(raceEl.value) ? defaultPlanName(state.raceType, raceEl.value) : 'My training plan';

    const input = readInput();
    const error = validatePlanInput(input, plan);
    errorEl.textContent = error;
    summaryEl.hidden = !!error;
    summaryEl.innerHTML = error ? '' : planStatsMarkup(plan && !planScheduleChanged(plan, input)
      ? plan.weeks
      : generatePlanWeeks(input.startDate, input.raceDate, input.raceType, input.runDays, input.longRunDay));
    return error;
  };

  form.querySelectorAll('[data-race]').forEach(btn => btn.addEventListener('click', () => {
    state.raceType = btn.dataset.race;
    suggestRaceDate();
    refresh();
  }));
  form.querySelectorAll('[data-day]').forEach(btn => btn.addEventListener('click', () => {
    const day = btn.dataset.day;
    state.runDays = state.runDays.includes(day)
      ? state.runDays.filter(d => d !== day)
      : WEEK_ORDER.filter(d => d === day || state.runDays.includes(d));
    refresh();
  }));
  longEl.addEventListener('change', () => { state.longRunDay = longEl.value; suggestRaceDate(); refresh(); });
  startEl.addEventListener('change', () => { suggestRaceDate(); refresh(); });
  raceEl.addEventListener('change', () => { state.raceTouched = true; refresh(); });
  form.querySelector('[data-action="cancel"]')?.addEventListener('click', () => onCancel());
  form.querySelector('[data-action="delete"]')?.addEventListener('click', () => onDelete());

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (refresh()) { errorEl.scrollIntoView({ block: 'nearest' }); return; }
    const saved = savePlanFromInput(readInput(), plan);
    if (saved && onSaved) onSaved(saved);
  });

  refresh();
}

// ============================================================================
// PLAN ADJUSTMENTS
// ============================================================================

const ADJUST_LOOKBACK_DAYS = 7;
const ADJUST_MAX_EXTRA_MI  = 2;

function loggedDates(data, planId) {
  return new Set(data.runs.filter(r => r.planId === planId).map(r => r.date));
}

// Easy runs in the week before `dateStr` that were never logged and have not
// been offered for redistribution yet.
function getMissedRuns(planId, dateStr) {
  const data = getStorage();
  const plan = data.plans.find(p => p.id === planId);
  if (!plan) return [];
  const logged = loggedDates(data, planId);
  const from   = formatDate(addDays(parseDate(dateStr), -ADJUST_LOOKBACK_DAYS));
  return plan.weeks.flatMap(w => w.runs).filter(r =>
    r.type === 'easy' && !r.missHandled && r.date >= from && r.date < dateStr && !logged.has(r.date));
}

// The next three unlogged easy runs after `dateStr`, from today onwards.
function getAdjustmentCandidates(planId, dateStr) {
  const data = getStorage();
  const plan = data.plans.find(p => p.id === planId);
  if (!plan) return [];
  const logged   = loggedDates(data, planId);
  const todayStr = formatDate(getToday());
  return plan.weeks.flatMap(w => w.runs).filter(r =>
    r.type === 'easy' && r.date > dateStr && r.date >= todayStr && !logged.has(r.date)).slice(0, 3);
}

// ============================================================================
// CHART INSTANCES
// ============================================================================

let progressChartInstance = null;
let weeklyChartInstance   = null;

// ============================================================================
// RENDERING — DASHBOARD
// ============================================================================

function recoveryColor(score) {
  if (score >= 67) return 'var(--success)';
  if (score >= 34) return 'var(--warning)';
  return 'var(--danger)';
}

function recoveryLabel(score) {
  if (score >= 67) return 'Ready to perform';
  if (score >= 34) return 'Moderate recovery';
  return 'Low — consider rest';
}

function updatePlanChrome() {
  document.body.classList.toggle('has-plan', getStorage().plans.length > 0);
}

function renderOnboarding() {
  document.getElementById('dashboardContent').innerHTML = `
    <div class="onboarding">
      <div class="onboarding-intro">
        <div class="onboarding-eyebrow">Welcome to RunTrack</div>
        <h2 class="onboarding-title">Build your training plan</h2>
        <p class="onboarding-text">Choose your race and the days you can run. RunTrack lays out a week-by-week schedule of easy runs, long runs and a taper. You can change it at any time.</p>
      </div>
      <div class="settings-section onboarding-card" id="onboardingForm"></div>
      <p class="onboarding-alt">Prefer to describe your goal in your own words? Try the <a href="#" onclick="switchTab('ai'); return false;">AI planner</a> with your own Anthropic API key. Moving from another device? <a href="#" onclick="showImportModal(); return false;">Import a RunTrack export</a>.</p>
    </div>`;
  mountPlanForm(document.getElementById('onboardingForm'), {
    submitLabel: 'Create my plan',
    onSaved: () => {
      renderAll();
      updateHeaderInfo();
      showToast('Your plan is ready. Log runs from the schedule or with the + button.', 'success');
    }
  });
}

function renderDashboard() {
  const data = getStorage();
  updatePlanChrome();
  if (data.plans.length === 0) {
    renderOnboarding();
    return;
  }

  const activePlan = data.plans[0];
  const today      = getToday();
  const todayStr   = formatDate(today);
  const daysToRace = daysBetween(todayStr, activePlan.raceDate);

  const runLog = {};
  data.runs.forEach(run => { if (run.planId === activePlan.id) runLog[run.date] = run; });

  let totalActualMiles = 0, totalPlannedMiles = 0, totalActualTime = 0;
  let completedRuns = 0, totalRuns = 0;
  let longestStreak = 0, currentStreak = 0;
  const longRunProgression = [];
  const weeklyMileage = [];

  for (const week of activePlan.weeks) {
    let weekPlanned = 0, weekActual = 0;
    const weekHasStarted = parseDate(week.startDate) <= today;

    for (const run of week.runs) {
      const runDate = parseDate(run.date);
      weekPlanned += run.plannedDistance;

      if (weekHasStarted) {
        totalRuns++;
        if (runDate <= today) totalPlannedMiles += run.plannedDistance;

        if (runLog[run.date]) {
          const logged = runLog[run.date];
          totalActualMiles += logged.distance;
          totalActualTime  += logged.time;
          weekActual       += logged.distance;
          completedRuns++;
          currentStreak++;
          longestStreak = Math.max(longestStreak, currentStreak);
        } else if (runDate < today) {
          currentStreak = 0;
        }
      }

      if (run.type === 'long') {
        longRunProgression.push({
          week: week.weekNumber,
          running: runLog[run.date] ? runLog[run.date].distance : null,
          planned: run.plannedDistance
        });
      }
    }

    weeklyMileage.push({ week: week.weekNumber, planned: weekPlanned, actual: weekHasStarted ? weekActual : null });
  }

  const completionPct = totalRuns > 0 ? Math.round((completedRuns / totalRuns) * 100) : 0;
  const totalPlanRuns = activePlan.weeks.reduce((s, w) => s + w.runs.length, 0);
  const overallPct    = totalPlanRuns > 0 ? Math.round((completedRuns / totalPlanRuns) * 100) : 0;
  const avgPace       = (totalActualTime && totalActualMiles) ? calculatePace(totalActualMiles, totalActualTime) : '—';

  const currentWeek = activePlan.weeks.find(week => {
    const ws = parseDate(week.startDate);
    const we = new Date(ws); we.setDate(we.getDate() + 6);
    return ws <= today && today <= we;
  });

  let thisWeekPlanned = 0, thisWeekActual = 0, thisWeekDone = 0, thisWeekTotal = 0;
  if (currentWeek) {
    for (const run of currentWeek.runs) {
      thisWeekPlanned += run.plannedDistance;
      thisWeekTotal++;
      if (runLog[run.date]) {
        thisWeekActual += runLog[run.date].distance;
        thisWeekDone++;
      }
    }
  }

  const nextRun = activePlan.weeks.flatMap(w => w.runs).find(r => r.date >= todayStr && !runLog[r.date]);
  let nextRunLabel = '—';
  if (nextRun) {
    const daysAway = daysBetween(todayStr, nextRun.date);
    const when = daysAway === 0 ? 'Today'
      : daysAway < 7 ? dayOfWeek(parseDate(nextRun.date))
      : escapeHtml(formatDisplayDate(nextRun.date, { weekday: 'short', month: 'short', day: 'numeric' }));
    nextRunLabel = `${when}<br><span style="font-size:13px;font-weight:600;letter-spacing:0;color:var(--text2);">${runTypeLabel(nextRun.type)} · ${nextRun.plannedDistance} mi</span>`;
  } else if (daysToRace < 0 || currentWeek) {
    nextRunLabel = `<span style="color:var(--success);">All done</span>`;
  }

  const weekLabel = currentWeek
    ? `Week ${currentWeek.weekNumber} &nbsp;·&nbsp; ${escapeHtml(formatDisplayDate(currentWeek.startDate, { month: 'short', day: 'numeric' }))}`
    : todayStr < activePlan.startDate
      ? `Plan starts ${escapeHtml(formatDisplayDate(activePlan.startDate, { weekday: 'short', month: 'short', day: 'numeric' }))}`
      : 'Plan complete';

  const bannerValue = daysToRace > 0 ? String(daysToRace) : daysToRace === 0 ? 'Today' : 'Done';
  const bannerLabel = daysToRace > 1 ? 'days to race' : daysToRace === 1 ? 'day to race' : daysToRace === 0 ? 'is race day' : 'race complete';

  // Whoop recovery card
  let whoopSection = '';
  if (data.whoopRecovery) {
    const r = data.whoopRecovery;
    whoopSection = `
    <div class="dash-section">
      <div class="dash-section-title">Today's Recovery &nbsp;—&nbsp; <span style="color:var(--text2);">via Whoop</span></div>
      <div class="grid-3">
        <div class="stat-card">
          <div class="stat-label">Recovery Score</div>
          <div class="stat-value" style="color:${recoveryColor(r.recoveryScore)}">${r.recoveryScore}<span style="font-size:18px;color:var(--text2);font-weight:400;">%</span></div>
          <div class="stat-sublabel">${recoveryLabel(r.recoveryScore)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">HRV</div>
          <div class="stat-value">${r.hrv.toFixed(1)}<span style="font-size:18px;color:var(--text2);font-weight:400;"> ms</span></div>
          <div class="stat-sublabel">RMSSD</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Resting HR</div>
          <div class="stat-value">${r.rhr}<span style="font-size:18px;color:var(--text2);font-weight:400;"> bpm</span></div>
          <div class="stat-sublabel">last night</div>
        </div>
      </div>
    </div>`;
  } else if (isWhoopConnected()) {
    whoopSection = `
    <div class="dash-section">
      <div class="dash-section-title">Today's Recovery &nbsp;—&nbsp; <span style="color:var(--text2);">via Whoop</span></div>
      <div style="color:var(--text2);font-size:14px;padding:var(--spacing-md) 0;">Fetching recovery data…</div>
    </div>`;
  }

  document.getElementById('dashboardContent').innerHTML = `
    <div class="view-header" style="margin-bottom:var(--spacing-xl);">
      <div>
        <h2>${escapeHtml(activePlan.name)}</h2>
        <div style="font-size:13px;color:var(--text2);margin-top:4px;">${raceTypeLabel(activePlan.raceType)} · Race day: ${escapeHtml(formatDisplayDate(activePlan.raceDate))}</div>
      </div>
    </div>

    <div class="race-banner">
      <div>
        <div class="race-banner-days">${bannerValue}</div>
        <div class="race-banner-label">${bannerLabel}</div>
      </div>
      <div class="race-banner-divider"></div>
      <div style="flex:1;padding-left:var(--spacing-xl);">
        <div style="font-size:14px;color:var(--text2);margin-bottom:4px;">Overall progress</div>
        <div style="font-size:20px;font-weight:700;">${completedRuns} of ${totalPlanRuns} runs complete</div>
        <div class="progress-bar" style="margin-top:10px;">
          <div class="progress-fill" style="width:${overallPct}%"></div>
        </div>
        <div style="font-size:12px;color:var(--text2);margin-top:6px;">${overallPct}% · ${totalActualMiles.toFixed(1)} mi logged</div>
      </div>
    </div>

    ${whoopSection}

    <div class="dash-section">
      <div class="dash-section-title">This Week &nbsp;—&nbsp; ${weekLabel}</div>
      <div class="grid-3">
        <div class="stat-card">
          <div class="stat-label">Runs</div>
          <div class="stat-value">${thisWeekDone}<span style="font-size:20px;color:var(--text2);">/${thisWeekTotal}</span></div>
          <div class="stat-sublabel">completed this week</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Miles</div>
          <div class="stat-value">${thisWeekActual.toFixed(1)}<span style="font-size:20px;color:var(--text2);">/${thisWeekPlanned.toFixed(1)}</span></div>
          <div class="stat-sublabel">logged / planned this week</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Next Run</div>
          <div class="stat-value" style="font-size:22px;">${nextRunLabel}</div>
        </div>
      </div>
    </div>

    <div class="dash-section">
      <div class="dash-section-title">Plan Progress &nbsp;—&nbsp; all ${activePlan.weeks.length} weeks</div>
      <div class="grid-4">
        <div class="stat-card">
          <div class="stat-label">Miles Logged</div>
          <div class="stat-value">${totalActualMiles.toFixed(1)}</div>
          <div class="stat-sublabel">of ${totalPlannedMiles.toFixed(0)} mi planned so far</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Avg Pace</div>
          <div class="stat-value" style="font-size:32px;">${avgPace}${avgPace !== '—' ? '<span style="font-size:13px;color:var(--text2);font-weight:400;margin-left:2px;">/mi</span>' : ''}</div>
          <div class="stat-sublabel">across all logged runs</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Current Streak</div>
          <div class="stat-value">${currentStreak}<span style="font-size:16px;color:var(--text2);font-weight:400;"> run${currentStreak !== 1 ? 's' : ''}</span></div>
          <div class="stat-sublabel">longest: ${longestStreak}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Completion</div>
          <div class="stat-value">${completionPct}%</div>
          <div class="progress-bar" style="margin-top:8px;">
            <div class="progress-fill" style="width:${completionPct}%"></div>
          </div>
          <div class="stat-sublabel">${completedRuns} / ${totalRuns} runs</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Long Run Progression</div>
      <div class="chart-container"><canvas id="progressChart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">Weekly Mileage</div>
      <div class="chart-container"><canvas id="weeklyChart"></canvas></div>
    </div>
  `;

  setTimeout(() => {
    if (document.getElementById('progressChart')) renderProgressChart(longRunProgression);
    if (document.getElementById('weeklyChart'))   renderWeeklyMileageChart(weeklyMileage);
  }, 0);
}

function chartsAvailable(canvas) {
  if (typeof Chart !== 'undefined') return true;
  canvas.parentElement.innerHTML = '<p class="chart-unavailable">Charts could not load. Check your connection and reload the page.</p>';
  return false;
}

function renderProgressChart(data) {
  if (progressChartInstance) { progressChartInstance.destroy(); progressChartInstance = null; }
  const canvas = document.getElementById('progressChart');
  if (!canvas || !chartsAvailable(canvas)) return;

  const successColor = getCSSVar('--success') || '#10b981';
  const text2Color   = getCSSVar('--text2')   || '#94a3b8';
  const borderColor  = getCSSVar('--border')  || '#2d3748';

  progressChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels: data.map(d => `Wk ${d.week}`),
      datasets: [
        { label: 'Planned', data: data.map(d => d.planned), borderColor: `${text2Color}88`, borderDash: [5, 5],
          pointRadius: 3, fill: false, tension: 0.3, borderWidth: 1.5 },
        { label: 'Actual',  data: data.map(d => d.running), borderColor: successColor,
          backgroundColor: `${successColor}22`, pointBackgroundColor: successColor,
          pointRadius: 5, fill: true, tension: 0.3, borderWidth: 2.5,
          spanGaps: false }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: text2Color, boxWidth: 12, font: { size: 12 } } } },
      scales: {
        x: { ticks: { color: text2Color, font: { size: 11 } }, grid: { color: borderColor } },
        y: { ticks: { color: text2Color, font: { size: 11 } }, grid: { color: borderColor },
             title: { display: true, text: 'Miles', color: text2Color, font: { size: 11 } } }
      }
    }
  });
}

function renderWeeklyMileageChart(data) {
  if (weeklyChartInstance) { weeklyChartInstance.destroy(); weeklyChartInstance = null; }
  const canvas = document.getElementById('weeklyChart');
  if (!canvas || !chartsAvailable(canvas)) return;

  const successColor = getCSSVar('--success') || '#10b981';
  const accentColor  = getCSSVar('--accent')  || '#3b82f6';
  const text2Color   = getCSSVar('--text2')   || '#94a3b8';
  const borderColor  = getCSSVar('--border')  || '#2d3748';

  weeklyChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: data.map(d => `Wk ${d.week}`),
      datasets: [
        { label: 'Planned', data: data.map(d => d.planned),
          backgroundColor: `${accentColor}33`, borderColor: `${accentColor}88`, borderWidth: 1 },
        { label: 'Actual',  data: data.map(d => d.actual),
          backgroundColor: `${successColor}bb`, borderColor: successColor, borderWidth: 1 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: text2Color, boxWidth: 12, font: { size: 12 } } } },
      scales: {
        x: { ticks: { color: text2Color, font: { size: 11 } }, grid: { display: false } },
        y: { ticks: { color: text2Color, font: { size: 11 } }, grid: { color: borderColor },
             title: { display: true, text: 'Miles', color: text2Color, font: { size: 11 } } }
      }
    }
  });
}

// ============================================================================
// RENDERING — SCHEDULE
// ============================================================================

function renderSchedule() {
  const data = getStorage();
  if (data.plans.length === 0) {
    document.getElementById('scheduleContent').innerHTML = `
      <div class="empty-state">
        <div class="empty-text">You do not have a training plan yet.</div>
        <button class="btn btn-primary" onclick="switchTab('dashboard')">Create a plan</button>
      </div>`;
    return;
  }

  const activePlan = data.plans[0];
  const today      = getToday();
  const runLog     = {};
  data.runs.forEach(run => { if (run.planId === activePlan.id) runLog[run.date] = run; });

  let html = '';

  for (const week of activePlan.weeks) {
    const weekStart = parseDate(week.startDate);
    const weekEnd   = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6);

    let weekMiles = 0, completedMiles = 0;
    const badges = [];

    for (const run of week.runs) {
      weekMiles += run.plannedDistance;
      if (runLog[run.date]) completedMiles += runLog[run.date].distance;
    }

    const isCurrentWeek = weekStart <= today && today <= weekEnd;
    const allLogged     = week.runs.length > 0 && week.runs.every(r => runLog[r.date]);
    const hasLongRun    = week.runs.some(r => r.type === 'long');
    const hasRace       = week.runs.some(r => r.type === 'race');

    if (isCurrentWeek) badges.push({ cls: 'badge-current', label: 'Current' });
    if (allLogged && weekEnd < today) badges.push({ cls: 'badge-complete', label: 'Complete' });
    if (hasRace) badges.push({ cls: 'badge-race', label: 'Race Week' });
    else if (hasLongRun) badges.push({ cls: 'badge-recovery', label: 'Long Run' });

    const isOpen = isCurrentWeek || (weekEnd >= today && weekStart <= new Date(today.getTime() + 7 * 86400000));

    html += `
      <div class="week-group">
        <div class="week-header" onclick="toggleWeek(this)">
          <div>
            <div class="week-title">Week ${week.weekNumber}</div>
            <div class="week-meta">${escapeHtml(formatDisplayDate(week.startDate, { month: 'short', day: 'numeric' }))} – ${escapeHtml(formatDisplayDate(formatDate(weekEnd), { month: 'short', day: 'numeric' }))}</div>
            <div class="week-badges">${badges.map(b => `<span class="badge ${b.cls}">${b.label}</span>`).join('')}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:15px;font-weight:700;">${completedMiles.toFixed(1)} / ${weekMiles.toFixed(1)} mi</div>
            <div style="font-size:12px;color:var(--text2);margin-top:4px;">${week.runs.filter(r => runLog[r.date]).length} / ${week.runs.length} runs</div>
          </div>
        </div>
        <div class="week-content ${isOpen ? '' : 'hidden'}">`;

    for (const run of week.runs) {
      const logEntry = runLog[run.date];
      const runDate  = parseDate(run.date);
      const isPast   = runDate < today;
      const isToday  = formatDate(runDate) === formatDate(today);
      const pace     = logEntry ? calculatePace(logEntry.distance, logEntry.time) : '';

      html += `
        <div class="run-row">
          <div class="run-dot ${run.type}"></div>
          <div class="run-info">
            <div class="run-name">${dayOfWeek(runDate)}, ${escapeHtml(formatDisplayDate(run.date, { month: 'short', day: 'numeric' }))}</div>
            <div class="run-details">
              <span class="run-type-tag run-type-${run.type}">${runTypeLabel(run.type)}</span>
              ${run.plannedDistance} mi planned${logEntry ? ` · <strong>${logEntry.distance} mi</strong> logged` : ''}
            </div>
          </div>
          <div class="run-status">
            ${logEntry
              ? `<span class="status-badge status-complete">Logged</span>${pace ? ` <span class="pace-label">${pace}/mi</span>` : ''}`
              : isToday
                ? `<span class="status-badge status-today">Today</span>`
                : isPast
                  ? `<span class="status-badge status-missed">Missed</span>`
                  : `<span class="status-badge status-upcoming">Upcoming</span>`
            }
          </div>
          <div class="run-actions">
            <button class="btn btn-secondary sm" onclick="showLogRunModal('${run.id}', '${run.date}')">
              ${logEntry ? 'Edit' : 'Log'}
            </button>
          </div>
        </div>`;
    }

    html += `</div></div>`;
  }

  document.getElementById('scheduleContent').innerHTML = html;
  updateHeaderInfo();
}

// ============================================================================
// RENDERING — HISTORY
// ============================================================================

function renderHistory() {
  const data = getStorage();

  if (data.runs.length === 0) {
    document.getElementById('historyContent').innerHTML = `
      <div class="empty-state">
        <div class="empty-text">No runs logged yet.</div>
        <button class="btn btn-secondary" onclick="showLogUnplannedModal()">Log a run</button>
      </div>`;
    return;
  }

  const sorted = [...data.runs].sort((a, b) => parseDate(b.date) - parseDate(a.date));

  let html = `<div style="overflow-x:auto;"><table class="history-table">
    <thead><tr>
      <th>Date</th><th>Type</th><th>Distance</th><th>Time</th><th>Pace</th><th>Effort</th><th>Notes</th>
    </tr></thead><tbody>`;

  sorted.forEach(run => {
    const source   = run.effortSource === 'auto' ? 'Auto-calculated from heart rate' : run.effortSource === 'whoop' ? 'From Whoop' : 'Set manually';
    const computed = run.effortSource === 'auto' || run.effortSource === 'whoop';
    html += `
      <tr style="cursor:pointer;" onclick="showLogRunModal('', '${run.date}', '${run.id}')">
        <td>${escapeHtml(formatDisplayDate(run.date, { month: 'short', day: 'numeric', year: 'numeric' }))}</td>
        <td><span class="run-type-tag run-type-${run.type}">${runTypeLabel(run.type)}</span></td>
        <td><strong>${run.distance}</strong> mi</td>
        <td>${secondsToTimeString(run.time)}</td>
        <td>${calculatePace(run.distance, run.time) || '—'}${calculatePace(run.distance, run.time) ? '/mi' : ''}</td>
        <td>${run.effort ? `<span class="effort-badge${computed ? ' auto' : ''}" title="${source}">${run.effort}/10</span>` : '—'}</td>
        <td class="notes-cell" title="${escapeHtml(run.notes || '')}">${escapeHtml(run.notes || '') || '—'}</td>
      </tr>`;
  });

  html += `</tbody></table></div>`;
  document.getElementById('historyContent').innerHTML = html;
}

// ============================================================================
// RENDERING — PLANS
// ============================================================================

function renderPlans() {
  const data = getStorage();

  if (data.plans.length === 0) {
    document.getElementById('plansContent').innerHTML = `
      <div class="empty-state">
        <div class="empty-text">No training plans yet.</div>
        <button class="btn btn-primary" onclick="switchTab('dashboard')">Create a plan</button>
      </div>`;
    return;
  }

  let html = '';
  data.plans.forEach((plan, idx) => {
    const isActive     = idx === 0;
    const plannedDates = new Set(plan.weeks.flatMap(w => w.runs.map(r => r.date)));
    const totalRuns    = plannedDates.size;
    const loggedRuns   = data.runs.filter(r => r.planId === plan.id && plannedDates.has(r.date)).length;
    const pct = totalRuns > 0 ? Math.round((loggedRuns / totalRuns) * 100) : 0;

    html += `
      <div class="plan-card ${isActive ? 'active' : ''}">
        ${isActive ? '<div class="plan-active-tag">Active</div>' : ''}
        <div class="plan-name">${escapeHtml(plan.name)}</div>
        <div class="plan-dates">${escapeHtml(formatDisplayDate(plan.startDate))} to ${escapeHtml(formatDisplayDate(plan.raceDate))}</div>
        <div class="plan-details">
          <div class="plan-detail-item"><strong>Race:</strong> ${raceTypeLabel(plan.raceType)}${plan.source === 'ai' ? ' · drafted with the AI planner' : ''}</div>
          <div class="plan-detail-item"><strong>Run days:</strong> ${plan.runDays.map(capitalize).join(', ')}</div>
          <div class="plan-detail-item"><strong>Weeks:</strong> ${plan.weeks.length} &nbsp;·&nbsp; <strong>Progress:</strong> ${loggedRuns}/${totalRuns} runs (${pct}%)</div>
        </div>
        <div class="progress-bar" style="margin:12px 0;">
          <div class="progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="plan-actions">
          ${isActive ? '' : `<button class="btn btn-primary sm" onclick="setActivePlan('${plan.id}')">Make active</button>`}
          <button class="btn btn-secondary sm" onclick="editPlan('${plan.id}')">Edit</button>
          <button class="btn btn-danger sm" onclick="deletePlanConfirm('${plan.id}')">Delete</button>
        </div>
      </div>`;
  });

  document.getElementById('plansContent').innerHTML = html;
}

// ============================================================================
// RENDERING — SETTINGS
// ============================================================================

function renderSettings() {
  const data          = getStorage();
  const fitConnected  = isFitbitConnected();
  const whoopConn     = isWhoopConnected();
  const fitLastSync   = storageGet(lsKey('fitbit_last_sync'));
  const whoopLastSync = storageGet(lsKey('whoop_last_sync'));
  const savedFitbitId = readDeviceSetting('fitbit_client_id');
  const savedWhoopId  = readDeviceSetting('whoop_client_id');
  const savedProxy    = readDeviceSetting('whoop_proxy_url');
  const hasAIKey      = !!getAnthropicKey();

  const syncText = (ts) => ts
    ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Never';

  const activePlan = data.plans[0];

  document.getElementById('settingsContent').innerHTML = `
    <div class="settings-group">
      <div class="settings-group-label">Training plan</div>
      ${activePlan ? `
      <div class="settings-row">
        <span class="settings-row-key">Active plan</span>
        <span class="settings-row-val">${escapeHtml(activePlan.name)}</span>
      </div>
      <div class="settings-row">
        <span class="settings-row-key">Race day</span>
        <span class="settings-row-val">${escapeHtml(formatDisplayDate(activePlan.raceDate))}</span>
      </div>
      <p class="settings-help">Edit the race, dates or run days to rebuild the schedule (logged runs are kept), or start a new plan. Earlier plans stay under All plans.</p>
      <div class="settings-row-actions">
        <button class="btn btn-secondary btn-sm" onclick="editPlan('${activePlan.id}')">Edit or rebuild</button>
        <button class="btn btn-secondary btn-sm" onclick="showCreatePlanModal()">New plan</button>
        <button class="btn btn-secondary btn-sm" onclick="switchTab('plans')">All plans (${data.plans.length})</button>
      </div>` : `
      <p class="settings-help">You do not have a training plan yet.</p>
      <div class="settings-row-actions">
        <button class="btn btn-primary btn-sm" onclick="switchTab('dashboard')">Create a plan</button>
      </div>`}
    </div>

    <div class="settings-group">
      <div class="settings-group-label">Profile</div>
      <div class="settings-row">
        <span class="settings-row-key">Age <span class="settings-row-hint">for HR zone calculation</span></span>
        <input type="number" class="settings-inline-input" id="userAgeInput" value="${getUserAge()}" min="10" max="100" onchange="saveUserAge(this.value)" />
      </div>
      <div class="settings-row">
        <span class="settings-row-key">Theme</span>
        <button class="btn btn-secondary btn-sm" onclick="toggleTheme()">${getTheme() === 'light' ? 'Switch to dark' : 'Switch to light'}</button>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-label">AI planner</div>
      <div class="settings-row">
        <span class="settings-row-key">Anthropic API key</span>
        <span class="settings-row-val">${hasAIKey ? 'Saved in this browser' : 'Not set'}</span>
      </div>
      <div class="settings-row">
        <label class="settings-row-key" for="aiModelInput">Model <span class="settings-row-hint">optional</span></label>
        <input type="text" class="settings-inline-input wide" id="aiModelInput" value="${escapeHtml(getSavedAIModel())}" placeholder="${DEFAULT_AI_MODEL}" autocomplete="off" spellcheck="false" onchange="saveAIModel(this.value)" />
      </div>
      <p class="settings-help">Leave the model blank to use the default, <code>${DEFAULT_AI_MODEL}</code>. Your key is stored only in this browser and is sent only to api.anthropic.com.</p>
      <div class="settings-row-actions">
        ${hasAIKey
          ? `<button class="btn btn-secondary btn-sm" onclick="forgetAnthropicKey()">Forget key</button>`
          : `<button class="btn btn-secondary btn-sm" onclick="switchTab('ai')">Add a key</button>`}
      </div>
    </div>

    <div class="settings-group" id="settings-fitbit">
      <div class="settings-group-label">Fitbit</div>
      ${fitConnected ? `
      <div class="settings-row">
        <span class="settings-row-key">Status</span>
        <span class="device-badge-connected">Connected</span>
      </div>
      <div class="settings-row">
        <span class="settings-row-key">Last sync</span>
        <span class="settings-row-val">${syncText(fitLastSync)}</span>
      </div>
      <div class="settings-row-actions">
        <button class="btn btn-primary btn-sm" id="fitbitSyncBtn" onclick="syncFitbitRuns({ notify: true })">Sync now</button>
        <button class="btn btn-secondary btn-sm" onclick="disconnectFitbit()">Disconnect</button>
      </div>
      ` : `
      <p class="settings-help">Import runs and heart rate data through your own Fitbit developer app. Google is shutting down the Fitbit Web API on October 30, 2026.</p>
      <div class="settings-row">
        <label class="settings-row-key" for="fitbitClientIdInput">Client ID</label>
        <input type="text" class="settings-inline-input wide" id="fitbitClientIdInput" value="${escapeHtml(savedFitbitId)}" placeholder="e.g. ABC123" autocomplete="off" spellcheck="false" />
      </div>
      <div class="settings-row settings-row-wrap">
        <span class="settings-row-key">Callback URL</span>
        ${redirectUriMarkup()}
      </div>
      <div class="settings-row-actions">
        <button class="btn btn-primary btn-sm" onclick="connectFitbit()">Connect Fitbit</button>
        <button class="btn btn-secondary btn-sm" onclick="showDeviceGuide('fitbit')">Setup guide</button>
      </div>
      `}
    </div>

    <div class="settings-group" id="settings-whoop">
      <div class="settings-group-label">Whoop <span class="badge-muted">Advanced</span></div>
      ${whoopConn ? `
      <div class="settings-row">
        <span class="settings-row-key">Status</span>
        <span class="device-badge-connected">Connected</span>
      </div>
      <div class="settings-row">
        <span class="settings-row-key">Last sync</span>
        <span class="settings-row-val">${syncText(whoopLastSync)}</span>
      </div>
      <div class="settings-row-actions">
        <button class="btn btn-primary btn-sm" id="whoopSyncBtn" onclick="syncWhoopData({ notify: true })">Sync now</button>
        <button class="btn btn-secondary btn-sm" onclick="disconnectWhoop()">Disconnect</button>
      </div>
      ` : `
      <p class="settings-help">For self-hosters. Whoop requires a client secret, so you need your own Whoop developer app and a small token proxy that you host. The setup guide has the steps and the proxy code.</p>
      <div class="settings-row">
        <label class="settings-row-key" for="whoopClientIdInput">Client ID</label>
        <input type="text" class="settings-inline-input wide" id="whoopClientIdInput" value="${escapeHtml(savedWhoopId)}" placeholder="From the Whoop dashboard" autocomplete="off" spellcheck="false" />
      </div>
      <div class="settings-row">
        <label class="settings-row-key" for="whoopProxyInput">Token proxy URL</label>
        <input type="url" class="settings-inline-input wide" id="whoopProxyInput" value="${escapeHtml(savedProxy)}" placeholder="https://your-proxy.example.com/token" autocomplete="off" spellcheck="false" />
      </div>
      <div class="settings-row-actions">
        <button class="btn btn-primary btn-sm" onclick="connectWhoop()">Connect Whoop</button>
        <button class="btn btn-secondary btn-sm" onclick="showDeviceGuide('whoop')">Setup guide</button>
      </div>
      `}
    </div>

    <div class="settings-group">
      <div class="settings-group-label">Data</div>
      <div class="settings-row">
        <span class="settings-row-key">Stored in</span>
        <span class="settings-row-val">${isAccountSession() ? 'Your account, synced' : 'This browser only'}</span>
      </div>
      <div class="settings-row">
        <span class="settings-row-key">Plans</span>
        <span class="settings-row-val">${data.plans.length}</span>
      </div>
      <div class="settings-row">
        <span class="settings-row-key">Runs logged</span>
        <span class="settings-row-val">${data.runs.length}</span>
      </div>
      <div class="settings-row-actions">
        <button class="btn btn-secondary btn-sm" onclick="exportData()">Export JSON</button>
        <button class="btn btn-secondary btn-sm" onclick="showImportModal()">Import JSON</button>
        <button class="btn btn-danger btn-sm" onclick="clearAllData()">Clear all data</button>
      </div>
    </div>

    <div class="settings-group settings-group-last">
      <div class="settings-group-label">Account</div>
      ${accountSettingsMarkup()}
    </div>
  `;
}

function accountSettingsMarkup() {
  if (isAccountSession()) {
    const guest = readGuestData();
    const guestRecords = guest.plans.length + guest.runs.length;
    const pending = guestRecords ? previewGuestImport() : { addedPlans: 0, addedRuns: 0 };
    const hasNew = pending.addedPlans + pending.addedRuns > 0;
    return `
      <div class="settings-row">
        <span class="settings-row-key">Signed in as</span>
        <span class="settings-row-val">${escapeHtml(session.username)}</span>
      </div>
      <p class="settings-help">Your plans and runs sync to your account, so you can sign in on any device. Accounts have no email address, so a forgotten password cannot be reset. Export your data now and then to keep a backup.</p>
      <div class="settings-row-actions">
        <button class="btn btn-secondary btn-sm" onclick="signOut()">Sign out</button>
      </div>
      ${guestRecords ? `
      <div class="settings-row">
        <span class="settings-row-key">Guest data in this browser</span>
        <span class="settings-row-val">${plural(guest.plans.length, 'plan')}, ${plural(guest.runs.length, 'run')}${hasNew ? '' : ' (already in your account)'}</span>
      </div>
      <p class="settings-help">Data from guest mode stays on this device, separate from your account. You return to it when you sign out.</p>
      <div class="settings-row-actions">
        ${hasNew ? '<button class="btn btn-secondary btn-sm" onclick="showGuestImportModal()">Import into my account</button>' : ''}
        <button class="btn btn-secondary btn-sm" onclick="deleteGuestData()">Delete guest data</button>
      </div>` : ''}`;
  }
  return `
      <div class="settings-row">
        <span class="settings-row-key">Mode</span>
        <span class="settings-row-val">Guest</span>
      </div>
      <p class="settings-help">${accountsEnabled()
        ? 'Your plans and runs are saved in this browser only. Sign in or create a free account to back them up and sync them across devices. You can bring your guest data with you.'
        : 'Your plans and runs are saved in this browser only. Use Export to keep a backup or to move them to another device.'}</p>
      ${accountsEnabled() ? `
      <div class="settings-row-actions">
        <button class="btn btn-primary btn-sm" onclick="showSignIn()">Sign in to sync</button>
      </div>` : ''}`;
}

function updateHeaderInfo() {
  const data = getStorage();
  if (data.plans.length === 0) { document.getElementById('headerInfo').innerHTML = ''; return; }
  const activePlan = data.plans[0];
  document.getElementById('headerInfo').innerHTML = `
    <div>
      <div style="font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:0.3px;">${escapeHtml(activePlan.name)}</div>
      <div style="font-size:14px;font-weight:600;">${daysToRaceText(activePlan.raceDate)}</div>
    </div>`;
}

// ============================================================================
// MODAL MANAGEMENT
// ============================================================================

let currentLogId = null;
let importMode   = 'merge';

function openModal(id)  { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

function findPlannedRun(plan, dateStr) {
  if (!plan || !dateStr) return null;
  for (const week of plan.weeks) {
    const run = week.runs.find(r => r.date === dateStr);
    if (run) return run;
  }
  return null;
}

function plannedRunLabel(run) {
  return run
    ? `${runTypeLabel(run.type)} · ${run.plannedDistance} mi · about ${secondsToTimeString(run.plannedTime)}`
    : 'Nothing planned for this day';
}

function buildEffortGrid(selected) {
  const grid = document.getElementById('effortGrid');
  grid.innerHTML = '';
  for (let i = 1; i <= 10; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `effort-btn${selected === i ? ' active' : ''}`;
    btn.textContent = i;
    btn.dataset.value = i;
    btn.setAttribute('aria-pressed', String(selected === i));
    btn.onclick = () => {
      const wasActive = btn.classList.contains('active');
      grid.querySelectorAll('.effort-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
      if (!wasActive) { btn.classList.add('active'); btn.setAttribute('aria-pressed', 'true'); }
    };
    grid.appendChild(btn);
  }
}

// Opens the log form for a date. If a run is already logged that day (or
// `logId` names one), the form edits it instead of adding a second run.
function showLogRunModal(runId, dateStr, logId) {
  const data = getStorage();
  let existingLog = logId ? data.runs.find(r => r.id === logId) : null;
  const plan = existingLog ? data.plans.find(p => p.id === existingLog.planId) : data.plans[0];
  const date = dateStr || existingLog?.date || formatDate(getToday());
  if (!existingLog && plan) existingLog = data.runs.find(r => r.planId === plan.id && r.date === date) || null;

  if (!plan && !existingLog) {
    showToast('Create a training plan first, then log your runs against it.');
    switchTab('dashboard');
    return;
  }

  const planned = findPlannedRun(plan, date);
  currentLogId = existingLog ? existingLog.id : null;

  document.getElementById('runLogTitle').textContent = existingLog ? 'Edit run' : 'Log a run';
  document.getElementById('logDate').value     = date;
  document.getElementById('logDistance').value = existingLog ? existingLog.distance : (planned ? planned.plannedDistance : '');
  document.getElementById('logTime').value     = existingLog ? secondsToTimeString(existingLog.time) : '';
  document.getElementById('logNotes').value    = existingLog ? existingLog.notes || '' : '';
  document.getElementById('logPlanned').textContent = plannedRunLabel(planned);
  document.getElementById('logError').textContent   = '';
  document.getElementById('deleteLogBtn').style.display = existingLog ? '' : 'none';
  buildEffortGrid(existingLog ? existingLog.effort : 0);

  openModal('runLogModal');
}

function showLogUnplannedModal() {
  showLogRunModal('', formatDate(getToday()));
}

function updateLogPlanned() {
  const data = getStorage();
  const log  = currentLogId ? data.runs.find(r => r.id === currentLogId) : null;
  const plan = log ? data.plans.find(p => p.id === log.planId) : data.plans[0];
  document.getElementById('logPlanned').textContent = plannedRunLabel(findPlannedRun(plan, document.getElementById('logDate').value));
}

function saveRunLog(event) {
  event.preventDefault();
  const errorEl  = document.getElementById('logError');
  const data     = getStorage();
  const existing = currentLogId ? data.runs.find(r => r.id === currentLogId) : null;
  const planId   = existing ? existing.planId : data.plans[0]?.id;
  const plan     = data.plans.find(p => p.id === planId);
  const dateStr  = document.getElementById('logDate').value;
  const distance = Number(document.getElementById('logDistance').value);
  const timeText = document.getElementById('logTime').value.trim();
  const time     = timeStringToSeconds(timeText);
  const notes    = document.getElementById('logNotes').value.trim().slice(0, 500);
  const effortEl = document.querySelector('#effortGrid .effort-btn.active');
  const effort   = effortEl ? Number(effortEl.dataset.value) : 0;
  const clash    = data.runs.find(r => r.planId === planId && r.date === dateStr && r.id !== existing?.id);

  let error = '';
  if (!planId) error = 'Create a training plan first.';
  else if (!isValidDateString(dateStr)) error = 'Choose the date of your run.';
  else if (clash) error = `You already logged a run on ${formatDisplayDate(dateStr, { month: 'short', day: 'numeric' })}. Open it from History to change it.`;
  else if (!(distance > 0) || distance > 200) error = 'Enter a distance in miles, for example 3.1.';
  else if (!timeText) error = 'Enter how long the run took, for example 32:15.';
  else if (!(time > 0) || time > 48 * 3600) error = 'Enter the time as mm:ss or h:mm:ss, for example 32:15 or 1:05:30.';
  errorEl.textContent = error;
  if (error) return;

  const planned = findPlannedRun(plan, dateStr);
  const run = existing || { id: generateUUID(), planId };
  if (!existing) data.runs.push(run);
  const keepSource = existing && effort && effort === existing.effort && existing.effortSource;
  Object.assign(run, {
    date: dateStr,
    type: planned ? planned.type : (existing?.type || 'easy'),
    distance: Math.round(distance * 100) / 100,
    time,
    effort,
    effortSource: keepSource ? existing.effortSource : effort ? 'manual' : 'none',
    notes
  });

  setStorage(data);
  closeModal('runLogModal');
  renderAll();
  updateHeaderInfo();
  if (existing) { showToast('Run updated.', 'success'); return; }
  if (!offerAdjustment(plan, dateStr)) showToast('Run logged.', 'success');
}

let pendingAdjustment = null;

// After a new run is logged, offer to spread recently missed easy miles over
// the next few easy runs. Each missed run is only offered once.
function offerAdjustment(plan, dateStr) {
  if (!plan) return false;
  const missed     = getMissedRuns(plan.id, dateStr);
  const candidates = getAdjustmentCandidates(plan.id, dateStr);
  const missedMi   = missed.reduce((sum, r) => sum + r.plannedDistance, 0);
  if (!missed.length || !candidates.length) return false;

  const extra = Math.min(ADJUST_MAX_EXTRA_MI, Math.round(missedMi / candidates.length * 2) / 2);
  missed.forEach(r => { r.missHandled = true; });
  setStorage(getStorage());
  if (extra <= 0) return false;

  pendingAdjustment = { planId: plan.id, extra, runIds: candidates.map(r => r.id) };
  document.getElementById('adjustmentMessage').textContent =
    `You missed ${missed.length} easy run${missed.length === 1 ? '' : 's'} (${Math.round(missedMi * 10) / 10} mi) in the week before this run. ` +
    `Add ${extra} mi to each of your next ${candidates.length === 1 ? 'easy run' : `${candidates.length} easy runs`} to make up some of it?`;
  document.getElementById('adjustmentRuns').innerHTML = candidates.map(r => `
    <div class="adjustment-run">
      <div class="adjustment-run-title">${dayOfWeek(parseDate(r.date))}, ${escapeHtml(formatDisplayDate(r.date, { month: 'short', day: 'numeric' }))}</div>
      <div class="adjustment-run-detail">${r.plannedDistance} mi to ${Math.round((r.plannedDistance + extra) * 10) / 10} mi</div>
    </div>`).join('');
  openModal('adjustmentModal');
  return true;
}

function applyAdjustment() {
  const data = getStorage();
  const plan = pendingAdjustment && data.plans.find(p => p.id === pendingAdjustment.planId);
  if (plan) {
    for (const run of plan.weeks.flatMap(w => w.runs)) {
      if (!pendingAdjustment.runIds.includes(run.id)) continue;
      run.plannedDistance = Math.round((run.plannedDistance + pendingAdjustment.extra) * 10) / 10;
      run.plannedTime = Math.round(run.plannedDistance * PACE_SEC_PER_MI[run.type]);
    }
    setStorage(data);
    renderAll();
    showToast('Your next easy runs were updated.', 'success');
  }
  pendingAdjustment = null;
  closeModal('adjustmentModal');
}

function deleteCurrentLog() {
  if (!currentLogId || !confirm('Delete this run from your log?')) return;
  const data = getStorage();
  data.runs = data.runs.filter(r => r.id !== currentLogId);
  currentLogId = null;
  setStorage(data);
  closeModal('runLogModal');
  renderAll();
  updateHeaderInfo();
  showToast('Run deleted.');
}

function openPlanModal(title, options) {
  document.getElementById('createPlanTitle').textContent = title;
  openModal('createPlanModal');
  mountPlanForm(document.getElementById('planFormHost'), {
    onCancel: () => closeModal('createPlanModal'),
    ...options
  });
}

function showCreatePlanModal() {
  openPlanModal('New plan', {
    submitLabel: 'Create plan',
    onSaved: () => {
      closeModal('createPlanModal');
      renderAll();
      updateHeaderInfo();
      switchTab('dashboard');
      showToast('Plan created and set as your active plan.', 'success');
    }
  });
}

function editPlan(planId) {
  const plan = getStorage().plans.find(p => p.id === planId);
  if (!plan) return;
  openPlanModal('Edit plan', {
    plan,
    submitLabel: 'Save changes',
    onSaved: () => {
      closeModal('createPlanModal');
      renderAll();
      updateHeaderInfo();
      showToast('Plan updated.', 'success');
    },
    onDelete: () => {
      if (deletePlanConfirm(planId)) closeModal('createPlanModal');
    }
  });
}

function setActivePlan(planId) {
  const data = getStorage();
  const plan = data.plans.find(p => p.id === planId);
  if (!plan) return;
  plan.activatedAt = Date.now();
  setStorage(data);
  renderAll();
  updateHeaderInfo();
  showToast(`"${plan.name}" is now your active plan.`, 'success');
}

function deletePlanConfirm(planId) {
  const data = getStorage();
  const plan = data.plans.find(p => p.id === planId);
  if (!plan) return false;
  const logged = data.runs.filter(r => r.planId === planId).length;
  const detail = logged ? ` and its ${logged} logged run${logged === 1 ? '' : 's'}` : '';
  if (!confirm(`Delete "${plan.name}"${detail}? This cannot be undone.`)) return false;
  data.plans = data.plans.filter(p => p.id !== planId);
  data.runs  = data.runs.filter(r => r.planId !== planId);
  setStorage(data);
  renderAll();
  updateHeaderInfo();
  showToast('Plan deleted.');
  return true;
}

function showImportModal() {
  importMode = 'merge';
  document.querySelectorAll('#importModal .pill').forEach(p => p.classList.toggle('active', p.dataset.mode === 'merge'));
  document.getElementById('importFile').value = '';
  document.getElementById('importError').textContent = '';
  openModal('importModal');
}

function setImportMode(element) {
  document.querySelectorAll('#importModal .pill').forEach(p => p.classList.remove('active'));
  element.classList.add('active');
  importMode = element.dataset.mode;
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function cleanNumber(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

// Validate an exported RunTrack file and return clean { plans, runs }.
// Unknown fields are dropped and unsafe IDs are replaced.
function sanitizeImportedData(raw) {
  if (!raw || typeof raw !== 'object' || (!Array.isArray(raw.plans) && !Array.isArray(raw.runs))) {
    throw new Error('This file is not a RunTrack export.');
  }
  const planIdMap = new Map();
  const plans = [];

  for (const p of Array.isArray(raw.plans) ? raw.plans : []) {
    if (!p || !isValidDateString(p.startDate) || !isValidDateString(p.raceDate) || !Array.isArray(p.weeks)) continue;
    const id = typeof p.id === 'string' && SAFE_ID_PATTERN.test(p.id) ? p.id : generateUUID();
    if (planIdMap.has(p.id) || plans.some(existing => existing.id === id)) continue;
    planIdMap.set(p.id, id);

    const seenDates = new Set();
    const weeks = p.weeks.slice(0, 60).map((w, i) => ({
      weekNumber: i + 1,
      startDate: isValidDateString(w?.startDate) ? w.startDate : formatDate(addDays(parseDate(p.startDate), i * 7)),
      runs: (Array.isArray(w?.runs) ? w.runs : []).filter(r => {
        if (!r || !isValidDateString(r.date) || seenDates.has(r.date) || cleanNumber(r.plannedDistance, 0.1, 100) === null) return false;
        seenDates.add(r.date);
        return true;
      }).map(r => {
        const type = ['easy', 'long', 'race'].includes(r.type) ? r.type : 'easy';
        const distance = Number(r.plannedDistance);
        return {
          id: typeof r.id === 'string' && SAFE_ID_PATTERN.test(r.id) ? r.id : generateUUID(),
          date: r.date, type, plannedDistance: distance,
          plannedTime: cleanNumber(r.plannedTime, 0, 172800) ?? Math.round(distance * PACE_SEC_PER_MI[type]),
          actualDistance: null, actualTime: null, effort: null,
          notes: cleanText(r.notes, 200)
        };
      })
    }));

    const runDays = WEEK_ORDER.filter(d => Array.isArray(p.runDays) && p.runDays.includes(d));
    const plan = {
      id,
      name: cleanText(p.name, 80) || 'Imported plan',
      raceType: RACE_TYPES.includes(p.raceType) ? p.raceType : 'custom',
      startDate: p.startDate,
      raceDate: p.raceDate,
      runDays,
      longRunDay: runDays.includes(p.longRunDay) ? p.longRunDay : (runDays[runDays.length - 1] || 'saturday'),
      createdAt: typeof p.createdAt === 'string' && !Number.isNaN(Date.parse(p.createdAt)) ? p.createdAt : new Date().toISOString(),
      weeks
    };
    const activatedAt = cleanNumber(p.activatedAt, 0, 1e14);
    if (activatedAt) plan.activatedAt = activatedAt;
    if (p.source === 'ai') plan.source = 'ai';
    const notes = cleanText(p.notes, 600);
    if (notes) plan.notes = notes;
    plans.push(plan);
  }

  const runs = [];
  const runIds = new Set();
  for (const r of Array.isArray(raw.runs) ? raw.runs : []) {
    const distance = cleanNumber(r?.distance, 0.01, 200);
    const time     = cleanNumber(r?.time, 1, 172800);
    if (!r || !isValidDateString(r.date) || distance === null || time === null) continue;
    let id = typeof r.id === 'string' && SAFE_ID_PATTERN.test(r.id) ? r.id : generateUUID();
    if (runIds.has(id)) id = generateUUID();
    runIds.add(id);

    const run = {
      id,
      planId: planIdMap.get(r.planId) || (typeof r.planId === 'string' && SAFE_ID_PATTERN.test(r.planId) ? r.planId : ''),
      date: r.date,
      type: ['easy', 'long', 'race'].includes(r.type) ? r.type : 'easy',
      distance,
      time: Math.round(time),
      effort: Number.isInteger(r.effort) && r.effort >= 1 && r.effort <= 10 ? r.effort : 0,
      effortSource: ['manual', 'auto', 'whoop', 'none'].includes(r.effortSource) ? r.effortSource : 'manual',
      notes: cleanText(r.notes, 500)
    };
    if (typeof r.fitbitId === 'string' || typeof r.fitbitId === 'number') run.fitbitId = String(r.fitbitId).slice(0, 64);
    if (typeof r.whoopWorkoutId === 'string') run.whoopWorkoutId = r.whoopWorkoutId.slice(0, 64);
    const hr = cleanNumber(r.avgHeartRate, 20, 260);
    if (hr !== null) run.avgHeartRate = hr;
    if (Array.isArray(r.heartRateZones)) {
      run.heartRateZones = r.heartRateZones.slice(0, 10)
        .filter(z => z && typeof z === 'object')
        .map(z => ({ name: cleanText(z.name, 40), minutes: cleanNumber(z.minutes, 0, 2880) ?? 0 }));
    }
    if (r.whoopZones && typeof r.whoopZones === 'object' && !Array.isArray(r.whoopZones)) {
      run.whoopZones = Object.fromEntries(Object.entries(r.whoopZones).slice(0, 10)
        .map(([key, value]) => [cleanText(key, 40), cleanNumber(value, 0, 1e9) ?? 0])
        .filter(([key]) => key));
    }
    runs.push(run);
  }

  if (!plans.length && !runs.length) throw new Error('No plans or runs were found in this file.');
  return { plans, runs };
}

// Merge imported records into existing data. Existing records win on ID
// clashes, and a run is skipped if its plan already has a run on that date.
function mergeRunTrackData(target, incoming) {
  const planIds = new Set(target.plans.map(p => p.id));
  const runIds  = new Set(target.runs.map(r => r.id));
  const runKeys = new Set(target.runs.map(r => `${r.planId}|${r.date}`));
  let addedPlans = 0, addedRuns = 0;
  for (const plan of incoming.plans) {
    if (planIds.has(plan.id)) continue;
    target.plans.push(plan);
    planIds.add(plan.id);
    addedPlans++;
  }
  for (const run of incoming.runs) {
    const key = `${run.planId}|${run.date}`;
    if (runIds.has(run.id) || runKeys.has(key)) continue;
    target.runs.push(run);
    runIds.add(run.id);
    runKeys.add(key);
    addedRuns++;
  }
  return { addedPlans, addedRuns };
}

function performImport() {
  const file  = document.getElementById('importFile').files[0];
  const errEl = document.getElementById('importError');
  errEl.textContent = '';
  if (!file) { errEl.textContent = 'Choose a RunTrack JSON export first.'; return; }
  if (file.size > IMPORT_MAX_BYTES) { errEl.textContent = 'That file is too large to be a RunTrack export.'; return; }

  const reader = new FileReader();
  reader.onerror = () => { errEl.textContent = 'Could not read that file.'; };
  reader.onload = (e) => {
    let imported;
    try {
      imported = sanitizeImportedData(JSON.parse(e.target.result));
    } catch (err) {
      errEl.textContent = err instanceof SyntaxError ? 'This file is not valid JSON.' : err.message;
      return;
    }

    const existing = getStorage();
    if (importMode === 'replace') {
      if ((existing.plans.length || existing.runs.length) &&
          !confirm('Replace all of your current plans and runs with this file? This cannot be undone.')) return;
      setStorage({ ...existing, plans: imported.plans, runs: imported.runs });
      showToast(`Imported ${plural(imported.plans.length, 'plan')} and ${plural(imported.runs.length, 'run')}.`, 'success');
    } else {
      const { addedPlans, addedRuns } = mergeRunTrackData(existing, imported);
      setStorage(existing);
      showToast(`Added ${plural(addedPlans, 'plan')} and ${plural(addedRuns, 'run')}. Duplicates were skipped.`, 'success');
    }
    closeModal('importModal');
    renderAll();
    updateHeaderInfo();
  };
  reader.readAsText(file);
}

function exportData() {
  const data = getStorage();
  const payload = { app: 'RunTrack', version: 1, exportedAt: new Date().toISOString(), plans: data.plans, runs: data.runs };
  downloadFile(JSON.stringify(payload, null, 2), 'application/json', `runtrack-export-${formatDate(getToday())}.json`);
}

function downloadFile(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a   = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileSlug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'runtrack';
}

function icsText(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Folds lines longer than 75 characters, as iCalendar (RFC 5545) requires.
function icsFold(line) {
  return line.length <= 75 ? line : line.match(/.{1,74}/gu).join('\r\n ');
}

function exportICS() {
  const data       = getStorage();
  const activePlan = data.plans[0];
  if (!activePlan) { showToast('Create a training plan first.'); return; }

  const todayStr = formatDate(getToday());
  const logged   = loggedDates(data, activePlan.id);
  const stamp    = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RunTrack//Training plan//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(activePlan.name)}`
  ];
  let events = 0;
  for (const run of activePlan.weeks.flatMap(w => w.runs)) {
    if (run.date < todayStr || logged.has(run.date)) continue;
    const summary = `${runTypeLabel(run.type)} run: ${run.plannedDistance} mi`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${run.id}@runtrack`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${run.date.replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${formatDate(addDays(parseDate(run.date), 1)).replace(/-/g, '')}`,
      `SUMMARY:${icsText(summary)}`,
      `DESCRIPTION:${icsText(`${activePlan.name}. ${summary}, about ${secondsToTimeString(run.plannedTime)}.`)}`,
      'END:VEVENT'
    );
    events++;
  }
  lines.push('END:VCALENDAR');
  if (!events) { showToast('There are no upcoming runs to export.'); return; }
  downloadFile(lines.map(icsFold).join('\r\n') + '\r\n', 'text/calendar', `${fileSlug(activePlan.name)}-schedule.ics`);
  showToast(`Exported ${events} upcoming run${events === 1 ? '' : 's'} to a calendar file.`, 'success');
}

function clearAllData() {
  const where = isAccountSession() ? 'from your account on every device' : 'from this browser';
  if (!confirm(`Delete all of your plans and runs ${where}? This cannot be undone.`)) return;
  setStorage({ ...getStorage(), plans: [], runs: [], whoopRecovery: null });
  renderAll();
  updateHeaderInfo();
  switchTab('dashboard');
  showToast('All plans and runs were deleted.');
}

function toggleWeek(element) { element.nextElementSibling.classList.toggle('hidden'); }

// ============================================================================
// THEME
// ============================================================================

function toggleTheme() {
  const newTheme = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(newTheme);
  updateThemeIcon();
  renderSettings();
  const data = getStorage();
  if (data.plans.length > 0 && document.getElementById('progressChart')) renderDashboard();
}

function updateThemeIcon() {
  const btn = document.querySelector('.theme-toggle');
  if (btn) btn.textContent = getTheme() === 'light' ? 'Dark Mode' : 'Light Mode';
}

// ============================================================================
// NAVIGATION
// ============================================================================

function renderAll() {
  renderDashboard(); renderSchedule(); renderHistory(); renderPlans();
  renderSettings(); renderAI(); renderDevices();
}

function switchTab(tab) {
  document.querySelectorAll('.nav-item').forEach(i => {
    const active = i.dataset.tab === tab;
    i.classList.toggle('active', active);
    if (active) i.setAttribute('aria-current', 'page');
    else i.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const targetView = document.getElementById(tab);
  if (targetView) targetView.classList.add('active');
  if      (tab === 'dashboard') renderDashboard();
  else if (tab === 'schedule')  renderSchedule();
  else if (tab === 'history')   renderHistory();
  else if (tab === 'plans')     renderPlans();
  else if (tab === 'settings')  renderSettings();
  else if (tab === 'ai')        renderAI();
  else if (tab === 'devices')   renderDevices();
}

function setupNavListeners() {
  document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
    item.addEventListener('click', (event) => {
      event.preventDefault();
      switchTab(item.dataset.tab);
    });
  });
}

// ============================================================================
// DEVICE INTEGRATIONS (optional)
// ============================================================================
//
// Fitbit and Whoop are optional. This site ships no client IDs: each person
// registers their own developer app and enters its details in Settings. OAuth
// tokens are kept only in this browser's localStorage and are sent only to the
// provider, or for Whoop token requests, to the proxy that the user hosts.

// Providers redirect back to this page without its query, hash or a trailing
// index.html, so the URL matches the one users register with the provider.
const OAUTH_REDIRECT_URI = (() => {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/index\.html$/, '');
  return url.toString();
})();

function readDeviceSetting(name) {
  return session ? (storageGet(lsKey(name)) || '').trim() : '';
}

function saveDeviceSetting(name, value) {
  const clean = String(value || '').trim();
  if (clean) storageSet(lsKey(name), clean);
  else storageRemove(lsKey(name));
}

function base64URLEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function randomToken(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64URLEncode(bytes);
}

async function startOAuth(provider, authorizeUrl, params) {
  if (!window.isSecureContext || !window.crypto || !crypto.subtle) {
    showToast('Connecting a device needs a secure (https) page.', 'error', 7000);
    return;
  }
  const verifier  = randomToken(32);
  const challenge = base64URLEncode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state     = `${provider}_${randomToken(12)}`;
  storageSet(lsKey(`${provider}_pkce_verifier`), verifier);
  storageSet(lsKey(`${provider}_oauth_state`), state);

  const query = new URLSearchParams({
    ...params,
    response_type: 'code',
    redirect_uri: OAUTH_REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  window.location.assign(`${authorizeUrl}?${query}`);
}

// Returns null when the current URL is not an OAuth callback for `provider`,
// otherwise { code, verifier } or { error }.
function readOAuthCallback(provider) {
  const params = new URLSearchParams(window.location.search);
  const state  = params.get('state') || '';
  if (!state.startsWith(`${provider}_`)) return null;

  window.history.replaceState({}, '', window.location.pathname);
  const storedState = storageGet(lsKey(`${provider}_oauth_state`));
  const verifier    = storageGet(lsKey(`${provider}_pkce_verifier`));
  storageRemove(lsKey(`${provider}_oauth_state`));
  storageRemove(lsKey(`${provider}_pkce_verifier`));

  if (params.get('error')) return { error: params.get('error') };
  if (!params.get('code') || state !== storedState || !verifier) return { error: 'invalid_state' };
  return { code: params.get('code'), verifier };
}

function saveOAuthTokens(provider, tokens, defaultLifetimeSec) {
  if (!tokens || !tokens.access_token) throw new Error('No access token in response');
  storageSet(lsKey(`${provider}_access_token`), tokens.access_token);
  if (tokens.refresh_token) storageSet(lsKey(`${provider}_refresh_token`), tokens.refresh_token);
  storageSet(lsKey(`${provider}_token_expires`), String(Date.now() + (tokens.expires_in || defaultLifetimeSec) * 1000));
}

function clearOAuthTokens(provider) {
  ['access_token', 'refresh_token', 'token_expires', 'last_sync']
    .forEach(name => storageRemove(lsKey(`${provider}_${name}`)));
}

function hasFreshToken(provider) {
  const expires = parseInt(storageGet(lsKey(`${provider}_token_expires`)) || '0', 10);
  return Date.now() < expires - 60000;
}

function setSyncBusy(buttonId, busy) {
  const button = document.getElementById(buttonId);
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? 'Syncing…' : 'Sync now';
}

async function copyText(text, successMessage = 'Copied.') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage, 'success');
    return;
  } catch (_) { /* fall back below */ }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch (_) { copied = false; }
  field.remove();
  showToast(copied ? successMessage : 'Could not copy. Select the address and copy it yourself.', copied ? 'success' : 'error');
}

function copyRedirectUri() {
  copyText(OAUTH_REDIRECT_URI, 'Callback URL copied.');
}

function redirectUriMarkup() {
  return `<span class="copy-field"><code>${escapeHtml(OAUTH_REDIRECT_URI)}</code><button type="button" class="btn btn-secondary btn-sm" onclick="copyRedirectUri()">Copy</button></span>`;
}

function showDeviceGuide(id) {
  switchTab('devices');
  const card = document.getElementById(`device-${id}`);
  if (card) card.scrollIntoView({ block: 'start' });
}

function openDeviceSettings(id, focusInput = true) {
  switchTab('settings');
  const group = document.getElementById(`settings-${id}`);
  if (group) group.scrollIntoView({ block: 'start' });
  const input = focusInput && document.getElementById(`${id}ClientIdInput`);
  if (input) input.focus({ preventScroll: true });
}

// Re-render the views that show device data. The dashboard is skipped while it
// shows the onboarding form, so a background sync never clears what the
// visitor is typing.
function refreshDeviceViews(runsChanged) {
  if (getStorage().plans.length) renderDashboard();
  if (runsChanged) { renderSchedule(); renderHistory(); }
}

// Add a device run to the plan day with the same calendar date, or refresh one
// imported earlier. Runs logged by hand or imported from another device are
// never overwritten, and when a day has several runs from the same device the
// longest one is kept. Returns true when the stored data changed.
function mergeDeviceRun({ data, plan, runLog, idField, id, date, values, effortSource, notes }) {
  const plannedRun = findPlannedRun(plan, date);
  if (!plannedRun) return false;

  let run = runLog[date];
  if (run) {
    if (!run[idField]) return false;
    if (run[idField] !== id && values.distance <= run.distance) return false;
    const unchanged = run[idField] === id &&
      Object.keys(values).every(key => JSON.stringify(run[key]) === JSON.stringify(values[key]));
    if (unchanged) return false;
    Object.assign(run, values, { [idField]: id });
  } else {
    run = {
      id: generateUUID(), planId: plan.id, date, type: plannedRun.type,
      ...values, effort: 0, effortSource: 'none', notes, [idField]: id,
    };
    data.runs.push(run);
    runLog[date] = run;
  }
  if (run.effortSource !== 'manual') {
    const effort = calculateAutoEffort(run, data.runs);
    if (effort) { run.effort = effort; run.effortSource = effortSource; }
  }
  return true;
}

// ============================================================================
// HEART RATE AND EFFORT
// ============================================================================

const DEFAULT_AGE = 30;

function getUserAge() {
  const age = parseInt(storageGet(lsKey('user_age')), 10);
  return age >= 10 && age <= 100 ? age : DEFAULT_AGE;
}

function saveUserAge(value) {
  const age = parseInt(value, 10);
  if (!(age >= 10 && age <= 100)) {
    showToast('Enter an age between 10 and 100.', 'error');
    renderSettings();
    return;
  }
  storageSet(lsKey('user_age'), String(age));
}

function calculateAutoEffort(run, allRuns) {
  const maxHR = 220 - getUserAge();
  const components = [], weights = [];

  // Heart rate zone component (40%): Fitbit Cardio+Peak or Whoop zone 4+5
  if (run.heartRateZones && run.heartRateZones.length > 0) {
    const totalMin = run.heartRateZones.reduce((s, z) => s + (z.minutes || 0), 0);
    if (totalMin > 0) {
      const hardMin = run.heartRateZones
        .filter(z => z.name === 'Cardio' || z.name === 'Peak')
        .reduce((s, z) => s + (z.minutes || 0), 0);
      components.push(Math.max(1, Math.min(10, Math.round(hardMin / totalMin * 9 + 1))));
      weights.push(0.4);
    }
  } else if (run.whoopZones) {
    // Whoop zones: zone_four_milli + zone_five_milli are high-intensity
    const total = Object.values(run.whoopZones).reduce((s, v) => s + (v || 0), 0);
    if (total > 0) {
      const hard = (run.whoopZones.zone_four_milli || 0) + (run.whoopZones.zone_five_milli || 0);
      components.push(Math.max(1, Math.min(10, Math.round(hard / total * 9 + 1))));
      weights.push(0.4);
    }
  }

  // Average HR component (35%)
  if (run.avgHeartRate > 0) {
    const ratio = run.avgHeartRate / maxHR;
    components.push(Math.max(1, Math.min(10, Math.round((ratio - 0.5) / 0.45 * 9 + 1))));
    weights.push(0.35);
  }

  // Pace component (25%)
  if (run.distance > 0 && run.time > 0) {
    const pace = run.time / run.distance;
    const past = allRuns
      .filter(r => r.id !== run.id && r.type === run.type && r.distance > 0 && r.time > 0 && r.date < run.date)
      .slice(-10);
    if (past.length >= 3) {
      const avgPace   = past.reduce((s, r) => s + r.time / r.distance, 0) / past.length;
      const paceRatio = avgPace / pace;
      components.push(Math.max(1, Math.min(10, Math.round((paceRatio - 0.8) / 0.4 * 9 + 1))));
      weights.push(0.25);
    }
  }

  if (components.length === 0) return null;
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  return Math.max(1, Math.min(10, Math.round(
    components.reduce((s, c, i) => s + c * (weights[i] / totalWeight), 0)
  )));
}

// ============================================================================
// FITBIT INTEGRATION
// ============================================================================
//
// OAuth 2.0 with PKCE, so no client secret or server is needed. A Fitbit app of
// type "Personal" can only read the account that registered it, which is why
// each person connects their own app. Google is shutting down the Fitbit Web
// API on October 30, 2026.

const FITBIT_AUTHORIZE_URL   = 'https://www.fitbit.com/oauth2/authorize';
const FITBIT_TOKEN_URL       = 'https://api.fitbit.com/oauth2/token';
const FITBIT_ACTIVITIES_URL  = 'https://api.fitbit.com/1/user/-/activities/list.json';
const FITBIT_RUNNING_TYPE_ID = 90009;  // the "Run" activity type

// Fitbit's "Run" type, plus exercises whose name says they were runs.
function isFitbitRun(activity) {
  const name = activity.activityName || '';
  if (/\b(walk|hike|step)/i.test(name)) return false;
  return activity.activityTypeId === FITBIT_RUNNING_TYPE_ID || /run|jog|treadmill/i.test(name);
}

function getFitbitClientId() {
  return readDeviceSetting('fitbit_client_id');
}

function isFitbitConnected() {
  return !!(session && storageGet(lsKey('fitbit_access_token')));
}

async function connectFitbit() {
  const input = document.getElementById('fitbitClientIdInput');
  if (input) saveDeviceSetting('fitbit_client_id', input.value);
  const clientId = getFitbitClientId();
  if (!clientId) {
    showToast('Enter the Client ID of your Fitbit app first. The setup guide shows where to find it.', 'error', 7000);
    if (input) input.focus();
    return;
  }
  if (!/^[A-Za-z0-9]{4,16}$/.test(clientId)) {
    showToast('That does not look like a Fitbit Client ID. It is a short code of letters and numbers, such as ABC123.', 'error', 7000);
    if (input) input.focus();
    return;
  }
  await startOAuth('fitbit', FITBIT_AUTHORIZE_URL, { client_id: clientId, scope: 'activity heartrate' });
}

async function handleFitbitCallback() {
  const callback = readOAuthCallback('fitbit');
  if (!callback) return null;
  if (callback.error) {
    showToast(callback.error === 'access_denied'
      ? 'Fitbit was not connected because access was not approved.'
      : 'Fitbit could not be connected. Please try again.', 'error', 7000);
    return false;
  }
  try {
    const res = await fetch(FITBIT_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: getFitbitClientId(), grant_type: 'authorization_code',
        redirect_uri: OAUTH_REDIRECT_URI, code: callback.code, code_verifier: callback.verifier,
      }),
    });
    if (!res.ok) {
      showToast('Fitbit did not accept the connection. Check that the Client ID and Callback URL match your Fitbit app.', 'error', 9000);
      return false;
    }
    saveOAuthTokens('fitbit', await res.json(), 28800);
    showToast('Fitbit connected.', 'success');
    return true;
  } catch (_) {
    showToast('Could not reach Fitbit. Check your connection and try again.', 'error', 7000);
    return false;
  }
}

async function getValidFitbitToken() {
  if (hasFreshToken('fitbit')) return storageGet(lsKey('fitbit_access_token'));
  const refreshToken = storageGet(lsKey('fitbit_refresh_token'));
  if (!refreshToken) { disconnectFitbit(); return null; }
  try {
    const res = await fetch(FITBIT_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: getFitbitClientId() }),
    });
    if (res.status === 400 || res.status === 401) { disconnectFitbit(); return null; }
    if (!res.ok) return null;
    const tokens = await res.json();
    saveOAuthTokens('fitbit', tokens, 28800);
    return tokens.access_token;
  } catch (_) { return null; }
}

function disconnectFitbit() {
  clearOAuthTokens('fitbit');
  renderSettings();
  renderDevices();
}

async function syncFitbitRuns({ notify = false } = {}) {
  setSyncBusy('fitbitSyncBtn', true);
  let message = '', type = 'info', synced = 0;
  try {
    const token = await getValidFitbitToken();
    if (!token) {
      message = isFitbitConnected()
        ? 'Could not reach Fitbit. Check your connection and try again.'
        : 'Fitbit access has ended. Connect Fitbit again in Settings.';
      type = 'error';
      notify = notify || !isFitbitConnected();
      return { error: 'not_connected' };
    }
    const data = getStorage();
    const plan = data.plans[0];
    if (!plan) {
      message = 'Create a training plan first. Fitbit runs are matched to the days in your plan.';
      return { synced: 0 };
    }

    // Fitbit pages through results with the pagination.next link. The offset
    // parameter itself only supports 0.
    const activities = [];
    const seen = new Set();
    let pageUrl = FITBIT_ACTIVITIES_URL + '?' + new URLSearchParams({
      afterDate: formatDate(addDays(parseDate(plan.startDate), -1)),
      sort: 'asc', limit: '100', offset: '0',
    });
    for (let page = 0; pageUrl && page < 20; page++) {
      const res = await fetch(pageUrl, { headers: { Authorization: 'Bearer ' + token } });
      if (res.status === 401) {
        disconnectFitbit();
        message = 'Fitbit access has ended. Connect Fitbit again in Settings.';
        type = 'error';
        notify = true;
        return { error: 'unauthorized' };
      }
      if (!res.ok) {
        if (activities.length) break;  // import the pages that did arrive
        message = res.status === 429
          ? 'Fitbit is limiting requests right now. Try again in an hour.'
          : 'Fitbit did not return your activities. Try again later.';
        type = 'error';
        return { error: res.status === 429 ? 'rate_limited' : 'fetch_failed' };
      }
      const body  = await res.json();
      const batch = Array.isArray(body.activities) ? body.activities : [];
      batch.forEach(activity => {
        if (!seen.has(activity.logId)) { seen.add(activity.logId); activities.push(activity); }
      });
      const next = body.pagination && body.pagination.next;
      pageUrl = batch.length === 100 && typeof next === 'string' && next !== pageUrl &&
        next.startsWith(FITBIT_ACTIVITIES_URL) ? next : '';
    }

    const runLog = {};
    data.runs.forEach(r => { if (r.planId === plan.id) runLog[r.date] = r; });

    for (const activity of activities) {
      if (!isFitbitRun(activity)) continue;
      let distance = activity.distance || 0;
      const unit = (activity.distanceUnit || '').toLowerCase();
      if (unit === 'kilometer' || unit === 'km') distance *= 0.621371;
      distance = Math.round(distance * 100) / 100;
      if (distance < 0.1) continue;

      const changed = mergeDeviceRun({
        data, plan, runLog, idField: 'fitbitId', id: activity.logId,
        date: (activity.startTime || '').substring(0, 10),
        values: {
          distance,
          time: Math.round((activity.duration || 0) / 1000),
          avgHeartRate: activity.averageHeartRate || 0,
          heartRateZones: activity.heartRateZones || [],
        },
        effortSource: 'auto', notes: 'Synced from Fitbit',
      });
      if (changed) synced++;
    }

    if (synced > 0) {
      setStorage(data);
      refreshDeviceViews(true);
    }
    storageSet(lsKey('fitbit_last_sync'), new Date().toISOString());
    message = synced
      ? `Synced ${plural(synced, 'run')} from Fitbit.`
      : 'Fitbit is up to date. There are no new runs on your plan days.';
    type = synced ? 'success' : 'info';
    return { synced };
  } catch (_) {
    message = 'Could not reach Fitbit. Check your connection and try again.';
    type = 'error';
    return { error: 'network' };
  } finally {
    setSyncBusy('fitbitSyncBtn', false);
    renderSettings();
    if (message && (notify || synced > 0)) showToast(message, type);
  }
}

// ============================================================================
// WHOOP INTEGRATION (advanced, self-hosted)
// ============================================================================
//
// Whoop issues tokens only when the request includes the app's client secret,
// which can never be shipped in a static site. Users who want Whoop deploy a
// small token proxy (sample code on the Devices tab) that adds the secret, and
// enter its URL in Settings. Everything else talks to Whoop directly.

const WHOOP_AUTHORIZE_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const WHOOP_API_BASE      = 'https://api.prod.whoop.com/developer/v2';
const WHOOP_RUNNING_SPORT_ID = 0;  // "Running" in Whoop's sport list

function getWhoopClientId() {
  return readDeviceSetting('whoop_client_id');
}

function getWhoopProxyUrl() {
  return readDeviceSetting('whoop_proxy_url');
}

function isValidProxyUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch (_) {
    return false;
  }
}

function isWhoopConnected() {
  return !!(session && storageGet(lsKey('whoop_access_token')));
}

async function connectWhoop() {
  const idInput    = document.getElementById('whoopClientIdInput');
  const proxyInput = document.getElementById('whoopProxyInput');
  if (idInput)    saveDeviceSetting('whoop_client_id', idInput.value);
  if (proxyInput) saveDeviceSetting('whoop_proxy_url', proxyInput.value);
  if (!getWhoopClientId()) {
    showToast('Enter the Client ID of your Whoop app first.', 'error');
    if (idInput) idInput.focus();
    return;
  }
  if (!isValidProxyUrl(getWhoopProxyUrl())) {
    showToast('Enter the https address of your Whoop token proxy, for example https://your-proxy.example.com/token.', 'error', 7000);
    if (proxyInput) proxyInput.focus();
    return;
  }
  await startOAuth('whoop', WHOOP_AUTHORIZE_URL, {
    client_id: getWhoopClientId(),
    scope: 'read:recovery read:workout offline',
  });
}

function requestWhoopToken(params) {
  return fetch(getWhoopProxyUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: getWhoopClientId(), ...params }),
  });
}

async function handleWhoopCallback() {
  const callback = readOAuthCallback('whoop');
  if (!callback) return null;
  if (callback.error) {
    showToast(callback.error === 'access_denied'
      ? 'Whoop was not connected because access was not approved.'
      : 'Whoop could not be connected. Please try again.', 'error', 7000);
    return false;
  }
  if (!isValidProxyUrl(getWhoopProxyUrl())) {
    showToast('Whoop needs your token proxy URL. Add it under Settings, Whoop, and connect again.', 'error', 7000);
    return false;
  }
  try {
    const res = await requestWhoopToken({
      grant_type: 'authorization_code', redirect_uri: OAUTH_REDIRECT_URI,
      code: callback.code, code_verifier: callback.verifier,
    });
    if (!res.ok) {
      showToast('Whoop did not accept the connection. Check the Client ID, the Redirect URI and the secrets in your token proxy.', 'error', 9000);
      return false;
    }
    saveOAuthTokens('whoop', await res.json(), 3600);
    showToast('Whoop connected.', 'success');
    return true;
  } catch (_) {
    showToast('Could not reach your Whoop token proxy. Check its URL and that ALLOWED_ORIGIN matches this site.', 'error', 9000);
    return false;
  }
}

async function getValidWhoopToken() {
  if (hasFreshToken('whoop')) return storageGet(lsKey('whoop_access_token'));
  const refreshToken = storageGet(lsKey('whoop_refresh_token'));
  if (!refreshToken || !isValidProxyUrl(getWhoopProxyUrl())) { disconnectWhoop(); return null; }
  try {
    const res = await requestWhoopToken({ grant_type: 'refresh_token', refresh_token: refreshToken, scope: 'offline' });
    if (res.status === 400 || res.status === 401) { disconnectWhoop(); return null; }
    if (!res.ok) return null;
    const tokens = await res.json();
    saveOAuthTokens('whoop', tokens, 3600);
    return tokens.access_token;
  } catch (_) { return null; }
}

function disconnectWhoop() {
  clearOAuthTokens('whoop');
  appData.whoopRecovery = null;
  renderSettings();
  renderDevices();
  refreshDeviceViews(false);
}

async function whoopGet(path, params, token) {
  const url = new URL(WHOOP_API_BASE + path);
  Object.entries(params).forEach(([key, value]) => { if (value) url.searchParams.set(key, value); });
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) {
    const error = new Error(`Whoop request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

// Calendar date of a workout in the time zone where it was recorded.
function whoopWorkoutDate(workout) {
  const start = new Date(workout.start);
  if (isNaN(start)) return null;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(workout.timezone_offset || '');
  if (!match) return formatDate(start);
  const offsetMin = (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
  return new Date(start.getTime() + offsetMin * 60000).toISOString().slice(0, 10);
}

function isWhoopRun(workout) {
  if (workout.sport_name) return /run/i.test(workout.sport_name);
  return workout.sport_id === WHOOP_RUNNING_SPORT_ID;
}

// Latest scored recovery from the last two days, shown on the dashboard.
async function syncWhoopRecovery(token) {
  const end   = new Date();
  const start = new Date(end.getTime() - 48 * 3600 * 1000);
  const json  = await whoopGet('/recovery', { start: start.toISOString(), end: end.toISOString(), limit: '5' }, token);
  const latest = (json.records || []).find(r => r.score_state === 'SCORED' && r.score);
  if (!latest) return;
  appData.whoopRecovery = {
    recoveryScore: Math.round(latest.score.recovery_score || 0),
    hrv: latest.score.hrv_rmssd_milli || 0,
    rhr: Math.round(latest.score.resting_heart_rate || 0),
    fetchedAt: new Date().toISOString(),
  };
}

// Import Whoop running workouts on plan days as logged runs.
async function syncWhoopRuns(token) {
  const data = getStorage();
  const plan = data.plans[0];
  if (!plan) return 0;

  const workouts = [];
  let nextToken = '';
  for (let page = 0; page < 40; page++) {
    const json = await whoopGet('/activity/workout', {
      start: parseDate(plan.startDate).toISOString(), limit: '25', nextToken,
    }, token);
    workouts.push(...(json.records || []));
    nextToken = json.next_token || '';
    if (!nextToken) break;
  }

  const runLog = {};
  data.runs.forEach(r => { if (r.planId === plan.id) runLog[r.date] = r; });

  let synced = 0;
  for (const workout of workouts) {
    if (workout.score_state !== 'SCORED' || !workout.score || !isWhoopRun(workout)) continue;
    const date     = whoopWorkoutDate(workout);
    const score    = workout.score;
    const distance = Math.round((score.distance_meter || 0) / 1609.344 * 100) / 100;
    if (!date || distance < 0.1) continue;

    const changed = mergeDeviceRun({
      data, plan, runLog, idField: 'whoopWorkoutId', id: workout.id, date,
      values: {
        distance,
        time: Math.max(0, Math.round((new Date(workout.end) - new Date(workout.start)) / 1000)) || 0,
        avgHeartRate: score.average_heart_rate || 0,
        whoopZones: score.zone_durations || score.zone_duration || {},
      },
      effortSource: 'whoop', notes: 'Synced from Whoop',
    });
    if (changed) synced++;
  }

  if (synced > 0) setStorage(data);
  return synced;
}

async function syncWhoopData({ notify = false } = {}) {
  setSyncBusy('whoopSyncBtn', true);
  let message = '', type = 'info', synced = 0;
  try {
    const token = await getValidWhoopToken();
    if (!token) {
      message = isWhoopConnected()
        ? 'Could not reach Whoop. Check your connection and try again.'
        : 'Whoop access has ended. Connect Whoop again in Settings.';
      type = 'error';
      notify = notify || !isWhoopConnected();
      return;
    }
    await syncWhoopRecovery(token);
    synced = await syncWhoopRuns(token);
    storageSet(lsKey('whoop_last_sync'), new Date().toISOString());
    message = synced ? `Synced ${plural(synced, 'run')} from Whoop.` : 'Whoop is up to date.';
    type = synced ? 'success' : 'info';
  } catch (error) {
    type = 'error';
    if (error.status === 401) {
      disconnectWhoop();
      message = 'Whoop access has ended. Connect Whoop again in Settings.';
      notify = true;
    } else if (error.status === 429) {
      message = 'Whoop is limiting requests right now. Try again in a few minutes.';
    } else {
      message = 'Could not sync with Whoop right now. Try again later.';
    }
  } finally {
    setSyncBusy('whoopSyncBtn', false);
    renderSettings();
    refreshDeviceViews(synced > 0);
    if (message && (notify || synced > 0)) showToast(message, type);
  }
}

// ============================================================================
// DEVICES (setup guides)
// ============================================================================

const WHOOP_PROXY_SAMPLE = `// Whoop token proxy, written for Cloudflare Workers.
// Secrets:  WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET
// Variable: ALLOWED_ORIGIN, the origin of your RunTrack site,
//           for example https://your-name.github.io
export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    if (request.headers.get('Origin') !== env.ALLOWED_ORIGIN) {
      return new Response('Forbidden', { status: 403 });
    }
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: cors });
    }

    const incoming = new URLSearchParams(await request.text());
    const grant = incoming.get('grant_type');
    if (grant !== 'authorization_code' && grant !== 'refresh_token') {
      return new Response('Unsupported grant type', { status: 400, headers: cors });
    }
    const params = new URLSearchParams();
    for (const key of ['grant_type', 'code', 'code_verifier', 'redirect_uri', 'refresh_token', 'scope']) {
      if (incoming.has(key)) params.set(key, incoming.get(key));
    }
    params.set('client_id', env.WHOOP_CLIENT_ID);
    params.set('client_secret', env.WHOOP_CLIENT_SECRET);

    const res = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  },
};`;

function renderDevices() {
  const container = document.getElementById('devicesContent');
  if (!container) return;

  const iconWatch = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="3"/><path d="M11 8h2M11 12h2M11 16h2"/></svg>`;
  const iconPulse = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>`;
  const origin    = escapeHtml(window.location.origin);

  const devices = [
    {
      id: 'fitbit',
      name: 'Fitbit',
      icon: iconWatch,
      tagline: 'Import runs with distance, time, average heart rate and heart rate zones',
      connected: isFitbitConnected(),
      steps: [
        {
          title: 'Register a Fitbit app',
          body: `Sign in at <a href="https://dev.fitbit.com/apps/new" target="_blank" rel="noopener noreferrer">dev.fitbit.com</a> and choose <em>Register an App</em>. Any name and website will do. Then set:
            <ul>
              <li><strong>OAuth 2.0 Application Type:</strong> Personal</li>
              <li><strong>Callback URL:</strong> exactly ${redirectUriMarkup()}</li>
              <li><strong>Default Access Type:</strong> Read Only</li>
            </ul>
            A Personal app can only read the Fitbit account that registered it, so everyone uses their own app.`,
        },
        {
          title: 'Connect RunTrack',
          body: 'Copy the <strong>OAuth 2.0 Client ID</strong> from your app\'s page, paste it under <strong>Settings, Fitbit</strong> and choose <strong>Connect Fitbit</strong>. Approve access on Fitbit and you come straight back here.',
          action: `<button type="button" class="btn btn-secondary btn-sm" onclick="openDeviceSettings('fitbit')">Open Fitbit settings</button>`,
        },
        {
          title: 'Sync your runs',
          body: 'RunTrack imports Fitbit runs that fall on your plan days and syncs again each time you open the app. You can also choose <strong>Sync now</strong> in Settings.',
        },
      ],
      notes: 'Fitbit uses OAuth 2.0 with PKCE, so no client secret or server is involved. Your Fitbit tokens are stored only in this browser.',
      warning: 'Google is shutting down the Fitbit Web API on October 30, 2026 and no longer accepts new Fitbit developer apps. If you already have one, you can use it until then.',
    },
    {
      id: 'whoop',
      name: 'Whoop',
      badge: 'Advanced, self-hosted',
      icon: iconPulse,
      tagline: 'Recovery, HRV and resting heart rate on your dashboard, plus run import',
      connected: isWhoopConnected(),
      steps: [
        {
          title: 'Create a Whoop developer app',
          body: `Sign in to the <a href="https://developer-dashboard.whoop.com" target="_blank" rel="noopener noreferrer">Whoop Developer Dashboard</a> with your Whoop account and create an app. Then set:
            <ul>
              <li><strong>Redirect URI:</strong> exactly ${redirectUriMarkup()}</li>
              <li><strong>Scopes:</strong> <code>read:recovery</code>, <code>read:workout</code> and <code>offline</code></li>
            </ul>
            Keep the Client ID and Client Secret for the next steps.`,
        },
        {
          title: 'Host a token proxy',
          body: `Whoop only issues tokens when the request includes your client secret, and a secret must never be put in a website. Deploy the small proxy below on a serverless platform you control. Store <code>WHOOP_CLIENT_ID</code> and <code>WHOOP_CLIENT_SECRET</code> as secrets and set <code>ALLOWED_ORIGIN</code> to <code>${origin}</code>.`,
        },
        {
          title: 'Connect RunTrack',
          body: 'Under <strong>Settings, Whoop</strong>, enter your Client ID and the proxy address, for example <code>https://your-proxy.example.com/token</code>, then choose <strong>Connect Whoop</strong>.',
          action: `<button type="button" class="btn btn-secondary btn-sm" onclick="openDeviceSettings('whoop')">Open Whoop settings</button>`,
        },
      ],
      proxyCode: WHOOP_PROXY_SAMPLE,
      notes: 'Your client secret stays in your proxy. RunTrack sends it only the authorization code or refresh token, and the proxy forwards them to Whoop with the secret. Whoop tokens are stored only in this browser.',
    },
  ];

  let html = `<p class="devices-intro">Connecting a device is optional. RunTrack talks to Fitbit and Whoop straight from your browser through a developer app that you register yourself, and keeps the access tokens in this browser only.</p>`;

  for (const device of devices) {
    const badges = [
      device.connected ? '<span class="device-badge-connected">Connected</span>' : '',
      device.badge ? `<span class="badge-muted">${device.badge}</span>` : '',
    ].join('');

    html += `
    <div class="device-card" id="device-${device.id}">
      <div class="device-card-header">
        <span class="device-icon">${device.icon}</span>
        <div class="device-card-info">
          <div class="device-card-name">${device.name} ${badges}</div>
          <div class="device-card-tagline">${device.tagline}</div>
        </div>
        ${device.connected ? `<button class="btn btn-secondary btn-sm" onclick="openDeviceSettings('${device.id}')">Manage</button>` : ''}
      </div>
      <div class="device-card-body">`;

    device.steps.forEach((step, i) => {
      html += `
        <div class="device-step">
          <div class="device-step-num">${i + 1}</div>
          <div>
            <div class="device-step-title">${step.title}</div>
            <div class="device-step-body">${step.body}</div>
            ${step.action ? `<div class="device-step-action">${step.action}</div>` : ''}
          </div>
        </div>`;
    });

    if (device.proxyCode) {
      html += `
        <details class="device-proxy-details">
          <summary>Show the token proxy code</summary>
          <pre class="code-block">${escapeHtml(device.proxyCode)}</pre>
        </details>`;
    }
    if (device.notes)   html += `<div class="device-note">${device.notes}</div>`;
    if (device.warning) html += `<div class="device-note device-note-warning">${device.warning}</div>`;
    html += `</div></div>`;
  }

  html += `<p class="devices-other">Using Garmin, Apple Watch or another device? Log runs by hand with the <strong>Log a run</strong> button. To move your data between browsers, use <strong>Export JSON</strong> and <strong>Import JSON</strong> in Settings.</p>`;

  container.innerHTML = html;
}

// ============================================================================
// AI PLANNER (bring your own Anthropic API key)
// ============================================================================
// Requests go directly from this browser to the Anthropic Messages API. The key
// is kept in localStorage for the current profile only: it is never synced to an
// account, written to the URL, logged, or sent anywhere except api.anthropic.com.

const AI_KEY_PATTERN   = /^sk-ant-\S{4,}$/;
const AI_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{1,100}$/;
const AI_MAX_TOKENS    = 16000;
const AI_TIMEOUT_MS    = 240000;
const AI_UNREADABLE    = 'Claude replied, but not with a plan RunTrack could read. Try again, or rephrase your goal.';

let aiPromptDraft = '';
let pendingAIPlan = null;
let aiBusy        = false;

class AIPlanError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

function getAnthropicKey() {
  return storageGet(lsKey('anthropic_api_key')) || '';
}

function getSavedAIModel() {
  const saved = storageGet(lsKey('ai_model')) || '';
  return AI_MODEL_PATTERN.test(saved) ? saved : '';
}

function getAIModel() {
  return getSavedAIModel() || DEFAULT_AI_MODEL;
}

function saveAnthropicKeyFromInput() {
  const input = document.getElementById('aiKeyInput');
  const errEl = document.getElementById('aiKeyError');
  const key   = (input?.value || '').trim();
  if (errEl) errEl.textContent = '';

  if (!AI_KEY_PATTERN.test(key)) {
    if (errEl) errEl.textContent = 'That does not look like an Anthropic API key. Keys start with "sk-ant-".';
    return;
  }
  if (!storageSet(lsKey('anthropic_api_key'), key)) {
    if (errEl) errEl.textContent = 'Could not save the key because browser storage is unavailable.';
    return;
  }
  input.value = '';
  showToast('API key saved in this browser.', 'success');
  renderAI();
  renderSettings();
}

function forgetAnthropicKey() {
  storageRemove(lsKey('anthropic_api_key'));
  showToast('API key removed from this browser.');
  renderAI();
  renderSettings();
}

function saveAIModel(value) {
  const model = (value || '').trim();
  if (!model) {
    storageRemove(lsKey('ai_model'));
    showToast(`The AI planner will use the default model (${DEFAULT_AI_MODEL}).`);
  } else if (!AI_MODEL_PATTERN.test(model)) {
    showToast('That model ID is not valid. Use letters, numbers, dots and dashes.', 'error');
  } else {
    storageSet(lsKey('ai_model'), model);
    showToast(`The AI planner will use ${model}.`, 'success');
  }
  renderSettings();
  renderAI();
}

function aiPrivacyNote() {
  return `<p class="privacy-note"><strong>Privacy:</strong> your key is stored only in this browser's local storage and is sent only to api.anthropic.com when you generate a plan. It is never saved to a RunTrack account or sent anywhere else. Usage is billed to your Anthropic account.</p>`;
}

function renderAI() {
  const host = document.getElementById('aiContent');
  if (!host) return;

  const hasKey      = !!getAnthropicKey();
  const exampleDate = formatDisplayDate(formatDate(addDays(getToday(), 7 * 16)), { month: 'long', day: 'numeric' });

  const keySection = hasKey ? `
    <div class="settings-section ai-key-status">
      <div class="ai-key-status-text">
        <div class="ai-key-status-title"><span class="device-badge-connected">Key saved</span> Your Anthropic API key is stored in this browser.</div>
        <div class="ai-key-status-sub">Model: <code>${escapeHtml(getAIModel())}</code> (change it in Settings)</div>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="forgetAnthropicKey()">Forget key</button>
    </div>` : `
    <div class="settings-section ai-key-card">
      <div class="settings-section-title">Add your Anthropic API key</div>
      <p class="settings-help">The AI planner runs on your own Anthropic account. Create a key at <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener noreferrer">platform.claude.com</a>, then paste it here.</p>
      <label class="form-label" for="aiKeyInput">API key</label>
      <div class="ai-key-row">
        <input type="password" class="form-input" id="aiKeyInput" placeholder="sk-ant-..." autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true"
          onkeydown="if (event.key === 'Enter') { event.preventDefault(); saveAnthropicKeyFromInput(); }" />
        <button type="button" class="btn btn-primary" onclick="saveAnthropicKeyFromInput()">Save key</button>
      </div>
      <div class="form-error" id="aiKeyError" role="alert"></div>
    </div>`;

  host.innerHTML = `
    <p class="view-intro">Describe your race and schedule, and Claude drafts a week-by-week plan you can review before saving it.</p>
    ${keySection}
    <div class="settings-section">
      <div class="settings-section-title">Describe your goal</div>
      <div class="form-group">
        <label class="form-label" for="aiPrompt">Race, race date, available days and current fitness</label>
        <textarea class="form-input" id="aiPrompt" rows="5" maxlength="4000" oninput="aiPromptDraft = this.value"
          placeholder="e.g. My first half marathon is on ${escapeHtml(exampleDate)}. I can run 3 days a week (Tuesday, Thursday and Saturday) and can currently run about 3 miles comfortably.">${escapeHtml(aiPromptDraft)}</textarea>
      </div>
      <div class="settings-actions">
        <button class="btn btn-primary" id="aiGenerateBtn" onclick="generateAIPlan()" ${hasKey && !aiBusy ? '' : 'disabled'}>${aiBusy ? 'Generating…' : 'Generate plan'}</button>
        ${hasKey ? '' : '<span class="form-hint">Add your API key above to enable this.</span>'}
      </div>
      ${aiPrivacyNote()}
    </div>
    <div id="aiResult" aria-live="polite">${aiBusy ? aiLoadingMarkup() : (pendingAIPlan ? renderAIPlanPreview(pendingAIPlan) : '')}</div>
  `;
}

function aiLoadingMarkup() {
  return `<div class="ai-status"><span class="spinner" aria-hidden="true"></span>Claude is drafting your plan. This usually takes under a minute.</div>`;
}

function showAIMessage(message, offerNewKey = false) {
  const el = document.getElementById('aiResult');
  if (!el) return;
  el.innerHTML = `
    <div class="settings-section ai-error" role="alert">
      <div class="ai-error-title">Could not generate a plan</div>
      <div class="ai-error-body">${escapeHtml(message)}</div>
      ${offerNewKey ? `<div class="settings-actions"><button class="btn btn-secondary btn-sm" onclick="forgetAnthropicKey()">Forget this key and enter a new one</button></div>` : ''}
    </div>`;
}

function buildAISystemPrompt() {
  const today = getToday();
  return `You are an experienced running coach working inside RunTrack, a training plan app. Turn the runner's request into a complete training plan.

Today is ${dayOfWeek(today)}, ${formatDate(today)}. All distances are in miles.

Reply with a single JSON object and nothing else: no markdown, no code fences, no commentary. Use exactly this shape:
{
  "name": "Short plan name",
  "raceType": "5k" | "10k" | "half_marathon" | "marathon" | "custom",
  "startDate": "YYYY-MM-DD",
  "raceDate": "YYYY-MM-DD",
  "notes": "One or two sentences of coaching guidance",
  "weeks": [
    { "week": 1, "runs": [ { "date": "YYYY-MM-DD", "type": "easy" | "long" | "race", "distance": 3, "notes": "Optional short cue" } ] }
  ]
}

Rules:
- Start on or after today unless the runner asks otherwise. Week N covers the 7 days starting at startDate + 7 * (N - 1).
- Only schedule runs on days the runner says they can run, with at most one run per date.
- Use "long" for the weekly long run and "easy" for every other training run.
- Build mileage gradually (about 10 percent per week), add a lighter week every 3 to 4 weeks, and taper for 1 to 3 weeks before race day.
- The final run is type "race" on raceDate with the race distance (5k = 3.1, 10k = 6.2, half_marathon = 13.1, marathon = 26.2).
- Keep the plan between 2 and 30 weeks and keep notes short.
- If the request cannot be turned into a running plan, reply with {"error": "short explanation"} instead.`;
}

async function callAnthropic(apiKey, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  const timeoutError  = () => new AIPlanError('The request timed out. Try again, or ask for a shorter plan.');
  const networkError  = () => new AIPlanError('Could not reach api.anthropic.com. Check your internet connection, and make sure no browser extension or network filter is blocking it.');

  try {
    let res;
    try {
      res = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: getAIModel(),
          max_tokens: AI_MAX_TOKENS,
          system: buildAISystemPrompt(),
          messages: [{ role: 'user', content: prompt }]
        }),
        signal: controller.signal
      });
    } catch (err) {
      throw err?.name === 'AbortError' ? timeoutError() : networkError();
    }

    let body = null;
    try {
      body = await res.json();
    } catch (err) {
      if (err?.name === 'AbortError') throw timeoutError();
    }
    if (!res.ok) throw describeAnthropicError(res.status, body);
    if (!body) throw new AIPlanError(AI_UNREADABLE);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function describeAnthropicError(status, body) {
  const apiMessage = typeof body?.error?.message === 'string' ? body.error.message.slice(0, 300) : '';
  const detail     = apiMessage ? ` Anthropic says: "${apiMessage}"` : '';
  const messages = {
    400: `Anthropic rejected the request (400).${detail}`,
    401: 'Anthropic did not accept this API key (401). Check that you copied the whole key, or create a new one at platform.claude.com.',
    403: `This API key is not allowed to use the Messages API (403).${detail}`,
    404: `The model "${getAIModel()}" was not found (404). Check the model ID in Settings, or clear it to use the default.`,
    413: 'The request was too large (413). Shorten your description and try again.',
    429: `Anthropic is rate limiting this API key (429).${detail} Wait a minute and try again, and check your usage limits in the Anthropic Console.`,
    500: 'Anthropic had an internal error (500). Try again in a moment.',
    529: 'The Anthropic API is temporarily overloaded (529). Try again in a few minutes.'
  };
  return new AIPlanError(messages[status] || `The Anthropic API returned an error (${status}).${detail}`, status);
}

function extractJSONObject(text) {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end   = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (_) { return null; }
}

function parseAIPlanResponse(body) {
  if (body.stop_reason === 'refusal') throw new AIPlanError('Claude declined to create this plan. Try rephrasing your goal.');
  if (body.stop_reason === 'max_tokens') throw new AIPlanError('The plan was too long to finish in one response. Ask for a shorter plan, or try again.');
  const text = (Array.isArray(body.content) ? body.content : [])
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('');
  const parsed = extractJSONObject(text);
  if (!parsed) throw new AIPlanError(AI_UNREADABLE);
  return parsed;
}

// Validate the model's JSON and convert it into RunTrack's plan format.
function normalizeAIPlan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AIPlanError(AI_UNREADABLE);
  if (typeof raw.error === 'string' && raw.error.trim()) {
    throw new AIPlanError(`Claude could not build a plan from that description: ${raw.error.trim().slice(0, 300)}`);
  }

  const byDate = new Map();
  for (const week of Array.isArray(raw.weeks) ? raw.weeks : []) {
    for (const run of Array.isArray(week?.runs) ? week.runs : []) {
      if (!run || !isValidDateString(run.date) || byDate.has(run.date)) continue;
      const distance = Number(run.distance ?? run.plannedDistance);
      if (!Number.isFinite(distance) || distance <= 0 || distance > 50) continue;
      const type    = ['easy', 'long', 'race'].includes(run.type) ? run.type : 'easy';
      const rounded = Math.round(distance * 10) / 10;
      byDate.set(run.date, {
        id: generateUUID(), date: run.date, type,
        plannedDistance: rounded, plannedTime: Math.round(rounded * PACE_SEC_PER_MI[type]),
        actualDistance: null, actualTime: null, effort: null,
        notes: typeof run.notes === 'string' ? run.notes.trim().slice(0, 200) : ''
      });
    }
  }

  const runs = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!runs.length) throw new AIPlanError(AI_UNREADABLE);

  const firstDate = runs[0].date;
  const lastDate  = runs[runs.length - 1].date;
  const startDate = isValidDateString(raw.startDate) && raw.startDate <= firstDate ? raw.startDate : firstDate;
  const lastRace  = [...runs].reverse().find(r => r.type === 'race');
  const raceDate  = lastRace ? lastRace.date
    : (isValidDateString(raw.raceDate) && raw.raceDate >= lastDate ? raw.raceDate : lastDate);

  const totalWeeks = Math.floor(daysBetween(startDate, raceDate) / 7) + 1;
  if (totalWeeks > 52) throw new AIPlanError('Claude returned a plan longer than a year. Try again with a closer race date.');

  const weeks = Array.from({ length: totalWeeks }, (_, i) => ({
    weekNumber: i + 1,
    startDate: formatDate(addDays(parseDate(startDate), i * 7)),
    runs: []
  }));
  for (const run of runs) {
    const index = Math.floor(daysBetween(startDate, run.date) / 7);
    if (index >= 0 && index < weeks.length) weeks[index].runs.push(run);
  }

  const dayCounts = {}, longCounts = {};
  runs.forEach(r => {
    const day = WEEKDAY_KEYS[parseDate(r.date).getDay()];
    dayCounts[day] = (dayCounts[day] || 0) + 1;
    if (r.type === 'long') longCounts[day] = (longCounts[day] || 0) + 1;
  });
  const runDays    = WEEK_ORDER.filter(day => dayCounts[day]);
  const longRunDay = Object.keys(longCounts).sort((a, b) => longCounts[b] - longCounts[a])[0] || runDays[runDays.length - 1];
  const raceType   = RACE_TYPES.includes(raw.raceType) ? raw.raceType : 'custom';

  return {
    id: generateUUID(),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : `${raceTypeLabel(raceType)} plan`,
    raceType, startDate, raceDate, runDays, longRunDay,
    notes: typeof raw.notes === 'string' ? raw.notes.trim().slice(0, 600) : '',
    source: 'ai',
    weeks
  };
}

async function generateAIPlan() {
  if (aiBusy) return;
  const apiKey = getAnthropicKey();
  if (!apiKey) { renderAI(); return; }

  const promptEl = document.getElementById('aiPrompt');
  const prompt   = (promptEl?.value || '').trim();
  aiPromptDraft  = promptEl?.value || '';
  if (!prompt) {
    showAIMessage('Describe your race, race date and the days you can run first.');
    promptEl?.focus();
    return;
  }

  aiBusy = true;
  pendingAIPlan = null;
  renderAI();

  let errorToShow = null;
  try {
    const body = await callAnthropic(apiKey, prompt);
    pendingAIPlan = normalizeAIPlan(parseAIPlanResponse(body));
  } catch (err) {
    errorToShow = err instanceof AIPlanError ? err : new AIPlanError('Something went wrong while generating the plan. Try again.');
  } finally {
    aiBusy = false;
  }

  renderAI();
  if (errorToShow) showAIMessage(errorToShow.message, errorToShow.status === 401);
}

function renderAIPlanPreview(plan) {
  const typeSuffix = { long: ' long', race: ' race', easy: '' };

  const weekRows = plan.weeks.map(week => {
    const miles = week.runs.reduce((sum, r) => sum + r.plannedDistance, 0);
    const runsText = week.runs.length
      ? week.runs.map(r => `${dayOfWeek(parseDate(r.date)).slice(0, 3)} ${r.plannedDistance}${typeSuffix[r.type]}`).join(', ')
      : 'Rest week';
    return `<tr><td>${week.weekNumber}</td><td>${escapeHtml(formatDisplayDate(week.startDate, { month: 'short', day: 'numeric' }))}</td><td>${escapeHtml(runsText)}</td><td>${miles.toFixed(1)}</td></tr>`;
  }).join('');

  return `
    <div class="settings-section ai-preview">
      <div class="ai-preview-label">Plan ready to review</div>
      <div class="ai-preview-name">${escapeHtml(plan.name)}</div>
      <div class="ai-preview-meta">${escapeHtml(raceTypeLabel(plan.raceType))} · ${escapeHtml(formatDisplayDate(plan.startDate))} to ${escapeHtml(formatDisplayDate(plan.raceDate))}</div>
      <div class="stat-strip">${planStatsMarkup(plan.weeks)}</div>
      ${plan.notes ? `<p class="ai-preview-notes">${escapeHtml(plan.notes)}</p>` : ''}
      <details class="ai-preview-weeks">
        <summary>Week-by-week schedule</summary>
        <div class="table-scroll">
          <table class="history-table">
            <thead><tr><th>Week</th><th>Starts</th><th>Runs (miles)</th><th>Total</th></tr></thead>
            <tbody>${weekRows}</tbody>
          </table>
        </div>
      </details>
      <p class="settings-help">Saving makes this your active plan. Your other plans stay available under Plans.</p>
      <div class="settings-actions">
        <button class="btn btn-primary" onclick="saveAIPlan()">Save and make active</button>
        <button class="btn btn-secondary" onclick="discardAIPlan()">Discard</button>
      </div>
    </div>`;
}

function saveAIPlan() {
  if (!pendingAIPlan) return;
  const data = getStorage();
  data.plans.unshift({ ...pendingAIPlan, createdAt: new Date().toISOString(), activatedAt: Date.now() });
  pendingAIPlan = null;
  setStorage(data);
  renderAll();
  updateHeaderInfo();
  switchTab('dashboard');
  showToast('Plan saved and set as your active plan.', 'success');
}

function discardAIPlan() {
  pendingAIPlan = null;
  renderAI();
}

// ============================================================================
// SIDEBAR COLLAPSE (desktop)
// ============================================================================

function toggleSidebarCollapse() {
  const sidebar   = document.getElementById('sidebar');
  const isCollapsed = sidebar.classList.toggle('collapsed');
  document.body.classList.toggle('sidebar-collapsed', isCollapsed);
  localStorage.setItem('runtrack_sidebar_collapsed', isCollapsed ? '1' : '');
  const btn = document.getElementById('sidebarCollapseBtn');
  if (btn) btn.innerHTML = isCollapsed ? '&#8250;' : '&#8249;';
}

function restoreSidebarState() {
  if (localStorage.getItem('runtrack_sidebar_collapsed') === '1') {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.add('collapsed');
    document.body.classList.add('sidebar-collapsed');
    const btn = document.getElementById('sidebarCollapseBtn');
    if (btn) btn.innerHTML = '&#8250;';
  }
}
