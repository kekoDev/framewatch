# FrameWatch MCP Server

> Give your AI coding agent eyes. FrameWatch opens your web app in a real browser and shows Claude Code what it looks like, what changed, and why.

You ask Claude Code to fix the login page. It edits the code and says "done". Was it? Without FrameWatch, neither of you knows until you open the browser yourself. With it, Claude Code opens the page, sees the result, reads the console, checks the spacing and the colours, clicks the button, and fixes what it got wrong — before it tells you it is done.

FrameWatch is an [MCP](https://modelcontextprotocol.io) server. Once registered, Claude Code gets 18 tools it calls on its own: screenshots, recordings that keep only the frames where something changed, a way to name and click every element on a page, measurements of how each element is built, form and link and accessibility checks, and a Vue-aware wait that returns the moment your dev server has hot-reloaded your edit.

## Quick start

**1. Register it with Claude Code** (one command, no install step):

```bash
claude mcp add framewatch npx framewatch-mcp-server
```

**2. Let it see full results.** Claude Code caps a tool result at 25,000 tokens and counts images toward it, which holds about two screenshots of a real page. Raise it once, in the shell you start Claude Code from:

```bash
export MAX_MCP_OUTPUT_TOKENS=100000
```

Add that line to your `~/.zshrc` or `~/.bashrc` to make it permanent.

**3. Start your app and ask.** Run your dev server as usual, open Claude Code in the project, and talk to it normally:

> Open http://localhost:5173 and tell me what you see.

> The header looks wrong on mobile. Check it at phone width and fix it.

> Test the login flow with test@example.com / password123 and show me what happens.

> I just changed the button styles — show me the page after the hot reload and check the contrast.

Claude Code picks the tools itself. You never call them by name, though you can: "use framewatch_dead_clicks on the settings page" works too.

**4. Sign in once, if your app has a login.** Ask Claude Code to log in and save the session:

> Log in at http://localhost:5173/login with my test account and save the session.

It runs `framewatch_save_auth`, which writes `.framewatch/auth.json`. From then on every tool opens pages already signed in, and says so.

That is the whole setup. The first tool call downloads Chromium if Playwright has not already; if that fails, run `npx playwright install chromium` once.

### Other MCP clients

Any client that speaks MCP over stdio can run FrameWatch. For Cursor, Windsurf, Claude Desktop or Zed, add this to the client's MCP configuration:

```json
{
  "mcpServers": {
    "framewatch": {
      "command": "npx",
      "args": ["-y", "framewatch-mcp-server"],
      "env": { "MAX_MCP_OUTPUT_TOKENS": "100000" }
    }
  }
}
```

### From a checkout

```bash
git clone https://github.com/kekoDev/framewatch.git
cd framewatch && npm install && npm run build
claude mcp add framewatch node "$PWD/dist/index.js"
```

### Requirements

- **Node 20.9 or newer.**
- **Chromium**, fetched by Playwright on install. If a tool ever reports the browser is missing, it prints the one command that fixes it.
- Nothing listens on a port and nothing phones home: FrameWatch only ever talks to the URLs it is given.

## What Claude Code can do with it

| Tool | Use it for |
| --- | --- |
| [`framewatch_screenshot`](#framewatch_screenshot) | What does this page look like right now? |
| [`framewatch_capture`](#framewatch_capture) | What happens over the next few seconds — animations, loading, a replayed user flow? |
| [`framewatch_interact`](#framewatch_interact) | Click this, then let me look; then click the next thing. |
| [`framewatch_snapshot`](#framewatch_snapshot) | What is on this page, and what do I call each thing? Refs to act on, instead of guessed selectors. |
| [`framewatch_inspect`](#framewatch_inspect) | Is this element built the way I meant — box, font, colours and contrast, spacing, alignment? |
| [`framewatch_wait_for`](#framewatch_wait_for) | I just saved a file — show me the page the moment Vite has patched it. |
| [`framewatch_responsive`](#framewatch_responsive) | Does it hold up at phone, tablet and desktop widths? |
| [`framewatch_accessibility`](#framewatch_accessibility) | What would an accessibility auditor flag? |
| [`framewatch_compare`](#framewatch_compare) | What changed between before and after? |
| [`framewatch_form_test`](#framewatch_form_test) | What does this form do with empty, huge, Arabic or hostile input? |
| [`framewatch_seo`](#framewatch_seo) | What do a search engine and a link preview make of this page? |
| [`framewatch_dead_clicks`](#framewatch_dead_clicks) | Which of these buttons and links do nothing when clicked? |
| [`framewatch_links`](#framewatch_links) | Where does every link on this page actually go — and which ones are broken? |
| [`framewatch_api_mock`](#framewatch_api_mock) | What does this page do with an empty list, a 500, or an API that takes five seconds? |
| [`framewatch_rtl`](#framewatch_rtl) | Does this page survive being flipped for Arabic, Hebrew or Persian? |
| [`framewatch_save_auth`](#framewatch_save_auth) | Sign in once, so every other tool starts past the login. |
| [`framewatch_start_server`](#framewatch_start_server--framewatch_stop_server) / [`framewatch_stop_server`](#framewatch_start_server--framewatch_stop_server) | Get the dev server up so there is something to point at. |

Why not just screenshots? Volume. A five-second recording at 10fps is fifty near-identical images, and fifty images is a flooded context window. FrameWatch records everything and returns almost none of it: only the frames where something meaningful changed, each cropped to the region that changed, each carrying the console output, network requests and DOM changes from the same moment — the context that explains why.

## Why `MAX_MCP_OUTPUT_TOKENS` matters

Claude Code caps one MCP tool result at 25,000 tokens by default and counts base64 image data toward it. A result over the cap is written to a file and replaced with a reference, so the model sees **no images at all**. A single screenshot of a real page is 180 KB of PNG, which is over on its own.

FrameWatch never lets a result cross that line. Every image goes out in the cheapest faithful encoding (palette PNG for flat UI, JPEG for anything photo-like), and a result that still would not fit is degraded in a fixed order — change-region crops first, then frames shrunk to 640px and 480px, then frames from the middle while the first, the last and every interaction frame stay — and a final line says exactly what was cut:

```
Image budget: 4 of 9 images kept — 5 crops dropped, frames at 640px — to fit MAX_MCP_OUTPUT_TOKENS=25000 (~52 KB of images per result). Set MAX_MCP_OUTPUT_TOKENS=100000 in the shell that starts Claude Code for full results.
```

The default cap holds one or two frames of a real page, which is why step 2 of the quick start raises it. The server reads the same variable and sizes its budget to it.

## Tools

### `framewatch_screenshot`

Take a single screenshot of a page (or of one element on it). Returns a PNG image content block (resized to max 800px wide) plus a one-line text summary.

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | string (URL) | — | Page to screenshot, e.g. `http://localhost:3000` |
| `wait_ms` | integer | `1000` | Wait after page load before capturing |
| `viewport` | `{ width, height }` | `1280×720` | Viewport size |
| `selector` | string | — | CSS selector: screenshot only this element |
| `wait_for` | string | — | CSS selector to wait for (visible) before capturing |
| `wait_for_timeout_ms` | integer ≥ 1 | `10000` | Max wait for `wait_for` / `selector` |
| `storage_state` | string (path) | — | Auth state file from [`framewatch_save_auth`](#framewatch_save_auth) — open the page already signed in |

**Example call** — the whole page, then one element of it:

```json
{ "url": "http://localhost:3000/pricing", "wait_ms": 1500 }
```
```json
{ "url": "http://localhost:3000/pricing", "selector": ".plan-card--pro", "wait_for": ".plan-card--pro" }
```

Failures (unreachable URL, selector never appears, invalid input) come back as MCP error results with a readable message rather than crashing the server. Error pages still produce a screenshot, with the HTTP status noted in the summary.

### `framewatch_capture`

Record a page for a few seconds and return only the frames where something meaningful changed. Each kept frame is a *diff card*: the full frame as a PNG (max 800px wide), a metadata line, and a crop of the changed region with its position. Good for animations, splash/loading screens, transitions, and anything else that changes over time.

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | string (URL) | — | Page to record, e.g. `http://localhost:3000` |
| `duration_ms` | integer 500–30000 | `5000` | How long to record |
| `sensitivity` | number 0–1 | `0.06` | Change threshold per frame: fraction of an 8×8 grid that must change (`0` keeps every frame, `1` keeps none beyond first/last) |
| `max_frames` | integer 1–30 | `20` | Maximum diff cards to return |
| `interval_ms` | integer 16–2000 | `100` | Raw frame capture interval (100 = 10 fps) |
| `viewport` | `{ width, height }` | `1280×720` | Viewport size |
| `wait_for` | string | — | CSS selector to wait for (visible) before recording starts |
| `wait_for_timeout_ms` | integer ≥ 1 | `10000` | Max wait for `wait_for` |
| `interactions` | array (≤ 50) | — | Interaction script to replay while recording (see below) |
| `interaction_timeout_ms` | integer ≥ 1 | `10000` | Max time one step may wait for its target element |
| `include_console` | boolean | `true` | Attach console output and uncaught errors (see [Context layers](#context-layers)) |
| `include_network` | boolean | `false` | Attach network requests |
| `include_dom` | boolean | `false` | Attach a summary of the DOM mutations between frames |
| `include_performance` | boolean | `false` | Attach paint timing, LCP and layout shifts |
| `storage_state` | string (path) | — | Auth state file from [`framewatch_save_auth`](#framewatch_save_auth) — record the app, not its login screen |

**Example call** — record a splash screen, keeping more frames than usual because the interesting parts of an animation are small:

```json
{ "url": "http://localhost:3000", "duration_ms": 5000, "sensitivity": 0.04, "include_console": true }
```

Recording starts as soon as the navigation commits (not after `load`), so loading and splash animations are captured from their first frame.

Returns one summary text block (`Captured 5 meaningful frames from 26 raw frames (2514ms recording) of http://… — "Title"`), then for each card:

1. the full frame as a PNG image block;
2. a text block, e.g. `Frame 2 @ 501ms [animation]` followed by `Changed: 20.0% — region: 80,40 240x160` (percentage of pixels that changed versus the previous card, and the padded bounding box in full-resolution viewport coordinates);
3. a PNG crop of that region — omitted when the change covers nearly the whole frame.

Which raw frames become cards:

- the first frame (`[initial]`) and the last frame are always kept;
- a frame is kept when more than `sensitivity` of the 8×8 grid cells differ from the last kept frame (compared at 320×240 grayscale);
- frames the recorder captured because of an event (e.g. a `[navigation]`) are always kept;
- kept frames closer than 200ms are merged, keeping the later, settled one — a continuous animation is thinned to roughly every 200ms;
- if there are still more than `max_frames`, the first, last and event frames are kept and the rest are sampled evenly by position among the remaining kept frames.

The recorder bounds every screenshot, because Chromium blocks them while a navigation is pending or the main thread is busy. A navigation tags the next frame the loop captures rather than requesting an extra screenshot at commit time — that frame reliably shows the new page, and a `history.replaceState` on every animation frame (the usual scroll-spy or router pattern) cannot flood the recording. Fragment-only URL changes are not treated as navigations, and a crashed or closed page ends the recording early with the frames captured so far.

Failures come back as MCP error results, like `framewatch_screenshot`.

#### Context layers

A frame tells you *that* something changed. The context layers tell you *why*. Each one collects timestamped events while the page records, and each diff card is given the events from its own window — everything after the previous card, up to and including its own timestamp. All four start collecting **before** the navigation, so a script that throws on load, the request that never comes back and first paint all land on the first card instead of being missed.

| Layer | Flag | What lands on a card |
| --- | --- | --- |
| Console | `include_console` (on) | `console.*` calls, uncaught exceptions, unhandled rejections, and the tab crashing |
| Network | `include_network` | One line per request that settled — method, url, status, duration — plus any still in flight when the recording ended |
| DOM | `include_dom` | Grouped mutations: elements added, removed, restyled, and text edited |
| Performance | `include_performance` | First Contentful Paint, Largest Contentful Paint, and layout shifts with their summed score |

```
Frame 3 @ 1204ms [interaction]
Changed: 12.4% — region: 40,220 320x180
Console:
  [error] TypeError: Cannot read properties of null (reading 'id') (at submit (http://localhost:3000/app.js:88:14))
Network:
  POST http://localhost:3000/api/login → 500 (312ms)
  GET http://localhost:3000/api/me → pending (1204ms)
Performance:
  layout shifts 2 (score 0.1875)
DOM:
  + div.error-banner in form#login
  ~ button#submit [disabled]
  ~ #spinner [style] ×18
```

Paint and LCP are reported in milliseconds since that document's navigation start (the same numbers Lighthouse gives), and only on the card where they were measured — a value that never changes is not repeated down the page. Layout shifts are counted whether or not they followed user input, unlike Chrome's CLS: a jump right after a click is often the one being hunted.

Console and network are Playwright events, so they survive a page that has frozen, navigated away or crashed. The DOM and performance layers inject an observer that pushes what it sees back out as it goes, so a navigation mid-recording does not take the old document's records with it. Both skip subframes, and the DOM layer ignores `<head>`, script/link/meta elements and whitespace-only text — none of it says anything about what the page looks like.

Every layer is capped so one page cannot flood the response: console keeps 100 entries and network 100 events, evicting ordinary ones to make room for errors and failures; the DOM keeps 500 mutations and renders at most 12 lines per card. The summary says what was collected and what had to be dropped:

```
Context — console: 12 entries; network: 8 requests (1 still pending); DOM: 340 mutations
DOM log was capped — 51 mutations dropped.
```

#### Replaying an interaction script

Pass `interactions` to drive the page while it records. Each step is `{ action, ... }`, where `delay_ms` is a wait **before** that action, so the delays accumulate over the recording:

```json
{
  "url": "http://localhost:3000/login",
  "duration_ms": 8000,
  "interactions": [
    { "action": "type",  "selector": "#email",    "value": "test@example.com", "delay_ms": 1000 },
    { "action": "type",  "selector": "#password", "value": "password123",      "delay_ms": 500 },
    { "action": "click", "selector": "button[type=submit]",                    "delay_ms": 500 },
    { "action": "wait",                                                        "delay_ms": 3000 }
  ]
}
```

`framewatch_capture` accepts `click`, `tap`, `type`, `key`, `scroll`, `swipe`, `hover`, `select`, `wait` and `navigate` — the same set the executor supports, so nothing has to be worked around. A frame is forced right after every step, so the result of each action is always kept as an `[interaction]` card. The summary gains a line such as:

```
Interactions: 4/4 replayed — type "test@example.com" into "#email", type "password123" into "#password", click "button[type=submit]", wait 3000ms
```

**Pressing keys.** `type` only produces printable text, so a form that is submitted with the keyboard needs a key press. Either write it as its own step, or put it inline in the value — a `\n` in a typed value presses Enter and a `\t` presses Tab, at exactly that point in the text:

```json
{ "action": "type", "selector": "#search", "value": "framewatch" },
{ "action": "key",  "value": "Enter" }
```
```json
{ "action": "type", "selector": "#search", "value": "framewatch\n" }
```

`key` takes any [Playwright key name](https://playwright.dev/docs/api/class-keyboard#keyboard-press) — `Enter`, `Escape`, `Tab`, `Backspace`, `ArrowDown`, `F5` — or a combo such as `Control+a` or `Shift+Tab`. It goes to whatever is focused; give it a `selector` to focus that element first. The first text run of a `type` still replaces the field's contents, so a script stays repeatable however many keys are in it.

Typed values are echoed in that line (elided only when long) and are visible in the frames themselves, so drive these flows with throwaway test credentials — a real password ends up in the tool output and therefore in the model's context.

A step that fails ends the script but **not** the capture — the frames recorded up to that point are the most useful thing FrameWatch can hand back, since they show the state the page was actually in. The failure is reported in the summary and the moment it happened is kept as an `[error]` card:

```
Interactions: 1/3 replayed — click "#btn". Step 2: click "#nope" failed: locator.click: Timeout 10000ms exceeded.
```

Touch is enabled automatically (and only) for scripts containing `tap` or `swipe`, because `hasTouch` puts `ontouchstart` on `window` and would otherwise change what a plain capture records. A `swipe` is dispatched as a real finger drag — `touchstart`, ten `touchmove`s about a frame apart, `touchend` — so velocity-sensitive UI (carousels, pull-to-refresh) behaves as it would under a thumb.

### `framewatch_interact`

Perform **one** interaction and see what it did: before frame, after frame, and a crop of the change. Unlike the other tools this one is stateful on purpose — the page stays open between calls, so you can click, look, type, and look again without replaying the whole flow.

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `action` | enum | — | `click`, `tap`, `type`, `key`, `scroll`, `swipe`, `navigate`, `select`, `hover` |
| `selector` | string | — | CSS selector for the target |
| `ref` | string | — | Element ref from [`framewatch_snapshot`](#framewatch_snapshot), e.g. `e8` — instead of `selector` |
| `value` | string | — | Text to type (`\n` presses Enter, `\t` Tab), key to press, option to select, or URL to navigate to |
| `x`, `y` | number | — | Coordinates for `click`/`tap`/`swipe` when no selector is given |
| `delta_x`, `delta_y` | number | — | Distance for `scroll` / `swipe` |
| `url` | string (URL) | — | Open this page first. Omit to act on the page left open by the previous call. |
| `wait_ms` | integer ≥ 0 | `500` | Settle time after the action, before the "after" screenshot |
| `timeout_ms` | integer ≥ 1 | `10000` | Max wait for the target element |
| `viewport` | `{ width, height }` | — | Resize the page (omit to leave it as it is) |
| `include_console` | boolean | `true` | Report console output and uncaught errors the action caused |
| `include_network` | boolean | `false` | Report network requests the action caused |
| `include_dom` | boolean | `false` | Report the DOM mutations the action caused |
| `include_performance` | boolean | `false` | Report paint timing and layout shifts around the action |
| `include_snapshot` | boolean | `false` | Append a [snapshot](#framewatch_snapshot) of the page after the action, with fresh refs for the next call |
| `storage_state` | string (path) | — | Auth state file from [`framewatch_save_auth`](#framewatch_save_auth), applied when the session page is opened |

On a [Vue app](#vue-apps), `navigate` with a path goes through vue-router — same document, state kept, no reload — and the headline reports the route change by name: `Vue 3.5.42 — route /login (login) → /settings (settings)`. Another origin, or a path the router does not know, is a full load, and the step says so.

**Example call** — a session, one call at a time. Only the first needs a `url`:

```json
{ "url": "http://localhost:3000/settings", "action": "click", "selector": "nav a[href='/settings/billing']" }
```
```json
{ "action": "type", "selector": "#card-number", "value": "4242424242424242" }
```
```json
{ "action": "click", "selector": "button[type=submit]", "wait_ms": 1500, "include_network": true }
```

Returns a summary line (`click "#btn" on http://localhost:3000/ — 8.4% of the frame changed — viewport 1280x720, images 800px wide (0.63×) — coordinates and regions are in viewport px`), the before frame, the after frame with its `Changed: …` metadata, and a crop of the changed region. The viewport line is on every tool that returns frames: the images are shrunk, the numbers are not, and clicking where the image says would land 1.6× off.

Instead of a selector, target an element by the `ref` a [`framewatch_snapshot`](#framewatch_snapshot) gave it — `{ "action": "click", "ref": "e11" }` — and pass `include_snapshot: true` to get the fresh refs back with the result, so a whole flow runs without a selector being guessed once. A ref that no longer resolves (the page re-rendered) says so and says to snapshot again.

The same [context layers](#context-layers) as `framewatch_capture` are available here, split over the two frames: the **before** frame carries how the page got into this state (anything it logged or fetched while loading), and the **after** frame carries what the action itself caused. That is usually the fastest way to answer "why did my click do nothing":

```
click "#submit" on http://localhost:3000/login — 0.4% of the frame changed
Context — console: 1 entry; network: 1 request
After — Frame 2 @ 612ms [interaction]
Changed: 0.4% — region: 300,180 60x24
Console:
  [error] TypeError: Cannot read properties of null (reading 'value')
Network:
  POST http://localhost:3000/api/login → 422 (88ms)
```

Because the page is reused between calls, the layers are installed on it once and **emptied at the start of every call**, so each call reports only what it caused. A layer can be switched on mid-session — it is attached to the document that is already open, no reload needed — but one that was on for an earlier call keeps running silently, since a page cannot un-expose an injected observer.

Calls are serialised — they all drive the same page, so they queue rather than interleave. The first call needs a `url`; later calls can omit it. Cookies, storage, scroll position and in-page state all carry over. Two things cannot change in place, because both are fixed when the browser context is created: touch support, and the saved auth. So the first `tap` or `swipe` on a page opened without touch reopens the page, as does naming a `storage_state` the open session was not created with — the summary says which of the two it was, because either resets page state. Passing the *same* `storage_state` again, or omitting it, leaves the session exactly where it is. The session closes when the MCP server shuts down; `framewatch_capture` and `framewatch_screenshot` are unaffected by it, as they always use a fresh, isolated browser context.

### `framewatch_snapshot`

Read the page as a tree of named elements. An agent that only has a screenshot has to guess a selector for everything it wants to click; this hands it the accessible name and a short ref for every element instead. The tree is Playwright's own AI-mode aria snapshot, and the refs are the ones its `aria-ref=` locator resolves — nothing is generated here.

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | string (URL) | — | Open this page first. Omit to read the page left open by `framewatch_interact` / `framewatch_inspect`. |
| `selector` | string | — | Only this container, e.g. `main` or `#checkout` |
| `mode` | `full` \| `interactive` | `full` | The whole tree with headings and text, or a flat list of only what can be clicked, typed into or chosen |
| `max_chars` | integer | `12000` | Cut the tree past this, on a line boundary, with a note saying how many lines went |
| `include_screenshot` | boolean | `false` | Also return a screenshot of the page as it was read |
| `include_components` | boolean | `false` | On a [Vue app](#vue-apps): append the component tree from the root |
| `wait_ms` | integer ≥ 0 | `500` | Settle time after opening `url` — a ceiling on a Vue app, which is read as soon as it is mounted |
| `wait_for` | string | — | CSS selector to wait for before reading |
| `viewport` | `{ width, height }` | — | Resize the page first (omit to leave it as it is) |
| `storage_state` | string (path) | — | Auth state file from [`framewatch_save_auth`](#framewatch_save_auth) |

**Example call**

```json
{ "url": "http://localhost:3000/login", "mode": "interactive" }
```

Returns, for the fixture in `test/fixtures/snapshot.html`:

```
Snapshot of http://127.0.0.1:53021/snapshot.html — "FrameWatch Snapshot Fixture" — viewport 1280x720 — 16 elements, 7 interactive
Refs: pass one as `ref` to framewatch_interact (to act on it) or framewatch_inspect (to measure it). They stay valid until the page changes — snapshot again after an action that re-rendered. In a framewatch_capture script, target the same element with a selector such as role=button[name="Sign in"].

- textbox "Email" [ref=e6]
- textbox "Password" [ref=e8]
- checkbox "Remember me" [checked] [ref=e10]
- button "Sign in" [ref=e11]
- link "Pricing" [ref=e13] [cursor=pointer] → /pricing
- link "Docs" [ref=e14] [cursor=pointer] → /docs
- generic [ref=e15] [cursor=pointer]: Card
```

`mode: "full"` keeps the hierarchy, headings and text, which is what you want when the question is "what does this page say" rather than "what can I press". Either way the next step is `framewatch_interact` with `"ref": "e11"`, or `framewatch_inspect` with `"targets": ["e11"]`.

Refs belong to the page. They are assigned when the snapshot is taken and stay valid until the DOM changes, which is why this tool reads the page `framewatch_interact` keeps open rather than a throwaway one — and why `framewatch_capture`, which always opens a fresh page, cannot take a ref. A capture script targets the same element with Playwright's role selector, written straight from the snapshot line: `role=button[name="Sign in"]`.

### `framewatch_inspect`

Measure how elements are actually built, to check UI work against what was intended. A screenshot shows that a button looks roughly right; this says it is 101×36 at 40,80, set in 14px/20px Arial 400, white on `#3b82f6` at a contrast of 3.68:1 which fails AA, padded 8/16, radius 6px, 20px below the heading and 20px in from the panel's left edge — and boxes it on a screenshot so you can see which element those numbers describe.

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | string (URL) | — | Open this page first. Omit to measure the page left open by `framewatch_interact` / `framewatch_snapshot`. |
| `targets` | string[] (≤ 12) | — | What to measure: snapshot refs (`e8`) and/or CSS selectors, in order. **Omit for a design inventory of the page.** |
| `selector` | string | — | Inventory only: count inside this container |
| `include_screenshot` | boolean | `true` | With `targets`: a screenshot with each target boxed and numbered |
| `wait_ms` | integer ≥ 0 | `500` | Settle time after opening `url` |
| `wait_for` | string | — | CSS selector to wait for before measuring |
| `viewport` | `{ width, height }` | — | Resize the page first (omit to leave it as it is) |
| `storage_state` | string (path) | — | Auth state file from [`framewatch_save_auth`](#framewatch_save_auth) |

**Example call**

```json
{ "url": "http://localhost:3000/", "targets": ["#cta", "#note", "#narrow"] }
```

Returns, for `test/fixtures/inspect.html`, five lines per target and one screenshot:

```
Inspected 3 of 3 targets on http://127.0.0.1:53021/inspect.html — viewport 1280x720, images 800px wide (0.63×) — coordinates and regions are in viewport px
1. #cta button "Get started" — <button#cta>
   box: 40,80 101x36 (viewport px; centre 91,98) — visible, fully in viewport
   text: 14px/20px Arial 400 — #ffffff on #3b82f6 — contrast 3.68:1 — fails AA for normal text (needs 4.5:1)
   spacing: padding 8 16; margin 0
   border: none; radius 6px
   layout: block; position absolute; 20px from parent's left, 279px from parent's right; 20px below previous sibling, 20px right of its left edge
2. #note paragraph — <p#note>
   box: 40,130 200x20 (viewport px; centre 140,140) — visible, fully in viewport
   text: 13px/20px Arial 400 — #7a7a7b (#00000080 as declared) on #f3f4f6 — contrast 3.90:1 — fails AA for normal text (needs 4.5:1)
   spacing: padding 0; margin 0
   border: none; radius 0px
   layout: block; position absolute; 20px from parent's left, 180px from parent's right; 14px below previous sibling, left-aligned with it
3. #narrow div — <div#narrow>
   box: 120,280 60x20 (viewport px; centre 150,290) — visible, fully in viewport, text overflows its box
   text: 16px/24px Arial 400 — #111111 on #f3f4f6 — contrast 17.16:1 — passes AAA for normal text
   spacing: padding 0; margin 0
   border: none; radius 0px
   layout: block; position absolute; 100px from parent's left, 240px from parent's right; overlaps previous sibling by 20px, 80px right of its left edge
```

Every number is as rendered, not as declared: the background is this element's own composited over its ancestors' until something is opaque, a translucent text colour is printed as the blend the eye sees (with the declared value beside it), and `display` is the computed value — an absolutely positioned `inline-block` reports `block`, because that is what it is laid out as. The box line also says when an element is off screen, partly outside the viewport, clipped by an ancestor with `overflow` set, hidden, or when its own text is wider than the box it was given. A target that resolved to nothing says so in its place — `2. #nope — matched nothing` — and a stale ref says to snapshot again.

With no `targets` the tool returns a **design inventory** instead: everything the page is built from, with counts, most-used first.

```
Design inventory — 15 elements, 6 with text
  fonts (1): Arial ×6
  font sizes (4): 16px ×3, 13px ×1, 14px ×1, 24px ×1
  font weights (2): 400 ×5, 700 ×1
  text colours (4): #111111 ×3, #00000080 ×1, #6b7280 ×1, #ffffff ×1
  backgrounds (6): #d1d5db ×3, #000000 ×1, #10b981 ×1, #3b82f6 ×1, #f3f4f6 ×1, #f59e0b ×1
  spacing (3): 16px ×4, 8px ×2, 12px ×1
  radii (1): 6px ×1
```

That is the fastest way to find the one 13px label on a 14px page, or the fourth shade of grey. It measures and counts; it does not score. "This page uses four font sizes" is a fact the agent can act on, and whether that is one too many is its call.

On a [Vue app](#vue-apps) each target gets one more line — the component that rendered it, with its props, its reactive state and its ancestry:

```
   component: LoginForm (props: title="Welcome back", max=3; state: email="", password="", loading=false, items=[3], submit=fn) in RouterView > App
```

### `framewatch_wait_for`

Wait for the open page to reach a state worth looking at, then look. The condition that earns the tool its place is `hot_update`: after the agent saves a file, Vite patches the open page in place, and this returns the moment that patch has landed — no reload, no replayed flow, no guessed sleep — and names the file that changed.

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | string (URL) | — | Open this page first. Omit to wait on the page left open by the other session tools. |
| `until` | enum | `hot_update` | `hot_update`: Vite applied a hot update or full reload newer than the last tool call on this page. `vue_ready`: a Vue app is mounted and its router has resolved. `selector`: `selector` is visible. `network_idle`: no requests for 500ms. |
| `selector` | string | — | For `until: selector` |
| `timeout_ms` | integer | `10000` | Give up after this long |
| `include_screenshot` | boolean | `true` | Screenshot once the condition holds |
| `include_snapshot` | boolean | `false` | Also return a [snapshot](#framewatch_snapshot) with fresh refs |
| `viewport`, `storage_state` | | | As elsewhere |

**Example call** — right after saving `LoginForm.vue`:

```json
{ "until": "hot_update" }
```
```
Hot update landed after 1428ms: /src/App.vue — Vue 3.5.42 — route /login (login) — http://localhost:5173/login — viewport 1280x720, images 800px wide (0.63×) — coordinates and regions are in viewport px
```

"Newer than the last tool call" is the whole trick. Every session tool stamps the page on its way out, so an update that landed between your save and this call still counts, and one from an earlier edit does not — the failure says `No hot update within 10000ms — last one landed 4210ms before this call (/src/App.vue)`. A page with no Vite client at all is told so instead of timing out: `has no Vite dev-server connection … Is this the dev server, or a built page?` A full reload (`[vite] page reload`) counts too, and the tool waits for the new document to load before looking.

The other conditions replace guessed sleeps: `vue_ready` reports `Vue ready after 512ms — Vue 3.5.42 — route / (home)`, `selector` reports `"#submit" appeared after 340ms`, `network_idle` reports `Network idle after 890ms`.

### Vue apps

FrameWatch reads what a Vue 3 app leaves in the DOM — the app on its container, and on every element a dev build rendered, the component that rendered it — and uses it in four places:

- **Every session tool settles on the app, not on a timer.** `framewatch_snapshot`, `framewatch_inspect`, `framewatch_interact` and `framewatch_wait_for` read the page the moment the app is mounted and vue-router has resolved its first navigation, then two frames later. `wait_ms` becomes a ceiling; a page without Vue gets the plain wait as before. Their headers name the app and the route: `Vue 3.5.42 — route /login (login)`.
- **`framewatch_inspect` names the component** behind each target, with props, reactive state (refs unwrapped, functions as `fn`, arrays as `[n]`) and the ancestry up to the root. **`framewatch_snapshot`** with `include_components` appends the tree — router and transition built-ins collapsed, identical leaf siblings counted.
- **`navigate` goes through the router** when the app has one and the value is a path or same-origin URL, so store state survives and nothing reloads. The step says `(vue-router)`, and interact reports `route /login (login) → /settings (settings)`.
- **`framewatch_wait_for` watches Vite** for the hot update your save produces.

Production builds keep only the app handle: the version and route are still reported, and the component line says `production build — no component data on elements`. Vue 2 is detected and named, but component details need Vue 3.

### `framewatch_responsive`

Screenshot one page at several viewport sizes in a single call. Each size loads in its own fresh browser context and they load concurrently, so three 2s waits cost about 2s — and a mobile shot is what a phone would really get, not a resized desktop layout that already ran its `matchMedia` listeners at 1440px.

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | string (URL) | — | Page to capture |
| `viewports` | array (1–8) | mobile 375×812, tablet 768×1024, desktop 1440×900 | `{ name, width, height }` per size |
| `wait_ms` | integer ≥ 0 | `2000` | Settle time after load, per viewport |
| `wait_for` | string | — | CSS selector to wait for (visible) at each viewport |
| `wait_for_timeout_ms` | integer ≥ 1 | `10000` | Max wait for `wait_for` |
| `storage_state` | string (path) | — | Auth state file from [`framewatch_save_auth`](#framewatch_save_auth), restored in every viewport's context |

**Example call** — the three defaults, or your own breakpoints:

```json
{ "url": "http://localhost:3000" }
```
```json
{
  "url": "http://localhost:3000",
  "viewports": [
    { "name": "iphone-se", "width": 375, "height": 667 },
    { "name": "ipad-portrait", "width": 768, "height": 1024 },
    { "name": "macbook", "width": 1440, "height": 900 },
    { "name": "wide", "width": 1920, "height": 1080 }
  ],
  "wait_for": "main"
}
```

Returns a summary, then one labelled image per viewport. Each label also reports **horizontal overflow** — content wider than its viewport — which is the commonest responsive bug and one a screenshot hides, because the part that sticks out is simply cropped off:

```
Captured http://localhost:3000/ at 3 of 3 viewports: mobile 375x812, tablet 768x1024, desktop 1440x900
Horizontal overflow at mobile — content is wider than the viewport, so something is sticking out past the right edge.

mobile 375x812 — image 375x812 — horizontal overflow: content is 640px wide in a 375px viewport (+265px) — page scrolls to 1420px (1.7 screens)
```

A viewport that fails is reported next to the ones that worked, rather than failing the call — "desktop is fine, mobile times out" is itself the finding. Only a run where *every* viewport failed comes back as an error.

### `framewatch_accessibility`

Run an [axe-core](https://github.com/dequelabs/axe-core) audit and report the violations. axe is the engine behind most commercial accessibility tooling, so a violation reported here is one an auditor would raise too.

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | string (URL) | — | Page to audit |
| `standard` | `wcag2a` \| `wcag2aa` \| `wcag21aa` | `wcag2aa` | Conformance level to test against |
| `wait_ms` | integer ≥ 0 | `1000` | Settle time after load, so the app can finish rendering |
| `wait_for` | string | — | CSS selector to wait for (visible) before auditing |
| `wait_for_timeout_ms` | integer ≥ 1 | `10000` | Max wait for `wait_for` |
| `max_violations` | integer 1–25 | `25` | Violation types to report (worst impact first) |
| `max_elements` | integer 1–20 | `3` | Offending elements listed under each violation |
| `viewport` | `{ width, height }` | `1280×720` | Some rules (reflow, target size) depend on it |
| `storage_state` | string (path) | — | Auth state file from [`framewatch_save_auth`](#framewatch_save_auth) — audit the page behind the login |

```
4 WCAG2AA (axe-core 4.13.0) violation types on http://localhost:3000/, affecting 7 elements — 3 critical, 1 serious.
11 rules passed, 2 need a human to check, 49 did not apply.

1. [critical] Images must have alternate text (image-alt) — 2 elements
   Ensures <img> elements have alternate text or a role of none or presentation
   • .hero > img
     <img src="/hero.png" width="800">
     Fix any of the following: Element does not have an alt attribute
   https://dequeuniversity.com/rules/axe/4.13/image-alt
```

**Example call** — audit at the level you are targeting, waiting for the app to render first:

```json
{ "url": "http://localhost:3000/checkout", "standard": "wcag21aa", "wait_for": "form#checkout" }
```

Violations are sorted worst impact first (critical → serious → moderate → minor), then by how many elements each affects. Passing rules are counted rather than listed — a list of two hundred rules that did not fire is noise — but "need a human to check" is worth reading: those are the checks axe could not decide on its own, typically colour contrast over an image.

The audit runs in a context with CSP bypassed and injects axe into the main frame and every child frame, so an app with a strict `Content-Security-Policy`, or one that embeds an iframe, is audited rather than refused.

### `framewatch_compare`

Diff two pages — two URLs, or the same URL before and after a code change — and show what moved.

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `url_a` | string (URL) or `"current"` | — | The "before" side |
| `url_b` | string (URL) or `"current"` | — | The "after" side |
| `wait_ms` | integer ≥ 0 | `2000` | Settle time after load, per side |
| `wait_for` | string | — | CSS selector to wait for (visible) on both sides |
| `wait_for_timeout_ms` | integer ≥ 1 | `10000` | Max wait for `wait_for` |
| `viewport` | `{ width, height }` | `1280×720` | Viewport for both sides |
| `storage_state` | string (path) | — | Auth state file from [`framewatch_save_auth`](#framewatch_save_auth), applied to both URL sides |

Returns the summary, both frames, and a **diff overlay**: side B with every differing pixel tinted, which is what turns "3.4% changed" into something you can act on.

```
Compared http://localhost:3000/ "Dashboard" against http://localhost:3001/ "Dashboard" at 1280x720 —
3.42% of pixels differ, all of it within 220,140 480x260.

Diff overlay — B with every differing pixel tinted. 31533 of 921600 pixels changed (3.42%), within 220,140 480x260.
```

**Example call** — two URLs, or the page `framewatch_interact` has open against a fresh one:

```json
{ "url_a": "http://localhost:3000", "url_b": "https://staging.example.com" }
```
```json
{ "url_a": "current", "url_b": "http://localhost:3000/checkout" }
```

The comparison is the same pixel comparison the capture engine uses between frames, so a change region here means what it means there. The two sides are captured one after the other rather than at once, so both get an unloaded machine and `wait_ms` means the same thing for each.

Pass `"current"` as `url_a` to compare against the page `framewatch_interact` has open, in whatever state your interactions left it — three clicks into a flow, against a plain URL. That page is read, never touched: it is not reloaded, and an explicit `viewport` is ignored for it (with a note saying so), because resizing it would destroy the state being compared. Both sides are then captured at the open page's size, since frames of different sizes cannot be compared pixel for pixel.

### `framewatch_save_auth`

Once this has written `.framewatch/auth.json`, **every page tool uses it automatically** when `storage_state` is omitted, and says so in its last line. `storage_state: "none"` opens a page signed out; `FRAMEWATCH_AUTH_STATE` moves the default file. A result whose page still shows a login form after the state was applied says the session has expired and to run this again.

Run a login or gate flow **once** and save the browser state it produces. Every other tool takes that file as `storage_state` and opens the page already signed in, so an app behind a login stops costing seven interaction steps and ten seconds on every single call.

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | string (URL) | — | Where the flow starts — the login page or the gate |
| `interactions` | array (≤ 50) | — | The steps to run, in order. Same shape and actions as a [capture script](#replaying-an-interaction-script), with `delay_ms` defaulting to `500` |
| `output_path` | string | `.framewatch/auth.json` | Where to write the state file |
| `wait_for` | string | — | CSS selector that only exists once signed in, e.g. `.feed`. **Strongly recommended** |
| `wait_for_timeout_ms` | integer ≥ 1 | `15000` | Max wait for `wait_for` after the last step |
| `timeout_ms` | integer ≥ 1 | `10000` | Max wait per step for its target element |
| `viewport` | `{ width, height, is_mobile, has_touch }` | `1280×720` | `is_mobile` emulates a phone; `has_touch` defaults to on when the flow taps or swipes, or when `is_mobile` is set |

**Example call** — a two-stage gate on a phone-shaped app, then everything after it:

```json
{
  "url": "http://localhost:8080",
  "interactions": [
    { "action": "type", "selector": "input", "value": "duo\n" },
    { "action": "wait", "delay_ms": 2000 },
    { "action": "type", "selector": "input", "value": "Keko" },
    { "action": "click", "selector": "button.go" },
    { "action": "click", "selector": "button:has-text('Open a room')", "delay_ms": 2000 }
  ],
  "output_path": ".framewatch/duo-auth.json",
  "wait_for": ".rail",
  "viewport": { "width": 390, "height": 844, "is_mobile": true, "has_touch": true }
}
```
```json
{
  "url": "http://localhost:8080",
  "storage_state": ".framewatch/duo-auth.json",
  "duration_ms": 5000,
  "interactions": [{ "action": "tap", "x": 195, "y": 400, "delay_ms": 1000 }],
  "viewport": { "width": 390, "height": 844 }
}
```

Returns the final frame plus what was saved:

```
Saved auth state to .framewatch/duo-auth.json — 3 cookies, 1 origin with 2 stored keys.
Ran 5 steps: type "duo\n" into "input"; wait 2000ms; type "Keko" into "input"; click "button.go"; click "button:has-text('Open a room')"
Ended on http://localhost:8080/rooms
Pass storage_state: ".framewatch/duo-auth.json" to framewatch_screenshot, framewatch_capture, framewatch_interact,
framewatch_responsive, framewatch_accessibility or framewatch_compare to start past this flow. The file holds live
session credentials — keep it out of version control.
```

**Nothing is written unless the flow finished**, `wait_for` included. A state file that is not signed in is worse than no file at all: every later call would load it and quietly get the login screen back. When a step fails, or the success selector never appears, the result is an error carrying the frame the flow stopped on — which is the thing that explains why:

```
Saving auth state failed: the flow ran, but ".rail" never became visible within 15000ms, so it did not sign in
Completed before it stopped: type "duo" into "input"; click "button.go"
Page at that moment: http://localhost:8080/gate
Nothing was written — a state file that is not signed in would make every later call fail silently.
```

What is saved is Playwright's storage state: **cookies and localStorage**, per origin. A session kept only in `sessionStorage` or in a JavaScript variable cannot be saved this way — the tool says so when the flow stored nothing at all. The file is plain JSON containing live session credentials, so treat it as a secret: keep it out of version control (`.framewatch/` is a good thing to gitignore), and use throwaway test accounts, since anything typed also shows up in the frames.

There is **no auto-refresh**. When a saved session expires, the login screen simply appears in the next capture — which is the clearest possible signal to run this tool again. FrameWatch does not try to detect it, because a heuristic that guesses wrong is worse than a screenshot you can see.

### `framewatch_form_test`

Fill a page's forms with deliberately awkward data and report what breaks. Forms are where user-facing bugs live, and the cases that break them — nothing at all, ten thousand characters, an apostrophe, Arabic, `<img onerror=…>` — are exactly the ones nobody types by hand twice.

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | string (URL) | — | Page with the form on it |
| `selector` | string | — | One form, or the container holding the fields. Omit to test every `<form>` on the page |
| `strategies` | array (1–9) | `valid`, `empty`, `special_chars`, `rtl_arabic` | Which kinds of data to try — see below |
| `submit` | boolean | `false` | Send the form after filling it |
| `wait_ms` | integer ≥ 0 | `2000` | Settle time after the submit, before the result is read |
| `wait_for` | string | — | CSS selector to wait for (visible) before the form is looked for |
| `wait_for_timeout_ms` | integer ≥ 1 | `10000` | Max wait for `wait_for` |
| `timeout_ms` | integer ≥ 1 | `10000` | Max wait for one field to accept its value |
| `max_fields` | integer 1–60 | `60` | Maximum fields to fill per form |
| `full_page` | boolean | `false` | Photograph the whole document rather than the viewport — for a form taller than the screen |
| `viewport` | `{ width, height }` | `1280×720` | Viewport size |
| `storage_state` | string (path) | — | Auth state file from [`framewatch_save_auth`](#framewatch_save_auth), for a form behind a login |

| Strategy | What goes in every field |
| --- | --- |
| `valid` | Realistic data of the right shape — an email in the email field, a number inside its `min`/`max`, and name/label hints for the rest (`user_email`, `phone`, `postcode`, …) |
| `empty` | Everything cleared, boxes unticked — then submitted |
| `maxlength` | Filled to the field's own `maxlength`, or 10,000 characters when it declares none |
| `special_chars` | Quotes, angle brackets, a backslash, an SQL fragment, CJK, Arabic and an emoji |
| `rtl_arabic` | Arabic text everywhere — RTL layout, bidirectional text, and inputs that only expected Latin |
| `numbers_only` | Digits in every field, including the ones that expect words |
| `spaces_only` | Whitespace — input that looks filled in and is empty once trimmed |
| `boundary` | The edges: one character for text, `min`/`max` for numbers and dates, the last option in a select |
| `xss` | Harmless XSS payloads that set a marker instead of doing damage |

**Example call** — the four defaults without sending anything, then the full sweep including the submit:

```json
{ "url": "http://localhost:3000/signup" }
```
```json
{
  "url": "http://localhost:3000/signup",
  "selector": "#signup",
  "strategies": ["valid", "empty", "maxlength", "special_chars", "rtl_arabic", "boundary", "xss"],
  "submit": true,
  "wait_ms": 1500
}
```

Every strategy runs in a **fresh page**. That costs a page load each, and it is the point: a form filled with valid data and then emptied is not the same test as a form that was empty from the start (live validation has run on every field, and half the frameworks in use have marked the form dirty), and a payload that executed under one strategy would be reported under every later one if they shared a page. Strategies that only fill run concurrently; with `submit: true` they run one at a time, because submitting is a write to the app under test.

Each strategy comes back as a screenshot after the fill, a screenshot after the submit, and what the page did about it:

```
Form test of http://localhost:3000/signup — #signup: 11 fillable fields, 5 not fillable. Ran 1 strategy, filling and
submitting the form, each in a page of its own.
Fields: #name (text, required, max 20), #email (email, required), #password (password, required), #age (number),
#website (url), #code (text), #country (select-one), #bio (textarea), #plan-basic (radio), #plan-pro (radio), … and 1 more
Not filled: #avatar (file input — a file cannot be chosen from a script), #csrf (hidden input),
#disabled-field (disabled), #readonly-field (read-only), #invisible-field (not visible)

empty — after fill: every field cleared, then submitted — does validation catch it
9 of 11 fields filled: #name="", #email="", #password="", #age="", #website="", #code="", #country="", #bio="",
#terms=unchecked
Left alone: #plan-basic (a radio button cannot be cleared, only replaced), #plan-pro (a radio button cannot be cleared…)

empty — after submit: clicked "#submit", waited 800ms
Page validation: Please fix 4 problem(s) below., Name is required, Enter a valid email address, Password must be at
least 8 characters, You must accept the terms
Fields the page marked invalid: #name, #email, #password, #terms
Browser validation: #name — Please fill out this field., #email — Please fill out this field., #terms — Please check
this box if you want to proceed.
Network: no request was made — the submit never left the page
Console:
  [error] form validation failed: name, email, password, terms
```

Two of those lines only exist because the empty cases are printed after a submit: **"Network: no request was made"** and **"Page validation: nothing new was shown"**. A form that silently does nothing looks exactly like a form that worked, and those two lines are the difference.

`Browser validation` is the browser's own constraint checking (`required`, `type="email"`, `min`), read from the field rather than from the screen. On a `novalidate` form — or one whose JavaScript calls `preventDefault()` first — none of it is ever shown to a user, which is worth knowing on its own. It is also where the RTL run earns its keep:

```
rtl_arabic — after fill: Arabic text in every field — catches RTL layout and bidirectional text bugs
10 of 11 fields filled: #name="مرحبا بالعالم — اختب", #email="اختبار@example.com", #age="69", #code="مرحبا", …
Truncated by the page: #code kept 5 of 32 characters
Browser validation: #email — A part followed by '@' should not contain the symbol 'ا'., #website — Please enter a URL.
```

**Truncation** is reported whenever a field kept less than it was given. Values are never longer than the field's own `maxlength` to begin with, so a truncation line always means a limit the markup does not declare — an `input` handler cutting the value down, a framework formatter, a paste guard.

The `xss` strategy is the one finding that gets promoted to the top of the response:

```
Warning — an injected payload executed on this page: input is being written back into the document as markup.
That is a reflected XSS. The payloads only set a marker; a real one would not be so polite.
```

The payloads assign a global (`window.__framewatch_xss = 1`) and nothing else, and whether that global is set afterwards is the entire test. Looking for the payload in the DOM instead would be guesswork: an input's own `value` serialises with its angle brackets intact, so a page that escaped everything perfectly would still look like a hit.

Fields nothing can fill — hidden, disabled, read-only, invisible, `type="file"` — are listed with the reason rather than skipped silently, and a field that refuses its value is reported while the rest of the form still gets filled. A page with **no `<form>` element at all** is not a page without a form: when there is none, every field on the page is treated as one form, and the submit falls back to a button whose text says what it does (`Save`, `Sign in`, `Continue`). The only thing that needs a real `<form>` is submitting with Enter.

### `framewatch_seo`

Audit what a search engine — and a link preview — would make of a page. Title and description with their lengths, canonical, robots directives and robots.txt, Open Graph and Twitter card tags, the heading outline, images with no alt text, and JSON-LD structured data checked against what Google's rich results actually require.

Everything is read from the **rendered DOM**, not the HTML that was served. A single-page app ships an empty `<div id="app">` and writes the title, the description and the structured data afterwards; reading the source would report every client-rendered page as having no SEO at all.

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | string (URL) | — | Page to audit |
| `wait_ms` | integer ≥ 0 | `1000` | Wait after load before reading the page, so a client-rendered app can finish |
| `wait_for` | string | — | CSS selector to wait for (visible) instead of, or as well as, a fixed wait |
| `wait_for_timeout_ms` | integer ≥ 1 | `10000` | Max wait for `wait_for` |
| `check_robots` | boolean | `true` | Fetch `/robots.txt` and work out whether this page's own path is crawlable |
| `robots_user_agent` | string | `Googlebot` | Which crawler to answer the robots.txt question for |
| `check_og_image` | boolean | `true` | Fetch the `og:image` and measure it |
| `include_performance` | boolean | `false` | Also measure this load: LCP, CLS, TTFB, page weight, DOM size |
| `viewport` | `{ width, height }` | `1280×720` | Viewport size |
| `storage_state` | string (path) | — | Auth state file from [`framewatch_save_auth`](#framewatch_save_auth) |

**Example call:**

```json
{ "url": "http://localhost:3000" }
```
```json
{ "url": "http://localhost:3000/menu", "wait_for": "#app h1", "include_performance": true }
```

Three of the checks are things the page cannot tell you about itself, and they are the ones that catch the expensive mistakes:

- **The response headers.** An `X-Robots-Tag: noindex` is invisible in the DOM and keeps the page out of the index just as thoroughly as the meta tag does.
- **robots.txt.** A page can be perfect and simply not crawlable. The verdict is worked out the way the specification says: the group named for the crawler beats the `*` group, and the *longest* matching rule wins regardless of the order the rules appear in — so `Disallow: /` followed by `Allow: /public/` permits `/public/page`, and reading top to bottom would get it exactly backwards.
- **The share image.** `og:image` is fetched and measured. One pointing at a 404, or at a 40×40 favicon, looks exactly like a working one until somebody shares the link — so the image comes back as an image, to be looked at.

```
SEO audit of http://localhost:3000/menu — 0 problems, 0 warnings, 21 checks passed.
Nothing here would keep this page out of an index or break its share card.

Indexing
  ✓ Robots directives — none — indexable by default
  ✓ robots.txt — Googlebot may crawl this path — no rule in the "googlebot" group matches /menu
  · Sitemap — http://localhost:3000/sitemap.xml
  ✓ Canonical — http://localhost:3000/menu
  ✓ Language — <html lang="en">
  ✓ Viewport — "width=device-width, initial-scale=1"

Title & description
  ✓ Title — "Keko Food — Order Fresh Food Online" (35 characters)
  ✓ Meta description — "Order fresh food from Keko Food and have it delivered in under thirty minutes, every day of the week." (101 characters)
  · Body — 73 words, 2 links (1 internal, 1 external)

Headings
  ✓ H1 — "Welcome to Keko Food"
  ✓ Outline — 1 h1, 2 h2, 2 h3 — no skipped levels
  Outline:
    h1 Welcome to Keko Food
      h2 Menu
        h3 Starters
        h3 Mains
      h2 Delivery
...
Performance (lab)
  ✓ LCP — 40ms — largest element: img (good ≤ 2500ms, poor > 4000ms)
  ✓ CLS — 0 (good ≤ 0.1, poor > 0.25)
  · Page weight — 2 requests, 6KB transferred — img 2× 3KB
```

Checks that passed are printed rather than counted, for the same reason the accessibility tool counts the rules that passed: a four-line report is otherwise indistinguishable from an audit that only looked at four things. The marks are `✓` passed, `!` worth fixing, `✗` will cost you traffic, `·` a measurement with no verdict attached.

A page with something wrong leads with it:

```
SEO audit of http://localhost:3000/staging — 6 problems, 11 warnings, 1 check passed.
Problems: noindex (this page tells search engines not to index it (<meta name=robots>: "noindex, nofollow"));
Meta description (missing); H1 (no <h1>); Alt text (2 of 3 images have no alt attribute: /img/hero.png, #logo);
JSON-LD block 1 (is not valid JSON); Product (missing required name, image (has description))

Indexing
  ✗ noindex — this page tells search engines not to index it (<meta name=robots>: "noindex, nofollow")
      → Remove the noindex if this page is meant to be found — it is the usual reason a live site has no search presence.
...
Structured data
  ✗ JSON-LD block 1 — is not valid JSON — Expected double-quoted property name in JSON at position 89 (line 2 column 89)
      → A block that does not parse is ignored entirely, so the page has that much less structured data than it looks like.
  ✗ Product — missing required name, image (has description)
      → Google drops the whole item when a required property is absent.
```

**Structured data** is checked against the properties Google's rich-result documentation requires, not against all of schema.org — which requires almost nothing and would report every page as perfect. `@graph` and top-level arrays are flattened, a type spelled as a `https://schema.org/…` URL is understood, subtypes inherit (`Restaurant` is checked as a `LocalBusiness`, `BlogPosting` as an `Article`), a property present but empty counts as absent, and a type nothing is known about is reported without being judged. A block that does not parse is a problem in its own right: it is ignored entirely by every consumer, so the page has less structured data than it looks like.

**`include_performance`** adds LCP, CLS, TTFB, FCP, page weight and DOM size from the same load, graded against Google's own boundaries. These are lab numbers from one headless load on this machine — useful for *"the LCP element is the hero image"*, worthless as a prediction of what real visitors will report, and the report says so rather than turning them into a score.

### `framewatch_dead_clicks`

Find the elements that look clickable and do nothing. A button whose handler never got attached, a link to `#`, a `<div>` with a pointer cursor and no listener — the things users click twice, then three times, then leave.

> **This one presses every button on the page**, including the one that deletes the account. It is the only FrameWatch tool that is not read-only. Pass `exclude` to keep it away from anything destructive, or `selector` to point it at one region.

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | string (URL) | — | Page to sweep |
| `wait_ms` | integer ≥ 0 | `1000` | Settle time after each load. Paid once per element that did something — the page is reloaded after those |
| `wait_for` | string | — | CSS selector to wait for (visible) after each load |
| `wait_for_timeout_ms` | integer ≥ 1 | `10000` | Max wait for `wait_for` |
| `settle_ms` | integer ≥ 0 | `500` | How long to watch the page after each click before deciding nothing happened |
| `selector` | string | whole page | Only sweep inside this container |
| `exclude` | string | — | Never click this, or anything inside it |
| `include_pointer` | boolean | `true` | Also test elements that only a `cursor: pointer` makes clickable |
| `include_hover` | boolean | `true` | For each dead element, check whether the page reacts to hovering it |
| `max_elements` | integer 1–100 | `40` | How many to click, in document order |
| `full_page` | boolean | `false` | Photograph the whole document, so dead elements below the fold are in the picture |
| `viewport` | `{ width, height }` | `1280×720` | Viewport size |
| `storage_state` | string (path) | — | Auth state file from [`framewatch_save_auth`](#framewatch_save_auth) |

**Example call:**

```json
{ "url": "http://localhost:3000" }
```
```json
{ "url": "http://localhost:3000/account", "exclude": "#delete-account, .danger", "settle_ms": 800 }
```

**Knowing that nothing happened is the hard part.** Clicking is easy; a handler can navigate, mutate the DOM, fetch, open a dialog, toggle a checkbox, scroll, move focus, write to `localStorage` or throw, and most of those leave no trace in any of the others. So every click is judged on all of them at once — the URL, an in-page `MutationObserver`, hashes of every field's value and of storage, scroll position, focus, plus Playwright's view of the console, network, dialogs, popups and downloads. Only silence on every channel counts as dead.

**Pages are rarely silent on their own,** so the same reading is taken once with nobody clicking, and what the page does by itself is subtracted. That is done by comparing *which* mutations happened rather than how many: two windows of the same length never catch the same number of clock ticks, but they do catch the same kind of change. Without it, one `setInterval` makes every element on the page look alive and the sweep finds nothing.

Three more things it gets right, because getting them wrong makes the answer useless:

- **`<a href="#">` has not gone anywhere.** Clicking one puts a bare `#` in the address bar. A plain URL comparison would report the single most common dead link there is as a working navigation.
- **`cursor: pointer` is inherited.** A pointer-styled card with a heading and a paragraph in it is one button, not three, so only the element the style starts at is tested — and a pointer wrapper around a real link is dropped, because the link is what gets clicked.
- **Off-site links are reported, never followed.** A link to another origin is alive by construction, and clicking it would send a request to a third party on your behalf. `mailto:`, `tel:` and anything with a `download` attribute are left alone too. `javascript:void(0)` *is* clicked — it is the link most likely to be dead.

The page is reloaded after any click that changed it, so element five is judged on the page as it shipped rather than on whatever the first four left behind. A click that changed nothing needs no reload, which is exactly the case being looked for: a page full of dead controls is also the fastest to sweep.

```
Dead-click sweep of http://localhost:3000 — 17 clickable elements found, 14 clicked, 4 dead, 1 broken, 3 not clicked.

Dead — nothing at all happened when these were clicked:
  2. a "Pricing" (#nav-pricing)
     Looks clickable: the cursor is a pointer; its href is "#", so it relies entirely on a handler; hovering it changes nothing.
  3. button "Save draft" (#save-draft)
     Looks clickable: hovering it changes nothing.
  4. div "Add to cart" (#card-buy)
     Looks clickable: it is a plain element styled with a pointer cursor — nothing else says it is a control; hovering it changes nothing.
  5. button "Subscribe" (#subscribe)
     Looks clickable: the cursor is a pointer; hovering it changes background, text colour.

Broken — the handler ran and threw:
  1. button "Export" (#export)
     the handler threw — TypeError: Cannot read properties of undefined (reading 'rows') (at HTMLButtonElement.<anonymous> (http://localhost:3000/app.js:412:19))

Marked aria-disabled, but they still work — a screen reader is told these are unavailable, and everyone else
can use them (they are clicked with Playwright's actionability checks off, which is the only way to reach one):
  button "Publish" (#publish) — it wrote to localStorage or sessionStorage

Alive — 8 elements did something:
  button "Show panel" (#show-panel) — 1 DOM change (~ div#panel [class])
  button "Ping the API" (#refresh) — 1 request — GET http://localhost:3000/api/ok → 200
  a "Go to another page" (#next) — went to http://localhost:3000/next; 1 request — GET http://localhost:3000/next → 200
  ...

Not clicked (3):
  a "Documentation" (#docs) — links to another site (https://docs.example.com)
  a "Email us" (#contact) — hands the click to mailto
  button "Delete everything" (#danger) — excluded
```

…followed by the page with every dead element boxed in red and every broken one in orange, numbered to match.

The number 4 next to a dead element is worth reading twice: it is a `<div>` that has nothing but a pointer cursor to suggest it is a control, which is the shape a dead click actually takes in a component framework. A `<button>` at least has a default behaviour to fall back on; a `<div>` whose `@click` never bound has nothing.

### `framewatch_links`

Check where every link on the page actually goes. 404s, server errors, redirect chains, redirects that land on an error page, hosts that never answer — and the `#fragment` links that point at nothing, which no link checker without a browser can find.

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | string (URL) | — | Page to check |
| `depth` | integer 0–3 | `0` | `0` checks this page only; `1` also opens each internal page it links to and checks those links, and so on |
| `check_external` | boolean | `true` | Also check links to other origins — a real request to somebody else's server |
| `include_resources` | boolean | `true` | Also check images, scripts, stylesheets, iframes and media |
| `check_fragments` | boolean | `true` | Check that a `#pricing` link points at an element that exists |
| `timeout_ms` | integer 100–30000 | `5000` | How long one link has to answer |
| `concurrency` | integer 1–10 | `5` | How many to check at once. Lower it if a host starts answering 429 |
| `max_links` | integer 1–500 | `200` | Distinct addresses to check. Links are spent before resources |
| `max_pages` | integer 1–25 | `10` | Pages to open when `depth` > 0, counting the one you named |
| `selector` | string | whole page | Only collect links inside this container |
| `wait_ms` | integer ≥ 0 | `1000` | Settle time after each load, so a client-rendered app can finish |
| `wait_for` | string | — | CSS selector to wait for (visible) after each load |
| `wait_for_timeout_ms` | integer ≥ 1 | `10000` | Max wait for `wait_for` |
| `full_page` | boolean | `false` | Photograph the whole document, so failing links below the fold are in the picture |
| `viewport` | `{ width, height }` | `1280×720` | Viewport size |
| `storage_state` | string (path) | — | Auth state file from [`framewatch_save_auth`](#framewatch_save_auth) |

**Example call:**

```json
{ "url": "http://localhost:3000" }
```
```json
{ "url": "http://localhost:3000", "depth": 1, "check_external": false, "selector": "footer" }
```

**A HEAD is not the test, it is the first guess.** A great many servers — CDNs, WAFs, a fair number of frameworks — answer `405` or `404` to a HEAD and serve the very same URL perfectly to a GET. So anything that comes back an error is asked for again as a GET before it is called broken. That second request is only ever paid on links that were about to be reported.

**A refusal is not a 404.** `401`, `403`, `429` and the non-standard `999` all come back on links that work perfectly for a person with a browser. They get their own section, because a report that cries wolf on a third of your outbound links is a report you stop reading.

**The chain is the finding.** Redirects are followed one hop at a time, so a link that arrives through four hops is reported as working *and* worth fixing, a link that redirects into a `404` is told apart from a plain `404`, and a loop is told apart from both.

**The things the page already loaded are not loaded again.** By the time anything is checked, Chromium has fetched the stylesheets, scripts and images itself — and its answer is better than a second request would be, because it is what actually happened. Re-requesting them would double the load on the app under test and could disagree with the browser, which is the verdict that counts.

**And `#pricing` is checked against the document.** A fragment that matches no element is a broken link nothing over HTTP will ever catch: the request succeeds, the page loads, and the visitor simply does not arrive. `#` and `#top` always resolve, and an old-style `<a name>` counts as well as an `id`.

```
Link check of http://localhost:3000 — 34 links found on 1 page (27 unique), 6 broken, 1 timed out, 2 unreachable, 1 dead fragment, 2 redirected, 2 blocked, 7 working, 7 not checked.
4 same-page fragments resolved against the document rather than over HTTP.

Broken (6):
  http://localhost:3000/pricing-old — 404 Not Found
    from a "Pricing" (#nav-pricing)
    → Point the link somewhere that exists, or restore the page.
  http://localhost:3000/api/report — 500 Internal Server Error
    from a "Download the report" (#report)
    → This link answers an error to every visitor.
  http://localhost:3000/go/docs — 404 Not Found — after 1 redirect, ending at http://localhost:3000/docs/v1
    from a "Documentation" (#docs)
    → Point the link somewhere that exists, or restore the page.
  http://localhost:3000/img/hero@2x.png — 404 Not Found (seen when the page loaded it)
    from img "Our team at work" (#hero)
    → Point the link somewhere that exists, or restore the page.

Timed out (1):
  https://status.example.com/uptime — no answer within the timeout
    from a "Status" (footer > nav > a:nth-of-type(3))
    → Raise `timeout_ms` if the host is simply slow; a link nobody's browser will wait for is broken in practice.

Could not be reached (2):
  http://localhost:3000/loop — the redirects loop — http://localhost:3000/loop is visited twice
    from a "Account" (#account)
    → Follow the chain by hand: a redirect loop is a page nobody can reach.
  https://blog.exmaple.com/post — the host name does not resolve
    from a "Read the post" (#blog)
    → Check the domain for a typo, and that it has not expired.

Fragments that point at nothing (1):
  #pricing-table — no element on the page has that id, and no <a name> either
    from a "See the plans" (#see-plans)

Redirected (2):
  http://localhost:3000/blog — redirected to http://localhost:3000/blog/ (1 hop), which answered 200 OK
    from a "Blog" (#nav-blog)
  http://example.com/terms — redirected to https://example.com/legal/terms (3 hops), which answered 200 OK
    from a "Terms" (#terms)
    → Link straight to the final address — every hop in the chain is another round trip.

Blocked — the server refused the check, not necessarily the link (2):
  https://www.linkedin.com/company/example — 999 — a non-standard status some sites return to automated checks — not a broken link
    from a "LinkedIn" (#social-in)
  https://app.example.com/dashboard — 401 Unauthorized — the server wants credentials before it will answer — the link is likely fine for a signed-in visitor
    from a "Dashboard" (#dashboard)

Not checked (7):
  mailto: — a mailto: with no address after it
    from a "Email us" (#contact)
  http:// — "http://" is not a URL a browser can resolve
    from a "Partners" (#partners)
  (an empty href) — an empty href reloads the current page
    from a "Careers" (#careers)
  ...

Working (7):
  http://localhost:3000/about — 200 OK
  http://localhost:3000/app.js — 200 OK (seen when the page loaded it)
  ...
```

…followed by the page with every failing link boxed in red and every dead fragment in orange, numbered to match.

The first three entries under **Not checked** are the ones worth reading: none of them is a network problem, and all three ship. A `mailto:` with nothing after it, an `href="http://"` somebody meant to finish, and an empty `href` that quietly reloads the page — a checker that only makes requests never sees any of them.

### `framewatch_api_mock`

Answer the page's API calls yourself and record what it does with the answer. The states you cannot reach on real data — an empty list, a 500, a 401, a response that takes five seconds, a body that is not valid JSON, a request that just fails — are one word each.

It takes everything [`framewatch_capture`](#framewatch_capture) takes, and returns the same diff cards. The only difference is what the network says back.

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | string (URL) | — | Page to record |
| `mocks` | array (1–20) | — | What to intercept and what to answer. See below |
| `block_unmatched` | boolean | `false` | Fail every request no mock matched instead of letting it reach the real server |
| `duration_ms` | integer 500–30000 | `5000` | How long to record |
| `interactions` | array | — | Steps to replay while recording — same script as `framewatch_capture` |
| `sensitivity` | number 0–1 | `0.06` | Frame change threshold |
| `max_frames` | integer 1–30 | `20` | Maximum diff cards |
| `wait_for` | string | — | CSS selector to wait for (visible) before recording starts |
| `include_network` | boolean | `true` | Attach the requests to the frames they settled between |
| `include_console` | boolean | `true` | Attach console output and uncaught errors |
| `viewport` | `{ width, height }` | `1280×720` | Viewport size |
| `storage_state` | string (path) | — | Auth state file from [`framewatch_save_auth`](#framewatch_save_auth) |

Each entry in `mocks`:

| Field | Type | Description |
| --- | --- | --- |
| `url_pattern` | string | Glob matched against the **whole URL**, e.g. `**/api/products*` |
| `scenario` | enum | `empty` (200, `[]`) · `error` (500) · `unauthorized` (401) · `not_found` (404) · `slow` (200 after 5s) · `malformed` (200, body that is not JSON) · `offline` (the request fails) |
| `response` | object | `status`, `body`, `delay_ms`, `headers` — each one overrides the scenario |
| `abort` | enum | `failed` · `timedout` · `connectionrefused` · `internetdisconnected` |
| `times` | integer ≥ 1 | Only the first N matching requests; the rest fall through |

**Example calls:**

```json
{ "url": "http://localhost:3000/products",
  "mocks": [{ "url_pattern": "**/api/products*", "scenario": "empty" }] }
```
```json
{ "url": "http://localhost:3000/products",
  "mocks": [{ "url_pattern": "**/api/products*", "scenario": "slow",
              "response": { "body": { "items": [{ "name": "Kombucha" }] } } }],
  "duration_ms": 8000 }
```
```json
{ "url": "http://localhost:3000",
  "mocks": [{ "url_pattern": "**/api/checkout", "scenario": "error", "times": 1 }],
  "interactions": [{ "action": "click", "selector": "#pay", "delay_ms": 500 },
                   { "action": "click", "selector": "#pay", "delay_ms": 2000 }] }
```

```
Captured 2 meaningful frames from 16 raw frames (1512ms recording) of http://localhost:3000/products — "Products"
API mocks — 1 declared, 1 served 1 request.
  ✓ **/api/products* → 200 empty ×1 (http://localhost:3000/api/products)
  Every request the page made was matched by a mock.
Context — console: 2 entries; network: 2 requests
Frame 1 @ 24ms [initial]
Console:
  [log] products: loading
  [log] products: empty
Network:
  GET http://localhost:3000/products → 200 (8ms)
  GET http://localhost:3000/api/products → 200 (2ms)
```

**The mock that matched nothing is the finding.** Mock `**/api/products*`, watch the app call `/api/product-list`, and every screenshot comes back looking perfect — because the page ran on real data and the test proved nothing. It is the only way this tool fails silently, so the tally leads the report and a zero is printed rather than omitted. When the pattern itself looks like the reason, it says so:

```
API mocks — 2 declared, 0 served 0 requests, 2 never matched.
  ✗ /api/products — no request matched it (patterns are matched against the whole URL, so a path needs a leading `**` — try `**/api/products*`).
  ✗ **/api/avatar* — no request matched it.
  Unmatched, answered by the real server:
    GET http://localhost:3000/api/products → 200
```

**What you did not mock still gets named.** Mocking one endpoint of a running app is the normal case, so everything else reaches the real server — but a run that quietly used the real backend for half its data is not the test you thought you ran. `block_unmatched: true` cuts them all off instead, which is how you ask "what does this page do with no backend at all".

**A string body is sent exactly as written.** `JSON.stringify("not json")` is `"not json"`, which parses perfectly — so if strings were encoded, an API that returns broken JSON would be impossible to simulate. That is the whole `malformed` scenario, and it is the failure your error boundary has probably never seen. Objects and arrays are JSON as you would expect.

**The page itself is never mocked.** A `**/*` pattern is a reasonable thing to write, and if the main document went through the mock there would be nothing left to photograph. The navigation is how the page got there, not something the page asked for.

**The first mock listed wins.** When two patterns match the same request, the one you wrote first gets it — which is what lets a narrow mock sit above a broad one. A mock with `times` falls through to the next match once it is spent, and then to the real server, so "the first call fails, the retry works" is a single call.

**And a delay that outlives the recording is called out**, rather than leaving you with a spinner that never resolves and no way to tell that from a rendering bug:

```
  ! **/api/products* → 200 after 9000ms ×1 — delayed 9000ms, longer than the 1500ms recording, so the request never got an answer.
```

### `framewatch_rtl`

Load the page twice — once as it ships, once flipped — measure every element in both, and report what failed to mirror.

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | string | — | The page to test |
| `rtl_trigger` | object | `{ type: "attribute", attr: "dir", value: "rtl", target: "html" }` | How this app switches direction. Also `{ type: "class", class }`, `{ type: "locale", locale }`, `{ type: "url", rtl_url }` |
| `inject_arabic` | boolean | `true` | Replace visible text with length-matched Arabic, in **both** passes |
| `selector` | string | — | Only measure inside this container |
| `exclude` | string | — | Never measure this, or anything inside it |
| `wait_ms` | number | `1000` | Settle time after each load — paid twice, once per direction |
| `wait_for` | string | — | Selector to wait for after each load |
| `max_elements` | number | `400` | Elements measured in each direction |
| `full_page` | boolean | `false` | Screenshot the whole page rather than the viewport |
| `viewport` | object | `1280x720` | |
| `storage_state` | string | — | Auth state from `framewatch_save_auth` |

```
framewatch_rtl({ url: "http://localhost:3000" })
```

```
Tested http://localhost:3000 in both directions — compared 14 elements, 5 problems, 2 warnings.
RTL applied by setting `dir="rtl"` on `html`.
Text replaced with Arabic in both passes (12 strings in RTL, 12 in LTR), matched to the original lengths so any overflow found is the layout rather than the substitution.

Problems — 5 (these are visible to an Arabic reader):
  1. div "→"  #arrow-next
       ✗ did not mirror — the box sits at the same place in both directions
         x=60 in LTR, x=60 in RTL; mirroring a 40px box in a 1280px viewport should put it at x=1180
       ! looks directional but is drawn the same way in both directions — a 'next' arrow points backwards in RTL
         no mirroring transform in either direction; `transform: scaleX(-1)` under `[dir=rtl]` flips it
  2. div "السابق اشترك في النشرة"  #not-mirrored
       ✗ did not mirror — the box sits at the same place in both directions
         x=40 in LTR, x=40 in RTL; mirroring a 200px box in a 1280px viewport should put it at x=1040
  3. p "خدمة التوصيل متاحة إلى جميع المناطق…"  #stays-left
       ✗ stayed left-aligned in an RTL context — the text hugs the wrong edge
         text-align is "left" in both directions; use `start` (or `end`) instead of `left`
  4. div "مرحبا بك في متجرنا الإلكتروني، السابق تواصل معنا"  #overflows-rtl
       ✗ overflows the left edge of the viewport in RTL — the part that sticks out is cropped, not visible
         sticks out 300px past the left edge in RTL, and none in LTR

Warnings — 2 (worth checking, may be deliberate):
  5. div #double-reversed  #double-reversed
       ! is `row-reverse` in both directions — RTL reverses it again, so the items end up back to front
         flex-direction: row-reverse under `dir=rtl` lays the items out left to right
  6. div "فريق الدعم جاهز للإجابة عن أسئلتك…"  #padding-stuck
       ! keeps the same physical padding in both directions
         padding-left 48px / padding-right 0px, unchanged from LTR; `padding-inline-start`/`padding-inline-end` would swap

By kind: did not mirror 3, directional icon did not flip 1, text stayed left-aligned 1, new overflow in RTL 1, flex row reversed twice 1, physical padding did not swap 1.
```

Then the LTR screenshot as the page ships, and the RTL screenshot with every finding boxed and numbered to match the list — red for a problem, orange for a warning.

**Nothing is judged from the RTL rendering alone.** This is what separates it from a linter. `text-align: left` is correct on a code block, a number column and a Latin brand name; `padding-left` is correct on anything that should not mirror. A tool that flags those on sight produces a report whose real findings are never read. So every verdict here is a *comparison*: the only findings are the things that failed to change when the LTR measurement proves they should have. Text that is left-aligned in both directions has forgotten to mirror; text that is left in LTR and right in RTL is `start` doing exactly its job, and nothing is said about it.

**If the trigger does not match your app, it says so before anything else.** An app that switches direction on a class renders left-to-right no matter what `dir` says — so the tool would measure LTR twice, find every element identical, and report a perfectly clean page. That is worse than an error, because it is a confident wrong answer that looks like good news. The computed direction is read back off the document, and a run that never left LTR leads with it:

```
✗ RTL was never applied — the document still computes `direction: ltr` after the trigger ran. Everything
below compares the page with itself, so it proves nothing. Check that `rtl_trigger` matches how this app
switches direction (an app that switches on a class needs `{ type: "class", class: "…" }`, one with a
separate Arabic build needs `{ type: "url", rtl_url: "…" }`).
```

**The Arabic goes into both passes, not just the flipped one.** The two passes are compared to each other, so they have to differ in exactly one variable. Text that changed in only one of them would change every box's width for reasons of font metrics rather than direction — and the mirroring check, which asks whether a box moved, would end up measuring the typeface. The replacement is matched to the length of what it replaces for the same reason: a button whose label became three characters would shrink, and the overflow it then reported would be an artifact of the substitution rather than a property of the page. Numbers are transliterated (`24.99` → `٢٤.٩٩`) rather than replaced, because a price is still a number in an Arabic interface.

**Overflow is only reported when it is new in RTL.** Content that already hung off the edge before the flip is a layout bug — `framewatch_responsive` is the tool that finds it — and repeating it here would fill an RTL report with things RTL did not cause.

### `framewatch_start_server` / `framewatch_stop_server`

Start the app's dev server so the rest of FrameWatch has something to point at, and stop it again.

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `command` | string | — | Shell command, e.g. `npm run dev` |
| `port` | integer 1–65535 | — | Port the server will listen on |
| `ready_pattern` | string (regex) | `ready\|started\|listening\|Local:` | Matched against the server's output; the matching line is reported back |
| `cwd` | string | current directory | Working directory for the command |
| `env` | object | — | Extra environment variables |
| `timeout_ms` | integer 100–300000 | `30000` | Max wait for the port to start answering |

```json
{ "status": "running", "port": 3000, "pid": 51234, "url": "http://localhost:3000", "ready_ms": 2140,
  "ready_line": "  ready in 812 ms — Local: http://localhost:3000/" }
```

**Example call:**

```json
{ "command": "npm run dev", "port": 5173, "cwd": "/Users/me/code/my-app" }
```

**Readiness is the port, not the log line.** `ready_pattern` is matched and quoted back — dev servers print the URL they actually bound to, which is worth repeating — but what makes a server "running" is that something answers on its port. That is the condition the next tool call depends on, and a pattern that fires early (or a regex that never matches a server working perfectly) would report the wrong thing in both directions. Both loopback addresses are probed, so a server bound only to `::1` is not mistaken for one that never started.

If the command exits first, or the port never opens, the error carries the server's own output — which is where the reason actually is:

```
Start server failed: `npm run dev` on port 3000 — the server exited before port 3000 opened (exit code 1).
Last output from the server:
  npm ERR! Missing script: "dev"
```

One server runs at a time. Starting the same command and port again is a no-op that reports the running server; starting a *different* one while it is up is an error naming what to stop first. A port already in use by something else is refused up front, rather than reported as an instant success. `framewatch_stop_server` takes no arguments and reports `not_running` rather than failing when there is nothing to stop; it signals the whole process group, so `npm run dev` → node → bundler all go together. FrameWatch also stops the server when the MCP server shuts down.

## Putting it together

A typical session — the agent brings the app up, records a flow, drives the page by hand, then checks the result. The output below is the real shape of what comes back, image blocks omitted:

```
framewatch_start_server  { "command": "npm run dev", "port": 5173 }
  → { "status": "running", "port": 5173, "url": "http://localhost:5173", "ready_ms": 1840,
      "ready_line": "  VITE v6.0.3  ready in 812 ms — Local: http://localhost:5173/" }

framewatch_capture       { "url": "http://localhost:5173/login", "duration_ms": 6000,
                           "interactions": [
                             { "action": "type",  "selector": "#email",    "value": "test@example.com", "delay_ms": 1000 },
                             { "action": "type",  "selector": "#password", "value": "hunter2",          "delay_ms": 500 },
                             { "action": "click", "selector": "#submit",                                "delay_ms": 500 },
                             { "action": "wait",                                                        "delay_ms": 2000 }
                           ],
                           "include_network": true, "include_dom": true }

  → Captured 7 meaningful frames from 66 raw frames (6040ms recording) of http://localhost:5173/login — "Sign in"
    Interactions: 4/4 replayed — type "test@example.com" into "#email", type "hunter2" into "#password", click "#submit", wait 2000ms
    Context — console: 2 entries; network: 2 requests; DOM: 282 mutations

    Frame 1 @ 30ms [initial]
    Network:
      GET http://localhost:5173/login → 200 (4ms)
    DOM:
      + form#login in body
      + input#email in form#login
      … and 4 more changes across 4 elements

    …

    Frame 4 @ 2147ms [interaction]
    Changed: 3.7% — region: 20,115 397x128
    DOM:
      ~ button#submit [disabled]
      ~ div#spinner [class]

    Frame 5 @ 2316ms [animation]
    Changed: 10.3% — region: 20,20 397x275
    Console:
      [error] Failed to load resource: the server responded with a status of 401 (Unauthorized)
      [error] login failed: Invalid email or password
    Network:
      POST http://localhost:5173/api/login → 401 (123ms)
    DOM:
      ~ div#spinner [class]
      ~ button#submit [disabled]

framewatch_snapshot      { "url": "http://localhost:5173/login", "mode": "interactive" }
  → Snapshot of http://localhost:5173/login — "Sign in" — viewport 1280x720 — 14 elements, 3 interactive
    - textbox "Email" [ref=e4]
    - textbox "Password" [ref=e6]
    - button "Sign in" [ref=e7]

framewatch_interact      { "action": "type", "ref": "e4", "value": "test@example.com" }
framewatch_interact      { "action": "type", "ref": "e6", "value": "correct-horse" }
framewatch_interact      { "action": "click", "ref": "e7", "wait_ms": 1500, "include_snapshot": true }
  → click e7 on http://localhost:5173/login — 74.2% of the frame changed — viewport 1280x720, images 800px wide (0.63×) — coordinates and regions are in viewport px
    …
    Snapshot — 31 elements, 9 interactive (refs valid until the page changes)
    - heading "Dashboard" [level=1] [ref=e2]
    …

framewatch_inspect       { "targets": ["e2", "e9"] }
  → Inspected 2 of 2 targets on http://localhost:5173/dashboard — viewport 1280x720, …
    1. e2 heading "Dashboard" — <h1>
       box: 32,24 224x40 (viewport px; centre 144,44) — visible, fully in viewport
       text: 32px/40px Inter 700 — #111827 on #ffffff — contrast 17.74:1 — passes AAA for large text
    …

framewatch_accessibility { "url": "http://localhost:5173/dashboard", "standard": "wcag21aa" }
framewatch_stop_server   {}
```

Two things worth noticing. The agent did not get 66 screenshots and a guess: it got the seven moments the page actually changed, the 401 that caused frame 5, and the `#spinner` and `#submit` changes that came with it. And the failure landed on an `[animation]` frame rather than an `[interaction]` one — the click is what FrameWatch forces a frame for, but the response arrived 170ms later, and the change detector caught it on its own.

The agent never guessed a selector: the snapshot named every field, the refs went straight into interact, and the click brought back the next page's refs with it. `framewatch_interact`, `framewatch_snapshot` and `framewatch_inspect` share one session page and do not inherit the page `framewatch_capture` used, so the first of them carries a `url`; the ones after it do not need one.

## Troubleshooting

**"Playwright's Chromium browser is not installed."** Run `npx playwright install chromium`. Every tool returns this message with the command in it rather than a stack trace.

**A capture came back with only two frames.** The page changed less than `sensitivity` between them. Lower it — `0.02` catches subtle fades, `0.06` (the default) is tuned to ignore cursor blinks. If the page genuinely settles instantly, two frames is the correct answer.

**A capture came back with `max_frames` frames of noise.** Something is animating continuously — a spinner, a video, a carousel. Raise `sensitivity` so only larger changes qualify, shorten `duration_ms`, or capture the specific moment with `framewatch_interact` instead.

**The frames are blank or show a loading skeleton.** Recording starts at navigation commit, which is the point for splash screens but not when you wanted the finished page. Pass `wait_for` with a selector that only exists once the app has rendered.

**An accessibility audit found nothing on a page you know is broken.** axe ran before the app rendered. Add `wait_for`, or raise `wait_ms` past the point where the content appears.

**`framewatch_interact` says a ref did not resolve.** Refs are assigned by the last `framewatch_snapshot` and die when the page re-renders. Snapshot again (or pass `include_snapshot: true` on each interact call) and use a ref from the new tree. `framewatch_capture` opens its own page and cannot take a ref at all — use `role=button[name="…"]` there.

**A result came back with no images, or fewer than expected.** Look for the `Image budget:` line at the end: the result was fitted to `MAX_MCP_OUTPUT_TOKENS` so it would arrive at all. Raise the variable (see [Result size](#result-size-and-max_mcp_output_tokens)), or ask for less — a lower `max_frames`, a `selector` on the snapshot, `include_screenshot: false` where you only need the text.

**`framewatch_wait_for` times out after every save.** Look at its message. "No Vite dev-server connection" means the page is not served by `vite` (a built preview, a different framework's server): there is no hot update to wait for. "last one landed Nms before this call" means the update arrived before the previous tool call — you looked after saving; look, then save, then wait.

**The change region and the image disagree.** They do not: the image is shrunk to 800px wide, the numbers are in viewport pixels, and each result's viewport line gives the factor. Multiply image coordinates by 1/factor before clicking with `x`/`y`.

**`framewatch_interact` says the page was reopened.** Touch support and the saved auth are both fixed when the browser context is created, so the first `tap` or `swipe` on a page opened without touch — or a `storage_state` the open session was not created with — reopens the page and resets its state. Put the `tap` and the `storage_state` in the first call of the session.

**`framewatch_start_server` refuses with "port already in use".** Something is already listening — often a dev server from an earlier session. Stop it, or point FrameWatch at it directly and skip `framewatch_start_server` altogether.

**Everything times out on a page behind a login.** Sign in once with [`framewatch_save_auth`](#framewatch_save_auth) and pass the file it writes as `storage_state` to the other tools. For a one-off, `framewatch_interact` also works: the session page keeps cookies and storage between calls, and `framewatch_compare` can read it with `"url_a": "current"`.

**A tool that worked yesterday now shows the login screen.** The saved session expired. Re-run `framewatch_save_auth` — nothing refreshes it automatically, by design: the screenshot showing you a login form is a more reliable signal than any heuristic guess.

**Every tool replays the login.** It should not have to: once [`framewatch_save_auth`](#framewatch_save_auth) has written `.framewatch/auth.json`, every page tool picks it up automatically and says so — `Auth: using .framewatch/auth.json (saved 2h ago)`. Pass `storage_state: "none"` to open a page signed out, `FRAMEWATCH_AUTH_STATE=/path` to keep the file somewhere else. When the saved session has expired the result says `did not sign you in — this page shows a login form`; and the moment a login succeeds inside `framewatch_interact`, the result reminds you to save it.

**`framewatch_save_auth` saved "no cookies and nothing in storage".** The flow did not actually sign in (add `wait_for` so a failure is reported instead of saved), or the app keeps its session in `sessionStorage` or in memory, neither of which can be saved. For those, drive the login with `framewatch_interact` and keep working in that session.

## Development

```bash
npm install
npm run build      # tsc → dist/
npm test           # builds + type-checks, then runs vitest (unit + stdio integration tests)
npm run typecheck  # type-check src/ and test/ without emitting
npm run coverage   # vitest with v8 coverage
npm run dev        # tsc --watch
```

Tests launch real Chromium against local fixture pages in `test/fixtures/`, served over HTTP by `test/helpers/fixture-server.ts` (which also answers the `/api/*` endpoints the fixtures call — including one request that is deliberately never answered, and `/api/image`, which generates a PNG of any size so the repository needs no binary assets):

| Fixture | What it is for |
| --- | --- |
| `basic.html`, `busy.html` | A still page, and one that never stops repainting |
| `splash.html` | A deterministic JS-timed animation — the frame-selection tests |
| `interactive.html` | Click/type/select/hover/touch/scroll targets, each a fixed-size solid block |
| `login.html` | A real form: validation, a POST that 401s, an error banner, a transition on success |
| `console.html`, `network.html`, `dom.html`, `perf.html` | One context layer each |
| `interact-context.html` | The layers on the long-lived `framewatch_interact` page |
| `recorder-flip.html`, `recorder-spa.html`, `recorder-target.html`, `redirect.html` | Navigation, `history.pushState`, and redirects |
| `responsive.html`, `responsive-late.html` | Breakpoints and overflow, at load and 400ms after it |
| `a11y-good.html`, `a11y-bad.html`, `a11y-frame.html`, `a11y-late.html`, `csp.html` | Clean, broken, broken-inside-an-iframe, broken-after-render, and behind a strict CSP |
| `compare-a.html` / `compare-b.html` | Two pages that differ in one region |
| `gate.html` | A gate that opens only for a cookie **and** a localStorage token — saving and restoring auth state |
| `form.html` | Every field type worth filling, five that nothing can fill, JS validation, and one input the page truncates |
| `form-multi.html`, `form-plain.html` | Two forms on one page (one with no submit button), and a page with no `<form>` element |
| `form-xss.html`, `form-gated.html` | Input echoed back as markup, and a form that only exists once signed in |
| `seo-good.html`, `seo-bad.html` | A page a search engine has nothing to complain about, and one with a fault in every category |
| `seo-blocked.html`, `robots.txt`, `private/briefing.html` | A perfect page that robots.txt forbids, and one path allowed back for Googlebot alone |
| `seo-og.html`, `seo-spa.html` | Every kind of `og:image` there is (`?card=`), and a page that writes its own SEO after load |
| `dead-clicks.html` | One live control per channel (DOM, network, storage, scroll, field, title, navigation), four dead ones, one that throws, three that must never be clicked |
| `dead-clicks-noisy.html` | A page that rewrites itself and polls the server with nobody touching it |
| `dead-clicks-shapes.html` | What counts as clickable: inherited pointer cursors, wrappers around links, elements with no ids |
| `links.html` | One of every kind of link: broken, redirected, looping, refused, timing out, unfetchable, and a fragment that points at nothing |
| `links-crawl.html`, `links-crawl-b.html` | Two pages with a broken link each, and a link back — a crawl that has to notice where it has been |
| `links-spa.html` | A page whose links are written after load |
| `highlight.html` | A positioned `<body>` with a margin — where an overlay's coordinates go wrong |

The dev-server tests drive `test/helpers/fake-dev-server.mjs`, a stand-in that can be told to start slowly, never open its port, exit with an error, or ignore SIGTERM. `test/packaging.test.ts` packs the tarball, unpacks it and speaks MCP to the binary inside, which is the closest thing to testing `npx framewatch-mcp-server` without publishing. The stdio integration test screenshots `https://example.com`, so that one needs network access.

Two things the coverage report will not show you. The DOM and performance probes run *inside* Chromium, so Node's V8 coverage cannot see them even though `context.test.ts` asserts on everything they emit; and `src/index.ts` plus the `register*Tool` functions run in a child process, so `server.test.ts` exercises them without registering a line. Read those numbers as "uninstrumented", not "untested".

## Architecture

```
MCP client (Claude Code) ◄─stdio─► FrameWatch server ◄──► Playwright Chromium
                                        │
                                 recorder → smart diff
                                        │
                                  sharp (resize / crop)
                                        │
                        context layers (console / network / DOM / performance)
```

- `src/index.ts` — McpServer + stdio transport; shuts the browser down on stdin EOF / SIGINT / SIGTERM / SIGHUP
- `src/engine/browser.ts` — one shared Chromium: a fresh context per tool call, plus the long-lived page `framewatch_interact` works on
- `src/engine/recorder.ts` — captures raw PNG frames at a fixed interval (plus forced frames on navigation)
- `src/engine/differ.ts` — grid-based frame selection, pixel-level change regions, crops
- `src/engine/forms.ts` — finds the forms on a page, fills them, submits them, and reads back what the page said
- `src/engine/seo.ts` — reads the SEO-relevant parts of the rendered document, fetches robots.txt, measures the share image
- `src/engine/clicks.ts` — finds what looks clickable, watches what a click does, and decides whether anything happened (the verdict is pure, so it is unit-tested without a browser)
- `src/engine/links.ts` — collects every address the rendered page refers to, records what the browser already loaded, and checks the rest one redirect hop at a time
- `src/engine/mocks.ts` — installs the routes a mock run needs, answers what they match, and keeps the tally of what each one served
- `src/engine/interaction.ts` — validates and executes one interaction step (click, tap, type, key, scroll, swipe, hover, select, navigate)
- `src/engine/snapshot.ts` — the aria tree with refs, on the session page, scoped, filtered and cut
- `src/engine/inspect.ts` — one element's box, type, colours, spacing and neighbours read in-page; the page's design inventory
- `src/engine/vue.ts` — what a Vue app leaves in the DOM: detection, readiness, the component behind an element, the tree, router navigation
- `src/engine/hmr.ts` — the Vite watcher on the session page, and "since the last look"
- `src/engine/layers/` — the context layers: `console.ts`, `network.ts` (Playwright events), `dom.ts`, `performance.ts` (injected observers), `probe.ts` (the injection plumbing they share), `session.ts` (layers for the long-lived interact page), and `index.ts` (attach, drain, split across cards)
- `src/utils/image.ts` — sharp wrappers, including the compare overlay
- `src/utils/highlight.ts` — labelled boxes drawn over elements (or over a measured box) through the CSSOM, so they survive a strict CSP
- `src/utils/snapshot-rules.ts` — what a snapshot line is: counting, the interactive filter, truncation, refs (pure)
- `src/utils/style-rules.ts` — what a measurement means: colour maths, WCAG contrast, alignment wording, every line inspect prints (pure)
- `src/utils/vue-rules.ts` — what a Vite console line means, router-or-load for a `navigate`, the component wording (pure)
- `src/utils/bounded-log.ts` — capped log that evicts ordinary entries to keep errors
- `src/utils/server-process.ts` — dev server process manager (spawn, port readiness, process-group kill)
- `src/utils/storage-state.ts` — reads and writes the saved auth state file, and the `storage_state` input every page tool shares
- `src/utils/test-data.ts` — what to type: one value per field per form-test strategy
- `src/utils/seo-rules.ts` — what counts as an SEO problem: robots.txt matching, structured-data expectations, every verdict (pure, so it is unit-tested without a browser)
- `src/utils/link-rules.ts` — what an href is, and what one HTTP answer means (pure, so it is unit-tested without a socket)
- `src/utils/mock-rules.ts` — what a mock scenario expands to, how a body is encoded, which mock wins, and how one run reads (pure, so it is unit-tested without a browser)
- `src/utils/format.ts` — turns diff cards into MCP content blocks
- `src/utils/budget.ts` — the image budget: cheapest encoding, then crops, size and frames, to fit `MAX_MCP_OUTPUT_TOKENS`; applied to every tool result by `tools/index.ts`
- `src/tools/screenshot.ts` — the screenshot tool
- `src/tools/capture.ts` — the capture tool, including interaction replay
- `src/tools/interact.ts` — the single-interaction tool, by selector or by snapshot ref
- `src/tools/snapshot.ts` — the page as a tree of named elements
- `src/tools/inspect.ts` — how elements are built; the design inventory
- `src/tools/wait-for.ts` — wait for a hot update, a mounted Vue app, a selector or a quiet network, then look
- `src/tools/responsive.ts` — multi-viewport capture with the overflow check
- `src/tools/accessibility.ts` — the axe-core audit
- `src/tools/compare.ts` — before/after comparison and the diff overlay
- `src/tools/save-auth.ts` — runs a login flow once and saves the browser state it produced
- `src/tools/form-test.ts` — the form tool: one strategy per page, and what each one produced
- `src/tools/seo.ts` — the SEO audit: gathers, judges, prints
- `src/tools/dead-clicks.ts` — the dead-click sweep: clicks everything, subtracts the page's own noise, marks up the result
- `src/tools/links.ts` — the link check: collect, check, crawl, group by what went wrong
- `src/tools/api-mock.ts` — the API mock tool: resolves the mocks, runs a capture behind them, reports what each one did
- `src/tools/server.ts` — the two dev-server tools

All diagnostics go to stderr; stdout is reserved for the MCP protocol.

## Contributing

Issues and pull requests are welcome at [github.com/kekoDev/framewatch](https://github.com/kekoDev/framewatch). `npm test` builds, type-checks and runs the whole suite against real Chromium; please make sure it is green, and add a fixture rather than a mock when the behaviour involves a page.

## License

[MIT](LICENSE)
