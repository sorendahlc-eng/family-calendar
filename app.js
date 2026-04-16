'use strict';

// ── Google Cloud Console setup ────────────────────────────────────────────────
// Add the following to your OAuth 2.0 client's "Authorized JavaScript origins":
//   https://sorendahlc-eng.github.io
//
// Also add this to "Authorized redirect URIs" (required for GIS token flow):
//   https://sorendahlc-eng.github.io
//
// Console: https://console.cloud.google.com/apis/credentials
// ─────────────────────────────────────────────────────────────────────────────

const CLIENT_ID = '620868311036-2beqbbfmh98e5sh1qelnloc7enio1e3q.apps.googleusercontent.com';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/tasks',
].join(' ');

const App = (() => {
  // ── State ─────────────────────────────────────────────────────────────────
  let accessToken = null;
  let tokenExpiry = 0;
  let tokenClient = null;

  let calendars = [];
  let eventsByCalendar = {};   // calendarId → Event[]
  let taskGroups = [];         // [{list, tasks}]

  let focusedMonth = new Date();
  let selectedDay = null;
  let now = new Date();
  let completing = new Set();  // taskIds currently being completed

  let refreshTimer = null;
  let clockTimer = null;

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  // ── Auth ──────────────────────────────────────────────────────────────────
  function initAuth() {
    // Wait for GIS to be ready
    if (typeof google === 'undefined') {
      setTimeout(initAuth, 100);
      return;
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: handleToken,
      error_callback: handleTokenError,
    });
    // Try silent token first
    tokenClient.requestAccessToken({ prompt: 'none' });
  }

  function handleToken(response) {
    if (response.error) {
      handleTokenError(response);
      return;
    }
    accessToken = response.access_token;
    tokenExpiry = Date.now() + (response.expires_in - 60) * 1000;
    $('loading-overlay').classList.add('hidden');
    showDashboard();
    startTimers();
    loadData();
  }

  function handleTokenError(err) {
    // Silent auth failed — show sign-in screen
    $('loading-overlay').classList.add('hidden');
    $('signin-screen').classList.remove('hidden');
    const signinBtn = $('signin-btn');
    signinBtn.disabled = false;
    signinBtn.innerHTML = '<span class="material-icons">login</span> Sign in with Google';
  }

  function ensureToken() {
    // Returns true if we have a valid token, false if we need to re-auth
    if (accessToken && Date.now() < tokenExpiry) return true;
    // Token expired — request a new one (may or may not require interaction)
    accessToken = null;
    tokenClient.requestAccessToken({ prompt: 'none' });
    return false;
  }

  function signIn() {
    const btn = $('signin-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-sm" style="display:inline-block"></span> Signing in…';
    $('signin-error').textContent = '';
    tokenClient.requestAccessToken({ prompt: 'select_account' });
  }

  function signOut() {
    stopTimers();
    if (accessToken) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    calendars = [];
    eventsByCalendar = {};
    taskGroups = [];
    $('dashboard').classList.add('hidden');
    $('signin-screen').classList.remove('hidden');
    $('signin-btn').disabled = false;
    $('signin-btn').innerHTML = '<span class="material-icons">login</span> Sign in with Google';
  }

  // ── API helpers ───────────────────────────────────────────────────────────
  async function apiGet(url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401) {
      // Token revoked — force re-auth
      accessToken = null;
      signOut();
      throw new Error('Unauthorized');
    }
    if (!res.ok) throw new Error(`API ${res.status}: ${url}`);
    return res.json();
  }

  async function apiPost(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
  }

  async function apiPatch(url, body) {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
  }

  // ── Calendar API ──────────────────────────────────────────────────────────
  async function fetchCalendars() {
    const data = await apiGet('https://www.googleapis.com/calendar/v3/users/me/calendarList');
    return data.items || [];
  }

  async function fetchEvents(calendarId, from, to) {
    const params = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
    });
    const data = await apiGet(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`
    );
    return data.items || [];
  }

  // ── Tasks API ─────────────────────────────────────────────────────────────
  async function fetchTaskLists() {
    const data = await apiGet('https://www.googleapis.com/tasks/v1/users/@me/lists');
    return data.items || [];
  }

  async function fetchTasks(taskListId) {
    const params = new URLSearchParams({
      showCompleted: 'false',
      showHidden: 'false',
    });
    const data = await apiGet(
      `https://www.googleapis.com/tasks/v1/lists/${encodeURIComponent(taskListId)}/tasks?${params}`
    );
    return data.items || [];
  }

  async function fetchAllTasks() {
    const lists = await fetchTaskLists();
    const groups = [];
    for (const list of lists) {
      if (!list.id) continue;
      try {
        const tasks = await fetchTasks(list.id);
        groups.push({ list, tasks });
      } catch (_) {
        groups.push({ list, tasks: [] });
      }
    }
    return groups;
  }

  async function completeTask(listId, taskId) {
    await apiPatch(
      `https://www.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
      { status: 'completed' }
    );
  }

  async function createTask(listId, title) {
    await apiPost(
      `https://www.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks`,
      { title }
    );
  }

  // ── Data loading ──────────────────────────────────────────────────────────
  async function loadData() {
    if (!accessToken) return;
    if (!ensureToken()) return; // token expired, waiting for refresh

    setRefreshing(true);
    now = new Date();

    try {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      const to = new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59);

      const [cals, groups] = await Promise.all([
        fetchCalendars(),
        fetchAllTasks(),
      ]);
      calendars = cals;
      taskGroups = groups;

      // Fetch events for all calendars in parallel
      const eventResults = await Promise.allSettled(
        calendars.map(cal => cal.id
          ? fetchEvents(cal.id, from, to).then(evs => ({ id: cal.id, evs }))
          : Promise.resolve({ id: null, evs: [] })
        )
      );
      eventsByCalendar = {};
      for (const r of eventResults) {
        if (r.status === 'fulfilled' && r.value.id) {
          eventsByCalendar[r.value.id] = r.value.evs;
        }
      }

      renderAll();
    } catch (e) {
      console.error('Load failed:', e);
    } finally {
      setRefreshing(false);
    }
  }

  async function loadTasksOnly() {
    if (!accessToken) return;
    try {
      taskGroups = await fetchAllTasks();
      renderTasks();
    } catch (e) {
      console.error('Tasks load failed:', e);
    }
  }

  // ── Timers ────────────────────────────────────────────────────────────────
  function startTimers() {
    refreshTimer = setInterval(() => loadData(), 15 * 60 * 1000);
    clockTimer = setInterval(() => {
      now = new Date();
      renderClock();
    }, 30 * 1000);
  }

  function stopTimers() {
    clearInterval(refreshTimer);
    clearInterval(clockTimer);
    refreshTimer = null;
    clockTimer = null;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  function renderAll() {
    renderClock();
    renderUpcoming();
    renderMonthView();
    renderTasks();
  }

  function renderClock() {
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    $('clock-time').textContent = `${h}:${m}`;
    $('clock-date').textContent = now.toLocaleDateString('en-GB', {
      weekday: 'long', month: 'long', day: 'numeric',
    });
  }

  function calColor(cal) {
    const hex = cal.backgroundColor;
    if (hex && /^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
    return '#448AFF';
  }

  // ── Upcoming events panel ─────────────────────────────────────────────────
  function renderUpcoming() {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      return d;
    });

    const container = $('events-list');
    container.innerHTML = '';

    for (const day of days) {
      const events = getEventsOnDay(day);
      if (!events.length) continue;

      const isToday = sameDay(day, today);
      const isTomorrow = diffDays(day, today) === 1;

      let label;
      if (isToday) label = 'Today';
      else if (isTomorrow) label = 'Tomorrow';
      else label = day.toLocaleDateString('en-GB', { weekday: 'long', month: 'short', day: 'numeric' });

      const group = document.createElement('div');
      group.className = 'day-group';

      const lbl = document.createElement('div');
      lbl.className = 'day-label' + (isToday ? ' today' : '');
      lbl.textContent = label;
      group.appendChild(lbl);

      for (const { cal, event } of events) {
        const tile = document.createElement('div');
        tile.className = 'event-tile';
        tile.innerHTML = `
          <div class="event-bar" style="background:${calColor(cal)}"></div>
          <div class="event-info">
            <div class="event-title">${escHtml(event.summary || '(No title)')}</div>
            <div class="event-time">${timeLabel(event)}</div>
          </div>`;
        group.appendChild(tile);
      }
      container.appendChild(group);
    }
  }

  // ── Month view ────────────────────────────────────────────────────────────
  function renderMonthView() {
    const year = focusedMonth.getFullYear();
    const month = focusedMonth.getMonth();
    const today = new Date();

    $('month-title').textContent = focusedMonth.toLocaleDateString('en-GB', {
      month: 'long', year: 'numeric',
    });

    const firstOfMonth = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    // Flutter uses weekday 1=Mon...7=Sun. JS: 0=Sun...6=Sat
    const startOffset = (firstOfMonth.getDay() + 6) % 7; // 0=Mon
    const totalCells = startOffset + daysInMonth;
    const rowCount = Math.ceil(totalCells / 7);

    const grid = $('month-grid');
    grid.innerHTML = '';

    for (let row = 0; row < rowCount; row++) {
      const rowEl = document.createElement('div');
      rowEl.className = 'month-row';
      for (let col = 0; col < 7; col++) {
        const cellIndex = row * 7 + col;
        const dayNum = cellIndex - startOffset + 1;
        const cell = document.createElement('div');

        if (dayNum < 1 || dayNum > daysInMonth) {
          cell.className = 'day-cell empty';
        } else {
          const day = new Date(year, month, dayNum);
          const isToday = sameDay(day, today);
          const isSel = selectedDay && sameDay(day, selectedDay);
          const isWeekend = day.getDay() === 0 || day.getDay() === 6;
          const eventsOnDay = getEventsOnDay(day);

          let cls = 'day-cell';
          if (isSel) cls += ' selected';
          else if (isToday) cls += ' today';
          else if (isWeekend) cls += ' weekend';
          cell.className = cls;

          const numEl = document.createElement('div');
          numEl.className = 'day-num';
          numEl.textContent = dayNum;
          cell.appendChild(numEl);

          if (eventsOnDay.length) {
            const dots = document.createElement('div');
            dots.className = 'day-dots';
            const shown = eventsOnDay.slice(0, 4);
            for (const { cal } of shown) {
              const dot = document.createElement('div');
              dot.className = 'event-dot';
              dot.style.background = calColor(cal);
              dots.appendChild(dot);
            }
            if (eventsOnDay.length > 4) {
              const ov = document.createElement('span');
              ov.className = 'event-overflow';
              ov.textContent = `+${eventsOnDay.length - 4}`;
              dots.appendChild(ov);
            }
            cell.appendChild(dots);
          }

          const capturedDay = new Date(day);
          cell.addEventListener('click', () => onDayClick(capturedDay));
        }
        rowEl.appendChild(cell);
      }
      grid.appendChild(rowEl);
    }

    renderLegend();
  }

  function renderLegend() {
    const leg = $('calendar-legend');
    leg.innerHTML = '';
    for (const cal of calendars) {
      const item = document.createElement('div');
      item.className = 'legend-item';
      item.innerHTML = `
        <div class="legend-dot" style="background:${calColor(cal)}"></div>
        <span class="legend-label">${escHtml(cal.summary || '')}</span>`;
      leg.appendChild(item);
    }
  }

  // ── Tasks panel ───────────────────────────────────────────────────────────
  function renderTasks() {
    const container = $('tasks-list');
    const hasAny = taskGroups.some(g => g.tasks.length > 0);

    if (!hasAny) {
      container.innerHTML = '<div class="tasks-empty">No tasks</div>';
      return;
    }

    container.innerHTML = '';
    const multiList = taskGroups.length > 1;

    for (const group of taskGroups) {
      if (!group.tasks.length) continue;

      if (multiList) {
        const lbl = document.createElement('div');
        lbl.className = 'task-group-label';
        lbl.textContent = group.list.title || 'Tasks';
        container.appendChild(lbl);
      }

      for (const task of group.tasks) {
        container.appendChild(buildTaskTile(group.list.id, task));
      }
    }
  }

  function buildTaskTile(listId, task) {
    const tile = document.createElement('div');
    tile.className = 'task-tile';
    tile.dataset.taskId = task.id;

    const isCompleting = completing.has(task.id);
    const dueInfo = dueLabel(task.due);

    const checkEl = document.createElement('button');
    checkEl.className = 'task-check';
    checkEl.title = 'Mark complete';
    if (isCompleting) {
      checkEl.innerHTML = '<div class="spinner-sm"></div>';
      checkEl.disabled = true;
    } else {
      checkEl.innerHTML = '<span class="material-icons">radio_button_unchecked</span>';
      checkEl.addEventListener('click', e => {
        e.stopPropagation();
        onCompleteTask(listId, task.id);
      });
    }
    tile.appendChild(checkEl);

    const info = document.createElement('div');
    info.className = 'task-info';

    const titleEl = document.createElement('div');
    titleEl.className = 'task-title' + (isCompleting ? ' completing' : '');
    titleEl.textContent = task.title || '(No title)';
    info.appendChild(titleEl);

    if (task.notes) {
      const notes = document.createElement('div');
      notes.className = 'task-notes';
      notes.textContent = task.notes;
      info.appendChild(notes);
    }

    if (dueInfo) {
      const due = document.createElement('div');
      due.className = 'task-due' + (dueInfo.overdue ? ' overdue' : '');
      due.textContent = dueInfo.label;
      info.appendChild(due);
    }

    tile.appendChild(info);
    return tile;
  }

  async function onCompleteTask(listId, taskId) {
    completing.add(taskId);
    renderTasks();
    try {
      await completeTask(listId, taskId);
      await loadTasksOnly();
    } catch (e) {
      console.error('Complete failed:', e);
      completing.delete(taskId);
      renderTasks();
    } finally {
      completing.delete(taskId);
    }
  }

  // ── Add task modal ────────────────────────────────────────────────────────
  function showAddTask() {
    if (!taskGroups.length) return;

    const select = $('task-list-select');
    select.innerHTML = '';
    for (const g of taskGroups) {
      const opt = document.createElement('option');
      opt.value = g.list.id;
      opt.textContent = g.list.title || 'Tasks';
      select.appendChild(opt);
    }

    // Hide select if only one list
    select.style.display = taskGroups.length > 1 ? 'block' : 'none';

    $('task-title-input').value = '';
    $('task-submit-btn').disabled = false;
    $('task-submit-btn').textContent = 'Add Task';

    const modal = $('task-modal');
    modal.classList.remove('hidden');
    modal.addEventListener('click', taskModalOverlayClick);

    setTimeout(() => $('task-title-input').focus(), 100);
    $('task-title-input').addEventListener('keydown', taskInputKeydown);
  }

  function taskModalOverlayClick(e) {
    if (e.target === $('task-modal')) closeTaskModal();
  }

  function taskInputKeydown(e) {
    if (e.key === 'Enter') submitTask();
    if (e.key === 'Escape') closeTaskModal();
  }

  function closeTaskModal() {
    $('task-modal').classList.add('hidden');
    $('task-modal').removeEventListener('click', taskModalOverlayClick);
    $('task-title-input').removeEventListener('keydown', taskInputKeydown);
  }

  async function submitTask() {
    const title = $('task-title-input').value.trim();
    if (!title) return;
    const listId = $('task-list-select').value || taskGroups[0]?.list.id;
    if (!listId) return;

    const btn = $('task-submit-btn');
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner-sm" style="display:inline-block"></div>';

    try {
      await createTask(listId, title);
      closeTaskModal();
      await loadTasksOnly();
    } catch (e) {
      console.error('Create task failed:', e);
      btn.disabled = false;
      btn.textContent = 'Add Task';
    }
  }

  // ── Day detail modal ──────────────────────────────────────────────────────
  function onDayClick(day) {
    selectedDay = day;
    renderMonthView();

    const events = getEventsOnDay(day);
    $('day-modal-title').textContent = day.toLocaleDateString('en-GB', {
      weekday: 'long', month: 'long', day: 'numeric',
    });

    const evContainer = $('day-modal-events');
    if (!events.length) {
      evContainer.innerHTML = '<div class="modal-no-events">No events</div>';
    } else {
      evContainer.innerHTML = '';
      for (const { cal, event } of events) {
        const item = document.createElement('div');
        item.className = 'modal-event-item';
        item.innerHTML = `
          <div class="modal-event-bar" style="background:${calColor(cal)}"></div>
          <div class="modal-event-info">
            <div class="modal-event-title">${escHtml(event.summary || '(No title)')}</div>
            <div class="modal-event-time">${timeLabel(event)}</div>
          </div>`;
        evContainer.appendChild(item);
      }
    }

    const modal = $('day-modal');
    modal.classList.remove('hidden');
    modal.addEventListener('click', dayModalOverlayClick);
  }

  function dayModalOverlayClick(e) {
    if (e.target === $('day-modal')) closeDayModal();
  }

  function closeDayModal() {
    $('day-modal').classList.add('hidden');
    $('day-modal').removeEventListener('click', dayModalOverlayClick);
    selectedDay = null;
    renderMonthView();
  }

  // ── Month navigation ──────────────────────────────────────────────────────
  function prevMonth() {
    focusedMonth = new Date(focusedMonth.getFullYear(), focusedMonth.getMonth() - 1, 1);
    renderMonthView();
  }

  function nextMonth() {
    focusedMonth = new Date(focusedMonth.getFullYear(), focusedMonth.getMonth() + 1, 1);
    renderMonthView();
  }

  function goToday() {
    focusedMonth = new Date();
    renderMonthView();
  }

  // ── UI helpers ────────────────────────────────────────────────────────────
  function showDashboard() {
    $('signin-screen').classList.add('hidden');
    $('dashboard').classList.remove('hidden');
    renderClock();
    renderUpcoming();
    renderMonthView();
    renderTasks();
  }

  function setRefreshing(on) {
    $('refresh-indicator').classList.toggle('hidden', !on);
  }

  // ── Event helpers ─────────────────────────────────────────────────────────
  function getEventsOnDay(day) {
    const result = [];
    const dayOnly = new Date(day.getFullYear(), day.getMonth(), day.getDate());

    for (const cal of calendars) {
      for (const event of (eventsByCalendar[cal.id] || [])) {
        if (occursOnDay(event, dayOnly)) {
          result.push({ cal, event });
        }
      }
    }

    // Sort: timed events by time, all-day last
    result.sort((a, b) => {
      const ta = timeLabel(a.event);
      const tb = timeLabel(b.event);
      if (ta === 'All day' && tb !== 'All day') return 1;
      if (ta !== 'All day' && tb === 'All day') return -1;
      return ta.localeCompare(tb);
    });

    return result;
  }

  function occursOnDay(event, dayOnly) {
    const start = eventStartDate(event);
    if (!start) return false;
    const end = eventEndDate(event) || start;
    return dayOnly >= start && dayOnly <= end;
  }

  function eventStartDate(event) {
    const s = event.start;
    if (!s) return null;
    if (s.dateTime) {
      const d = new Date(s.dateTime);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }
    if (s.date) {
      const [y, mo, da] = s.date.split('-').map(Number);
      return new Date(y, mo - 1, da);
    }
    return null;
  }

  function eventEndDate(event) {
    const e = event.end;
    if (!e) return eventStartDate(event);
    if (e.dateTime) {
      const d = new Date(e.dateTime);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }
    if (e.date) {
      // All-day end is exclusive — subtract 1 day
      const [y, mo, da] = e.date.split('-').map(Number);
      const d = new Date(y, mo - 1, da);
      d.setDate(d.getDate() - 1);
      return d;
    }
    return eventStartDate(event);
  }

  function timeLabel(event) {
    const s = event.start;
    if (!s) return '';
    if (s.dateTime) {
      const d = new Date(s.dateTime);
      return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    }
    return 'All day';
  }

  function dueLabel(due) {
    if (!due) return null;
    try {
      const dt = new Date(due);
      const today = new Date();
      const dayOnly = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
      const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const diff = Math.round((dayOnly - todayOnly) / 86400000);
      if (diff === 0) return { label: 'Today', overdue: false };
      if (diff === 1) return { label: 'Tomorrow', overdue: false };
      if (diff < 0) return { label: 'Overdue', overdue: true };
      return { label: dt.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }), overdue: false };
    } catch (_) {
      return null;
    }
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
  }

  function diffDays(a, b) {
    const aOnly = new Date(a.getFullYear(), a.getMonth(), a.getDate());
    const bOnly = new Date(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((aOnly - bOnly) / 86400000);
  }

  function escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    // Show loading overlay until GIS responds
    $('signin-screen').classList.add('hidden');
    $('dashboard').classList.add('hidden');
    initAuth();
  }

  // Public API
  return {
    init,
    signIn,
    signOut,
    loadData,
    prevMonth,
    nextMonth,
    goToday,
    showAddTask,
    submitTask,
  };
})();

// Boot when DOM is ready
document.addEventListener('DOMContentLoaded', () => App.init());
