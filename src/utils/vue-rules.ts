/**
 * What the Vue support decides and says.
 *
 * Pure: what a Vite console line means, whether a `navigate` value goes
 * through vue-router or the address bar, and the wording of every line about
 * a Vue app or one of its components. The measurements come from
 * `engine/vue.ts`; nothing here touches a browser.
 */

/** One line Vite's client wrote to the console, decoded. */
export type ViteEvent =
  | { kind: "update"; path: string }
  | { kind: "css"; path: string }
  | { kind: "reload"; path: string }
  | { kind: "connected" };

/**
 * Vite's client logs exactly these (unchanged since Vite 2):
 *   `[vite] hot updated: /src/App.vue`
 *   `[vite] css hot updated: /src/a.css?t=…`
 *   `[vite] page reload src/main.js`
 *   `[vite] connected.`
 */
export function parseViteLine(text: string): ViteEvent | null {
  const line = text.trim();
  let m = /^\[vite\] css hot updated: (.+)$/.exec(line);
  if (m) return { kind: "css", path: m[1].trim() };
  m = /^\[vite\] hot updated: (.+)$/.exec(line);
  if (m) return { kind: "update", path: m[1].trim() };
  m = /^\[vite\] page reload(?: (.+))?$/.exec(line);
  if (m) return { kind: "reload", path: (m[1] ?? "").trim() };
  if (line === "[vite] connected.") return { kind: "connected" };
  return null;
}

export interface NavigatePlan {
  /** `router` for vue-router's `push`; `load` for a full navigation. */
  via: "router" | "load";
  /** The router path (with query and hash) or the absolute URL to load. */
  target: string;
}

/**
 * A path, or a URL on the page's own origin, goes through the router when
 * there is one — that keeps the app's state and skips the reload, which is
 * what a person clicking a link in the app gets. Anything else is a full load.
 */
export function classifyNavigate(value: string, currentUrl: string, hasRouter: boolean): NavigatePlan {
  let resolved: URL;
  try {
    resolved = new URL(value, currentUrl);
  } catch {
    return { via: "load", target: value };
  }
  if (!hasRouter) return { via: "load", target: resolved.href };
  let origin: string;
  try {
    origin = new URL(currentUrl).origin;
  } catch {
    return { via: "load", target: resolved.href };
  }
  if (resolved.origin !== origin) return { via: "load", target: resolved.href };
  return { via: "router", target: `${resolved.pathname}${resolved.search}${resolved.hash}` };
}

/** The app on the page, as detected. */
export interface VueInfo {
  version: string;
  major: number;
  router: boolean;
  route?: { path: string; name?: string };
  /** A production build: no component data on elements. */
  production: boolean;
}

export function describeVue(info: VueInfo): string {
  const head = `Vue ${info.version}${info.production ? " (production build)" : ""}`;
  if (!info.router || !info.route) return `${head} — no router`;
  const name = info.route.name ? ` (${info.route.name})` : "";
  return `${head} — route ${info.route.path}${name}`;
}

/** One component, as read off an element. Values are already serialised. */
export interface ComponentInfo {
  name: string;
  props: Record<string, string>;
  state: Record<string, string>;
  /** Ancestors, nearest first, up to the root. */
  path: string[];
}

export interface ComponentUnavailable {
  unavailable: string;
}

export function formatComponentLine(info: ComponentInfo | ComponentUnavailable): string {
  if ("unavailable" in info) return `component: ${info.unavailable}`;
  const sections: string[] = [];
  const props = entries(info.props);
  if (props) sections.push(`props: ${props}`);
  const state = entries(info.state);
  if (state) sections.push(`state: ${state}`);
  let line = `component: ${info.name}`;
  if (sections.length > 0) line += ` (${sections.join("; ")})`;
  if (info.path.length > 0) line += ` in ${info.path.join(" > ")}`;
  return line;
}

function entries(record: Record<string, string>): string | null {
  const parts = Object.entries(record).map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

export interface ComponentNode {
  name: string;
  children: ComponentNode[];
}

/** The tree, indented by depth, identical leaf siblings collapsed with a count. */
export function formatComponentTree(root: ComponentNode, total: number): string[] {
  const lines = [`Components (${total}):`];
  const walk = (node: ComponentNode, depth: number): void => {
    const indent = "  ".repeat(depth + 1);
    lines.push(`${indent}${node.name}`);
    const children = node.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.children.length === 0) {
        let run = 1;
        while (i + run < children.length && children[i + run].name === child.name && children[i + run].children.length === 0) run++;
        lines.push(`${indent}  ${child.name}${run > 1 ? ` ×${run}` : ""}`);
        i += run - 1;
        continue;
      }
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return lines;
}
