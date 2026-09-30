import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Content security policy for the single page app. Scripts, styles and connections are same origin only, there
 * are no inline scripts or styles, no framing and no form posts elsewhere. The API keeps its own stricter
 * default (`default-src 'none'`); this policy applies only to the files served from the web root.
 */
export const SPA_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Serve the built web UI from `webRoot` with a single page app fallback. Returns a handler for the not-found
 * path: it answers GET and HEAD requests outside `/api` and reports whether it did. A request for a missing
 * file with an extension is left to the JSON 404 (a missing script must never come back as HTML), and the
 * real path of every file must stay inside the web root (no traversal, no symlink escape).
 */
export function createStaticHandler(webRoot: string): (req: FastifyRequest, reply: FastifyReply) => Promise<boolean> {
  const root = resolve(webRoot);

  const readInside = async (candidate: string): Promise<{ body: Buffer; ext: string } | null> => {
    try {
      // Compare real paths on both sides: the root itself may sit behind a symlink (for example a temp directory).
      const realRoot = await realpath(root);
      const real = await realpath(candidate);
      if (real !== realRoot && !real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) return null;
      if (!(await stat(real)).isFile()) return null;
      return { body: await readFile(real), ext: extname(real).toLowerCase() };
    } catch {
      return null;
    }
  };

  return async (req, reply) => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const rawPath = req.url.split("?")[0] as string;
    if (rawPath === "/api" || rawPath.startsWith("/api/")) return false;
    let path: string;
    try {
      path = decodeURIComponent(rawPath);
    } catch {
      return false;
    }
    if (path.includes("\0")) return false;
    const relative = path.replace(/^\/+/, "");
    let file = relative === "" ? null : await readInside(join(root, relative));
    if (!file) {
      // Only extension-less paths are application routes. A missing asset is a 404, never index.html.
      if (extname(relative) !== "") return false;
      file = await readInside(join(root, "index.html"));
      if (!file) return false;
    }
    const type = CONTENT_TYPES[file.ext] ?? "application/octet-stream";
    reply.header("content-security-policy", SPA_CSP).type(type);
    await reply.send(req.method === "HEAD" ? undefined : file.body);
    return true;
  };
}
