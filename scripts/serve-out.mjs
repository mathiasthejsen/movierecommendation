// Serve the static export (out/) under NEXT_PUBLIC_BASE_PATH, like GitHub Pages does.
// Usage: npm run build && npm run preview   (PORT defaults to 4173)
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = new URL("../out/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const base = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/+$/, "");
const port = Number(process.env.PORT || 4173);
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain",
  ".woff2": "font/woff2", ".ico": "image/x-icon",
};

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (base && !url.pathname.startsWith(`${base}/`)) {
    res.writeHead(302, { Location: `${base}/` }).end();
    return;
  }
  let rel = decodeURIComponent(url.pathname.slice(base.length));
  let file = normalize(join(root, rel));
  if (!file.startsWith(normalize(root))) return res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404, { "Content-Type": types[".html"] });
    return createReadStream(join(root, "404.html")).pipe(res);
  }
  res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Serving out/ at http://localhost:${port}${base}/`));
