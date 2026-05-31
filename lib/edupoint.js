const crypto = require("crypto");
const https = require("https");
const { URL, URLSearchParams } = require("url");
const { parseXml, getElements, getAttr, getText, firstElement } = require("./xml");

const USER_AGENT = "StudentVUE/8.0.26 CFNetwork/1121.2.2 Darwin/19.3.0";

function decodeInnerXml(raw) {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeDistrictUrl(input) {
  let url = input.trim();
  if (!url.startsWith("http")) {
    url = `https://${url}`;
  }
  url = url.replace(/\/+$/, "");
  return url;
}

function postForm(baseUrl, fields, servicePath = "PXPCommunication.asmx") {
  return new Promise((resolve, reject) => {
    const endpoint = `${normalizeDistrictUrl(baseUrl)}/Service/${servicePath}/ProcessWebServiceRequest`;
    const body = new URLSearchParams(fields).toString();
    const target = new URL(endpoint);

    const req = https.request(
      {
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": USER_AGENT,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`District server returned ${res.statusCode}`));
            return;
          }
          resolve(text);
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function callMethod({ districtUrl, username, password, methodName, paramStr = "" }) {
  const responseText = await postForm(districtUrl, {
    userID: username,
    password,
    skipLoginLog: "false",
    parent: "false",
    webServiceHandleName: "PXPWebServices",
    methodName,
    paramStr,
  });

  const envelope = parseXml(responseText);
  const innerRaw = getText(firstElement(getElements(envelope, "string")));
  if (!innerRaw) {
    throw new Error("Unexpected response from district server");
  }

  const innerXml = decodeInnerXml(innerRaw);
  const doc = parseXml(innerXml);
  const error = firstElement(getElements(doc, "RT_ERROR"));
  if (error) {
    throw new Error(getAttr(error, "ERROR_MESSAGE") || "Login failed");
  }

  return doc;
}

function buildParams(childIntId = 0, reportPeriod = null) {
  if (reportPeriod === null || reportPeriod === undefined) {
    return `<Parms><ChildIntID>${childIntId}</ChildIntID></Parms>`;
  }
  return `<Parms><ChildIntID>${childIntId}</ChildIntID><ReportPeriod>${reportPeriod}</ReportPeriod></Parms>`;
}

function mapStudentInfo(doc) {
  const info = firstElement(getElements(doc, "StudentInfo"));
  if (!info) return null;

  return {
    name: getText(firstElement(getElements(info, "FormattedName"))),
    permId: getText(firstElement(getElements(info, "PermID"))),
    gender: getText(firstElement(getElements(info, "Gender"))),
    grade: getText(firstElement(getElements(info, "Grade"))),
    photo: getText(firstElement(getElements(info, "Photo"))),
    school:
      getText(firstElement(getElements(info, "OrganizationName"))) ||
      getText(firstElement(getElements(info, "SchoolName"))) ||
      getText(firstElement(getElements(info, "School"))),
  };
}

function parseUsDate(value) {
  const match = String(value || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  return new Date(Number(match[3]), Number(match[1]) - 1, Number(match[2]));
}

function pickCurrentReportingPeriod(periods) {
  if (!periods.length) return null;

  const today = new Date();
  today.setHours(12, 0, 0, 0);

  const containingToday = periods.find((period) => {
    const start = parseUsDate(period.startDate);
    const end = parseUsDate(period.endDate);
    return start && end && today >= start && today <= end;
  });
  if (containingToday) return containingToday;

  const sorted = [...periods].sort((a, b) => {
    const aEnd = parseUsDate(a.endDate)?.getTime() || 0;
    const bEnd = parseUsDate(b.endDate)?.getTime() || 0;
    return bEnd - aEnd;
  });

  const latestEnded = sorted.find((period) => {
    const end = parseUsDate(period.endDate);
    return end && today >= end;
  });

  return latestEnded || sorted[0];
}

function mapReportingPeriods(doc) {
  const container = firstElement(getElements(doc, "ReportingPeriods"));
  const periods = container ? getElements(container, "ReportPeriod") : getElements(doc, "ReportPeriod");
  return periods.map((node) => ({
    index: Number(getAttr(node, "Index")),
    name: getAttr(node, "GradePeriod"),
    startDate: getAttr(node, "StartDate"),
    endDate: getAttr(node, "EndDate"),
  }));
}

function pickMarkForPeriod(marks, activePeriod) {
  if (!marks?.length) return null;
  if (!activePeriod) return marks[0];

  const periodName = String(activePeriod.name || "").toLowerCase();
  const byName = marks.find(
    (mark) =>
      String(mark.name || "").toLowerCase() === periodName ||
      String(mark.shortName || "").toLowerCase() === periodName
  );
  if (byName) return byName;

  const quarterMatch = periodName.match(/quarter\s+(\d)/);
  if (quarterMatch) {
    const quarterMark = marks.find((mark) => String(mark.name || "").toUpperCase() === `QTR${quarterMatch[1]}`);
    if (quarterMark) return quarterMark;
  }

  const progressMatch = periodName.match(/prg(\d)/i);
  if (progressMatch) {
    const progressMark = marks.find((mark) => String(mark.name || "").toUpperCase() === `PRG${progressMatch[1]}`);
    if (progressMark) return progressMark;
  }

  return marks[marks.length - 1];
}

function mapGradebook(doc, requestedPeriod = null, reportingPeriodsOverride = null) {
  const reportingPeriods = reportingPeriodsOverride || mapReportingPeriods(doc);
  const responsePeriod = firstElement(getElements(doc, "ReportingPeriod"));

  let activePeriod = null;

  if (requestedPeriod !== null && requestedPeriod !== undefined && requestedPeriod !== "") {
    activePeriod = reportingPeriods.find((period) => period.index === Number(requestedPeriod)) || null;
  }

  if (!activePeriod && responsePeriod) {
    activePeriod = {
      index: Number(getAttr(responsePeriod, "Index")),
      name: getAttr(responsePeriod, "GradePeriod"),
      startDate: getAttr(responsePeriod, "StartDate"),
      endDate: getAttr(responsePeriod, "EndDate"),
    };
  }

  if (!activePeriod) {
    activePeriod = reportingPeriods[0] || null;
  }

  const coursesNode = firstElement(getElements(doc, "Courses"));
  const courseNodes = coursesNode ? getElements(coursesNode, "Course") : [];

  const courses = courseNodes.map((course) => {
    const marks = getElements(course, "Mark").map((mark) => ({
      name: getAttr(mark, "MarkName"),
      shortName: getAttr(mark, "ShortMarkName"),
      score: getAttr(mark, "CalculatedScoreString"),
      rawScore: getAttr(mark, "CalculatedScoreRaw"),
      assignments: getElements(mark, "Assignment").map((assignment) => ({
        id: getAttr(assignment, "GradebookID"),
        name: getAttr(assignment, "Measure"),
        type: getAttr(assignment, "Type"),
        dueDate: getAttr(assignment, "DueDate"),
        date: getAttr(assignment, "Date"),
        score: getAttr(assignment, "DisplayScore"),
        points: getAttr(assignment, "Points"),
        notes: getAttr(assignment, "Notes"),
      })),
    }));

    const currentMark = pickMarkForPeriod(marks, activePeriod);

    return {
      period: getAttr(course, "Period"),
      title: getAttr(course, "Title"),
      courseName: getAttr(course, "CourseName"),
      courseId: getAttr(course, "CourseID"),
      room: getAttr(course, "Room"),
      teacher: getAttr(course, "Staff"),
      teacherEmail: getAttr(course, "StaffEMail"),
      imageType: getAttr(course, "ImageType"),
      marks,
      currentMark,
    };
  });

  return {
    reportingPeriods,
    activePeriod,
    courses,
  };
}

const ATTENDANCE_TYPE_PRIORITY = ["unexcused", "tardy", "excused", "activity", "not_scheduled"];

function classifyAttendanceType({ iconName = "", name = "", reason = "", dailyIconName = "" } = {}) {
  const icon = String(iconName || dailyIconName).toLowerCase();
  const label = String(name).toLowerCase();
  const code = String(reason).toLowerCase();

  if (icon.includes("tardy") || label.includes("tardy")) return "tardy";
  if (
    icon.includes("unexcused") ||
    label.includes("unexcused") ||
    label.includes("truant") ||
    label.includes("inexcusable") ||
    code === "a"
  ) {
    return "unexcused";
  }
  if (icon.includes("excused") || label.includes("excused") || code === "e") return "excused";
  if (icon.includes("activity") || label.includes("school related") || label.includes("activity")) {
    return "activity";
  }
  if (icon.includes("not_sched") || code === "n/s" || label.includes("not scheduled")) {
    return "not_scheduled";
  }

  return null;
}

function summarizeAttendanceDay(absence) {
  const dailyType = classifyAttendanceType({
    dailyIconName: getAttr(absence, "DailyIconName"),
    reason: getAttr(absence, "Reason"),
    name: getAttr(absence, "CodeAllDayDescription"),
  });

  const periods = getElements(absence, "Period")
    .map((period) => {
      const name = getAttr(period, "Name");
      const reason = getAttr(period, "Reason");
      const iconName = getAttr(period, "IconName");
      const type = classifyAttendanceType({ iconName, name, reason });

      return {
        number: getAttr(period, "Number"),
        course: getAttr(period, "Course"),
        teacher: getAttr(period, "Staff"),
        name,
        reason,
        iconName,
        type,
      };
    })
    .filter((period) => period.type);

  let type = dailyType;
  if (!type) {
    for (const candidate of ATTENDANCE_TYPE_PRIORITY) {
      if (periods.some((period) => period.type === candidate)) {
        type = candidate;
        break;
      }
    }
  }

  return {
    date: getAttr(absence, "AbsenceDate"),
    type,
    reason: getAttr(absence, "Reason"),
    note: getAttr(absence, "Note"),
    dailyIconName: getAttr(absence, "DailyIconName"),
    periods,
  };
}

function mapAttendance(doc) {
  const root = firstElement(getElements(doc, "Attendance"));
  if (!root) {
    return { schoolName: "", days: [], totals: {} };
  }

  const days = getElements(root, "Absence")
    .map(summarizeAttendanceDay)
    .filter((day) => day.type);

  const totals = {
    excused: sumPeriodTotals(firstElement(getElements(root, "TotalExcused"))),
    tardies: sumPeriodTotals(firstElement(getElements(root, "TotalTardies"))),
    unexcused: sumPeriodTotals(firstElement(getElements(root, "TotalUnexcused"))),
    activities: sumPeriodTotals(firstElement(getElements(root, "TotalActivities"))),
    unexcusedTardies: sumPeriodTotals(firstElement(getElements(root, "TotalUnexcusedTardies"))),
  };

  return {
    schoolName: getAttr(root, "SchoolName"),
    days,
    totals,
  };
}

function sumPeriodTotals(container) {
  if (!container) return 0;
  return getElements(container, "PeriodTotal").reduce((sum, node) => {
    return sum + Number(getAttr(node, "Total") || 0);
  }, 0);
}

function mapSchedule(doc) {
  const root = firstElement(getElements(doc, "ClassSchedule"));
  if (!root) return { terms: [], courses: [] };

  const terms = getElements(root, "Term").map((term) => ({
    index: getAttr(term, "Index"),
    name: getAttr(term, "Name"),
  }));

  const courses = getElements(root, "Course").map((course) => ({
    period: getAttr(course, "Period"),
    title: getAttr(course, "Title"),
    room: getAttr(course, "Room"),
    teacher: getAttr(course, "Staff"),
    termIndex: getAttr(course, "TermIndex"),
  }));

  return { terms, courses };
}

function mapHomework(doc) {
  const assignments = getElements(doc, "Assignment").map((item) => ({
    subject: getAttr(item, "Subject"),
    title: getAttr(item, "Title"),
    dueDate: getAttr(item, "DueDate"),
    assignedDate: getAttr(item, "AssignedDate"),
    type: getAttr(item, "Type"),
    points: getAttr(item, "Points"),
    status: getAttr(item, "Status"),
    notes: getAttr(item, "Notes"),
  }));

  return { assignments };
}

class EduPointClient {
  constructor({ districtUrl, username, password }) {
    this.districtUrl = normalizeDistrictUrl(districtUrl);
    this.username = username;
    this.password = password;
  }

  async request(methodName, reportPeriod = null) {
    const doc = await callMethod({
      districtUrl: this.districtUrl,
      username: this.username,
      password: this.password,
      methodName,
      paramStr: buildParams(0, reportPeriod),
    });
    return doc;
  }

  async getStudentInfo() {
    const doc = await this.request("StudentInfo");
    return mapStudentInfo(doc);
  }

  async getGradebook(reportPeriod = null) {
    const normalizedPeriod =
      reportPeriod === null || reportPeriod === undefined || reportPeriod === "" ? null : Number(reportPeriod);

    if (normalizedPeriod === null) {
      const initialDoc = await this.request("Gradebook", null);
      const reportingPeriods = mapReportingPeriods(initialDoc);
      const targetPeriod = pickCurrentReportingPeriod(reportingPeriods);

      if (targetPeriod) {
        const doc = await this.request("Gradebook", targetPeriod.index);
        return mapGradebook(doc, targetPeriod.index, reportingPeriods);
      }

      return mapGradebook(initialDoc, null, reportingPeriods);
    }

    const initialDoc = await this.request("Gradebook", null);
    const reportingPeriods = mapReportingPeriods(initialDoc);
    const doc = await this.request("Gradebook", normalizedPeriod);
    return mapGradebook(doc, normalizedPeriod, reportingPeriods);
  }

  async getAttendance() {
    const doc = await this.request("Attendance");
    return mapAttendance(doc);
  }

  async getSchedule() {
    const doc = await this.request("ClassSchedule");
    return mapSchedule(doc);
  }

  async getHomework() {
    const doc = await this.request("StudentHWList");
    return mapHomework(doc);
  }

  async getDashboard(reportPeriod = null) {
    const normalizedPeriod =
      reportPeriod === null || reportPeriod === undefined || reportPeriod === "" ? null : Number(reportPeriod);

    const [student, gradebook, attendance, schedule, homework] = await Promise.all([
      this.getStudentInfo(),
      this.getGradebook(normalizedPeriod),
      this.getAttendance(),
      this.getSchedule().catch(() => ({ terms: [], courses: [] })),
      this.getHomework().catch(() => ({ assignments: [] })),
    ]);

    if (student && !student.school && attendance?.schoolName) {
      student.school = attendance.schoolName;
    }

    return { student, gradebook, attendance, schedule, homework };
  }
}

function createSessionStore() {
  const sessions = new Map();

  return {
    create(credentials) {
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, {
        ...credentials,
        districtUrl: normalizeDistrictUrl(credentials.districtUrl),
        createdAt: Date.now(),
      });
      return token;
    },
    get(token) {
      return sessions.get(token) || null;
    },
    destroy(token) {
      sessions.delete(token);
    },
    clientFor(token) {
      const session = sessions.get(token);
      if (!session) return null;
      return new EduPointClient(session);
    },
  };
}

const HDINFO_BASE_URL = "https://support.edupoint.com";
const HDINFO_KEY = "5E4B7859-B805-474B-A833-FDB15D205D40";
const districtDirectoryCache = new Map();

const STATE_ZIP_HINTS = {
  al: ["35203", "36104"],
  az: ["85001", "85701"],
  ca: ["94102", "90001", "92101"],
  co: ["80202", "80903"],
  fl: ["33101", "32801", "33602"],
  ga: ["30303", "31401"],
  ks: ["67212", "66101", "66604"],
  md: ["21201", "20850"],
  mi: ["48226", "49503"],
  mn: ["55401", "55101"],
  mo: ["63101", "64106"],
  nc: ["27601", "28202"],
  nj: ["07102", "08608"],
  nv: ["89101", "89501"],
  ny: ["10001", "14201"],
  oh: ["43215", "44114"],
  or: ["97201", "97401"],
  pa: ["19103", "15222"],
  tn: ["37201", "38103"],
  tx: ["75201", "77002", "78701"],
  va: ["23219", "22101"],
  wa: ["98101", "99201"],
};

function districtHost(input) {
  try {
    return new URL(normalizeDistrictUrl(input)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function urlHostsMatch(inputHost, pvueUrl) {
  const candidateHost = districtHost(pvueUrl);
  return candidateHost === inputHost;
}

function cacheDistrictEntry(district) {
  const host = districtHost(district.url);
  if (host) {
    districtDirectoryCache.set(host, district);
  }
}

function zipHintsForHost(hostname) {
  const prefix = hostname.split(".")[0].split("-")[0];
  return STATE_ZIP_HINTS[prefix] || [];
}

function mapDistrictList(doc) {
  return getElements(doc, "DistrictInfo").map((node) => ({
    name: getAttr(node, "Name"),
    address: getAttr(node, "Address"),
    url: getAttr(node, "PvueURL"),
  }));
}

async function fetchDistrictsByZip(zip) {
  const responseText = await postForm(
    HDINFO_BASE_URL,
    {
      userID: "EdupointDistrictInfo",
      password: "Edup01nt",
      skipLoginLog: "true",
      webServiceHandleName: "HDInfoServices",
      methodName: "GetMatchingDistrictList",
      paramStr: `<Parms><Key>${HDINFO_KEY}</Key><MatchToDistrictZipCode>${zip}</MatchToDistrictZipCode></Parms>`,
    },
    "HDInfoCommunication.asmx"
  );

  const envelope = parseXml(responseText);
  const innerRaw = getText(firstElement(getElements(envelope, "string")));
  if (!innerRaw) return [];

  const doc = parseXml(decodeInnerXml(innerRaw));
  const districts = mapDistrictList(doc);
  districts.forEach(cacheDistrictEntry);
  return districts;
}

function verifyDistrictReachable(districtUrl) {
  return new Promise((resolve, reject) => {
    const target = new URL(`${normalizeDistrictUrl(districtUrl)}/Service/PXPCommunication.asmx`);
    const req = https.get(
      {
        hostname: target.hostname,
        path: target.pathname,
        headers: { "User-Agent": USER_AGENT },
        timeout: 8000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("District lookup timed out"));
    });
  });
}

async function lookupDistrict(districtUrl) {
  const host = districtHost(districtUrl);
  if (!host || !host.includes(".")) {
    return { valid: false, name: null, address: null };
  }

  const cached = districtDirectoryCache.get(host);
  if (cached) {
    return { valid: true, name: cached.name, address: cached.address };
  }

  try {
    const reachable = await verifyDistrictReachable(districtUrl);
    if (!reachable) {
      return { valid: false, name: null, address: null };
    }
  } catch {
    return { valid: false, name: null, address: null };
  }

  const zipCandidates = [
    ...zipHintsForHost(host),
    "67212",
    "94127",
    "10001",
    "60601",
    "75201",
    "98101",
    "85001",
  ];

  for (const zip of [...new Set(zipCandidates)]) {
    try {
      const districts = await fetchDistrictsByZip(zip);
      for (const district of districts) {
        if (urlHostsMatch(host, district.url)) {
          return { valid: true, name: district.name, address: district.address };
        }
      }
    } catch {
      // Try the next zip hint.
    }
  }

  return { valid: true, name: null, address: null };
}

module.exports = {
  EduPointClient,
  createSessionStore,
  normalizeDistrictUrl,
  lookupDistrict,
};
