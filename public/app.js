const DEFAULT_DISTRICT_URL = "ks-wic-psv.edupoint.com";

const state = {
  token: localStorage.getItem("bettervue_token") || "",
  districtUrl: localStorage.getItem("bettervue_district") || DEFAULT_DISTRICT_URL,
  student: null,
  dashboard: null,
  view: "dashboard",
  loading: false,
  error: "",
  expandedCourses: new Set(),
  reportPeriod: null,
  attendanceMonth: null,
  selectedAttendanceDate: null,
  districtLookup: {
    loading: false,
    valid: null,
    name: "",
    address: "",
  },
};

let districtLookupTimer = null;
let districtLookupRequest = 0;
let lastDistrictLookupUrl = "";

const app = document.getElementById("app");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function gradeClass(score) {
  const letter = String(score || "").trim().charAt(0).toUpperCase();
  if (["A"].includes(letter)) return "excellent";
  if (["B"].includes(letter)) return "good";
  if (["C", "D"].includes(letter)) return "warning";
  if (["F"].includes(letter)) return "poor";
  return "";
}

function courseColor(title = "") {
  const colors = [
    ["#2563eb", "#0ea5e9"],
    ["#7c3aed", "#a855f7"],
    ["#0f766e", "#14b8a6"],
    ["#b45309", "#f59e0b"],
    ["#be123c", "#fb7185"],
    ["#4338ca", "#6366f1"],
  ];
  let hash = 0;
  for (const char of title) hash = (hash + char.charCodeAt(0)) % colors.length;
  return colors[hash];
}

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }

  return payload;
}

function setError(message) {
  state.error = message;
  render();
}

function formatDistrictLocation(address) {
  return String(address || "")
    .replace(/\s+\d{5}(?:-\d{4})?$/, "")
    .trim();
}

function renderDistrictLookupHint() {
  const lookup = state.districtLookup;
  if (lookup.loading) {
    return `<p class="district-info loading">Looking up district...</p>`;
  }
  if (lookup.valid && lookup.name) {
    const location = formatDistrictLocation(lookup.address);
    return `
      <p class="district-info valid">
        <strong>${escapeHtml(lookup.name)}</strong>
        ${location ? `<span>${escapeHtml(location)}</span>` : ""}
      </p>
    `;
  }
  if (lookup.valid === false) {
    return `<p class="district-info invalid">Could not reach this district URL.</p>`;
  }
  return "";
}

function updateDistrictLookupHint() {
  const container = document.getElementById("district-info");
  if (!container) return;
  container.innerHTML = renderDistrictLookupHint();
}

async function lookupDistrictName(url) {
  const trimmed = url.trim();
  const requestId = ++districtLookupRequest;

  if (!trimmed || !trimmed.includes(".")) {
    state.districtLookup = { loading: false, valid: null, name: "", address: "" };
    lastDistrictLookupUrl = "";
    updateDistrictLookupHint();
    return;
  }

  if (trimmed === lastDistrictLookupUrl && !state.districtLookup.loading) {
    updateDistrictLookupHint();
    return;
  }

  state.districtLookup = { loading: true, valid: null, name: "", address: "" };
  updateDistrictLookupHint();

  try {
    const response = await fetch(`/api/district-lookup?url=${encodeURIComponent(trimmed)}`);
    const result = await response.json();
    if (requestId !== districtLookupRequest) return;

    if (!response.ok) {
      throw new Error(result.error || "District lookup failed");
    }

    lastDistrictLookupUrl = trimmed;
    state.districtLookup = {
      loading: false,
      valid: result.valid,
      name: result.name || "",
      address: result.address || "",
    };
  } catch {
    if (requestId !== districtLookupRequest) return;
    state.districtLookup = { loading: false, valid: false, name: "", address: "" };
  }

  updateDistrictLookupHint();
}

function scheduleDistrictLookup(url) {
  clearTimeout(districtLookupTimer);
  districtLookupTimer = setTimeout(() => lookupDistrictName(url), 400);
}

function bindDistrictLookup() {
  const districtInput = document.getElementById("districtUrl");
  if (!districtInput) return;

  if (districtInput.dataset.lookupBound !== "true") {
    districtInput.dataset.lookupBound = "true";
    districtInput.addEventListener("input", (event) => {
      scheduleDistrictLookup(event.target.value);
    });
  }

  scheduleDistrictLookup(districtInput.value);
}

function renderLogin() {
  app.innerHTML = `
    <div class="login-shell">
      <div class="login-card">
        <div class="brand">
          <div class="brand-mark">BV</div>
          <div>
            <h1>BetterVUE</h1>
            <p>A cleaner StudentVUE experience</p>
          </div>
        </div>
        <p class="subtitle">Sign in with your district URL and StudentVUE credentials.</p>
        ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ""}
        <form id="login-form">
          <div class="field">
            <label for="districtUrl">District URL</label>
            <input id="districtUrl" name="districtUrl" value="${escapeHtml(state.districtUrl)}" required />
            <div id="district-info"></div>
          </div>
          <div class="field">
            <label for="username">Student ID / Username</label>
            <input id="username" name="username" autocomplete="username" required />
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required />
          </div>
          <button class="btn btn-primary" type="submit">${state.loading ? "Signing in..." : "Sign in"}</button>
        </form>
      </div>
    </div>
  `;

  document.getElementById("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    state.loading = true;
    state.error = "";
    render();

    const form = event.currentTarget;
    const districtUrl = form.districtUrl.value.trim();
    const username = form.username.value.trim();
    const password = form.password.value;

    try {
      const result = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ districtUrl, username, password }),
      });

      state.token = result.token;
      state.districtUrl = result.districtUrl;
      state.student = result.student;
      state.dashboard = null;
      state.reportPeriod = null;
      localStorage.setItem("bettervue_token", state.token);
      localStorage.setItem("bettervue_district", state.districtUrl);
      state.loading = false;
      await loadDashboard();
    } catch (error) {
      state.loading = false;
      setError(error.message);
    }
  });

  bindDistrictLookup();
}

function renderCourseCard(course, index, activePeriod) {
  const mark = course.currentMark || course.marks?.[0];
  const score = mark?.score || "—";
  const assignments = mark?.assignments || [];
  const expanded = state.expandedCourses.has(index);
  const [from, to] = courseColor(course.courseName || course.title);
  const initials = (course.courseName || course.title || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  return `
    <div class="course-card">
      <button class="course-summary" data-course="${index}" type="button">
        <div class="course-icon" style="background: linear-gradient(135deg, ${from}, ${to})">${escapeHtml(initials)}</div>
        <div>
          <h4>${escapeHtml(course.title || course.courseName)}</h4>
          <p>Period ${escapeHtml(course.period)} · ${escapeHtml(course.teacher)} · Room ${escapeHtml(course.room || "—")}</p>
        </div>
        <div class="grade-pill ${gradeClass(score)}">${escapeHtml(score)}</div>
      </button>
      ${
        expanded
          ? `<div class="course-details">
              <table class="assignments-table">
                <thead>
                  <tr>
                    <th>Assignment</th>
                    <th>Type</th>
                    <th>Due</th>
                    <th>Score</th>
                  </tr>
                </thead>
                <tbody>
                  ${
                    assignments.length
                      ? assignments
                          .slice(0, 25)
                          .map(
                            (assignment) => `
                              <tr>
                                <td>${escapeHtml(assignment.name)}</td>
                                <td>${escapeHtml(assignment.type)}</td>
                                <td>${escapeHtml(assignment.dueDate || assignment.date)}</td>
                                <td>${escapeHtml(assignment.score || assignment.points || "—")}</td>
                              </tr>
                            `
                          )
                          .join("")
                      : `<tr><td colspan="4">No assignments for this reporting period.</td></tr>`
                  }
                </tbody>
              </table>
            </div>`
          : ""
      }
    </div>
  `;
}

function renderDashboard() {
  const data = state.dashboard;
  if (!data) {
    return `<div class="loading">Loading your dashboard...</div>`;
  }

  const courses = data.gradebook?.courses || [];
  const attendanceDays = data.attendance?.days?.length || 0;
  const avgCourses = courses.filter((course) => (course.currentMark || course.marks?.[0])?.score).length;
  const reportingPeriods = data.gradebook?.reportingPeriods || [];
  const activePeriod = state.reportPeriod ?? data.gradebook?.activePeriod?.index ?? "";
  const gradesLoading = state.loading && Boolean(state.dashboard);

  return `
    <div class="stats-grid">
      <div class="stat-card">
        <span>Grade level</span>
        <strong>${escapeHtml(data.student?.grade || "—")}</strong>
      </div>
      <div class="stat-card">
        <span>Active courses</span>
        <strong>${courses.length}</strong>
      </div>
      <div class="stat-card">
        <span>Graded classes</span>
        <strong>${avgCourses}</strong>
      </div>
      <div class="stat-card">
        <span>Attendance events</span>
        <strong>${attendanceDays}</strong>
      </div>
    </div>

    <div class="panel${gradesLoading ? " panel-loading-state" : ""}">
      <div class="panel-header">
        <h3>Current grades</h3>
        <select id="report-period" ${gradesLoading ? "disabled" : ""}>
          ${reportingPeriods
            .map(
              (period) =>
                `<option value="${period.index}" ${String(period.index) === String(activePeriod) ? "selected" : ""}>${escapeHtml(period.name)}</option>`
            )
            .join("")}
        </select>
      </div>
      ${
        gradesLoading
          ? `<div class="panel-loading"><span class="spinner" aria-hidden="true"></span>Updating grades...</div>`
          : `<div class="course-grid">
              ${courses.length ? courses.map((course, index) => renderCourseCard(course, index, data.gradebook?.activePeriod)).join("") : `<div class="empty-state">No courses found for this period.</div>`}
            </div>`
      }
    </div>
  `;
}

function renderGradebook() {
  return renderDashboard();
}

function parseAttendanceDate(value) {
  const match = String(value || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  return new Date(Number(match[3]), Number(match[1]) - 1, Number(match[2]));
}

function attendanceDateKey(value) {
  const date = typeof value === "string" ? parseAttendanceDate(value) : value;
  if (!date) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatAttendanceDate(value) {
  const date = parseAttendanceDate(value);
  if (!date) return value || "";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

const ATTENDANCE_LABELS = {
  excused: "Excused",
  tardy: "Tardy",
  unexcused: "Unexcused",
  activity: "Activity",
  not_scheduled: "Not Scheduled",
};

function renderAttendanceIcon(type, compact = false) {
  const size = compact ? 12 : 14;
  const svgs = {
    excused: `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true"><path fill="currentColor" d="M6.2 11.1 3.4 8.3l-.9.9 3.7 3.7 7.8-7.8-.9-.9z"/></svg>`,
    tardy: `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true"><path fill="currentColor" d="M8 2a6 6 0 1 0 6 6h-1.5A4.5 4.5 0 1 1 8 3.5V2zm0 3v3.2l2.4 1.4-.8 1.3L7 9V5h1z"/></svg>`,
    unexcused: `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5"/></svg>`,
    activity: `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true"><path fill="currentColor" d="M4 2v12l9-6z"/></svg>`,
    not_scheduled: `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path fill="currentColor" d="m4.2 4.2 7.6 7.6-1.4 1.4-7.6-7.6z"/></svg>`,
  };

  return `<span class="attendance-icon ${type}${compact ? " compact" : ""}" title="${escapeHtml(ATTENDANCE_LABELS[type] || type)}">${svgs[type] || svgs.unexcused}</span>`;
}

function buildAttendanceCalendar(attendance) {
  const byDate = new Map();

  for (const day of attendance.days || []) {
    byDate.set(attendanceDateKey(day.date), day);
  }

  return byDate;
}

function ensureAttendanceMonth(attendance) {
  if (state.attendanceMonth) return state.attendanceMonth;

  const allDates = (attendance.days || [])
    .map((item) => parseAttendanceDate(item.date))
    .filter(Boolean);

  const anchor = allDates.sort((a, b) => b - a)[0] || new Date();
  state.attendanceMonth = { year: anchor.getFullYear(), month: anchor.getMonth() };
  return state.attendanceMonth;
}

function renderAttendanceDayDetail(day) {
  if (!day) {
    return `<div class="attendance-day-detail empty">Select a highlighted day to see details.</div>`;
  }

  const periods = day.periods || [];

  return `
    <div class="attendance-day-detail">
      <div class="attendance-detail-card ${escapeHtml(day.type)}">
        <div class="attendance-detail-header">
          ${renderAttendanceIcon(day.type)}
          <div>
            <strong>${escapeHtml(ATTENDANCE_LABELS[day.type] || "Attendance")}</strong>
            <p>${escapeHtml(formatAttendanceDate(day.date))}</p>
          </div>
        </div>
        ${
          periods.length
            ? `<ul class="attendance-period-list">${periods
                .map(
                  (period) => `
                    <li>
                      <div class="attendance-period-top">
                        <span>Period ${escapeHtml(period.number)}</span>
                        ${period.type && period.type !== day.type ? renderAttendanceIcon(period.type, true) : ""}
                      </div>
                      <strong>${escapeHtml(period.course)}</strong>
                      <span>${escapeHtml(period.name || period.teacher)}</span>
                    </li>
                  `
                )
                .join("")}</ul>`
            : `<p class="attendance-detail-note">${escapeHtml(day.note || day.reason || ATTENDANCE_LABELS[day.type])}</p>`
        }
      </div>
    </div>
  `;
}

function renderAttendanceCalendarGrid({ year, month }, eventsByDate) {
  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = attendanceDateKey(new Date());
  const cells = [];

  for (let i = 0; i < startOffset; i += 1) {
    cells.push(`<div class="calendar-cell empty"></div>`);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month, day);
    const key = attendanceDateKey(date);
    const event = eventsByDate.get(key);
    const isSelected = state.selectedAttendanceDate === key;
    const classes = [
      "calendar-cell",
      event ? "has-events" : "",
      isSelected ? "selected" : "",
      key === todayKey ? "today" : "",
    ]
      .filter(Boolean)
      .join(" ");

    cells.push(`
      <button
        class="${classes}"
        type="button"
        data-attendance-date="${key}"
        ${event ? "" : "disabled"}
        aria-label="${day}${event ? `, ${ATTENDANCE_LABELS[event.type]}` : ""}"
      >
        <span class="calendar-day-number">${day}</span>
        ${event ? `<span class="calendar-event-icons">${renderAttendanceIcon(event.type, true)}</span>` : ""}
      </button>
    `);
  }

  return cells.join("");
}

function renderAttendanceSummary(attendance) {
  const days = attendance.days || [];
  const counts = days.reduce((acc, day) => {
    acc[day.type] = (acc[day.type] || 0) + 1;
    return acc;
  }, {});

  return Object.entries(ATTENDANCE_LABELS)
    .map(([type, label]) => {
      const count = counts[type] || 0;
      if (!count) return "";
      return `<span>${renderAttendanceIcon(type, true)} ${count} ${label.toLowerCase()}${count === 1 ? "" : "s"}</span>`;
    })
    .filter(Boolean)
    .join(" · ");
}

function renderAttendance() {
  const attendance = state.dashboard?.attendance;
  if (!attendance) {
    return `<div class="loading">Loading attendance...</div>`;
  }

  const eventsByDate = buildAttendanceCalendar(attendance);
  const { year, month } = ensureAttendanceMonth(attendance);
  const monthLabel = new Date(year, month, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  const selectedDay = state.selectedAttendanceDate ? eventsByDate.get(state.selectedAttendanceDate) : null;
  const summary = renderAttendanceSummary(attendance);

  return `
    <div class="attendance-layout">
      <div class="panel attendance-calendar-panel">
        <div class="panel-header">
          <div>
            <h3>Attendance · ${escapeHtml(attendance.schoolName || "School")}</h3>
            <p class="attendance-subtitle">${summary || "No attendance events on record."}</p>
          </div>
          <div class="calendar-nav">
            <button class="btn btn-secondary" id="attendance-prev" type="button" aria-label="Previous month">‹</button>
            <strong class="calendar-month-label">${escapeHtml(monthLabel)}</strong>
            <button class="btn btn-secondary" id="attendance-next" type="button" aria-label="Next month">›</button>
          </div>
        </div>
        <div class="attendance-legend">
          ${Object.entries(ATTENDANCE_LABELS)
            .map(([type, label]) => `<span>${renderAttendanceIcon(type, true)} ${label}</span>`)
            .join("")}
        </div>
        ${
          eventsByDate.size
            ? `<div class="attendance-calendar">
                <div class="calendar-weekdays">
                  ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
                    .map((day) => `<div>${day}</div>`)
                    .join("")}
                </div>
                <div class="calendar-grid">
                  ${renderAttendanceCalendarGrid({ year, month }, eventsByDate)}
                </div>
              </div>`
            : `<div class="empty-state">No attendance events on record.</div>`
        }
      </div>
      <div class="panel attendance-detail-panel">
        <div class="panel-header">
          <h3>Day details</h3>
        </div>
        ${renderAttendanceDayDetail(selectedDay)}
      </div>
    </div>
  `;
}

function renderMainContent() {
  if (state.loading && !state.dashboard) {
    return `<div class="loading">Loading...</div>`;
  }

  if (state.view === "attendance") return renderAttendance();
  if (state.view === "gradebook") return renderGradebook();
  return renderDashboard();
}

function getStudentSchool() {
  return state.student?.school || state.dashboard?.attendance?.schoolName || "";
}

function renderApp() {
  const photo = state.student?.photo
    ? `data:image/png;base64,${state.student.photo}`
    : "";

  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">BV</div>
          <div>
            <h1>BetterVUE</h1>
            <p>${escapeHtml(state.districtUrl.replace(/^https?:\/\//, ""))}</p>
          </div>
        </div>
        <nav class="nav">
          <button class="${state.view === "dashboard" ? "active" : ""}" data-view="dashboard" type="button">Dashboard</button>
          <button class="${state.view === "gradebook" ? "active" : ""}" data-view="gradebook" type="button">Gradebook</button>
          <button class="${state.view === "attendance" ? "active" : ""}" data-view="attendance" type="button">Attendance</button>
        </nav>
        <div class="student-card">
          ${
            photo
              ? `<img src="${photo}" alt="Student photo" />`
              : `<div class="avatar-placeholder"></div>`
          }
          <div>
            <strong>${escapeHtml(state.student?.name || "Student")}</strong>
            <span>Grade ${escapeHtml(state.student?.grade || "—")}</span>
            ${getStudentSchool() ? `<span class="student-school">${escapeHtml(getStudentSchool())}</span>` : ""}
          </div>
        </div>
      </aside>
      <main class="main">
        <div class="topbar">
          <h2>${state.view === "attendance" ? "Attendance" : state.view === "gradebook" ? "Gradebook" : "Dashboard"}</h2>
          <div class="topbar-actions">
            <button class="btn btn-secondary" id="refresh-btn" type="button" ${state.loading ? "disabled" : ""}>${state.loading ? "Refreshing..." : "Refresh"}</button>
            <button class="btn btn-secondary" id="logout-btn" type="button">Sign out</button>
          </div>
        </div>
        ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ""}
        ${renderMainContent()}
      </main>
    </div>
  `;

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      state.error = "";
      if (button.dataset.view === "attendance" && state.dashboard?.attendance) {
        const eventsByDate = buildAttendanceCalendar(state.dashboard.attendance);
        ensureAttendanceMonth(state.dashboard.attendance);
        if (!state.selectedAttendanceDate && eventsByDate.size) {
          const latestKey = [...eventsByDate.keys()].sort().at(-1);
          state.selectedAttendanceDate = latestKey;
        }
      }
      render();
    });
  });

  document.querySelectorAll("[data-attendance-date]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedAttendanceDate = button.dataset.attendanceDate;
      render();
    });
  });

  const attendancePrev = document.getElementById("attendance-prev");
  if (attendancePrev) {
    attendancePrev.addEventListener("click", () => {
      const current = ensureAttendanceMonth(state.dashboard.attendance);
      const nextMonth = current.month - 1;
      if (nextMonth < 0) {
        state.attendanceMonth = { year: current.year - 1, month: 11 };
      } else {
        state.attendanceMonth = { year: current.year, month: nextMonth };
      }
      state.selectedAttendanceDate = null;
      render();
    });
  }

  const attendanceNext = document.getElementById("attendance-next");
  if (attendanceNext) {
    attendanceNext.addEventListener("click", () => {
      const current = ensureAttendanceMonth(state.dashboard.attendance);
      const nextMonth = current.month + 1;
      if (nextMonth > 11) {
        state.attendanceMonth = { year: current.year + 1, month: 0 };
      } else {
        state.attendanceMonth = { year: current.year, month: nextMonth };
      }
      state.selectedAttendanceDate = null;
      render();
    });
  }

  document.querySelectorAll("[data-course]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.course);
      if (state.expandedCourses.has(index)) {
        state.expandedCourses.delete(index);
      } else {
        state.expandedCourses.add(index);
      }
      render();
    });
  });

  const periodSelect = document.getElementById("report-period");
  if (periodSelect) {
    periodSelect.addEventListener("change", async (event) => {
      state.reportPeriod = event.target.value;
      await loadDashboard(state.reportPeriod);
    });
  }

  document.getElementById("refresh-btn").addEventListener("click", () => {
    loadDashboard(state.reportPeriod);
  });

  document.getElementById("logout-btn").addEventListener("click", async () => {
    try {
      await api("/api/logout", { method: "POST", body: "{}" });
    } catch (_) {
      // ignore
    }
    localStorage.removeItem("bettervue_token");
    localStorage.removeItem("bettervue_district");
    state.token = "";
    state.dashboard = null;
    state.student = null;
    state.reportPeriod = null;
    state.view = "dashboard";
    render();
  });
}

async function loadDashboard(period) {
  state.loading = true;
  state.error = "";
  render();

  try {
    const usePeriod = period !== undefined && period !== null && period !== "";
    const query = usePeriod ? `?period=${encodeURIComponent(period)}` : "";
    const data = await api(`/api/dashboard${query}`);
    state.dashboard = data;
    state.student = data.student || state.student;
    if (data.gradebook?.activePeriod) {
      state.reportPeriod = data.gradebook.activePeriod.index;
    }
  } catch (error) {
    if (error.message.includes("Session expired")) {
      localStorage.removeItem("bettervue_token");
      state.token = "";
    }
    state.error = error.message;
  } finally {
    state.loading = false;
    render();
  }
}

function render() {
  if (!state.token) {
    renderLogin();
    return;
  }

  if (!state.dashboard && !state.loading) {
    loadDashboard();
    return;
  }

  renderApp();
}

render();
