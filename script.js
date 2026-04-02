// ============================================================================
// FIREBASE CONFIGURATION
// ============================================================================
// Replace these placeholder values with your Firebase project config.
// Get them from: Firebase Console → Project Settings → General → Your apps → Config
const FIREBASE_CONFIG = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId:             "YOUR_APP_ID"
};

firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth();
const db   = firebase.firestore();

// Enable offline persistence (keep app working when offline)
db.enablePersistence({ synchronizeTabs: true }).catch(() => {});

let currentUser = null;
let appData = { plans: [], runs: [], whoopRecovery: null };

// ============================================================================
// AUTH
// ============================================================================

function usernameToEmail(username) {
  return `${username.toLowerCase().trim()}@runtrack.local`;
}

async function handleLogin(event) {
  event.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl    = document.getElementById('loginError');
  const btn      = document.getElementById('loginBtn');

  errEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    await auth.signInWithEmailAndPassword(usernameToEmail(username), password);
  } catch (e) {
    errEl.textContent = e.code === 'auth/user-not-found' || e.code === 'auth/wrong-password'
      ? 'Incorrect username or password.'
      : e.message;
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

async function handleRegister(event) {
  event.preventDefault();
  const username = document.getElementById('registerUsername').value.trim();
  const password = document.getElementById('registerPassword').value;
  const confirm  = document.getElementById('registerConfirm').value;
  const errEl    = document.getElementById('registerError');
  const btn      = document.getElementById('registerBtn');

  errEl.textContent = '';
  if (password !== confirm) { errEl.textContent = 'Passwords do not match.'; return; }

  btn.disabled = true;
  btn.textContent = 'Creating account…';

  try {
    const cred = await auth.createUserWithEmailAndPassword(usernameToEmail(username), password);
    await db.collection('users').doc(cred.user.uid).set({
      username,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    errEl.textContent = e.code === 'auth/email-already-in-use'
      ? 'That username is already taken.'
      : e.message;
    btn.disabled = false;
    btn.textContent = 'Create Account';
  }
}

async function logoutUser() {
  clearUserLocalStorage(currentUser?.uid);
  await auth.signOut();
}

function clearUserLocalStorage(uid) {
  if (!uid) return;
  const prefix = `rt_${uid}_`;
  Object.keys(localStorage).filter(k => k.startsWith(prefix))
    .forEach(k => localStorage.removeItem(k));
}

function toggleAuthMode() {
  const loginForm    = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');
  const showingLogin = loginForm.style.display !== 'none';
  loginForm.style.display    = showingLogin ? 'none' : 'block';
  registerForm.style.display = showingLogin ? 'block' : 'none';
}

// Auth state gate — all app boot logic lives here
auth.onAuthStateChanged(async (user) => {
  if (user) {
    currentUser = user;

    // Migrate any pre-auth bare localStorage tokens to namespaced keys
    migrateLegacyLocalStorage();

    // Show app, hide auth overlay
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('appShell').style.display    = 'flex';
    document.getElementById('appShell').style.removeProperty('display');
    // Apply flex properly
    document.body.style.flexDirection = '';

    // Load username for display
    try {
      const profile = await db.collection('users').doc(user.uid).get();
      const username = profile.exists ? profile.data().username : user.email.split('@')[0];
      const headerUser = document.getElementById('headerUsername');
      if (headerUser) headerUser.textContent = username;
      const sidebarUser = document.getElementById('sidebarUser');
      if (sidebarUser) sidebarUser.textContent = username;
    } catch (_) {}

    await initializeData();

    // Handle OAuth callbacks
    const didConnectFitbit = await handleFitbitCallback();
    const didConnectWhoop  = await handleWhoopCallback();

    if (didConnectFitbit || didConnectWhoop) {
      switchTab('settings');
    }

    renderAll();
    updateHeaderInfo();

    if (!didConnectFitbit && isFitbitConnected()) syncFitbitRuns();
    if (!didConnectWhoop  && isWhoopConnected())  syncWhoopRecovery();

    setupNavListeners();

  } else {
    currentUser = null;
    appData = { plans: [], runs: [], whoopRecovery: null };
    document.getElementById('authOverlay').style.display = 'flex';
    document.getElementById('appShell').style.display    = 'none';
  }
});

function migrateLegacyLocalStorage() {
  // Move any old (pre-multi-user) tokens to the namespaced keys
  const toMigrate = [
    'fitbit_access_token', 'fitbit_refresh_token',
    'fitbit_token_expires', 'fitbit_last_sync',
    'runtrack_user_age'
  ];
  toMigrate.forEach(k => {
    const val = localStorage.getItem(k);
    if (val) {
      localStorage.setItem(lsKey(k === 'runtrack_user_age' ? 'user_age' : k), val);
      localStorage.removeItem(k);
    }
  });
}

// ============================================================================
// PER-USER LOCALSTORAGE HELPER
// ============================================================================

function lsKey(key) {
  // currentUser is guaranteed non-null whenever this is called
  return `rt_${currentUser.uid}_${key}`;
}

// ============================================================================
// FIRESTORE DATA LAYER  (replaces Dexie)
// ============================================================================

function getStorage() { return appData; }

function setStorage(data) {
  appData = data;
  persistToDB(data);
}

async function loadFromDB() {
  const uid = currentUser.uid;
  const [plansSnap, runsSnap] = await Promise.all([
    db.collection('users').doc(uid).collection('plans').orderBy('createdAt').get(),
    db.collection('users').doc(uid).collection('runs').get()
  ]);
  appData = {
    plans: plansSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    runs:  runsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    whoopRecovery: appData.whoopRecovery || null
  };
  return appData;
}

async function persistToDB(data) {
  if (!currentUser) return;
  const uid      = currentUser.uid;
  const plansCol = db.collection('users').doc(uid).collection('plans');
  const runsCol  = db.collection('users').doc(uid).collection('runs');

  try {
    // Get existing run IDs so we can delete any that were removed
    const existingRunsSnap = await runsCol.get();
    const existingRunIds   = new Set(existingRunsSnap.docs.map(d => d.id));
    const newRunIds        = new Set(data.runs.map(r => r.id));

    const batch = db.batch();
    data.plans.forEach(p => batch.set(plansCol.doc(p.id), p));
    data.runs.forEach(r  => batch.set(runsCol.doc(r.id),  r));
    existingRunIds.forEach(id => { if (!newRunIds.has(id)) batch.delete(runsCol.doc(id)); });
    await batch.commit();
  } catch (e) {
    // Silently handle — Firestore offline cache still keeps data
  }
}

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

function getEstToday() {
  const now = new Date();
  const est = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return new Date(est.getFullYear(), est.getMonth(), est.getDate());
}

function formatDate(date) { return date.toISOString().split('T')[0]; }

function parseDate(dateStr) {
  const [year, month, day] = dateStr.split('-');
  return new Date(year, parseInt(month) - 1, day);
}

function timeStringToSeconds(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.trim().split(':');
  if (parts.length === 2) return parseInt(parts[0]) * 60 + parseInt(parts[1]);
  if (parts.length === 3) return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
  return 0;
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

// ============================================================================
// PLAN GENERATION
// ============================================================================

function generatePlanWeeks(startDate, raceDate, raceType, runDays, longRunDay) {
  const start = parseDate(startDate);
  const race  = parseDate(raceDate);
  const totalWeeks = Math.max(1, Math.round((race - start) / (7 * 24 * 60 * 60 * 1000)));

  const peakLongRun  = { '5k': 6, '10k': 9, 'half_marathon': 12, 'marathon': 20, 'custom': 10 };
  const raceDistances = { '5k': 3.1, '10k': 6.2, 'half_marathon': 13.1, 'marathon': 26.2, 'custom': 13.1 };
  const dayOffsets    = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

  const peak      = peakLongRun[raceType] || 10;
  const raceDist  = raceDistances[raceType] || 13.1;
  const taperWeeks = Math.min(3, Math.floor(totalWeeks * 0.2));
  const buildWeeks = totalWeeks - taperWeeks;
  const weeks = [];

  for (let w = 0; w < totalWeeks; w++) {
    const weekStart = new Date(start);
    weekStart.setDate(weekStart.getDate() + w * 7);

    const isRecovery = w > 0 && (w + 1) % 4 === 0 && w < buildWeeks;
    const isTaper    = w >= buildWeeks;
    const weekRuns   = [];

    for (const day of runDays) {
      let daysToAdd = dayOffsets[day] - weekStart.getDay();
      if (daysToAdd < 0) daysToAdd += 7;
      const runDate = new Date(weekStart);
      runDate.setDate(runDate.getDate() + daysToAdd);
      const dateStr = formatDate(runDate);

      if (dateStr === raceDate) {
        weekRuns.push({ id: generateUUID(), date: dateStr, type: 'race', plannedDistance: raceDist,
          plannedTime: Math.round(raceDist * 600), actualDistance: null, actualTime: null, effort: null, notes: '' });
        continue;
      }

      const isLongRunDay = day === longRunDay;
      let distance, type, paceSec;

      if (isLongRunDay) {
        type = 'long'; paceSec = 660;
        if (isTaper) {
          const taperProgress = (w - buildWeeks) / Math.max(taperWeeks - 1, 1);
          distance = peak * (1 - 0.4 * taperProgress);
        } else if (isRecovery) {
          distance = peak * 0.6;
        } else {
          const buildProgress = Math.min(w / Math.max(buildWeeks - 1, 1), 1);
          distance = 4 + buildProgress * (peak - 4);
        }
      } else {
        type = 'easy'; paceSec = 600;
        if (isTaper) distance = 3;
        else if (isRecovery) distance = 2;
        else distance = 2 + Math.min(5, Math.floor(w / 3));
      }

      distance = Math.max(1, Math.round(distance * 2) / 2);
      weekRuns.push({ id: generateUUID(), date: dateStr, type, plannedDistance: distance,
        plannedTime: Math.round(distance * paceSec), actualDistance: null, actualTime: null, effort: null, notes: '' });
    }

    weekRuns.sort((a, b) => a.date.localeCompare(b.date));
    weeks.push({ weekNumber: w + 1, startDate: formatDate(weekStart), runs: weekRuns });
  }
  return weeks;
}

function generatePlan(config) {
  return { ...config,
    weeks: generatePlanWeeks(config.startDate, config.raceDate, config.raceType, config.runDays, config.longRunDay),
    createdAt: new Date().toISOString()
  };
}

function createDefaultPlan() {
  const schedule = [
    [1,  '2026-03-30', [['2026-03-30','easy',2],   ['2026-04-01','easy',2],   ['2026-04-04','long',3]]],
    [2,  '2026-04-06', [['2026-04-06','easy',2],   ['2026-04-08','easy',2.5], ['2026-04-11','long',4]]],
    [3,  '2026-04-13', [['2026-04-13','easy',2.5], ['2026-04-15','easy',2.5], ['2026-04-18','long',5]]],
    [4,  '2026-04-20', [['2026-04-20','easy',2.5], ['2026-04-22','easy',3],   ['2026-04-25','long',5]]],
    [5,  '2026-04-27', [['2026-04-27','easy',3],   ['2026-04-29','easy',3],   ['2026-05-02','long',6]]],
    [6,  '2026-05-04', [['2026-05-04','easy',3],   ['2026-05-06','easy',3],   ['2026-05-09','long',7]]],
    [7,  '2026-05-11', [['2026-05-11','easy',3],   ['2026-05-13','easy',3.5], ['2026-05-16','long',7.5]]],
    [8,  '2026-05-18', [['2026-05-18','easy',3],   ['2026-05-20','easy',3.5], ['2026-05-23','long',8]]],
    [9,  '2026-05-25', [['2026-05-25','easy',3.5], ['2026-05-27','easy',3.5], ['2026-05-30','long',9]]],
    [10, '2026-06-01', [['2026-06-01','easy',3.5], ['2026-06-03','easy',4],   ['2026-06-06','long',10]]],
    [11, '2026-06-08', [['2026-06-08','easy',4],   ['2026-06-10','easy',4],   ['2026-06-13','long',11]]],
    [12, '2026-06-15', [['2026-06-15','easy',4],   ['2026-06-17','easy',4],   ['2026-06-20','long',12]]],
    [13, '2026-06-22', [['2026-06-22','easy',4],   ['2026-06-24','easy',4],   ['2026-06-27','long',10]]],
    [14, '2026-06-29', [['2026-06-29','easy',3.5], ['2026-07-01','easy',3.5], ['2026-07-04','long',8]]],
    [15, '2026-07-06', [['2026-07-06','easy',3],   ['2026-07-08','easy',3],   ['2026-07-11','long',6]]],
    [16, '2026-07-13', [['2026-07-13','easy',2],   ['2026-07-15','easy',2],   ['2026-07-19','race',13.1]]],
  ];

  const weeks = schedule.map(([weekNumber, startDate, runs]) => ({
    weekNumber,
    startDate,
    runs: runs.map(([date, type, plannedDistance]) => ({
      id: generateUUID(), date, type, plannedDistance,
      plannedTime: Math.round(plannedDistance * (type === 'long' ? 660 : 600)),
      actualDistance: null, actualTime: null, effort: null, notes: ''
    }))
  }));

  return {
    id: generateUUID(),
    name: 'Half Marathon 2026',
    raceType: 'half_marathon',
    startDate: '2026-03-30',
    raceDate: '2026-07-19',
    runDays: ['monday', 'wednesday', 'saturday'],
    longRunDay: 'saturday',
    createdAt: new Date().toISOString(),
    weeks
  };
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initializeData() {
  await loadFromDB();
  if (!appData.plans || appData.plans.length === 0) {
    appData = { plans: [], runs: [], whoopRecovery: null };
    const plan = createDefaultPlan();
    appData.plans.push(plan);
    appData.runs.push({
      id: generateUUID(), planId: plan.id, date: '2026-03-30',
      type: 'easy', distance: 2, time: 1097, effort: 7, notes: 'First run'
    });
    await persistToDB(appData);
  }
}

// ============================================================================
// PLAN ADJUSTMENTS
// ============================================================================

function getMissedRuns(planId, upToDate) {
  const data = getStorage();
  const plan = data.plans.find(p => p.id === planId);
  if (!plan) return [];
  const upToDateObj = parseDate(upToDate);
  const runLog = {};
  data.runs.forEach(run => { if (run.planId === planId) runLog[run.date] = run; });
  const missedRuns = [];
  for (const week of plan.weeks) {
    for (const run of week.runs) {
      if (parseDate(run.date) <= upToDateObj && !runLog[run.date] && run.type === 'easy')
        missedRuns.push(run);
    }
  }
  return missedRuns;
}

function getAdjustmentCandidates(planId, startDate) {
  const data = getStorage();
  const plan = data.plans.find(p => p.id === planId);
  if (!plan) return [];
  const startDateObj = parseDate(startDate);
  const runLog = {};
  data.runs.forEach(run => { if (run.planId === planId) runLog[run.date] = run; });
  const candidates = [];
  for (const week of plan.weeks) {
    for (const run of week.runs) {
      if (parseDate(run.date) >= startDateObj && !runLog[run.date] && run.type === 'easy')
        candidates.push(run);
    }
  }
  return candidates.slice(0, 3);
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

function renderDashboard() {
  const data = getStorage();
  if (data.plans.length === 0) {
    document.getElementById('dashboardContent').innerHTML = `
      <div class="empty-state">
        <div class="empty-text">No training plans yet</div>
        <button class="btn btn-primary" onclick="showCreatePlanModal()">Create Your First Plan</button>
      </div>`;
    return;
  }

  const activePlan = data.plans[0];
  const today      = getEstToday();
  const raceDate   = parseDate(activePlan.raceDate);
  const daysToRace = Math.ceil((raceDate - today) / (1000 * 60 * 60 * 24));

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
  let nextRun = null;
  if (currentWeek) {
    for (const run of currentWeek.runs) {
      thisWeekPlanned += run.plannedDistance;
      thisWeekTotal++;
      if (runLog[run.date]) {
        thisWeekActual += runLog[run.date].distance;
        thisWeekDone++;
      } else if (!nextRun && parseDate(run.date) >= today) {
        nextRun = run;
      }
    }
  }

  const nextRunLabel = nextRun
    ? `${dayOfWeek(parseDate(nextRun.date))}<br><span style="font-size:13px;color:var(--text2);">${runTypeLabel(nextRun.type)} · ${nextRun.plannedDistance} mi</span>`
    : currentWeek ? `<span style="color:var(--success);">Week complete</span>` : '—';

  const weekLabel = currentWeek
    ? `Week ${currentWeek.weekNumber} &nbsp;·&nbsp; ${currentWeek.startDate}`
    : 'Between weeks';

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
        <h2>${activePlan.name}</h2>
        <div style="font-size:13px;color:var(--text2);margin-top:4px;">${raceTypeLabel(activePlan.raceType)} · Race date: ${activePlan.raceDate}</div>
      </div>
    </div>

    <div class="race-banner">
      <div>
        <div class="race-banner-days">${daysToRace}</div>
        <div class="race-banner-label">days to race</div>
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

function renderProgressChart(data) {
  if (progressChartInstance) { progressChartInstance.destroy(); progressChartInstance = null; }
  const canvas = document.getElementById('progressChart');
  if (!canvas) return;

  const accentColor  = getCSSVar('--accent')  || '#3b82f6';
  const text2Color   = getCSSVar('--text2')   || '#cbd5e1';
  const borderColor  = getCSSVar('--border')  || '#475569';

  progressChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels: data.map(d => `Wk ${d.week}`),
      datasets: [
        { label: 'Planned', data: data.map(d => d.planned), borderColor: text2Color, borderDash: [5, 5],
          pointRadius: 3, fill: false, tension: 0.3, borderWidth: 1.5 },
        { label: 'Actual',  data: data.map(d => d.running), borderColor: accentColor,
          backgroundColor: `${accentColor}22`, pointBackgroundColor: accentColor,
          pointRadius: 5, fill: true, tension: 0.3, borderWidth: 2,
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
  if (!canvas) return;

  const accentColor  = getCSSVar('--accent')  || '#3b82f6';
  const text2Color   = getCSSVar('--text2')   || '#cbd5e1';
  const borderColor  = getCSSVar('--border')  || '#475569';

  weeklyChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: data.map(d => `Wk ${d.week}`),
      datasets: [
        { label: 'Planned', data: data.map(d => d.planned),
          backgroundColor: `${text2Color}33`, borderColor: text2Color, borderWidth: 1 },
        { label: 'Actual',  data: data.map(d => d.actual),
          backgroundColor: `${accentColor}99`, borderColor: accentColor, borderWidth: 1 }
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
    document.getElementById('scheduleContent').innerHTML =
      `<div class="empty-state"><div class="empty-text">No plans yet. <a href="#" onclick="showCreatePlanModal();return false;">Create one →</a></div></div>`;
    return;
  }

  const activePlan = data.plans[0];
  const today      = getEstToday();
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
            <div class="week-meta">${formatDate(weekStart)} – ${formatDate(weekEnd)}</div>
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
            <div class="run-name">${dayOfWeek(runDate)}, ${run.date}</div>
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
        <div class="empty-text">No runs logged yet</div>
        <button class="btn btn-secondary" onclick="showLogUnplannedModal()">Log Your First Run</button>
      </div>`;
    return;
  }

  const sorted = [...data.runs].sort((a, b) => parseDate(b.date) - parseDate(a.date));

  let html = `<div style="overflow-x:auto;"><table class="history-table">
    <thead><tr>
      <th>Date</th><th>Type</th><th>Distance</th><th>Time</th><th>Pace</th><th>Effort</th><th>Notes</th>
    </tr></thead><tbody>`;

  sorted.forEach(run => {
    const source = run.effortSource === 'auto' ? 'Auto-calculated' : run.effortSource === 'whoop' ? 'From Whoop' : 'Manually set';
    html += `
      <tr style="cursor:pointer;" onclick="showLogRunModal('', '${run.date}')">
        <td>${run.date}</td>
        <td><span class="run-type-tag run-type-${run.type}">${runTypeLabel(run.type)}</span></td>
        <td><strong>${run.distance}</strong> mi</td>
        <td>${secondsToTimeString(run.time)}</td>
        <td>${calculatePace(run.distance, run.time) || '—'}${calculatePace(run.distance, run.time) ? '/mi' : ''}</td>
        <td>${run.effort ? `<span class="effort-badge" title="${source}">${run.effort}/10${run.effortSource === 'auto' || run.effortSource === 'whoop' ? ' ◆' : ''}</span>` : '—'}</td>
        <td class="notes-cell">${run.notes || '—'}</td>
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
        <div class="empty-text">No training plans yet</div>
        <button class="btn btn-primary" onclick="showCreatePlanModal()">Create Your First Plan</button>
      </div>`;
    return;
  }

  let html = '';
  data.plans.forEach((plan, idx) => {
    const isActive  = idx === 0;
    const totalRuns = plan.weeks.reduce((s, w) => s + w.runs.length, 0);
    const loggedRuns = data.runs.filter(r => r.planId === plan.id).length;
    const pct = totalRuns > 0 ? Math.round((loggedRuns / totalRuns) * 100) : 0;

    html += `
      <div class="plan-card ${isActive ? 'active' : ''}">
        ${isActive ? '<div class="plan-active-tag">Active</div>' : ''}
        <div class="plan-name">${plan.name}</div>
        <div class="plan-dates">${plan.startDate} → ${plan.raceDate}</div>
        <div class="plan-details">
          <div class="plan-detail-item"><strong>Race:</strong> ${raceTypeLabel(plan.raceType)}</div>
          <div class="plan-detail-item"><strong>Run Days:</strong> ${plan.runDays.map(d => d[0].toUpperCase() + d.slice(1)).join(', ')}</div>
          <div class="plan-detail-item"><strong>Weeks:</strong> ${plan.weeks.length} &nbsp;·&nbsp; <strong>Progress:</strong> ${loggedRuns}/${totalRuns} runs (${pct}%)</div>
        </div>
        <div class="progress-bar" style="margin:12px 0;">
          <div class="progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="plan-actions">
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
  const data         = getStorage();
  const fitConnected = isFitbitConnected();
  const whoopConn    = isWhoopConnected();

  const fitLastSync  = localStorage.getItem(lsKey('fitbit_last_sync'));
  const whoopLastSync = localStorage.getItem(lsKey('whoop_last_sync'));

  const syncText = (ts) => ts
    ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Never';

  const fitbitSection = fitConnected
    ? `<div class="settings-stat">Status: <strong style="color:var(--success)">Connected</strong></div>
       <div class="settings-stat">Last sync: <strong>${syncText(fitLastSync)}</strong></div>
       <div class="settings-actions">
         <button class="btn btn-primary" id="fitbitSyncBtn" onclick="syncFitbitRuns()">Sync Now</button>
         <button class="btn btn-danger" onclick="disconnectFitbit()">Disconnect</button>
       </div>`
    : `<div class="settings-stat" style="color:var(--text2)">Connect your Fitbit to automatically import completed runs.</div>
       <div class="settings-actions">
         <button class="btn btn-primary" onclick="connectFitbit()">Connect Fitbit</button>
       </div>`;

  const whoopSection = whoopConn
    ? `<div class="settings-stat">Status: <strong style="color:var(--success)">Connected</strong></div>
       <div class="settings-stat">Last sync: <strong>${syncText(whoopLastSync)}</strong></div>
       <div class="settings-actions">
         <button class="btn btn-primary" id="whoopSyncBtn" onclick="syncWhoopData()">Sync Now</button>
         <button class="btn btn-danger" onclick="disconnectWhoop()">Disconnect</button>
       </div>`
    : `<div class="settings-stat" style="color:var(--text2)">Connect your Whoop to see recovery score, HRV and RHR on your dashboard, and import runs.</div>
       <div class="settings-actions">
         <button class="btn btn-primary" onclick="connectWhoop()">Connect Whoop</button>
       </div>`;

  document.getElementById('settingsContent').innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Profile</div>
      <div class="settings-stat">
        Age: <input type="number" id="userAgeInput" value="${getUserAge()}" min="10" max="100"
          style="width:60px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg3);color:var(--text);font-size:14px;"
          onchange="saveUserAge(this.value)" />
        <span style="color:var(--text2);font-size:12px;margin-left:8px;">Used for max HR calculation</span>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Fitbit</div>
      ${fitbitSection}
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Whoop</div>
      ${whoopSection}
    </div>
    <div class="settings-section">
      <div class="settings-section-title">App Data</div>
      <div class="settings-stat">Total Plans: <strong>${data.plans.length}</strong></div>
      <div class="settings-stat">Total Runs Logged: <strong>${data.runs.length}</strong></div>
      <div class="settings-actions">
        <button class="btn btn-secondary" onclick="exportData()">Export JSON</button>
        <button class="btn btn-secondary" onclick="showImportModal()">Import JSON</button>
        <button class="btn btn-danger" onclick="clearAllData()">Clear All Data</button>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Appearance</div>
      <div class="settings-stat">Theme: <strong>${getTheme() === 'light' ? 'Light' : 'Dark'}</strong></div>
      <div class="settings-actions">
        <button class="btn btn-secondary" onclick="toggleTheme()">Toggle Theme</button>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Account</div>
      <div class="settings-actions">
        <button class="btn btn-danger" onclick="logoutUser()">Sign Out</button>
      </div>
    </div>
  `;
}

function updateHeaderInfo() {
  const data = getStorage();
  if (data.plans.length === 0) { document.getElementById('headerInfo').innerHTML = ''; return; }
  const activePlan = data.plans[0];
  const daysLeft   = Math.ceil((parseDate(activePlan.raceDate) - getEstToday()) / (1000 * 60 * 60 * 24));
  document.getElementById('headerInfo').innerHTML = `
    <div>
      <div style="font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:0.3px;">${activePlan.name}</div>
      <div style="font-size:14px;font-weight:600;">${daysLeft} days to race</div>
    </div>`;
}

// ============================================================================
// MODAL MANAGEMENT
// ============================================================================

let currentRunId  = null;
let currentPlanId = null;
let importMode    = 'merge';

function openModal(id)  { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

function showLogRunModal(runId, dateStr) {
  const data       = getStorage();
  const activePlan = data.plans[0];
  currentRunId     = runId || null;

  let plannedInfo = '';
  let foundRun    = null;

  if (activePlan) {
    for (const week of activePlan.weeks) {
      const f = week.runs.find(r => r.id === runId || r.date === dateStr);
      if (f) { foundRun = f; break; }
    }
  }

  const existingLog = data.runs.find(r => r.date === (dateStr || (foundRun && foundRun.date)) && r.planId === activePlan?.id);

  document.getElementById('logDate').value     = dateStr || '';
  document.getElementById('logDistance').value = existingLog ? existingLog.distance : (foundRun ? foundRun.plannedDistance : '');
  document.getElementById('logTime').value     = existingLog ? secondsToTimeString(existingLog.time) : '';
  document.getElementById('logNotes').value    = existingLog ? existingLog.notes : '';

  if (foundRun) {
    plannedInfo = `${foundRun.plannedDistance} mi · ${secondsToTimeString(foundRun.plannedTime)}`;
  }
  document.getElementById('logPlanned').textContent = plannedInfo;

  const deleteBtn = document.getElementById('deleteLogBtn');
  if (deleteBtn) deleteBtn.style.display = existingLog ? 'block' : 'none';

  const effortGrid = document.getElementById('effortGrid');
  effortGrid.innerHTML = '';
  for (let i = 1; i <= 10; i++) {
    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = `effort-btn ${existingLog && existingLog.effort === i ? 'active' : ''}`;
    btn.textContent = i;
    btn.onclick = () => {
      document.querySelectorAll('.effort-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };
    effortGrid.appendChild(btn);
  }

  openModal('runLogModal');
}

function showLogUnplannedModal() {
  const data = getStorage();
  if (!data.plans.length) { alert('Create a training plan first.'); return; }

  currentRunId = null;
  document.getElementById('logDate').value     = formatDate(getEstToday());
  document.getElementById('logDistance').value = '';
  document.getElementById('logTime').value     = '';
  document.getElementById('logNotes').value    = '';
  document.getElementById('logPlanned').textContent = '';
  const deleteBtn = document.getElementById('deleteLogBtn');
  if (deleteBtn) deleteBtn.style.display = 'none';

  const effortGrid = document.getElementById('effortGrid');
  effortGrid.innerHTML = '';
  for (let i = 1; i <= 10; i++) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'effort-btn'; btn.textContent = i;
    btn.onclick = () => {
      document.querySelectorAll('.effort-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };
    effortGrid.appendChild(btn);
  }
  openModal('runLogModal');
}

function saveRunLog(event) {
  event.preventDefault();
  const data       = getStorage();
  const activePlan = data.plans[0];
  const dateStr    = document.getElementById('logDate').value;
  const distance   = parseFloat(document.getElementById('logDistance').value);
  const time       = timeStringToSeconds(document.getElementById('logTime').value);
  const notes      = document.getElementById('logNotes').value;
  const effortBtn  = document.querySelector('.effort-btn.active');
  const effort     = effortBtn ? parseInt(effortBtn.textContent) : 0;

  if (!distance || !time) { alert('Please fill in distance and time'); return; }

  let runLog = data.runs.find(r => r.date === dateStr && r.planId === activePlan.id);
  if (!runLog) {
    runLog = { id: generateUUID(), planId: activePlan.id, date: dateStr };
    data.runs.push(runLog);
  }

  let runType = 'easy';
  if (currentRunId) {
    for (const week of activePlan.weeks) {
      const found = week.runs.find(r => r.id === currentRunId);
      if (found) { runType = found.type; break; }
    }
  }

  runLog.type         = runType;
  runLog.distance     = distance;
  runLog.time         = time;
  runLog.effort       = effort;
  runLog.effortSource = effort ? 'manual' : 'none';
  runLog.notes        = notes;

  const missedMileage = getMissedRuns(activePlan.id, dateStr).reduce((s, r) => s + r.plannedDistance, 0);
  if (missedMileage > 0 && distance > 3) {
    const candidates = getAdjustmentCandidates(activePlan.id, dateStr);
    if (candidates.length > 0) {
      showAdjustmentModal(missedMileage, candidates, data);
      setStorage(data);
      closeModal('runLogModal');
      return;
    }
  }

  setStorage(data);
  closeModal('runLogModal');
  renderSchedule();
  renderDashboard();
}

function showAdjustmentModal(missedMileage, candidates, data) {
  document.getElementById('adjustmentMessage').textContent =
    `You've logged a longer run. Redistribute ${missedMileage.toFixed(1)} missed miles across future easy runs?`;
  document.getElementById('adjustmentRuns').innerHTML = candidates.map(r => `
    <div class="adjustment-run">
      <div class="adjustment-run-title">${dayOfWeek(parseDate(r.date))}, ${r.date}</div>
      <div class="adjustment-run-detail">${r.plannedDistance} mi → ${(r.plannedDistance + missedMileage / candidates.length).toFixed(1)} mi</div>
    </div>`).join('');
  window._adjustmentData = { data, candidates, missedMileage };
  openModal('adjustmentModal');
}

function applyAdjustment() {
  const { data, candidates, missedMileage } = window._adjustmentData;
  candidates.forEach(candidate => {
    for (const week of data.plans[0].weeks) {
      const found = week.runs.find(r => r.id === candidate.id);
      if (found) { found.plannedDistance += missedMileage / candidates.length; break; }
    }
  });
  setStorage(data);
  closeModal('adjustmentModal');
  renderSchedule();
  renderDashboard();
}

function deleteCurrentLog() {
  const data       = getStorage();
  const activePlan = data.plans[0];
  const dateStr    = document.getElementById('logDate').value;
  const idx        = data.runs.findIndex(r => r.date === dateStr && r.planId === activePlan.id);
  if (idx !== -1) { data.runs.splice(idx, 1); setStorage(data); }
  closeModal('runLogModal');
  renderSchedule();
  renderDashboard();
}

function showCreatePlanModal() {
  document.getElementById('createPlanTitle').textContent = 'New Plan';
  document.getElementById('planName').value      = '';
  document.getElementById('planRaceType').value  = '';
  document.getElementById('planStartDate').value = '';
  document.getElementById('planRaceDate').value  = '';
  document.getElementById('planLongRunDay').value = '';
  document.getElementById('deletePlanBtn').style.display = 'none';
  currentPlanId = null;

  const pillGroup = document.getElementById('runDaysPills');
  pillGroup.innerHTML = '';
  ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].forEach(day => {
    const pill = document.createElement('div');
    pill.className = 'pill'; pill.textContent = day;
    pill.onclick = () => pill.classList.toggle('active');
    pillGroup.appendChild(pill);
  });
  openModal('createPlanModal');
}

function savePlan(event) {
  event.preventDefault();
  const name       = document.getElementById('planName').value.trim();
  const raceType   = document.getElementById('planRaceType').value;
  const startDate  = document.getElementById('planStartDate').value;
  const raceDate   = document.getElementById('planRaceDate').value;
  const longRunDay = document.getElementById('planLongRunDay').value;
  const runDays    = Array.from(document.querySelectorAll('#runDaysPills .pill.active')).map(p => p.textContent.toLowerCase());

  if (!name || !raceType || !startDate || !raceDate || !longRunDay || runDays.length === 0) {
    alert('Please fill in all fields and select at least one run day'); return;
  }
  if (!runDays.includes(longRunDay)) { alert('Long run day must be one of the selected run days'); return; }

  const data = getStorage();
  if (currentPlanId) {
    const plan = data.plans.find(p => p.id === currentPlanId);
    if (plan) {
      const changed = plan.startDate !== startDate || plan.raceDate !== raceDate ||
        JSON.stringify([...plan.runDays].sort()) !== JSON.stringify([...runDays].sort()) ||
        plan.longRunDay !== longRunDay;
      plan.name = name; plan.raceType = raceType; plan.startDate = startDate;
      plan.raceDate = raceDate; plan.runDays = runDays; plan.longRunDay = longRunDay;
      if (changed) plan.weeks = generatePlanWeeks(startDate, raceDate, raceType, runDays, longRunDay);
    }
  } else {
    const plan = generatePlan({ id: generateUUID(), name, raceType, startDate, raceDate, runDays, longRunDay });
    data.plans.unshift(plan);
  }
  setStorage(data);
  closeModal('createPlanModal');
  renderPlans(); renderSchedule(); renderDashboard();
}

function editPlan(planId) {
  const data = getStorage();
  const plan = data.plans.find(p => p.id === planId);
  if (!plan) return;

  document.getElementById('createPlanTitle').textContent = 'Edit Plan';
  document.getElementById('planName').value       = plan.name;
  document.getElementById('planRaceType').value   = plan.raceType;
  document.getElementById('planStartDate').value  = plan.startDate;
  document.getElementById('planRaceDate').value   = plan.raceDate;
  document.getElementById('planLongRunDay').value = plan.longRunDay;
  currentPlanId = planId;
  document.getElementById('deletePlanBtn').style.display = 'block';

  const pillGroup = document.getElementById('runDaysPills');
  pillGroup.innerHTML = '';
  ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].forEach(day => {
    const pill = document.createElement('div');
    pill.className = `pill ${plan.runDays.includes(day.toLowerCase()) ? 'active' : ''}`;
    pill.textContent = day;
    pill.onclick = () => pill.classList.toggle('active');
    pillGroup.appendChild(pill);
  });
  openModal('createPlanModal');
}

function deletePlan() {
  if (!currentPlanId) return;
  if (!confirm('Delete this plan and all its logged runs?')) return;
  const data = getStorage();
  data.plans = data.plans.filter(p => p.id !== currentPlanId);
  data.runs  = data.runs.filter(r => r.planId !== currentPlanId);
  setStorage(data); currentPlanId = null;
  closeModal('createPlanModal'); renderPlans(); renderSchedule(); renderDashboard();
}

function deletePlanConfirm(planId) {
  if (!confirm('Delete this plan and all its logged runs?')) return;
  const data = getStorage();
  data.plans = data.plans.filter(p => p.id !== planId);
  data.runs  = data.runs.filter(r => r.planId !== planId);
  setStorage(data); renderPlans(); renderSchedule(); renderDashboard();
}

function showImportModal() {
  importMode = 'merge';
  document.getElementById('importFile').value = '';
  openModal('importModal');
}

function setImportMode(element) {
  document.querySelectorAll('#importModal .pill').forEach(p => p.classList.remove('active'));
  element.classList.add('active');
  importMode = element.dataset.mode;
}

function performImport() {
  const file = document.getElementById('importFile').files[0];
  if (!file) { alert('Please select a file'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const imported = JSON.parse(e.target.result);
      if (importMode === 'replace') {
        setStorage(imported);
      } else {
        const existing = getStorage();
        existing.plans.push(...(imported.plans || []));
        existing.runs.push(...(imported.runs || []));
        setStorage(existing);
      }
      closeModal('importModal');
      renderAll(); updateHeaderInfo();
    } catch (err) { alert('Invalid JSON file'); }
  };
  reader.readAsText(file);
}

function exportData() {
  const data = getStorage();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `runtrack-export-${formatDate(new Date())}.json`; a.click();
  URL.revokeObjectURL(url);
}

function exportICS() {
  const data = getStorage();
  if (data.plans.length === 0) return;
  const activePlan = data.plans[0];
  const today      = getEstToday();
  const runLog     = {};
  data.runs.forEach(run => { if (run.planId === activePlan.id) runLog[run.date] = run; });

  let ics = `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//RunTrack//EN\nCALSCALE:GREGORIAN\nMETHOD:PUBLISH\nX-WR-CALNAME:${activePlan.name}\n`;
  for (const week of activePlan.weeks) {
    for (const run of week.runs) {
      if (!runLog[run.date] && parseDate(run.date) >= today) {
        const icalDate = run.date.replace(/-/g, '');
        ics += `BEGIN:VEVENT\nDTSTART:${icalDate}\nSUMMARY:${runTypeLabel(run.type)} - ${run.plannedDistance} mi\nDESCRIPTION:${runTypeLabel(run.type)} - ${run.plannedDistance} miles\nUID:${run.id}@runtrack\nEND:VEVENT\n`;
      }
    }
  }
  ics += 'END:VCALENDAR';
  const blob = new Blob([ics], { type: 'text/calendar' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a'); a.href = url; a.download = `${activePlan.name}-schedule.ics`; a.click();
  URL.revokeObjectURL(url);
}

function clearAllData() {
  if (!confirm('Delete all plans and runs? This cannot be undone.')) return;
  setStorage({ plans: [], runs: [], whoopRecovery: null });
  renderAll(); updateHeaderInfo();
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
  renderDashboard(); renderSchedule(); renderHistory(); renderPlans(); renderSettings();
}

function switchTab(tab) {
  document.querySelectorAll('.nav-item').forEach(i => {
    i.classList.toggle('active', i.dataset.tab === tab);
  });
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const targetView = document.getElementById(tab);
  if (targetView) targetView.classList.add('active');
  if (tab === 'dashboard') renderDashboard();
  else if (tab === 'schedule') renderSchedule();
  else if (tab === 'history') renderHistory();
  else if (tab === 'plans') renderPlans();
  else if (tab === 'settings') renderSettings();
}

function setupNavListeners() {
  document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      switchTab(item.dataset.tab);
      if (window.innerWidth <= 768) {
        const sidebar = document.getElementById('sidebar');
        if (sidebar) sidebar.classList.remove('open');
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setTheme(getTheme());
  updateThemeIcon();
  restoreSidebarState();
  // onAuthStateChanged handles everything else
});

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.classList.toggle('open');
}

// ============================================================================
// FITBIT INTEGRATION
// ============================================================================

const FITBIT_CLIENT_ID   = '23VCWT';
const FITBIT_REDIRECT_URI = (() => { const u = new URL(window.location.href); u.search = ''; u.hash = ''; return u.toString(); })();

function base64URLEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generateCodeVerifier() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return base64URLEncode(buf);
}

async function generateCodeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64URLEncode(digest);
}

async function connectFitbit() {
  const verifier   = await generateCodeVerifier();
  const challenge  = await generateCodeChallenge(verifier);
  const stateBuf   = new Uint8Array(8);
  crypto.getRandomValues(stateBuf);
  const state = 'fitbit_' + base64URLEncode(stateBuf);

  localStorage.setItem(lsKey('fitbit_pkce_verifier'), verifier);
  localStorage.setItem(lsKey('fitbit_oauth_state'),   state);

  const params = new URLSearchParams({
    response_type: 'code', client_id: FITBIT_CLIENT_ID,
    redirect_uri: FITBIT_REDIRECT_URI, scope: 'activity heartrate',
    code_challenge: challenge, code_challenge_method: 'S256', state,
  });
  window.location.href = 'https://www.fitbit.com/oauth2/authorize?' + params;
}

async function handleFitbitCallback() {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get('code');
  const state  = params.get('state');
  if (!code || !state?.startsWith('fitbit_')) return false;

  window.history.replaceState({}, '', window.location.pathname);

  const storedState = localStorage.getItem(lsKey('fitbit_oauth_state'));
  const verifier    = localStorage.getItem(lsKey('fitbit_pkce_verifier'));
  localStorage.removeItem(lsKey('fitbit_oauth_state'));
  localStorage.removeItem(lsKey('fitbit_pkce_verifier'));

  if (state !== storedState || !verifier) return false;

  try {
    const res = await fetch('https://api.fitbit.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: FITBIT_CLIENT_ID, grant_type: 'authorization_code',
        redirect_uri: FITBIT_REDIRECT_URI, code, code_verifier: verifier }),
    });
    if (!res.ok) return false;
    saveFitbitTokens(await res.json());
    return true;
  } catch (e) { return false; }
}

function saveFitbitTokens(tokens) {
  localStorage.setItem(lsKey('fitbit_access_token'),  tokens.access_token);
  if (tokens.refresh_token) localStorage.setItem(lsKey('fitbit_refresh_token'), tokens.refresh_token);
  localStorage.setItem(lsKey('fitbit_token_expires'), Date.now() + (tokens.expires_in || 28800) * 1000);
}

async function getValidFitbitToken() {
  const expires = parseInt(localStorage.getItem(lsKey('fitbit_token_expires')) || '0');
  if (Date.now() < expires - 60000) return localStorage.getItem(lsKey('fitbit_access_token'));

  const refreshToken = localStorage.getItem(lsKey('fitbit_refresh_token'));
  if (!refreshToken) { disconnectFitbit(); return null; }

  try {
    const res = await fetch('https://api.fitbit.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: FITBIT_CLIENT_ID }),
    });
    if (!res.ok) { disconnectFitbit(); return null; }
    const tokens = await res.json();
    saveFitbitTokens(tokens);
    return tokens.access_token;
  } catch (e) { return null; }
}

function isFitbitConnected() {
  return !!(currentUser && localStorage.getItem(lsKey('fitbit_access_token')));
}

function disconnectFitbit() {
  ['fitbit_access_token', 'fitbit_refresh_token', 'fitbit_token_expires', 'fitbit_last_sync']
    .forEach(k => localStorage.removeItem(lsKey(k)));
  renderSettings();
}

function getUserAge() {
  return parseInt(localStorage.getItem(lsKey('user_age')) || '23');
}

function saveUserAge(age) {
  localStorage.setItem(lsKey('user_age'), String(parseInt(age) || 23));
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

async function syncFitbitRuns() {
  const btn   = document.getElementById('fitbitSyncBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }

  const token = await getValidFitbitToken();
  if (!token) { if (btn) { btn.disabled = false; btn.textContent = 'Sync Now'; } return { error: 'not_connected' }; }

  const data = getStorage();
  if (!data.plans.length) return { synced: 0 };
  const plan = data.plans[0];

  const allActivities = [];
  let offset = 0;
  try {
    while (true) {
      const url = new URL('https://api.fitbit.com/1/user/-/activities/list.json');
      url.searchParams.set('afterDate', plan.startDate);
      url.searchParams.set('sort', 'asc');
      url.searchParams.set('limit', '100');
      url.searchParams.set('offset', String(offset));
      const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) break;
      const json  = await res.json();
      const batch = json.activities || [];
      allActivities.push(...batch);
      if (batch.length < 100) break;
      offset += 100;
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Sync Now'; }
    return { error: 'fetch_failed' };
  }

  const RUN_TYPE_IDS  = new Set([90009, 90013, 90015, 90001, 90003, 90024]);
  const runActivities = allActivities.filter(a => {
    const name = (a.activityName || '').toLowerCase();
    if (/\b(walk|hike|step)/i.test(a.activityName)) return false;
    return RUN_TYPE_IDS.has(a.activityTypeId) || /run|jog/i.test(name);
  });

  const runLog = {};
  data.runs.forEach(r => { if (r.planId === plan.id) runLog[r.date] = r; });

  let synced = 0;
  for (const activity of runActivities) {
    const date = activity.startTime.substring(0, 10);
    let distanceMiles = activity.distance || 0;
    const unit = (activity.distanceUnit || '').toLowerCase();
    if (unit === 'kilometer' || unit === 'km') distanceMiles *= 0.621371;
    distanceMiles = Math.round(distanceMiles * 100) / 100;
    if (distanceMiles < 0.1) continue;

    const durationSec   = Math.round((activity.duration || 0) / 1000);
    const avgHeartRate  = activity.averageHeartRate || 0;
    const heartRateZones = activity.heartRateZones || [];

    let plannedRun = null;
    for (const week of plan.weeks) {
      const found = week.runs.find(r => r.date === date);
      if (found) { plannedRun = found; break; }
    }
    if (!plannedRun) continue;

    if (runLog[date]) {
      if (runLog[date].fitbitId && RUN_TYPE_IDS.has(activity.activityTypeId)) {
        runLog[date].distance      = distanceMiles;
        runLog[date].time          = durationSec;
        runLog[date].fitbitId      = activity.logId;
        runLog[date].avgHeartRate  = avgHeartRate;
        runLog[date].heartRateZones = heartRateZones;
        if (runLog[date].effortSource !== 'manual') {
          const autoEffort = calculateAutoEffort(runLog[date], data.runs);
          if (autoEffort) { runLog[date].effort = autoEffort; runLog[date].effortSource = 'auto'; }
        }
        synced++;
      }
      continue;
    }

    const newRun = {
      id: generateUUID(), planId: plan.id, date, type: plannedRun.type,
      distance: distanceMiles, time: durationSec,
      avgHeartRate, heartRateZones,
      effort: 0, effortSource: 'none',
      notes: 'Synced from Fitbit', fitbitId: activity.logId,
    };
    const autoEffort = calculateAutoEffort(newRun, data.runs);
    if (autoEffort) { newRun.effort = autoEffort; newRun.effortSource = 'auto'; }
    data.runs.push(newRun);
    runLog[date] = newRun;
    synced++;
  }

  if (synced > 0) setStorage(data);
  localStorage.setItem(lsKey('fitbit_last_sync'), new Date().toISOString());

  if (btn) { btn.disabled = false; btn.textContent = 'Sync Now'; }
  renderSettings();
  if (synced > 0) { renderDashboard(); renderSchedule(); renderHistory(); }
  return { synced };
}

// ============================================================================
// WHOOP INTEGRATION
// ============================================================================

// ⚠️  Whoop requires a client_secret for token exchange.
//     For a static site, proxy the token call through a serverless function
//     (e.g. Cloudflare Worker) that holds the secret. Set WHOOP_TOKEN_PROXY
//     to your worker URL, e.g. "https://whoop-proxy.yourname.workers.dev/token"
//     Leave blank to attempt direct token exchange (will fail in production).
const WHOOP_CLIENT_ID    = 'YOUR_WHOOP_CLIENT_ID';
const WHOOP_REDIRECT_URI = FITBIT_REDIRECT_URI;
const WHOOP_TOKEN_PROXY  = ''; // set to your proxy URL

// Whoop sport IDs that are running activities
const WHOOP_RUN_SPORT_IDS = new Set([0, 71, 126]);  // Running, Trail Run, Treadmill

async function connectWhoop() {
  const verifier  = await generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const stateBuf  = new Uint8Array(8);
  crypto.getRandomValues(stateBuf);
  const state = 'whoop_' + base64URLEncode(stateBuf);

  localStorage.setItem(lsKey('whoop_pkce_verifier'), verifier);
  localStorage.setItem(lsKey('whoop_oauth_state'),   state);

  const params = new URLSearchParams({
    response_type: 'code', client_id: WHOOP_CLIENT_ID,
    redirect_uri: WHOOP_REDIRECT_URI,
    scope: 'read:recovery read:workout offline',
    code_challenge: challenge, code_challenge_method: 'S256', state,
  });
  window.location.href = 'https://api.prod.whoop.com/oauth/oauth2/auth?' + params;
}

async function handleWhoopCallback() {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get('code');
  const state  = params.get('state');
  if (!code || !state?.startsWith('whoop_')) return false;

  window.history.replaceState({}, '', window.location.pathname);

  const storedState = localStorage.getItem(lsKey('whoop_oauth_state'));
  const verifier    = localStorage.getItem(lsKey('whoop_pkce_verifier'));
  localStorage.removeItem(lsKey('whoop_oauth_state'));
  localStorage.removeItem(lsKey('whoop_pkce_verifier'));

  if (state !== storedState || !verifier) return false;

  const tokenEndpoint = WHOOP_TOKEN_PROXY || 'https://api.prod.whoop.com/oauth/oauth2/token';
  try {
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: WHOOP_CLIENT_ID, grant_type: 'authorization_code',
        redirect_uri: WHOOP_REDIRECT_URI, code, code_verifier: verifier }),
    });
    if (!res.ok) return false;
    saveWhoopTokens(await res.json());
    return true;
  } catch (e) { return false; }
}

function saveWhoopTokens(tokens) {
  localStorage.setItem(lsKey('whoop_access_token'),  tokens.access_token);
  if (tokens.refresh_token) localStorage.setItem(lsKey('whoop_refresh_token'), tokens.refresh_token);
  localStorage.setItem(lsKey('whoop_token_expires'), Date.now() + (tokens.expires_in || 3600) * 1000);
}

async function getValidWhoopToken() {
  const expires = parseInt(localStorage.getItem(lsKey('whoop_token_expires')) || '0');
  if (Date.now() < expires - 60000) return localStorage.getItem(lsKey('whoop_access_token'));

  const refreshToken = localStorage.getItem(lsKey('whoop_refresh_token'));
  if (!refreshToken) { disconnectWhoop(); return null; }

  const tokenEndpoint = WHOOP_TOKEN_PROXY || 'https://api.prod.whoop.com/oauth/oauth2/token';
  try {
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: WHOOP_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    if (!res.ok) { disconnectWhoop(); return null; }
    const tokens = await res.json();
    saveWhoopTokens(tokens);
    return tokens.access_token;
  } catch (e) { return null; }
}

function isWhoopConnected() {
  return !!(currentUser && localStorage.getItem(lsKey('whoop_access_token')));
}

function disconnectWhoop() {
  ['whoop_access_token', 'whoop_refresh_token', 'whoop_token_expires', 'whoop_last_sync']
    .forEach(k => localStorage.removeItem(lsKey(k)));
  appData.whoopRecovery = null;
  renderSettings();
  renderDashboard();
}

// Fetch latest recovery score (last 24h) and update dashboard
async function syncWhoopRecovery() {
  const token = await getValidWhoopToken();
  if (!token) return;

  try {
    const end   = new Date();
    const start = new Date(end - 48 * 3600 * 1000); // look back 48h for latest record
    const url   = new URL('https://api.prod.whoop.com/developer/v1/recovery');
    url.searchParams.set('start', start.toISOString());
    url.searchParams.set('end',   end.toISOString());
    url.searchParams.set('limit', '5');

    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const json    = await res.json();
    const records = (json.records || []).filter(r => r.score_state === 'SCORED');
    if (!records.length) return;

    const latest = records[0].score;
    appData.whoopRecovery = {
      recoveryScore: Math.round(latest.recovery_score || 0),
      hrv:  latest.hrv_rmssd_milli || 0,
      rhr:  Math.round(latest.resting_heart_rate || 0),
      fetchedAt: new Date().toISOString()
    };
    localStorage.setItem(lsKey('whoop_last_sync'), new Date().toISOString());
    renderDashboard();
    renderSettings();
  } catch (e) { /* silent fail */ }
}

// Sync Whoop workouts as run logs (mirrors syncFitbitRuns)
async function syncWhoopRuns() {
  const token = await getValidWhoopToken();
  if (!token) return { error: 'not_connected' };

  const data = getStorage();
  if (!data.plans.length) return { synced: 0 };
  const plan = data.plans[0];

  let allWorkouts = [], nextToken = null;
  try {
    do {
      const url = new URL('https://api.prod.whoop.com/developer/v1/activity/workout');
      url.searchParams.set('start', plan.startDate + 'T00:00:00.000Z');
      url.searchParams.set('limit', '25');
      if (nextToken) url.searchParams.set('nextToken', nextToken);

      const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) break;
      const json = await res.json();
      allWorkouts.push(...(json.records || []));
      nextToken = json.next_token || null;
    } while (nextToken);
  } catch (e) { return { error: 'fetch_failed' }; }

  const runWorkouts = allWorkouts.filter(w => WHOOP_RUN_SPORT_IDS.has(w.sport_id) && w.score_state === 'SCORED');
  const runLog = {};
  data.runs.forEach(r => { if (r.planId === plan.id) runLog[r.date] = r; });

  let synced = 0;
  for (const workout of runWorkouts) {
    const date = workout.start.substring(0, 10);
    const score = workout.score;

    let distanceMiles = (score.distance_meter || 0) / 1609.344;
    distanceMiles = Math.round(distanceMiles * 100) / 100;
    if (distanceMiles < 0.1) continue;

    const durationSec  = Math.round((new Date(workout.end) - new Date(workout.start)) / 1000);
    const avgHeartRate = score.average_heart_rate || 0;
    const whoopZones   = score.zone_duration || {};

    let plannedRun = null;
    for (const week of plan.weeks) {
      const found = week.runs.find(r => r.date === date);
      if (found) { plannedRun = found; break; }
    }
    if (!plannedRun) continue;

    if (runLog[date]) {
      // Only update if this entry was originally synced from Whoop
      if (runLog[date].whoopWorkoutId && !runLog[date].fitbitId) {
        runLog[date].distance     = distanceMiles;
        runLog[date].time         = durationSec;
        runLog[date].avgHeartRate = avgHeartRate;
        runLog[date].whoopZones   = whoopZones;
        if (runLog[date].effortSource !== 'manual') {
          const autoEffort = calculateAutoEffort(runLog[date], data.runs);
          if (autoEffort) { runLog[date].effort = autoEffort; runLog[date].effortSource = 'whoop'; }
        }
        synced++;
      }
      continue;
    }

    const newRun = {
      id: generateUUID(), planId: plan.id, date, type: plannedRun.type,
      distance: distanceMiles, time: durationSec,
      avgHeartRate, whoopZones,
      effort: 0, effortSource: 'none',
      notes: 'Synced from Whoop', whoopWorkoutId: workout.id,
    };
    const autoEffort = calculateAutoEffort(newRun, data.runs);
    if (autoEffort) { newRun.effort = autoEffort; newRun.effortSource = 'whoop'; }
    data.runs.push(newRun);
    runLog[date] = newRun;
    synced++;
  }

  if (synced > 0) setStorage(data);
  return { synced };
}

// Trigger both recovery and run sync
async function syncWhoopData() {
  const btn = document.getElementById('whoopSyncBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }

  await syncWhoopRecovery();
  const { synced } = await syncWhoopRuns();

  localStorage.setItem(lsKey('whoop_last_sync'), new Date().toISOString());
  if (btn) { btn.disabled = false; btn.textContent = 'Sync Now'; }
  renderSettings();
  if (synced > 0) { renderDashboard(); renderSchedule(); renderHistory(); }
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
