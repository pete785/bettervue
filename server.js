const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { createSessionStore, normalizeDistrictUrl, lookupDistrict } = require("./lib/edupoint");

const PORT = process.env.PORT || 3847;
const PUBLIC_DIR = path.join(__dirname, "public");
const sessions = createSessionStore();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, pathname) {
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath === "/" ? "index.html" : safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (pathname !== "/" && !path.extname(pathname)) {
        fs.readFile(path.join(PUBLIC_DIR, "index.html"), (fallbackErr, fallbackData) => {
          if (fallbackErr) {
            sendJson(res, 404, { error: "Not found" });
            return;
          }
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(fallbackData);
        });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}

function getToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return null;
}

async function handleApi(req, res, pathname, searchParams) {
  if (req.method === "GET" && pathname === "/api/district-lookup") {
    try {
      const districtUrl = searchParams.get("url") || "";
      if (!districtUrl.trim()) {
        sendJson(res, 400, { error: "District URL is required." });
        return;
      }

      const result = await lookupDistrict(districtUrl);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, { error: error.message || "District lookup failed" });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/login") {
    try {
      const body = await readBody(req);
      const districtUrl = normalizeDistrictUrl(body.districtUrl || "");
      const username = String(body.username || "").trim();
      const password = String(body.password || "");

      if (!districtUrl || !username || !password) {
        sendJson(res, 400, { error: "District URL, username, and password are required." });
        return;
      }

      const { EduPointClient } = require("./lib/edupoint");
      const client = new EduPointClient({ districtUrl, username, password });
      const student = await client.getStudentInfo();

      if (!student?.name) {
        sendJson(res, 401, { error: "Could not load student profile. Check your credentials." });
        return;
      }

      const token = sessions.create({ districtUrl, username, password });
      sendJson(res, 200, { token, student, districtUrl });
    } catch (error) {
      sendJson(res, 401, { error: error.message || "Login failed" });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/logout") {
    const token = getToken(req);
    if (token) sessions.destroy(token);
    sendJson(res, 200, { ok: true });
    return;
  }

  const token = getToken(req);
  const client = sessions.clientFor(token);
  if (!client) {
    sendJson(res, 401, { error: "Session expired. Please sign in again." });
    return;
  }

  const reportPeriod = searchParams.get("period");

  try {
    if (req.method === "GET" && pathname === "/api/dashboard") {
      const data = await client.getDashboard(reportPeriod);
      sendJson(res, 200, data);
      return;
    }

    if (req.method === "GET" && pathname === "/api/gradebook") {
      const data = await client.getGradebook(reportPeriod);
      sendJson(res, 200, data);
      return;
    }

    if (req.method === "GET" && pathname === "/api/attendance") {
      const data = await client.getAttendance();
      sendJson(res, 200, data);
      return;
    }

    if (req.method === "GET" && pathname === "/api/student") {
      const data = await client.getStudentInfo();
      sendJson(res, 200, data);
      return;
    }

    sendJson(res, 404, { error: "API route not found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Request failed" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname.startsWith("/api/")) {
    await handleApi(req, res, pathname, url.searchParams);
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`BetterVUE running at http://localhost:${PORT}`);
});
