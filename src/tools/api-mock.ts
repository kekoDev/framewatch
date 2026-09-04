import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MAX_MOCKS, MAX_MOCK_BODY_BYTES, MAX_MOCK_DELAY_MS } from "../constants.js";
import { MockRouter } from "../engine/mocks.js";
import { formatDiffCards } from "../utils/format.js";
import {
  ABORT_REASONS,
  MOCK_SCENARIOS,
  formatMockReport,
  resolveMock,
  type ResolvedMock,
} from "../utils/mock-rules.js";
import { authLines, captureInputShape, runCapture, summariseContext, type CaptureRun } from "./capture.js";

export const API_MOCK_TOOL_NAME = "framewatch_api_mock";

/** What one mock answers with, when it answers at all. */
export const mockResponseSchema = z.object({
  status: z.number().int().min(100).max(599).optional().describe("HTTP status to answer with (default 200)"),
  body: z
    .unknown()
    .optional()
    .describe(
      "The response body. An object or array is sent as JSON; a string is sent exactly as written, which is " +
        "how you simulate an API that returns broken JSON.",
    ),
  delay_ms: z
    .number()
    .int()
    .min(0)
    .max(MAX_MOCK_DELAY_MS)
    .optional()
    .describe("Hold the response back this long, so the recording shows the waiting state"),
  headers: z.record(z.string()).optional().describe("Response headers. A `content-type` here overrides the one the body implies."),
});

/** One rule: what to intercept, and what to do with it. */
export const mockSchema = z.object({
  url_pattern: z
    .string()
    .min(1)
    .describe(
      "Glob matched against the whole URL, e.g. `**/api/products*`. A bare path like `/api/products` matches " +
        "nothing — it needs the leading `**`.",
    ),
  scenario: z
    .enum(MOCK_SCENARIOS)
    .optional()
    .describe(
      "Shorthand for a common state: `empty` (200, `[]`), `error` (500), `unauthorized` (401), `not_found` " +
        "(404), `slow` (200 after 5s), `malformed` (200 with a body that is not JSON), `offline` (the request " +
        "fails outright). Anything you also put in `response` wins over the shorthand.",
    ),
  response: mockResponseSchema.optional(),
  abort: z
    .enum(ABORT_REASONS)
    .optional()
    .describe("Fail the request instead of answering it — what the page sees when the network is down"),
  times: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Only apply to the first N matching requests; later ones fall through to the next mock, or to the real server"),
});

export const apiMockInputShape = {
  ...captureInputShape,
  mocks: z
    .array(mockSchema)
    .min(1)
    .max(MAX_MOCKS)
    .describe("The requests to intercept. When two patterns match the same request, the first one listed wins."),
  block_unmatched: z
    .boolean()
    .default(false)
    .describe(
      "Fail every request no mock matched, instead of letting it reach the real server. Turns the run into " +
        "'what does this page do with no backend at all'.",
    ),
  // Louder than in framewatch_capture, and deliberately: the whole point here
  // is what the page did with the answers it was given, so the requests
  // themselves are part of the result rather than an extra.
  include_network: z
    .boolean()
    .default(true)
    .describe("Attach network requests (method, url, status, duration) to the frames they settled between"),
};

export const apiMockInputSchema = z.object(apiMockInputShape);
export type ApiMockInput = z.input<typeof apiMockInputSchema>;
type ParsedApiMockInput = z.output<typeof apiMockInputSchema>;

/**
 * Show the page the answers it is never given in development.
 *
 * Intercepts the requests named in `mocks`, answers them however the caller
 * says — empty, broken, slow, unauthorised, dead — and records the page's
 * reaction as diff cards, exactly as `framewatch_capture` would. It is the
 * same recorder, differ and layers; the only difference is what the network
 * says back.
 *
 * The report leads with what each mock actually did, because the failure this
 * tool is most likely to hit is the silent one: a pattern that matches nothing,
 * a page that renders perfectly on real data, and a test that proved nothing at
 * all.
 */
export async function mockApi(rawInput: ApiMockInput): Promise<CallToolResult> {
  const parsed = apiMockInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return errorResult(`API mock run failed: invalid input — ${issues}`);
  }
  const input = parsed.data;

  const mocks = input.mocks.map((mock) => resolveMock(mock));
  const oversized = tooLarge(mocks);
  if (oversized) return errorResult(`API mock run of ${input.url} failed: ${oversized}`);

  const router = new MockRouter({ mocks, block_unmatched: input.block_unmatched });

  let run: CaptureRun;
  try {
    run = await runCapture(input, {
      prepare: (page) => router.install(page),
      finish: async () => router.dispose(),
    });
  } catch (error) {
    router.dispose();
    return errorResult(describeApiMockFailure(input, error));
  }

  const report = formatMockReport({
    activity: router.activity,
    unmatched: router.unmatched,
    block_unmatched: input.block_unmatched,
    // The length that was asked for, not the wall clock the recorder measured:
    // "longer than the 5000ms recording" is what the caller can act on.
    duration_ms: input.duration_ms,
  });

  return formatDiffCards({
    cards: run.cards,
    total_frames: run.total_frames,
    duration_ms: run.duration_ms,
    url: run.url,
    final_url: run.final_url,
    title: run.title,
    dropped: run.dropped,
    interactions: run.interactions,
    viewport: run.viewport,
    notes: [...report, ...(summariseContext(run.context, run.cards.length) ?? []), ...authLines(run)],
  });
}

/**
 * The first mock whose body will not fit, if any. Bodies are held in Node,
 * pushed into the browser and echoed in the report, so an unbounded one is a
 * way to wedge all three at once.
 */
function tooLarge(mocks: ResolvedMock[]): string | undefined {
  for (let i = 0; i < mocks.length; i++) {
    const mock = mocks[i];
    if (mock.kind !== "fulfill") continue;
    const bytes = Buffer.byteLength(mock.body, "utf8");
    if (bytes > MAX_MOCK_BODY_BYTES) {
      return (
        `mock ${i + 1} (\`${mock.url_pattern}\`) has a ${bytes}-byte body, which is too large — ` +
        `the limit is ${MAX_MOCK_BODY_BYTES} bytes.`
      );
    }
  }
  return undefined;
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * One actionable line for a run that could not happen. Mirrors
 * `describeCaptureFailure`: match on the failing Playwright call, never on
 * substrings of a user-supplied selector.
 */
export function describeApiMockFailure(
  input: Pick<ParsedApiMockInput, "url" | "wait_for" | "wait_for_timeout_ms">,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split("\n")[0];
  const prefix = `API mock run of ${input.url} failed:`;

  if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
    return (
      `${prefix} Playwright's Chromium browser is not installed. ` +
      `Run \`npx playwright install chromium\` and try again. (${line})`
    );
  }
  if (input.wait_for && /^page\.waitForSelector:/.test(message)) {
    return `${prefix} selector "${input.wait_for}" did not become visible within ${input.wait_for_timeout_ms}ms.`;
  }
  if (/^page\.goto:/.test(message)) {
    return `${prefix} the page could not be opened — ${line}`;
  }
  return `${prefix} ${line}`;
}

export function registerApiMockTool(server: McpServer): void {
  server.registerTool(
    API_MOCK_TOOL_NAME,
    {
      title: "API mock",
      description:
        "Answer the page's API calls yourself and record what it does with the answer. Use it to see the " +
        "states you cannot reach on real data: an empty list, a 500, a 401, a response that takes five " +
        "seconds, a body that is not valid JSON, or a request that fails outright. `scenario` covers each of " +
        "those in a word; `response` sets the status, body, headers and delay by hand. Returns the same diff " +
        "cards as framewatch_capture, plus a report of what each mock actually served — including the ones " +
        "that matched nothing, which is how you find out a pattern was wrong instead of trusting a page that " +
        "looked fine. Requests no mock matched reach the real server and are named; `block_unmatched` cuts " +
        "them off instead.",
      inputSchema: apiMockInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => mockApi(args),
  );
}
