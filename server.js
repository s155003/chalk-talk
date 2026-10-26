// Local development server. Serves public/ and routes /api/* to the same
// handler modules Vercel deploys as serverless functions.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "public");
const PORT = Number(process.env.PORT) || 3000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8"
};

const handlers = {};
async function loadHandler(name) {
  if (!handlers[name]) {
    const mod = await import(`./api/${name}.js`);
    handlers[name] = mod.default;
  }
  return handlers[name];
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) reject(new Error("Body too large")); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// Minimal shim so the Vercel-style handlers work on plain Node.
function wrapRes(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith("/api/")) {
    const name = url.pathname.slice(5).replace(/[^a-z]/g, "");
    if (!fs.existsSync(path.join(here, "api", `${name}.js`))) {
      wrapRes(res).status(404).json({ error: "Not found" });
      return;
    }
    try {
      const raw = await readBody(req);
      req.body = raw ? JSON.parse(raw) : {};
    } catch (err) {
      wrapRes(res).status(400).json({ error: "Bad JSON" });
      return;
    }
    const handler = await loadHandler(name);
    await handler(req, wrapRes(res));
    return;
  }

  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[\\/])+/, "");
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }
  res.setHeader("Content-Type", TYPES[path.extname(full)] || "application/octet-stream");
  fs.createReadStream(full).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Counterparty running at http://localhost:${PORT}`);
});
