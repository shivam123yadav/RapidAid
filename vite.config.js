import { createReadStream, statSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const projectRoot = dirname(fileURLToPath(import.meta.url));

/**
 * ONNX Runtime Web loads its `.mjs` glue via a dynamic `import()`. Vite
 * refuses to run `public/` files through its module pipeline ("It can only
 * be referenced via HTML tags"), which breaks the wasm backend in dev.
 * Serve `/ort/*` as raw static bytes with the correct MIME type before the
 * transform middleware (and in preview). Built `dist/` output is plain
 * static, so production hosting needs no special handling.
 */
function serveOrtAssets() {
  const handler = (baseDir) => (req, res, next) => {
    const url = (req.url ?? "").split("?")[0];
    if (!url.startsWith("/ort/")) return next();
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let decoded;
    try {
      decoded = decodeURIComponent(url.slice(1));
    } catch {
      return next();
    }
    const ortRoot = normalize(join(baseDir, "ort"));
    const filePath = normalize(join(baseDir, decoded));
    if (filePath !== ortRoot && !filePath.startsWith(ortRoot + sep)) return next();
    let stats;
    try {
      stats = statSync(filePath);
    } catch {
      return next();
    }
    if (!stats.isFile()) return next();

    const type = filePath.endsWith(".wasm")
      ? "application/wasm"
      : filePath.endsWith(".mjs") || filePath.endsWith(".js")
        ? "text/javascript"
        : "application/octet-stream";
    const etag = `W/"${stats.mtimeMs}-${stats.size}"`;
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("ETag", etag);
    if (req.headers["if-none-match"] === etag) {
      res.statusCode = 304;
      res.end();
      return;
    }
    res.setHeader("Content-Length", stats.size);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  };

  return {
    name: "serve-ort-assets",
    configureServer(server) {
      server.middlewares.use(handler(join(projectRoot, "public")));
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler(join(projectRoot, "dist")));
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serveOrtAssets()],
  server: {
    host: "0.0.0.0",
    port: Number(process.env.PORT || process.env.VITE_PORT || 3001),
    strictPort: true,
    hmr: {
      port: Number(process.env.PORT || process.env.VITE_PORT || 3001),
    },
    // Dev proxy: browser talks same-origin to :3000, Vite forwards /api
    // to the Express server on :5000 — cookies and CORS stay simple.
    proxy: {
      "/api": {
        target: "http://localhost:5000",
        changeOrigin: true,
      },
    },
  },
});
