// ============================================================================
// DATABASE (IndexedDB via Dexie)
// ============================================================================

const db = new Dexie('RunTrackDB');
db.version(1).stores({
  plans: 'id, raceType, startDate, raceDate, createdAt',
  runs: 'id, planId, date, type'
});
db.version(2).stores({
  plans: 'id, raceType, startDate, raceDate, createdAt',
  runs: 'id, planId, date, type'
}).upgrade(tx => {
  return Promise.all([tx.table('plans').clear(), tx.table('runs').clear()]);
});
db.version(3).stores({
  plans: 'id, raceType, startDate, raceDate, createdAt',
  runs: 'id, planId, date, type'
}).upgrade(tx => {
  // Replace generated plan with exact hard-coded schedule (Sat long runs, corrected distances)
  return Promise.all([tx.table('plans').clear(), tx.table('runs').clear()]);
});

let appData = { plans: [], runs: [] };

async function loadFromDB() {
  try {
    // Migrate from localStorage if needed
    const localRaw = localStorage.getItem('runtrack_v1');
    if (localRaw) {
      const localData = JSON.parse(localRaw);
      const count = await db.plans.count();
      if (count === 0 && localData.plans && localData.plans.length > 0) {
        await db.transaction('rw', db.plans, db.runs, async () => {
          await db.plans.bulkAdd(localData.plans);
          await db.runs.bulkAdd(localData.runs || []);
        });
      }
      localStorage.removeItem('runtrack_v1');
    }
    const plans = await db.plans.orderBy('createdAt').toArray();
    const runs = await db.runs.toArray();
    appData = { plans, runs };
  } catch (e) {
    // Fallback: stay with empty appData
    appData = { plans: [], runs: [] };
  }
  return appData;
}

function getStorage() {
  return appData;
}

function setStorage(data) {
  appData = data;
  persistToDB(data);
}

async function persistToDB(data) {
  try {
    await db.transaction('rw', db.plans, db.runs, async () => {
      await db.plans.clear();
      await db.runs.clear();
      if (data.plans.length > 0) await db.plans.bulkPut(data.plans);
      if (data.runs.length > 0) await db.runs.bulkPut(data.runs);
    });
  } catch (e) {
    try { localStorage.setItem('runtrack_v1', JSON.stringify(data)); } catch (_) {}
  }
}

function getTheme() {
  return localStorage.getItem('runtrack_theme') || 'dark';
}

function setTheme(theme) {
  localStorage.setItem('runtrack_theme', theme);
  if (theme === 'light') {
    document.documentElement.classList.add('light-mode');
  } else {
    document.documentElement.classList.remove('light-mode');
  }
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

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

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
  const race = parseDate(raceDate);
  const totalWeeks = Math.max(1, Math.round((race - start) / (7 * 24 * 60 * 60 * 1000)));

  const peakLongRun = { '5k': 6, '10k': 9, 'half_marathon': 12, 'marathon': 20, 'custom': 10 };
  const raceDistances = { '5k': 3.1, '10k': 6.2, 'half_marathon': 13.1, 'marathon': 26.2, 'custom': 13.1 };
  const dayOffsets = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

  const peak = peakLongRun[raceType] || 10;
  const raceDist = raceDistances[raceType] || 13.1;
  const taperWeeks = Math.min(3, Math.floor(totalWeeks * 0.2));
  const buildWeeks = totalWeeks - taperWeeks;
  const weeks = [];

  for (let w = 0; w < totalWeeks; w++) {
    const weekStart = new Date(start);
    weekStart.setDate(weekStart.getDate() + w * 7);

    const isRecovery = w > 0 && (w + 1) % 4 === 0 && w < buildWeeks;
    const isTaper = w >= buildWeeks;
    const weekRuns = [];

    for (const day of runDays) {
      let daysToAdd = dayOffsets[day] - weekStart.getDay();
      if (daysToAdd < 0) daysToAdd += 7;
      const runDate = new Date(weekStart);
      runDate.setDate(runDate.getDate() + daysToAdd);
      const dateStr = formatDate(runDate);

      if (dateStr === raceDate) {
        weekRuns.push({
          id: generateUUID(), date: dateStr, type: 'race',
          plannedDistance: raceDist,
          plannedTime: Math.round(raceDist * 600),
          actualDistance: null, actualTime: null, effort: null, notes: ''
        });
        continue;
      }

      const isLongRunDay = day === longRunDay;
      let distance, type, paceSec;

      if (isLongRunDay) {
        type = 'long';
        paceSec = 660;
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
        type = 'easy';
        paceSec = 600;
        if (isTaper) distance = 3;
        else if (isRecovery) distance = 2;
        else distance = 2 + Math.min(5, Math.floor(w / 3));
      }

      distance = Math.max(1, Math.round(distance * 2) / 2);

      weekRuns.push({
        id: generateUUID(), date: dateStr, type,
        plannedDistance: distance,
        plannedTime: Math.round(distance * paceSec),
        actualDistance: null, actualTime: null, effort: null, notes: ''
      });
    }

    weekRuns.sort((a, b) => a.date.localeCompare(b.date));
    weeks.push({ weekNumber: w + 1, startDate: formatDate(weekStart), runs: weekRuns });
  }

  return weeks;
}

function generatePlan(config) {
  return {
    ...config,
    weeks: generatePlanWeeks(config.startDate, config.raceDate, config.raceType, config.runDays, config.longRunDay),
    createdAt: new Date().toISOString()
  };
}

function createDefaultPlan() {
  // Exact schedule — long runs on Saturday, Mon/Wed easy runs
  // [weekNum, weekStart, [[date, type, miles], ...]]
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
    [11, '2026-06-08', [['2026-06-08','easy',3.5], ['2026-06-10','easy',4],   ['2026-06-13','long',11]]],
    [12, '2026-06-15', [['2026-06-15','easy',4],   ['2026-06-17','easy',4],   ['2026-06-20','long',12]]],
    [13, '2026-06-22', [['2026-06-22','easy',3],   ['2026-06-24','easy',3],   ['2026-06-27','long',10]]],
    [14, '2026-06-29', [['2026-06-29','easy',3],   ['2026-07-01','easy',3],   ['2026-07-04','long',8]]],
    [15, '2026-07-06', [['2026-07-06','easy',2],   ['2026-07-08','easy',2],   ['2026-07-11','long',5]]],
    [16, '2026-07-13', [['2026-07-13','easy',2],   ['2026-07-19','race',13.1]]],
  ];

  const weeks = schedule.map(([weekNumber, startDate, runs]) => ({
    weekNumber,
    startDate,
    runs: runs.map(([date, type, dist]) => ({
      id: generateUUID(),
      date,
      type,
      plannedDistance: dist,
      plannedTime: Math.round(dist * (type === 'long' ? 660 : 600)),
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
    weeks,
    createdAt: new Date().toISOString()
  };
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initializeData() {
  await loadFromDB();

  if (!appData.plans || appData.plans.length === 0) {
    appData = { plans: [], runs: [] };
    const plan = createDefaultPlan();
    appData.plans.push(plan);
    appData.runs.push({
      id: generateUUID(),
      planId: plan.id,
      date: '2026-03-30',
      type: 'easy',
      distance: 2,
      time: 1097,
      effort: 7,
      notes: 'First run'
    });
    await persistToDB(appData);
  }
}

// ============================================================================
// PLAN ADJUSTMENTS
// ============================================================================

function getMissedRuns(planId, upToDate) {
  const data = getStorage();
  const plan = data.plans.find((p) => p.id === planId);
  if (!plan) return [];
  const upToDateObj = parseDate(upToDate);
  const runLog = {};
  data.runs.forEach((run) => { if (run.planId === planId) runLog[run.date] = run; });
  const missedRuns = [];
  for (const week of plan.weeks) {
    for (const run of week.runs) {
      if (parseDate(run.date) <= upToDateObj && !runLog[run.date] && run.type === 'easy') {
        missedRuns.push(run);
      }
    }
  }
  return missedRuns;
}

function getAdjustmentCandidates(planId, startDate) {
  const data = getStorage();
  const plan = data.plans.find((p) => p.id === planId);
  if (!plan) return [];
  const startDateObj = parseDate(startDate);
  const runLog = {};
  data.runs.forEach((run) => { if (run.planId === planId) runLog[run.date] = run; });
  const candidates = [];
  for (const week of plan.weeks) {
    for (const run of week.runs) {
      if (parseDate(run.date) >= startDateObj && !runLog[run.date] && run.type === 'easy') {
        candidates.push(run);
      }
    }
  }
  return candidates.slice(0, 3);
}

// ============================================================================
// CHART INSTANCES
// ============================================================================

let progressChartInstance = null;
let weeklyChartInstance = null;

// ============================================================================
// RENDERING — DASHBOARD
// ============================================================================

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
  const today = getEstToday();
  const raceDate = parseDate(activePlan.raceDate);
  const daysToRace = Math.ceil((raceDate - today) / (1000 * 60 * 60 * 24));

  const runLog = {};
  data.runs.forEach((run) => { if (run.planId === activePlan.id) runLog[run.date] = run; });

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
        // Count all runs in any week that has started as expected
        totalRuns++;
        if (runDate <= today) totalPlannedMiles += run.plannedDistance;

        if (runLog[run.date]) {
          const logged = runLog[run.date];
          totalActualMiles += logged.distance;
          totalActualTime += logged.time;
          weekActual += logged.distance;
          completedRuns++;
          currentStreak++;
          longestStreak = Math.max(longestStreak, currentStreak);
        } else if (runDate < today) {
          // Strictly past and unlogged = missed, break streak
          currentStreak = 0;
        }
        // Today's or future runs in a started week don't break the streak
      }

      if (run.type === 'long') {
        longRunProgression.push({
          week: week.weekNumber,
          running: runLog[run.date] ? runLog[run.date].distance : null,
          planned: run.plannedDistance
        });
      }
    }

    weeklyMileage.push({
      week: week.weekNumber,
      planned: weekPlanned,
      actual: weekHasStarted ? weekActual : null
    });
  }

  const completionPct = totalRuns > 0 ? Math.round((completedRuns / totalRuns) * 100) : 0;
  const avgPace = (totalActualTime && totalActualMiles) ? calculatePace(totalActualMiles, totalActualTime) : '—';

  // Current week snapshot
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

  document.getElementById('dashboardContent').innerHTML = `
    <div class="view-header" style="margin-bottom:var(--spacing-xl);">
      <div>
        <h2>${activePlan.name}</h2>
        <div style="font-size:13px;color:var(--text2);margin-top:4px;">${raceTypeLabel(activePlan.raceType)} · Race date: ${activePlan.raceDate}</div>
      </div>
    </div>

    <!-- Race countdown banner -->
    <div class="race-banner">
      <div>
        <div class="race-banner-days">${daysToRace}</div>
        <div class="race-banner-label">days to race</div>
      </div>
      <div class="race-banner-divider"></div>
      <div style="flex:1;padding-left:var(--spacing-xl);">
        <div style="font-size:14px;color:var(--text2);margin-bottom:4px;">Overall progress</div>
        <div style="font-size:20px;font-weight:700;">${completedRuns} of ${totalRuns} runs complete</div>
        <div class="progress-bar" style="margin-top:10px;">
          <div class="progress-fill" style="width:${completionPct}%"></div>
        </div>
        <div style="font-size:12px;color:var(--text2);margin-top:6px;">${completionPct}% · ${totalActualMiles.toFixed(1)} mi logged</div>
      </div>
    </div>

    <!-- This Week -->
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

    <!-- Plan Progress -->
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

    <!-- Charts -->
    <div class="card">
      <div class="card-title">Long Run Progression</div>
      <div class="chart-container">
        <canvas id="progressChart"></canvas>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Weekly Mileage</div>
      <div class="chart-container">
        <canvas id="weeklyChart"></canvas>
      </div>
    </div>
  `;

  setTimeout(() => {
    if (document.getElementById('progressChart')) renderProgressChart(longRunProgression);
    if (document.getElementById('weeklyChart')) renderWeeklyMileageChart(weeklyMileage);
  }, 0);
}

function renderProgressChart(data) {
  if (progressChartInstance) { progressChartInstance.destroy(); progressChartInstance = null; }
  const canvas = document.getElementById('progressChart');
  if (!canvas) return;

  const accentColor = getCSSVar('--accent') || '#3b82f6';
  const successColor = getCSSVar('--success') || '#10b981';
  const textColor = getCSSVar('--text') || '#f1f5f9';
  const text2Color = getCSSVar('--text2') || '#cbd5e1';
  const borderColor = getCSSVar('--border') || '#475569';

  progressChartInstance = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: data.map(d => `Wk ${d.week}`),
      datasets: [
        {
          label: 'Planned',
          data: data.map(d => d.planned),
          borderColor: accentColor,
          backgroundColor: accentColor + '22',
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointHoverRadius: 6,
        },
        {
          label: 'Actual',
          data: data.map(d => d.running),
          borderColor: successColor,
          backgroundColor: successColor + '22',
          fill: false,
          tension: 0.4,
          pointRadius: 4,
          pointHoverRadius: 7,
          spanGaps: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: textColor, font: { size: 13 } } },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y != null ? ctx.parsed.y.toFixed(1) + ' mi' : 'not logged'}`,
          },
        },
      },
      scales: {
        y: {
          title: { display: true, text: 'Distance (miles)', color: text2Color },
          ticks: { color: text2Color },
          grid: { color: borderColor + '55' },
          beginAtZero: true,
        },
        x: {
          ticks: { color: text2Color },
          grid: { color: borderColor + '33' },
        },
      },
    },
  });
}

function renderWeeklyMileageChart(data) {
  if (weeklyChartInstance) { weeklyChartInstance.destroy(); weeklyChartInstance = null; }
  const canvas = document.getElementById('weeklyChart');
  if (!canvas) return;

  const accentColor = getCSSVar('--accent') || '#3b82f6';
  const successColor = getCSSVar('--success') || '#10b981';
  const textColor = getCSSVar('--text') || '#f1f5f9';
  const text2Color = getCSSVar('--text2') || '#cbd5e1';
  const borderColor = getCSSVar('--border') || '#475569';

  weeklyChartInstance = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: data.map(d => `Wk ${d.week}`),
      datasets: [
        {
          label: 'Planned',
          data: data.map(d => d.planned),
          backgroundColor: accentColor + '44',
          borderColor: accentColor,
          borderWidth: 1,
          borderRadius: 4,
        },
        {
          label: 'Actual',
          data: data.map(d => d.actual),
          backgroundColor: successColor + '88',
          borderColor: successColor,
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: textColor, font: { size: 13 } } },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y != null ? ctx.parsed.y.toFixed(1) + ' mi' : '—'}`,
          },
        },
      },
      scales: {
        y: {
          title: { display: true, text: 'Miles', color: text2Color },
          ticks: { color: text2Color },
          grid: { color: borderColor + '55' },
          beginAtZero: true,
        },
        x: {
          ticks: { color: text2Color, maxTicksLimit: 16 },
          grid: { display: false },
        },
      },
    },
  });
}

// ============================================================================
// RENDERING — SCHEDULE
// ============================================================================

function renderSchedule() {
  const data = getStorage();
  if (data.plans.length === 0) {
    document.getElementById('scheduleContent').innerHTML = `<div class="empty-state"><div class="empty-text">No plans yet. <a href="#" onclick="showCreatePlanModal();return false;">Create one →</a></div></div>`;
    return;
  }

  const activePlan = data.plans[0];
  const today = getEstToday();
  const runLog = {};
  data.runs.forEach((run) => { if (run.planId === activePlan.id) runLog[run.date] = run; });

  let html = '';

  for (const week of activePlan.weeks) {
    const weekStart = parseDate(week.startDate);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);

    let weekMiles = 0, completedMiles = 0;
    const badges = [];

    for (const run of week.runs) {
      weekMiles += run.plannedDistance;
      if (runLog[run.date]) completedMiles += runLog[run.date].distance;
    }

    const isCurrentWeek = weekStart <= today && today <= weekEnd;
    const allLogged = week.runs.length > 0 && week.runs.every(r => runLog[r.date]);
    const hasLongRun = week.runs.some(r => r.type === 'long');
    const hasRace = week.runs.some(r => r.type === 'race');

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
        <div class="week-content ${isOpen ? '' : 'hidden'}">
    `;

    for (const run of week.runs) {
      const logEntry = runLog[run.date];
      const runDate = parseDate(run.date);
      const isPast = runDate < today;
      const isToday = formatDate(runDate) === formatDate(today);
      const pace = logEntry ? calculatePace(logEntry.distance, logEntry.time) : '';

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
        </div>
      `;
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

  let html = `
    <div style="overflow-x:auto;">
      <table class="history-table">
        <thead>
          <tr>
            <th>Date</th><th>Type</th><th>Distance</th><th>Time</th><th>Pace</th><th>Effort</th><th>Notes</th>
          </tr>
        </thead>
        <tbody>
  `;

  sorted.forEach((run) => {
    html += `
      <tr style="cursor:pointer;" onclick="showLogRunModal('', '${run.date}')">
        <td>${run.date}</td>
        <td><span class="run-type-tag run-type-${run.type}">${runTypeLabel(run.type)}</span></td>
        <td><strong>${run.distance}</strong> mi</td>
        <td>${secondsToTimeString(run.time)}</td>
        <td>${calculatePace(run.distance, run.time) || '—'}${calculatePace(run.distance, run.time) ? '/mi' : ''}</td>
        <td>${run.effort ? `<span class="effort-badge">${run.effort}/10</span>` : '—'}</td>
        <td class="notes-cell">${run.notes || '—'}</td>
      </tr>
    `;
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
    const isActive = idx === 0;
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
      </div>
    `;
  });

  document.getElementById('plansContent').innerHTML = html;
}

// ============================================================================
// RENDERING — SETTINGS
// ============================================================================

function renderSettings() {
  const data = getStorage();

  document.getElementById('settingsContent').innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">App Data</div>
      <div class="settings-stat">Total Plans: <strong>${data.plans.length}</strong></div>
      <div class="settings-stat">Total Runs Logged: <strong>${data.runs.length}</strong></div>
      <div class="settings-stat">Storage: <strong>IndexedDB (offline-first)</strong></div>
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
  `;
}

function updateHeaderInfo() {
  const data = getStorage();
  if (data.plans.length === 0) {
    document.getElementById('headerInfo').innerHTML = '';
    return;
  }
  const activePlan = data.plans[0];
  const daysLeft = Math.ceil((parseDate(activePlan.raceDate) - getEstToday()) / (1000 * 60 * 60 * 24));
  document.getElementById('headerInfo').innerHTML = `
    <div>
      <div style="font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:0.3px;">${activePlan.name}</div>
      <div style="font-size:14px;font-weight:600;">${daysLeft} days to race</div>
    </div>
  `;
}

// ============================================================================
// MODAL MANAGEMENT
// ============================================================================

let currentRunId = null;
let currentPlanId = null;
let importMode = 'merge';

function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

function showLogRunModal(runId, dateStr) {
  const data = getStorage();
  const activePlan = data.plans[0];
  let run = null;

  if (runId) {
    for (const week of activePlan.weeks) {
      const found = week.runs.find((r) => r.id === runId);
      if (found) { run = found; break; }
    }
  }

  const existingLog = data.runs.find(r => r.date === dateStr && r.planId === activePlan.id);

  currentRunId = runId;
  document.getElementById('logDate').value = dateStr;
  document.getElementById('logPlanned').textContent = run ? `${run.plannedDistance} mi planned` : 'Unplanned';
  document.getElementById('logDistance').value = existingLog ? existingLog.distance : '';
  document.getElementById('logTime').value = existingLog ? secondsToTimeString(existingLog.time) : '';
  document.getElementById('logNotes').value = existingLog ? existingLog.notes : '';

  const effortGrid = document.getElementById('effortGrid');
  effortGrid.innerHTML = '';
  for (let i = 1; i <= 10; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `effort-btn ${existingLog && existingLog.effort === i ? 'active' : ''}`;
    btn.textContent = i;
    btn.onclick = () => {
      document.querySelectorAll('.effort-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };
    effortGrid.appendChild(btn);
  }

  document.getElementById('deleteLogBtn').style.display = existingLog ? 'block' : 'none';
  openModal('runLogModal');
}

function showLogUnplannedModal() {
  document.getElementById('logDate').value = formatDate(getEstToday());
  document.getElementById('logPlanned').textContent = 'Unplanned run';
  document.getElementById('logDistance').value = '';
  document.getElementById('logTime').value = '';
  document.getElementById('logNotes').value = '';
  document.getElementById('deleteLogBtn').style.display = 'none';
  currentRunId = null;

  const effortGrid = document.getElementById('effortGrid');
  effortGrid.innerHTML = '';
  for (let i = 1; i <= 10; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'effort-btn';
    btn.textContent = i;
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
  const data = getStorage();
  const activePlan = data.plans[0];
  const dateStr = document.getElementById('logDate').value;
  const distance = parseFloat(document.getElementById('logDistance').value);
  const time = timeStringToSeconds(document.getElementById('logTime').value);
  const notes = document.getElementById('logNotes').value;
  const effortBtn = document.querySelector('.effort-btn.active');
  const effort = effortBtn ? parseInt(effortBtn.textContent) : 0;

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

  runLog.type = runType;
  runLog.distance = distance;
  runLog.time = time;
  runLog.effort = effort;
  runLog.notes = notes;

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
    </div>
  `).join('');
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
  const data = getStorage();
  const activePlan = data.plans[0];
  const dateStr = document.getElementById('logDate').value;
  const idx = data.runs.findIndex(r => r.date === dateStr && r.planId === activePlan.id);
  if (idx !== -1) { data.runs.splice(idx, 1); setStorage(data); }
  closeModal('runLogModal');
  renderSchedule();
  renderDashboard();
}

function showCreatePlanModal() {
  document.getElementById('createPlanTitle').textContent = 'New Plan';
  document.getElementById('planName').value = '';
  document.getElementById('planRaceType').value = '';
  document.getElementById('planStartDate').value = '';
  document.getElementById('planRaceDate').value = '';
  document.getElementById('planLongRunDay').value = '';
  document.getElementById('deletePlanBtn').style.display = 'none';
  currentPlanId = null;

  const pillGroup = document.getElementById('runDaysPills');
  pillGroup.innerHTML = '';
  ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].forEach(day => {
    const pill = document.createElement('div');
    pill.className = 'pill';
    pill.textContent = day;
    pill.onclick = () => pill.classList.toggle('active');
    pillGroup.appendChild(pill);
  });

  openModal('createPlanModal');
}

function savePlan(event) {
  event.preventDefault();

  const name = document.getElementById('planName').value.trim();
  const raceType = document.getElementById('planRaceType').value;
  const startDate = document.getElementById('planStartDate').value;
  const raceDate = document.getElementById('planRaceDate').value;
  const longRunDay = document.getElementById('planLongRunDay').value;
  const runDays = Array.from(document.querySelectorAll('#runDaysPills .pill.active'))
    .map(p => p.textContent.toLowerCase());

  if (!name || !raceType || !startDate || !raceDate || !longRunDay || runDays.length === 0) {
    alert('Please fill in all fields and select at least one run day');
    return;
  }
  if (!runDays.includes(longRunDay)) {
    alert('Long run day must be one of the selected run days');
    return;
  }

  const data = getStorage();

  if (currentPlanId) {
    const plan = data.plans.find(p => p.id === currentPlanId);
    if (plan) {
      const changed = plan.startDate !== startDate || plan.raceDate !== raceDate ||
        JSON.stringify([...plan.runDays].sort()) !== JSON.stringify([...runDays].sort()) ||
        plan.longRunDay !== longRunDay;
      plan.name = name;
      plan.raceType = raceType;
      plan.startDate = startDate;
      plan.raceDate = raceDate;
      plan.runDays = runDays;
      plan.longRunDay = longRunDay;
      if (changed) plan.weeks = generatePlanWeeks(startDate, raceDate, raceType, runDays, longRunDay);
    }
  } else {
    const plan = generatePlan({ id: generateUUID(), name, raceType, startDate, raceDate, runDays, longRunDay });
    data.plans.unshift(plan);
  }

  setStorage(data);
  closeModal('createPlanModal');
  renderPlans();
  renderSchedule();
  renderDashboard();
}

function editPlan(planId) {
  const data = getStorage();
  const plan = data.plans.find(p => p.id === planId);
  if (!plan) return;

  document.getElementById('createPlanTitle').textContent = 'Edit Plan';
  document.getElementById('planName').value = plan.name;
  document.getElementById('planRaceType').value = plan.raceType;
  document.getElementById('planStartDate').value = plan.startDate;
  document.getElementById('planRaceDate').value = plan.raceDate;
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
  data.runs = data.runs.filter(r => r.planId !== currentPlanId);
  setStorage(data);
  currentPlanId = null;
  closeModal('createPlanModal');
  renderPlans();
  renderSchedule();
  renderDashboard();
}

function deletePlanConfirm(planId) {
  if (!confirm('Delete this plan and all its logged runs?')) return;
  const data = getStorage();
  data.plans = data.plans.filter(p => p.id !== planId);
  data.runs = data.runs.filter(r => r.planId !== planId);
  setStorage(data);
  renderPlans();
  renderSchedule();
  renderDashboard();
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
      renderDashboard();
      renderSchedule();
      renderHistory();
      renderPlans();
      updateHeaderInfo();
    } catch (err) {
      alert('Invalid JSON file');
    }
  };
  reader.readAsText(file);
}

function exportData() {
  const data = getStorage();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `runtrack-export-${formatDate(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportICS() {
  const data = getStorage();
  if (data.plans.length === 0) return;
  const activePlan = data.plans[0];
  const today = getEstToday();
  const runLog = {};
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
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${activePlan.name}-schedule.ics`;
  a.click();
  URL.revokeObjectURL(url);
}

function clearAllData() {
  if (!confirm('Delete all plans and runs? This cannot be undone.')) return;
  setStorage({ plans: [], runs: [] });
  renderDashboard();
  renderSchedule();
  renderHistory();
  renderPlans();
  renderSettings();
  updateHeaderInfo();
}

function toggleWeek(element) {
  element.nextElementSibling.classList.toggle('hidden');
}

// ============================================================================
// THEME
// ============================================================================

function toggleTheme() {
  const newTheme = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(newTheme);
  updateThemeIcon();
  renderSettings();
  // Re-render charts with new theme colors
  const data = getStorage();
  if (data.plans.length > 0 && document.getElementById('progressChart')) {
    renderDashboard();
  }
}

function updateThemeIcon() {
  const btn = document.querySelector('.theme-toggle');
  if (btn) btn.textContent = getTheme() === 'light' ? 'Dark Mode' : 'Light Mode';
}

// ============================================================================
// NAVIGATION
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  setTheme(getTheme());
  updateThemeIcon();
  restoreSidebarState();

  await initializeData();

  renderDashboard();
  renderSchedule();
  renderHistory();
  renderPlans();
  renderSettings();
  updateHeaderInfo();

  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = item.dataset.tab;

      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      const targetView = document.getElementById(tab);
      if (targetView) targetView.classList.add('active');

      if (tab === 'dashboard') renderDashboard();
      else if (tab === 'schedule') renderSchedule();
      else if (tab === 'history') renderHistory();
      else if (tab === 'plans') renderPlans();
      else if (tab === 'settings') renderSettings();

      if (window.innerWidth <= 768) {
        document.getElementById('sidebar').classList.remove('open');
      }
    });
  });
});

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

function toggleSidebarCollapse() {
  const sidebar = document.getElementById('sidebar');
  const isCollapsed = sidebar.classList.toggle('collapsed');
  document.body.classList.toggle('sidebar-collapsed', isCollapsed);
  localStorage.setItem('runtrack_sidebar_collapsed', isCollapsed ? '1' : '');
  const btn = document.getElementById('sidebarCollapseBtn');
  if (btn) btn.innerHTML = isCollapsed ? '&#8250;' : '&#8249;';
}

function restoreSidebarState() {
  if (localStorage.getItem('runtrack_sidebar_collapsed') === '1') {
    document.getElementById('sidebar').classList.add('collapsed');
    document.body.classList.add('sidebar-collapsed');
    const btn = document.getElementById('sidebarCollapseBtn');
    if (btn) btn.innerHTML = '&#8250;';
  }
}
