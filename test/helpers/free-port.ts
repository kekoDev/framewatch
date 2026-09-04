import { createServer } from "node:net";

/**
 * A port nothing is listening on right now.
 *
 * Binding port 0 and letting the OS choose is the only reliable way to find
 * one; it is released again before this returns, so there is a small window in
 * which something else could take it. Nothing in this suite races for ports,
 * and the alternative — a fixed port — collides with whatever the developer
 * already has running.
 */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}
