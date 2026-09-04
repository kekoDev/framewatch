#!/usr/bin/env node
/**
 * A stand-in dev server for the framewatch_start_server tests.
 *
 * It exists to be started, watched and killed, so every part of that is
 * controllable from the command line:
 *
 *   node fake-dev-server.mjs --port 3000 [options]
 *
 *   --ready-ms N      wait N ms before printing the "ready" line (default 0)
 *   --listen-ms N     wait N ms before actually opening the port (default 0)
 *   --never-listen    print everything, never open the port
 *   --exit N          print and exit with code N instead of listening
 *   --stderr          print the ready line on stderr (as Vite and Next do)
 *   --ignore-sigterm  refuse to stop politely, so it has to be killed
 *   --quiet           print nothing at all
 */
import { createServer } from "node:http";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 || at + 1 >= args.length ? fallback : Number(args[at + 1]);
};

const port = value("--port", 0);
const readyMs = value("--ready-ms", 0);
const listenMs = value("--listen-ms", 0);
const exitCode = args.includes("--exit") ? value("--exit", 0) : null;
const out = flag("--stderr") ? process.stderr : process.stdout;

const say = (line) => {
  if (!flag("--quiet")) out.write(`${line}\n`);
};

say("fake-dev-server starting up");

if (flag("--ignore-sigterm")) {
  process.on("SIGTERM", () => say("ignoring SIGTERM"));
  process.on("SIGINT", () => say("ignoring SIGINT"));
}

if (exitCode !== null) {
  say("something went wrong: cannot find module 'nope'");
  process.exit(exitCode);
}

setTimeout(() => say(`  ready in 42 ms — Local: http://localhost:${port}/`), Math.max(0, readyMs));

if (!flag("--never-listen")) {
  setTimeout(() => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>fake dev server</title><h1>up</h1>");
    });
    server.listen(port, "127.0.0.1", () => say(`listening on ${port}`));
  }, Math.max(0, listenMs));
} else {
  // Nothing to keep the loop alive otherwise.
  setInterval(() => {}, 1 << 30);
}
