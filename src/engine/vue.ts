import type { Locator, Page } from "playwright";
import { MAX_COMPONENT_ENTRIES, MAX_COMPONENT_TREE_NODES, MAX_COMPONENT_VALUE_LENGTH } from "../constants.js";
import type { ComponentInfo, ComponentNode, ComponentUnavailable, VueInfo } from "../utils/vue-rules.js";

/**
 * What a Vue app on the page is willing to tell us.
 *
 * Vue 3 leaves two handles behind in the DOM: the app on its container
 * (`__vue_app__`, and `data-v-app` on the same element), and on every element
 * a dev build rendered, the component instance that rendered it
 * (`__vueParentComponent`). From those come the version, the router and its
 * current route, the component name, props and state behind any element, the
 * whole component tree, and a way to navigate through the router instead of
 * the address bar. Production builds keep only the app handle, and say so.
 *
 * Everything in-page below is serialised into Chromium: it may not close over
 * a module value, so every cap is passed in.
 */

export async function detectVue(page: Page): Promise<VueInfo | null> {
  try {
    return await page.evaluate(detectInPage);
  } catch {
    return null;
  }
}

export interface ReadyOptions {
  /** How long to keep looking for a mounted app. */
  detect_ms: number;
  /** Once found, how long to give the router to be ready. */
  ready_ms: number;
}

export interface ReadyResult {
  vue: VueInfo | null;
  /** Wall time spent, whichever way it ended. */
  waited_ms: number;
}

/**
 * Wait for a Vue app to be mounted and its router (if any) to have resolved
 * its first navigation, then two frames so the first render is painted.
 * Returns as soon as that is true; a page with no Vue is given `detect_ms`
 * and then handed back untouched — no slower than the sleep it replaces.
 */
export async function waitForVueReady(page: Page, options: ReadyOptions): Promise<ReadyResult> {
  const started = Date.now();
  const deadline = started + Math.max(0, options.detect_ms);
  let vue: VueInfo | null = null;
  for (;;) {
    vue = await detectVue(page);
    if (vue !== null || Date.now() >= deadline) break;
    await page.waitForTimeout(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  if (vue !== null) {
    await page.evaluate(readyInPage, { timeout_ms: options.ready_ms }).catch(() => undefined);
    vue = (await detectVue(page)) ?? vue;
  }
  return { vue, waited_ms: Date.now() - started };
}

/** The component that rendered the element `locator` points at, or why there is none. */
export async function componentOf(locator: Locator): Promise<ComponentInfo | ComponentUnavailable | null> {
  try {
    return await locator.evaluate(componentInPage, { max_value: MAX_COMPONENT_VALUE_LENGTH, max_entries: MAX_COMPONENT_ENTRIES });
  } catch {
    return null;
  }
}

export interface ComponentTree {
  root: ComponentNode;
  total: number;
}

export async function componentTree(page: Page): Promise<ComponentTree | null> {
  try {
    return await page.evaluate(treeInPage, {
      max_nodes: MAX_COMPONENT_TREE_NODES,
      builtins: ["RouterView", "RouterLink", "Transition", "TransitionGroup", "KeepAlive", "BaseTransition", "Teleport", "Suspense"],
    });
  } catch {
    return null;
  }
}

export type RouterOutcome = { ok: true; route: { path: string; name?: string } } | { ok: false; error: string };

/** `router.push(path)`, awaited, on the app's own router. */
export async function routerNavigate(page: Page, path: string): Promise<RouterOutcome> {
  try {
    return await page.evaluate(routerPushInPage, { path });
  } catch (error) {
    return { ok: false, error: (error instanceof Error ? error.message : String(error)).split("\n")[0] };
  }
}

/* ── In-page ──────────────────────────────────────────────────────────────
 * Each function below is serialised whole into Chromium, so each carries its
 * own copy of `findApp`: a shared module-level helper would be a
 * ReferenceError in the page.
 */

function detectInPage(): VueInfo | null {
  const doc = (globalThis as any).document;
  if (!doc) return null;
  const findApp = (): { app: any; root: any } | null => {
    const doc = (globalThis as any).document;
    if (!doc) return null;
    const marked = doc.querySelector("[data-v-app]");
    if (marked && marked.__vue_app__) return { app: marked.__vue_app__, root: marked };
    const all = doc.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) {
      if (all[i].__vue_app__) return { app: all[i].__vue_app__, root: all[i] };
    }
    return null;
  };

  const found = findApp();
  if (found) {
    const { app, root } = found;
    // A dev build keeps the root instance on the app; a production build does
    // not, but both stamp `data-v-app` on the container at mount.
    const instance = app._instance;
    const mounted = instance ? instance.isMounted === true : root.hasAttribute("data-v-app");
    if (!mounted) return null;
    const props = app.config && app.config.globalProperties;
    const router = props && props.$router;
    let route: { path: string; name?: string } | undefined;
    if (router && router.currentRoute && router.currentRoute.value) {
      const current = router.currentRoute.value;
      route = { path: String(current.fullPath) };
      if (current.name !== undefined && current.name !== null) route.name = String(current.name);
    }
    // A dev build stamps every rendered element with its component; a
    // production build stamps none. Look at what the app rendered.
    let production = true;
    const rendered = root.querySelectorAll("*");
    for (let i = 0; i < rendered.length && i < 50; i++) {
      if ("__vueParentComponent" in rendered[i]) {
        production = false;
        break;
      }
    }
    if (rendered.length === 0) production = !("__vueParentComponent" in root);
    const version = String(app.version || "3");
    const out: VueInfo = { version, major: Number(version.split(".")[0]) || 3, router: !!router, production };
    if (route) out.route = route;
    return out;
  }

  // Vue 2 leaves `__vue__` on component root elements.
  const all = doc.querySelectorAll("*");
  for (let i = 0; i < all.length; i++) {
    const vm = all[i].__vue__;
    if (!vm || !vm.$root) continue;
    const ctor = vm.$root.constructor;
    const version = String((ctor && ctor.version) || ((globalThis as any).Vue && (globalThis as any).Vue.version) || "2");
    const router = vm.$root.$router;
    const out: VueInfo = { version, major: 2, router: !!router, production: false };
    if (router && vm.$root.$route) {
      out.route = { path: String(vm.$root.$route.fullPath) };
      if (vm.$root.$route.name) out.route.name = String(vm.$root.$route.name);
    }
    return out;
  }
  return null;
}

async function readyInPage(config: { timeout_ms: number }): Promise<boolean> {
  const findApp = (): { app: any; root: any } | null => {
    const doc = (globalThis as any).document;
    if (!doc) return null;
    const marked = doc.querySelector("[data-v-app]");
    if (marked && marked.__vue_app__) return { app: marked.__vue_app__, root: marked };
    const all = doc.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) {
      if (all[i].__vue_app__) return { app: all[i].__vue_app__, root: all[i] };
    }
    return null;
  };
  const found = findApp();
  if (!found) return false;
  const props = found.app.config && found.app.config.globalProperties;
  const router = props && props.$router;
  let ready = true;
  if (router && typeof router.isReady === "function") {
    ready = await Promise.race<boolean>([
      router.isReady().then(() => true, () => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), config.timeout_ms)),
    ]);
  }
  const raf = (globalThis as any).requestAnimationFrame;
  if (typeof raf === "function") {
    await new Promise<void>((resolve) => raf(() => raf(() => resolve())));
  }
  return ready;
}

function componentInPage(element: any, config: { max_value: number; max_entries: number }): ComponentInfo | ComponentUnavailable | null {
  const findApp = (): { app: any; root: any } | null => {
    const doc = (globalThis as any).document;
    if (!doc) return null;
    const marked = doc.querySelector("[data-v-app]");
    if (marked && marked.__vue_app__) return { app: marked.__vue_app__, root: marked };
    const all = doc.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) {
      if (all[i].__vue_app__) return { app: all[i].__vue_app__, root: all[i] };
    }
    return null;
  };
  const serialise = (value: any): string => {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    const type = typeof value;
    if (type === "string") {
      const quoted = JSON.stringify(value);
      return quoted.length > config.max_value + 2 ? JSON.stringify(value.slice(0, config.max_value)) + "…" : quoted;
    }
    if (type === "number" || type === "boolean" || type === "bigint") return String(value);
    if (type === "function") return "fn";
    if (type === "symbol") return "symbol";
    if (Array.isArray(value)) return "[" + value.length + "]";
    if (value instanceof Date) return value.toISOString();
    if (value && typeof value === "object" && "__v_isRef" in value) return serialise(value.value);
    try {
      const keys = Object.keys(value);
      const shown = keys.slice(0, 4).join(", ");
      return "{" + shown + (keys.length > 4 ? ", …" : "") + "}";
    } catch {
      return "{…}";
    }
  };
  const entries = (source: any, skip?: (key: string) => boolean): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!source || typeof source !== "object") return out;
    let keys: string[] = [];
    try {
      keys = Object.keys(source);
    } catch {
      return out;
    }
    let count = 0;
    for (const key of keys) {
      if (skip && skip(key)) continue;
      if (count >= config.max_entries) {
        out["…"] = "+" + (keys.length - count) + " more";
        break;
      }
      let value: any;
      try {
        value = source[key];
      } catch {
        value = undefined;
      }
      out[key] = serialise(value);
      count++;
    }
    return out;
  };
  const nameOf = (instance: any): string => {
    const type = instance && instance.type;
    if (!type) return "Anonymous";
    if (type.name) return String(type.name);
    if (type.__name) return String(type.__name);
    if (type.__file) return String(type.__file).split("/").pop()!.replace(/\.vue$/, "");
    return instance.parent === null ? "App" : "Anonymous";
  };

  // Vue 3 dev build: the nearest element that knows its component.
  let node: any = element;
  while (node && node.nodeType === 1) {
    if ("__vueParentComponent" in node && node.__vueParentComponent) {
      const instance = node.__vueParentComponent;
      const path: string[] = [];
      let parent = instance.parent;
      while (parent) {
        path.push(nameOf(parent));
        parent = parent.parent;
      }
      return {
        name: nameOf(instance),
        props: entries(instance.props),
        state: {
          ...entries(instance.setupState, (key) => key.startsWith("_") || key.startsWith("$")),
          ...entries(instance.data, (key) => key.startsWith("_") || key.startsWith("$")),
        },
        path,
      };
    }
    node = node.parentElement;
  }

  // No component data. Say which kind of nothing this is.
  node = element;
  while (node && node.nodeType === 1) {
    if (node.__vue__) return { unavailable: "Vue 2 — component details need Vue 3" };
    if (node.__vue_app__) return { unavailable: "production build — no component data on elements" };
    node = node.parentElement;
  }
  const found = findApp();
  if (found && found.root.contains(element)) return { unavailable: "production build — no component data on elements" };
  return null;
}

function treeInPage(config: { max_nodes: number; builtins: string[] }): { root: ComponentNode; total: number } | null {
  const findApp = (): { app: any; root: any } | null => {
    const doc = (globalThis as any).document;
    if (!doc) return null;
    const marked = doc.querySelector("[data-v-app]");
    if (marked && marked.__vue_app__) return { app: marked.__vue_app__, root: marked };
    const all = doc.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) {
      if (all[i].__vue_app__) return { app: all[i].__vue_app__, root: all[i] };
    }
    return null;
  };
  const found = findApp();
  if (!found || !found.app._instance) return null;
  const builtins = new Set(config.builtins);
  let total = 0;
  const nameOf = (instance: any): string => {
    const type = instance.type || {};
    if (type.name) return String(type.name);
    if (type.__name) return String(type.__name);
    if (type.__file) return String(type.__file).split("/").pop()!.replace(/\.vue$/, "");
    return instance.parent === null ? "App" : "Anonymous";
  };
  const visit = (vnode: any, into: ComponentNode[]): void => {
    if (!vnode || total >= config.max_nodes) return;
    if (vnode.component) {
      const instance = vnode.component;
      const name = nameOf(instance);
      if (builtins.has(name)) {
        visit(instance.subTree, into);
        return;
      }
      const node: ComponentNode = { name, children: [] };
      total++;
      into.push(node);
      visit(instance.subTree, node.children);
      return;
    }
    if (vnode.suspense) {
      visit(vnode.suspense.activeBranch, into);
      return;
    }
    if (Array.isArray(vnode.children)) {
      for (const child of vnode.children) visit(child, into);
    }
  };
  const rootInstance = found.app._instance;
  const root: ComponentNode = { name: nameOf(rootInstance), children: [] };
  total = 1;
  visit(rootInstance.subTree, root.children);
  return { root, total };
}

async function routerPushInPage(config: { path: string }): Promise<RouterOutcome> {
  const findApp = (): { app: any; root: any } | null => {
    const doc = (globalThis as any).document;
    if (!doc) return null;
    const marked = doc.querySelector("[data-v-app]");
    if (marked && marked.__vue_app__) return { app: marked.__vue_app__, root: marked };
    const all = doc.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) {
      if (all[i].__vue_app__) return { app: all[i].__vue_app__, root: all[i] };
    }
    return null;
  };
  const found = findApp();
  if (!found) return { ok: false, error: "no Vue app on this page" };
  const props = found.app.config && found.app.config.globalProperties;
  const router = props && props.$router;
  if (!router || typeof router.push !== "function") return { ok: false, error: "no vue-router on this app" };
  try {
    if (typeof router.resolve === "function") {
      const resolved = router.resolve(config.path);
      if (!resolved || !resolved.matched || resolved.matched.length === 0) {
        return { ok: false, error: "no route matched " + config.path };
      }
    }
    const failure = await router.push(config.path);
    if (failure) {
      return { ok: false, error: "navigation " + (failure.type === 8 ? "cancelled" : failure.type === 16 ? "duplicated" : "aborted") + (failure.message ? ": " + failure.message : "") };
    }
    const raf = (globalThis as any).requestAnimationFrame;
    if (typeof raf === "function") await new Promise<void>((resolve) => raf(() => raf(() => resolve())));
    const current = router.currentRoute && router.currentRoute.value;
    const route: { path: string; name?: string } = { path: current ? String(current.fullPath) : config.path };
    if (current && current.name !== undefined && current.name !== null) route.name = String(current.name);
    return { ok: true, route };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
