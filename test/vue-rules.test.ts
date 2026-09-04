import { describe, expect, it } from "vitest";
import {
  classifyNavigate,
  describeVue,
  formatComponentLine,
  formatComponentTree,
  parseViteLine,
  type ComponentInfo,
  type ComponentNode,
  type VueInfo,
} from "../src/utils/vue-rules.js";

/**
 * Everything the Vue support decides and says, without a browser: what a
 * Vite console line means, whether a `navigate` goes through the router or
 * the address bar, and the wording of every component line.
 */

describe("parseViteLine", () => {
  it("reads a hot update, a css hot update, a full reload and the connection line", () => {
    expect(parseViteLine("[vite] hot updated: /src/App.vue")).toEqual({ kind: "update", path: "/src/App.vue" });
    expect(parseViteLine("[vite] css hot updated: /src/a.css?t=1")).toEqual({ kind: "css", path: "/src/a.css?t=1" });
    expect(parseViteLine("[vite] page reload src/main.js")).toEqual({ kind: "reload", path: "src/main.js" });
    expect(parseViteLine("[vite] connected.")).toEqual({ kind: "connected" });
  });

  it("ignores everything else, including other vite chatter", () => {
    expect(parseViteLine("[vite] connecting...")).toBeNull();
    expect(parseViteLine("hot updated: /x")).toBeNull();
    expect(parseViteLine("")).toBeNull();
  });
});

describe("classifyNavigate", () => {
  const here = "http://localhost:5173/app/login?x=1";

  it("sends a path, and a same-origin URL, through the router", () => {
    expect(classifyNavigate("/settings", here, true)).toEqual({ via: "router", target: "/settings" });
    expect(classifyNavigate("settings?tab=2", here, true)).toEqual({ via: "router", target: "/app/settings?tab=2" });
    expect(classifyNavigate("http://localhost:5173/settings#top", here, true)).toEqual({ via: "router", target: "/settings#top" });
  });

  it("loads another origin, and anything at all when there is no router", () => {
    expect(classifyNavigate("https://example.com/", here, true)).toEqual({ via: "load", target: "https://example.com/" });
    expect(classifyNavigate("/settings", here, false)).toEqual({ via: "load", target: "http://localhost:5173/settings" });
  });
});

const vue = (over: Partial<VueInfo> = {}): VueInfo => ({
  version: "3.5.42",
  major: 3,
  router: true,
  route: { path: "/login", name: "login" },
  production: false,
  ...over,
});

describe("describeVue", () => {
  it("names the version and the current route", () => {
    expect(describeVue(vue())).toBe("Vue 3.5.42 — route /login (login)");
  });

  it("leaves the route out without a router, and notes a production build", () => {
    expect(describeVue(vue({ router: false, route: undefined }))).toBe("Vue 3.5.42 — no router");
    expect(describeVue(vue({ production: true, route: { path: "/" } }))).toBe("Vue 3.5.42 (production build) — route /");
  });
});

const component = (over: Partial<ComponentInfo> = {}): ComponentInfo => ({
  name: "LoginForm",
  props: { title: '"Welcome back"', max: "3" },
  state: { email: '""', loading: "false", items: "[3]", submit: "fn" },
  path: ["RouterView", "App"],
  ...over,
});

describe("formatComponentLine", () => {
  it("prints the name, props, state and the path up to the root", () => {
    expect(formatComponentLine(component())).toBe(
      'component: LoginForm (props: title="Welcome back", max=3; state: email="", loading=false, items=[3], submit=fn) in RouterView > App',
    );
  });

  it("drops empty sections", () => {
    expect(formatComponentLine(component({ props: {}, state: {}, path: [] }))).toBe("component: LoginForm");
    expect(formatComponentLine(component({ state: {} }))).toBe(
      'component: LoginForm (props: title="Welcome back", max=3) in RouterView > App',
    );
  });

  it("says why there is nothing when there is nothing", () => {
    expect(formatComponentLine({ unavailable: "production build — no component data on elements" })).toBe(
      "component: production build — no component data on elements",
    );
  });
});

describe("formatComponentTree", () => {
  const tree: ComponentNode = {
    name: "App",
    children: [
      {
        name: "LoginForm",
        children: [
          { name: "BaseInput", children: [] },
          { name: "BaseInput", children: [] },
          { name: "BaseButton", children: [] },
        ],
      },
    ],
  };

  it("indents by depth and collapses identical leaf siblings", () => {
    expect(formatComponentTree(tree, 5)).toEqual([
      "Components (5):",
      "  App",
      "    LoginForm",
      "      BaseInput ×2",
      "      BaseButton",
    ]);
  });
});
