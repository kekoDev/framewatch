import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import sharp from "sharp";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));

/**
 * `/vendor/*` serves the framework builds the Vue fixtures load, straight
 * from node_modules — dev dependencies, so a test never reaches the network.
 */
const VENDOR: Record<string, string> = {
  "/vendor/vue.js": "vue/dist/vue.global.js",
  "/vendor/vue.prod.js": "vue/dist/vue.global.prod.js",
  "/vendor/vue-router.js": "vue-router/dist/vue-router.global.js",
};
const NODE_MODULES = fileURLToPath(new URL("../../node_modules/", import.meta.url));

export interface FixtureServer {
  /** Base URL, e.g. http://127.0.0.1:54321 */
  url: string;
  close(): Promise<void>;
}

/**
 * Serve test/fixtures/*.html over plain HTTP on a random localhost port, plus
 * a handful of `/api/*` endpoints the network-layer fixtures call:
 *
 *   /api/ok        200 with a small JSON body
 *   /api/slow?ms=N 200 after N ms (default 300)
 *   /api/missing   404
 *   /api/pending   never responds — a request that is still in flight when a
 *                  recording ends, which the network layer has to report
 *   /api/login     POST; answers after 120ms with 200 for the password
 *                  `LOGIN_PASSWORD` and 401 for anything else (login.html)
 *   /api/image     a generated PNG of any size (?w=1200&h=630), or the status
 *                  in ?status= — a share image the SEO audit can fetch and
 *                  measure without a binary asset in the repository
 *   /api/status    answers with ?code=N (default 200) — every status a link
 *                  check has an opinion about, on demand
 *   /api/redirect  302 to ?to=… , via ?hops=N intermediate redirects
 *   /api/loop      302 to itself — a redirect chain with no end
 *   /api/nohead    405 to a HEAD, 200 to a GET — the server that makes a
 *                  HEAD-only link checker report working links as broken
 *   /api/products  a real list of products (?page=N labels them) — the answer
 *                  framewatch_api_mock is standing in front of, so a request
 *                  that reached the real server is visibly different from a
 *                  mocked one
 *
 * `{{BASE}}` in an .html or .txt fixture is replaced with this server's base
 * URL. The port is picked at random per run, so that is the only way a fixture
 * can carry an absolute URL to itself — which is what a canonical link, an
 * og:url and an og:image all have to be.
 *
 * Because /api/pending never answers, every socket is tracked and destroyed on
 * close; `server.close()` alone waits for open connections and would hang.
 */
export async function startFixtureServer(): Promise<FixtureServer> {
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();

  const server: Server = createServer(async (req, res) => {
    const [path, query] = (req.url ?? "/").split("?");
    if (path.startsWith("/api/")) {
      await handleApi(req, path, query ?? "", res, timers);
      return;
    }
    if (VENDOR[path]) {
      try {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(await readFile(join(NODE_MODULES, VENDOR[path])));
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("vendor build not installed");
      }
      return;
    }
    // `/vue-app.html/login` is a history-mode route on vue-app.html: the file
    // is the first segment, the rest belongs to the app's router.
    const file = path === "/" ? "basic.html" : path.replace(/^\//, "").replace(/^([^/]+\.html)\/.*$/, "$1");
    try {
      const type = contentType(file);
      const raw = await readFile(join(FIXTURES_DIR, file));
      const body = type.startsWith("text/") ? Buffer.from(raw.toString("utf8").replaceAll("{{BASE}}", base())) : raw;
      res.writeHead(200, { "content-type": type });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server failed to bind");
  const base = (): string => `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  return {
    url: base(),
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        server.close((err) => (err ? reject(err) : resolve()));
        for (const socket of sockets) socket.destroy();
        sockets.clear();
      }),
  };
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function contentType(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** The one password `/api/login` accepts; login.html is driven with it in tests. */
export const LOGIN_PASSWORD = "password123";

async function handleApi(
  req: IncomingMessage,
  path: string,
  query: string,
  res: ServerResponse<IncomingMessage>,
  timers: Set<NodeJS.Timeout>,
): Promise<void> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  switch (path) {
    case "/api/ok":
      json(200, { ok: true });
      return;
    case "/api/slow": {
      const ms = Number(new URLSearchParams(query).get("ms") ?? 300);
      const timer = setTimeout(() => {
        timers.delete(timer);
        json(200, { ok: true, waited: ms });
      }, Number.isFinite(ms) ? Math.max(0, ms) : 300);
      timers.add(timer);
      return;
    }
    case "/api/missing":
      json(404, { error: "not found" });
      return;
    case "/api/pending":
      // Deliberately never answered.
      return;
    case "/api/image": {
      // A share image, generated rather than committed — this repository keeps
      // no binary assets, and every size the audit has an opinion about needs
      // to be reachable.
      const params = new URLSearchParams(query);
      const status = Number(params.get("status") ?? 200);
      if (Number.isFinite(status) && status >= 400) {
        json(status, { error: "no image here" });
        return;
      }
      const size = (name: string, fallback: number): number => {
        const value = Number(params.get(name) ?? fallback);
        return Number.isFinite(value) ? Math.min(2000, Math.max(1, Math.round(value))) : fallback;
      };
      const png = await sharp({
        create: { width: size("w", 1200), height: size("h", 630), channels: 3, background: { r: 32, g: 96, b: 176 } },
      })
        .png()
        .toBuffer();
      res.writeHead(200, { "content-type": "image/png", "content-length": String(png.byteLength) });
      res.end(png);
      return;
    }
    case "/api/products": {
      // Deliberately three items with recognisable names: a test can tell the
      // real answer from a mocked one by what came back, not by counting.
      const page = new URLSearchParams(query).get("page");
      const suffix = page ? ` (page ${page})` : "";
      json(200, [
        { id: 1, name: `Real Widget${suffix}` },
        { id: 2, name: `Real Gadget${suffix}` },
        { id: 3, name: `Real Doohickey${suffix}` },
      ]);
      return;
    }
    case "/api/status": {
      const code = Number(new URLSearchParams(query).get("code") ?? 200);
      const status = Number.isFinite(code) && code >= 100 && code <= 999 ? Math.round(code) : 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ status }));
      return;
    }
    case "/api/redirect": {
      // `hops` counts the redirects still to be made before `to` is reached,
      // so a chain of any length can be asked for in one href.
      const params = new URLSearchParams(query);
      const to = params.get("to") ?? "/basic.html";
      const hops = Number(params.get("hops") ?? 0);
      const remaining = Number.isFinite(hops) ? Math.max(0, Math.min(20, Math.round(hops))) : 0;
      const location =
        remaining > 0
          ? `/api/redirect?to=${encodeURIComponent(to)}&hops=${remaining - 1}`
          : to;
      res.writeHead(Number(params.get("code") ?? 302), { location, "content-type": "text/plain" });
      res.end("redirecting");
      return;
    }
    case "/api/loop":
      res.writeHead(302, { location: "/api/loop", "content-type": "text/plain" });
      res.end("round we go");
      return;
    case "/api/nohead":
      // The reason a link checker cannot trust HEAD: plenty of servers refuse
      // it outright while serving the very same URL to a GET.
      if (req.method === "HEAD") {
        res.writeHead(405, { allow: "GET", "content-type": "text/plain" });
        res.end();
        return;
      }
      json(200, { ok: true, method: req.method });
      return;
    case "/api/login": {
      let password = "";
      try {
        password = (JSON.parse(await readBody(req)) as { password?: string }).password ?? "";
      } catch {
        // Unparseable body — falls through to the 401 below.
      }
      // A deliberate delay: the request has to be in flight long enough for a
      // recording to catch the pending state, and to have a duration worth reporting.
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (password === LOGIN_PASSWORD) json(200, { token: "fixture-token" });
        else json(401, { error: "invalid credentials" });
      }, 120);
      timers.add(timer);
      return;
    }
    default:
      json(404, { error: "unknown endpoint" });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(""));
  });
}
