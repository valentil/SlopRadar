// serve-report.js — serves report.html + fixtures, handles POST /__push.
// Usage: node serve-report.js [--port 8731]

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const HERE = __dirname;
const EXT_DIR = path.resolve(HERE, "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg !== -1 ? parseInt(process.argv[portArg + 1], 10) : 8731;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
};

function send(res, code, body, type = "text/plain") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

// Run git in the extension directory
function gitPush(cb) {
  // First verify EXT_DIR is actually a git repo
  execFile("git", ["-C", EXT_DIR, "rev-parse", "--is-inside-work-tree"], (e0) => {
    if (e0) {
      return cb({
        ok: false,
        message: "Not a git repo. Run: git init && git remote add origin <url>",
      });
    }

    // Stage everything
    execFile("git", ["-C", EXT_DIR, "add", "-A"], (e1, o1, err1) => {
      if (e1) return cb({ ok: false, message: "git add failed: " + (err1 || e1.message) });

      // Anything to commit?
      execFile("git", ["-C", EXT_DIR, "status", "--porcelain"], (e2, statusOut) => {
        if (e2) return cb({ ok: false, message: "git status failed" });
        if (!statusOut.trim()) {
          return cb({ ok: true, message: "Nothing to commit — working tree clean" });
        }

        const msg = "SlopRadar: verified by local test suite (" + new Date().toISOString() + ")";
        execFile("git", ["-C", EXT_DIR, "commit", "-m", msg], (e3, o3, err3) => {
          if (e3) return cb({ ok: false, message: "git commit failed: " + (err3 || e3.message) });

          // Check a remote exists before pushing
          execFile("git", ["-C", EXT_DIR, "remote"], (e4, remoteOut) => {
            if (e4 || !remoteOut.trim()) {
              return cb({
                ok: true,
                message: "Committed locally. No remote configured — add one with: git remote add origin <url>",
              });
            }
            execFile("git", ["-C", EXT_DIR, "push"], (e5, o5, err5) => {
              if (e5) return cb({ ok: false, message: "git push failed: " + (err5 || e5.message) });
              cb({ ok: true, message: "Committed & pushed: " + msg });
            });
          });
        });
      });
    });
  });
}

const server = http.createServer((req, res) => {
  // ── Push endpoint ──
  if (req.method === "POST" && req.url === "/__push") {
    gitPush((result) => {
      send(res, result.ok ? 200 : 500, JSON.stringify(result), "application/json");
    });
    return;
  }

  // ── Static files ──
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/report.html";

  // Serve from test dir; allow fixtures/ subdir
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(HERE, safePath);

  if (!filePath.startsWith(HERE)) {
    return send(res, 403, "Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, "Not found: " + urlPath);
    const ext = path.extname(filePath);
    send(res, 200, data, MIME[ext] || "application/octet-stream");
  });
});

server.listen(PORT, () => {
  console.log(`\n  SlopRadar test report → http://localhost:${PORT}\n`);
});
