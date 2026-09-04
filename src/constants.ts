/** Default capture interval between raw frames (10 fps). */
export const CAPTURE_INTERVAL_MS = 100;

/** Grid used by the smart diff engine (GRID_SIZE x GRID_SIZE cells). */
export const GRID_SIZE = 8;

/** Mean absolute per-pixel difference (0–255) for a grid cell to count as changed. */
export const CELL_THRESHOLD = 15;

/** Absolute per-pixel grayscale difference (0–255) for a single pixel to count as changed (full-res bbox). */
export const PIXEL_THRESHOLD = 15;

/** Fraction of grid cells that must change for a frame to be kept. */
export const DEFAULT_SENSITIVITY = 0.06;

/** Kept frames closer than this are merged, keeping the later "settled" one. */
export const MERGE_WINDOW_MS = 200;

/** Padding added around the change bounding box when cropping. */
export const CROP_PADDING_PX = 20;

/** Skip the crop image when the padded bounding box covers at least this fraction of the frame. */
export const CROP_SKIP_COVERAGE = 0.9;

/** Low-res size used for fast frame comparison. */
export const DIFF_WIDTH = 320;
export const DIFF_HEIGHT = 240;

/** Maximum width of images returned to the MCP client. */
export const OUTPUT_MAX_WIDTH = 800;

/** Hard cap on diff cards returned by a single capture. */
export const MAX_FRAMES_CAP = 30;

/** Default number of diff cards returned by a capture. */
export const DEFAULT_MAX_FRAMES = 20;

/** Capture recording length bounds and default. */
export const DEFAULT_CAPTURE_DURATION_MS = 5000;
export const MIN_CAPTURE_DURATION_MS = 500;
export const MAX_CAPTURE_DURATION_MS = 30_000;

/**
 * Upper bound on a capture viewport. A recording holds every raw PNG in
 * memory until the cards are built, so an unbounded viewport is an
 * out-of-memory risk (a 30s 4K recording already holds hundreds of MB).
 */
export const MAX_VIEWPORT_WIDTH = 3840;
export const MAX_VIEWPORT_HEIGHT = 2160;

/** Default viewport for all page-based tools. */
export const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;

/** Default wait after page load before a screenshot is taken. */
export const DEFAULT_SCREENSHOT_WAIT_MS = 1000;

/** Default navigation timeout for page.goto. */
export const NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * Floor for the per-screenshot timeout. Chromium will not produce a screenshot
 * while the main frame has a pending cross-document navigation or a blocked
 * main thread, and Playwright's 30s default would stall the whole recording.
 */
export const SCREENSHOT_TIMEOUT_MS = 2000;

/**
 * Bound on the final screenshot taken by stop() when the previous attempt
 * timed out. Short, so an genuinely wedged page cannot stall shutdown, but
 * still enough for a page that has since recovered (e.g. after a navigation).
 */
export const SCREENSHOT_FINAL_TIMEOUT_MS = 500;

/**
 * Chromium refuses a screenshot until it has produced its first frame (right
 * after a navigation commits). Retry that specific failure a few times.
 */
export const SCREENSHOT_RETRY_ATTEMPTS = 4;
export const SCREENSHOT_RETRY_DELAY_MS = 15;

/**
 * Bound on the cosmetic page metadata read after a recording (the title).
 * `page.title()` takes no timeout of its own and blocks for Playwright's full
 * 30s default while the page's main thread is busy.
 */
export const PAGE_INFO_TIMEOUT_MS = 1000;

/** Default timeout when waiting for a selector to appear. */
export const SELECTOR_TIMEOUT_MS = 10_000;

/**
 * A swipe is dispatched as touchStart → SWIPE_STEPS touchMoves → touchEnd,
 * with each move about a frame apart so the page's own velocity maths (a
 * carousel, pull-to-refresh) sees a plausible gesture rather than a teleport.
 */
export const SWIPE_STEPS = 10;
export const SWIPE_STEP_DELAY_MS = 16;

/**
 * Cap on the length of a replayed interaction script. Each step can carry its
 * own delay, so an unbounded script would sidestep MAX_CAPTURE_DURATION_MS.
 */
export const MAX_INTERACTIONS = 50;

/** Default settle time between an interaction and its "after" screenshot. */
export const DEFAULT_INTERACT_WAIT_MS = 500;

/* ── Context layers (Phase 4) ─────────────────────────────────────────────
 * Every layer is bounded twice over: in the page (so a runaway app cannot
 * grow the tab's memory) and in Node (so one capture cannot flood the MCP
 * response). The Node-side caps are the ones a user notices, and each layer
 * reports what it had to drop.
 */

/** Console entries kept per capture. Errors evict older non-errors once full. */
export const MAX_CONSOLE_ENTRIES = 100;

/** Console text longer than this is elided — one runaway log must not fill the response. */
export const MAX_CONSOLE_TEXT_LENGTH = 300;

/** Network events kept per capture. Failed/error responses evict older successful ones once full. */
export const MAX_NETWORK_EVENTS = 100;

/** URLs longer than this are shortened in the middle (query strings and data: URIs are unbounded). */
export const MAX_NETWORK_URL_LENGTH = 120;

/** DOM mutation records kept per capture, before grouping. */
export const MAX_DOM_RECORDS = 500;

/** Grouped DOM lines rendered on a single card. */
export const MAX_DOM_LINES_PER_CARD = 12;

/** Performance entries (paint, LCP, layout shift) kept per capture. */
export const MAX_PERF_SAMPLES = 500;

/**
 * How long the in-page probes batch records before pushing them to Node.
 * Roughly one animation frame: long enough to coalesce a burst of mutations
 * into one binding call, short enough that little is lost if the document is
 * replaced. Record timestamps are stamped when the record is made, not when
 * the batch is flushed, so batching never affects which card a record lands on.
 */
export const LAYER_FLUSH_MS = 32;

/** Records one in-page batch may carry. A page that mutates more than this per flush is reporting a storm, not detail. */
export const MAX_LAYER_BATCH = 200;

/** Records an in-page probe may push over the lifetime of one document. */
export const MAX_LAYER_RECORDS_PER_DOCUMENT = 2000;

/* ── Responsive (Phase 5) ─────────────────────────────────────────────── */

/** Viewports `framewatch_responsive` uses when the caller names none. */
export const DEFAULT_RESPONSIVE_VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

/** Viewports one responsive call may capture. Each one is a live browser context. */
export const MAX_RESPONSIVE_VIEWPORTS = 8;

/** Default settle time after load before each responsive screenshot. */
export const DEFAULT_RESPONSIVE_WAIT_MS = 2000;

/**
 * Slack (px) allowed before content counts as overflowing its viewport.
 * Sub-pixel layout rounding routinely puts scrollWidth one pixel over
 * clientWidth on a page that is perfectly fine.
 */
export const OVERFLOW_TOLERANCE_PX = 1;

/* ── Compare (Phase 5) ────────────────────────────────────────────────── */

/** Default settle time after load before each compared screenshot. */
export const DEFAULT_COMPARE_WAIT_MS = 2000;

/** Colour painted over changed pixels in the compare overlay, and its opacity (0–255). */
export const OVERLAY_COLOUR = { r: 255, g: 0, b: 200 } as const;
export const OVERLAY_ALPHA = 190;

/* ── Accessibility (Phase 5) ──────────────────────────────────────────── */

/** Default settle time after load before the audit runs. */
export const DEFAULT_A11Y_WAIT_MS = 1000;

/** Violations reported by one audit, and elements listed under each. */
export const MAX_A11Y_VIOLATIONS = 25;
export const MAX_A11Y_NODES_PER_VIOLATION = 3;

/** Length of one element's HTML in a violation report before it is elided. */
export const MAX_A11Y_HTML_LENGTH = 160;

/** Bound on the axe-core run itself (a huge DOM can take a while). */
export const A11Y_RUN_TIMEOUT_MS = 60_000;

/** How long axe waits for an iframe to answer before auditing without it. */
export const A11Y_FRAME_WAIT_MS = 5000;

/* ── Auth state (v0.1.1) ──────────────────────────────────────────────── */

/** Where `framewatch_save_auth` writes its state file when the caller names no path. */
export const DEFAULT_AUTH_STATE_PATH = ".framewatch/auth.json";

/**
 * Settle time before each step of a saved login flow. Higher than a capture
 * script's 0: this runs blind (nothing is watching the frames), so each step
 * has to leave the next one something to act on.
 */
export const SAVE_AUTH_STEP_DELAY_MS = 500;

/** How long `wait_for` may take to prove the flow signed in. Logins wait on a network round trip. */
export const SAVE_AUTH_WAIT_FOR_TIMEOUT_MS = 15_000;

/* ── Dev server (Phase 5) ─────────────────────────────────────────────── */

/** Default regex matched against dev server output to spot its "ready" line. */
export const DEFAULT_READY_PATTERN = "ready|started|listening|Local:";

/** Bounds and default for how long `framewatch_start_server` waits for the port. */
export const DEFAULT_SERVER_TIMEOUT_MS = 30_000;
export const MIN_SERVER_TIMEOUT_MS = 100;
export const MAX_SERVER_TIMEOUT_MS = 300_000;

/** Output lines kept from a dev server. Lines mentioning errors evict ordinary ones. */
export const MAX_SERVER_LOG_LINES = 200;

/** Length of one captured output line before it is elided. */
export const MAX_SERVER_LINE_LENGTH = 300;

/** Output lines quoted back when a server fails to start or is stopped. */
export const SERVER_OUTPUT_TAIL = 15;

/** How often the port is probed while waiting for the server, and the bound on one probe. */
export const SERVER_PORT_POLL_MS = 200;
export const SERVER_PORT_PROBE_TIMEOUT_MS = 1000;

/** Time a stopped server gets to exit on SIGTERM before it is killed outright. */
export const SERVER_STOP_GRACE_MS = 5000;

/* ── Form testing (Tier 1) ────────────────────────────────────────────── */

/** How much text a `maxlength` strategy puts in a field that declares no limit of its own. */
export const MAX_FORM_FILL_LENGTH = 10_000;

/** Default settle time after a submit before the result is read and photographed. */
export const DEFAULT_FORM_WAIT_MS = 2000;

/**
 * Settle time between filling the last field and the "after fill" screenshot.
 * Live validation runs on blur/input and often on a debounce, so a shot taken
 * the instant the last field is filled shows a form that has not reacted yet.
 */
export const FORM_FILL_SETTLE_MS = 300;

/** Fields one strategy will fill. A form longer than this is filled up to the cap and says so. */
export const MAX_FORM_FIELDS = 60;

/** Fields listed by name in the report for one strategy, before the rest are counted instead. */
export const MAX_FORM_FIELDS_LISTED = 10;

/** Validation messages (browser-side and on-page alike) listed per strategy. */
export const MAX_FORM_ERRORS = 8;

/** Network requests listed per strategy. */
export const MAX_FORM_NETWORK_EVENTS = 8;

/** Console entries listed per strategy. */
export const MAX_FORM_CONSOLE_ENTRIES = 8;

/** Length of one echoed field value or error message before it is elided. */
export const MAX_FORM_TEXT_LENGTH = 80;

/** Validation messages read off the page in one scan, and the longest text counted as a message. */
export const MAX_FORM_MESSAGES = 20;
export const MAX_FORM_MESSAGE_LENGTH = 200;

/** Bound on one form-test screenshot. A page wedged by its own submit handler must not stall the run. */
export const FORM_SCREENSHOT_TIMEOUT_MS = 5000;

/* ── SEO (Tier 1) ─────────────────────────────────────────────────────── */

/** Default settle time after load before the page is read. */
export const DEFAULT_SEO_WAIT_MS = 1000;

/**
 * Title length bounds. Search results are laid out in pixels, not characters,
 * so these are the usual rules of thumb rather than hard limits: under 30
 * characters is leaving the strongest ranking signal on the page unused, and
 * past 60 the tail is generally cut off.
 */
export const SEO_TITLE_MIN = 30;
export const SEO_TITLE_MAX = 60;

/** Meta description bounds — the snippet is cut somewhere around 160 characters. */
export const SEO_DESCRIPTION_MIN = 70;
export const SEO_DESCRIPTION_MAX = 160;

/** What a share image should be: the 1.91:1 card the networks render, and the floor below which they render none. */
export const SEO_OG_IMAGE_IDEAL = { width: 1200, height: 630 } as const;
export const SEO_OG_IMAGE_MIN = { width: 200, height: 200 } as const;

/** Headings listed in the outline before the rest are counted instead. */
export const MAX_SEO_HEADINGS = 40;

/** Images listed by source when they have no alt text. */
export const MAX_SEO_IMAGES_LISTED = 10;

/** JSON-LD blocks parsed, and the length of one before it is elided. */
export const MAX_SEO_JSONLD_BLOCKS = 10;
export const MAX_SEO_JSONLD_LENGTH = 20_000;

/** Length of one echoed value (title, heading, URL) before it is elided. */
export const MAX_SEO_TEXT_LENGTH = 120;

/** Bounds on the two extra requests an audit makes: robots.txt and the share image. */
export const SEO_FETCH_TIMEOUT_MS = 8000;

/** A share image larger than this is measured and reported but never returned as an image block. */
export const MAX_SEO_IMAGE_BYTES = 8_000_000;

/**
 * Core Web Vitals thresholds — Google's own "good" and "poor" boundaries.
 * These are lab numbers from one headless load, so they are reported as
 * measurements with a verdict attached, never as a score.
 */
export const SEO_LCP_GOOD_MS = 2500;
export const SEO_LCP_POOR_MS = 4000;
export const SEO_CLS_GOOD = 0.1;
export const SEO_CLS_POOR = 0.25;
export const SEO_TTFB_GOOD_MS = 800;
export const SEO_TTFB_POOR_MS = 1800;

/** Resource types listed in the page-weight breakdown. */
export const MAX_SEO_RESOURCE_TYPES = 6;

/** DOM size Lighthouse starts warning about, and the size it calls excessive. */
export const SEO_DOM_NODES_WARN = 1400;
export const SEO_DOM_NODES_POOR = 3000;

/* ── Dead clicks (Tier 1) ─────────────────────────────────────────────── */

/** Default settle time after load before the page is swept for clickable elements. */
export const DEFAULT_DEAD_CLICK_WAIT_MS = 1000;

/**
 * How long the page is watched after each click before the verdict is taken.
 * Long enough for a handler, a render and a fetch to start; short enough that
 * forty of them do not turn one tool call into a minute of waiting.
 */
export const DEFAULT_DEAD_CLICK_SETTLE_MS = 500;

/** Elements one sweep clicks by default, and the hard cap. Every one costs a click and a settle. */
export const DEFAULT_DEAD_CLICK_ELEMENTS = 40;
export const MAX_DEAD_CLICK_ELEMENTS = 100;

/**
 * Bound on one click and on re-finding the element it belongs to. Much shorter
 * than SELECTOR_TIMEOUT_MS: a control that cannot be clicked within this is a
 * finding in its own right, and waiting ten seconds for each of forty of them
 * is not a test anybody would run twice.
 */
export const DEAD_CLICK_TIMEOUT_MS = 3000;

/** Elements walked when looking for clickable ones. Past this the page is reporting a tree, not a screen. */
export const MAX_DEAD_CLICK_SCAN = 5000;

/** Settle time after hovering an element before its hover styles are read (CSS transitions). */
export const DEAD_CLICK_HOVER_SETTLE_MS = 250;

/** DOM mutations quoted under one element before the rest are counted instead. */
export const MAX_DEAD_CLICK_CHANGES = 6;

/**
 * Distinct mutation descriptions the page keeps per window.
 *
 * Comfortably more than are ever printed, and for a reason: what a click did
 * is decided by which of these the page does *not* also do on its own, so a
 * list that filled up with a ticking clock's churn would hide the one change
 * that mattered.
 */
export const MAX_DEAD_CLICK_CHANGE_SAMPLES = 24;

/** Elements listed in each section of the report before the rest are counted instead. */
export const MAX_DEAD_CLICK_LISTED = 20;

/** Effects listed for one element before the rest are counted instead. */
export const MAX_DEAD_CLICK_EFFECTS = 5;

/** Length of one element's visible text, and of one generated selector, before it is elided. */
export const MAX_DEAD_CLICK_TEXT_LENGTH = 60;
export const MAX_DEAD_CLICK_SELECTOR_LENGTH = 120;

/* ── Highlight overlay ────────────────────────────────────────────────── */

/** Boxes one overlay draws. Past this the screenshot is a colour field, not a finding. */
export const MAX_HIGHLIGHTS = 30;

/** The overlay's colours: what a dead element is painted, and what a broken one is. */
export const HIGHLIGHT_DEAD_COLOUR = "#e5194b";
export const HIGHLIGHT_BROKEN_COLOUR = "#f08c00";

/* ── Links (Tier 1) ───────────────────────────────────────────────────── */

/** Default settle time after each page load before its links are read. */
export const DEFAULT_LINKS_WAIT_MS = 1000;

/** Bound on one link check, and the bounds the caller may set. */
export const DEFAULT_LINK_TIMEOUT_MS = 5000;
export const MIN_LINK_TIMEOUT_MS = 100;
export const MAX_LINK_TIMEOUT_MS = 30_000;

/** Link checks in flight at once. Every one of them is a real request to somebody's server. */
export const DEFAULT_LINK_CONCURRENCY = 5;
export const MAX_LINK_CONCURRENCY = 10;

/**
 * Redirects followed before a chain is called endless. Generous next to the
 * two or three a real site uses, and far below the point where following one
 * more would tell anybody anything.
 */
export const MAX_LINK_REDIRECTS = 10;

/** Distinct URLs one run will check, and how deep a crawl may go. */
export const DEFAULT_MAX_LINKS = 200;
export const MAX_LINKS_CAP = 500;
export const MAX_LINK_DEPTH = 3;

/** Pages one crawl will open. Each is a full browser navigation, not a fetch. */
export const DEFAULT_LINK_PAGES = 10;
export const MAX_LINK_PAGES = 25;

/** Elements walked when collecting links. Past this the page is a document dump, not a screen. */
export const MAX_LINK_SCAN = 5000;

/** Links listed in one section of the report before the rest are counted instead. */
export const MAX_LINKS_LISTED = 25;

/** Places one link is named as appearing before the rest are counted instead. */
export const MAX_LINK_SOURCES_LISTED = 3;

/** Length of one link's text, URL and selector before each is elided. */
export const MAX_LINK_TEXT_LENGTH = 60;
export const MAX_LINK_URL_LENGTH = 120;
export const MAX_LINK_SELECTOR_LENGTH = 120;

/* ── API mocking (Tier 2) ─────────────────────────────────────────────── */

/** Mocks one call may declare. Each is a live route on the page. */
export const MAX_MOCKS = 20;

/**
 * Delay the `slow` scenario applies. Five seconds is past every spinner
 * timeout worth having and comfortably inside the default recording, so the
 * frames show the waiting state and then the arrival.
 */
export const MOCK_SLOW_DELAY_MS = 5000;

/** Longest delay a mock may declare. Beyond the recording it is simply never delivered. */
export const MAX_MOCK_DELAY_MS = MAX_CAPTURE_DURATION_MS;

/**
 * Size of one mock body. Generous, because "how does this render 1000 rows"
 * is one of the scenarios this tool exists for, and still bounded — the body
 * is held in Node, sent over stdio and echoed in the report.
 */
export const MAX_MOCK_BODY_BYTES = 2_000_000;

/** Requests named under one mock in the report before the rest are counted instead. */
export const MAX_MOCK_URLS_LISTED = 3;

/** Unmatched requests named in the report before the rest are counted instead. */
export const MAX_UNMATCHED_LISTED = 10;

/** Unmatched requests recorded at all. A page that never stops polling must not fill the response. */
export const MAX_UNMATCHED_TRACKED = 200;

/* ── RTL (Tier 2) ─────────────────────────────────────────────────────── */

/** Default settle time after each load before the page is measured. */
export const DEFAULT_RTL_WAIT_MS = 1000;

/**
 * Slack (px) before a box counts as "did not move".
 *
 * Sub-pixel layout, fractional scaling and font metrics routinely shift a box
 * by a pixel between two renders of the same page. A tolerance under about
 * two pixels reports that rounding as a mirroring bug on almost every element.
 */
export const RTL_MIRROR_TOLERANCE_PX = 2;

/** Slack (px) on padding and margin comparisons, for the same reason. */
export const RTL_ALIGN_TOLERANCE_PX = 1;

/**
 * Slack (px) before content counts as overflowing in RTL.
 *
 * Matches OVERFLOW_TOLERANCE_PX in spirit but is looser: an RTL relayout
 * reflows every line box, so a page routinely lands a pixel or two wider than
 * it did in LTR without anything being wrong.
 */
export const RTL_OVERFLOW_TOLERANCE_PX = 2;

/** Elements walked when measuring a page. Past this the page is a document dump, not a screen. */
export const MAX_RTL_SCAN = 5000;

/**
 * Elements actually measured and compared, by default and at the cap.
 *
 * Every one of these is measured twice and compared, so the cost is real but
 * bounded — and a page with more than a few hundred laid-out boxes is one
 * where the first hundred findings are the whole story anyway.
 */
export const DEFAULT_RTL_ELEMENTS = 400;
export const MAX_RTL_ELEMENTS = 1500;

/** Findings listed in one section of the report before the rest are counted instead. */
export const MAX_RTL_LISTED = 25;

/** Issues listed under one element before the rest are counted instead. */
export const MAX_RTL_ISSUES_PER_ELEMENT = 4;

/** Length of one element's text, and of one generated selector, before it is elided. */
export const MAX_RTL_TEXT_LENGTH = 60;
export const MAX_RTL_SELECTOR_LENGTH = 120;

/** Text nodes one Arabic injection will replace. A page longer than this is filled up to the cap. */
export const MAX_ARABIC_INJECTION_NODES = 2000;

/** Longest single string the Arabic injector will build, however long the original was. */
export const MAX_ARABIC_INJECTION_LENGTH = 300;

/** What a finding is painted in the overlay: a problem, and a warning. */
export const HIGHLIGHT_RTL_PROBLEM_COLOUR = "#e5194b";
export const HIGHLIGHT_RTL_WARNING_COLOUR = "#f08c00";

/* ── Snapshot & inspect ───────────────────────────────────────────────── */

/** Characters of aria tree one snapshot returns before it is cut, with a note. */
export const DEFAULT_SNAPSHOT_MAX_CHARS = 12_000;
export const MAX_SNAPSHOT_MAX_CHARS = 100_000;

/** Elements one inspect call measures. Each is a full evaluate and a block of lines. */
export const MAX_INSPECT_TARGETS = 12;

/** Length of an element's own text quoted in an inspection before it is elided. */
export const MAX_INSPECT_TEXT_LENGTH = 60;

/** Elements the design inventory walks before it stops counting. */
export const MAX_INVENTORY_ELEMENTS = 3000;

/** Values listed per inventory dimension; the rest are counted into a tail. */
export const MAX_INVENTORY_VALUES = 12;

/** Settle time after opening a page for snapshot/inspect, so a client-rendered app has drawn. */
export const DEFAULT_SNAPSHOT_WAIT_MS = 500;

/** What inspect's boxes are painted. */
export const HIGHLIGHT_INSPECT_COLOUR = "#e5194b";

/* ── Vue & Vite ───────────────────────────────────────────────────────── */

/** How long a session tool looks for a Vue app after opening a page before treating it as a plain page. */
export const VUE_DETECT_MS = 500;

/** Once an app is found: max wait for vue-router to be ready. */
export const VUE_READY_TIMEOUT_MS = 5000;

/** framewatch_wait_for's default and ceiling. */
export const DEFAULT_WAIT_FOR_TIMEOUT_MS = 10_000;
export const MAX_WAIT_FOR_TIMEOUT_MS = 120_000;

/** One serialised prop or state value, and how many of each are listed per component. */
export const MAX_COMPONENT_VALUE_LENGTH = 40;
export const MAX_COMPONENT_ENTRIES = 12;

/** Components the tree walk names before it stops. */
export const MAX_COMPONENT_TREE_NODES = 300;

/** Vite events remembered per session page. */
export const MAX_HMR_EVENTS = 50;

/* ── Image budget ─────────────────────────────────────────────────────── */

/** Claude Code's default cap on one MCP tool result; base64 image data counts toward it. */
export const DEFAULT_MCP_OUTPUT_TOKENS = 25_000;

/** How base64 tokenises, conservatively: a result sized on 3 chars/token never lands over the cap. */
export const BUDGET_CHARS_PER_TOKEN = 3;

/** Tokens left for JSON framing and the budget note itself. */
export const BUDGET_MARGIN_TOKENS = 1500;

/** Widths a frame is stepped down through before any frame is dropped, then after the last one. */
export const BUDGET_WIDTHS = [640, 480] as const;
export const BUDGET_LAST_RESORT_WIDTHS = [320, 240, 160] as const;

/** JPEG quality for the lossy candidate. */
export const BUDGET_JPEG_QUALITY = 78;

/** What to tell the user to set for full results. */
export const BUDGET_SUGGESTED_TOKENS = 100_000;
