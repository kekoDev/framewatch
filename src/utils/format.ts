import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OUTPUT_MAX_WIDTH } from "../constants.js";
import { markImage } from "./budget.js";
import type { DiffCard, Viewport } from "../types.js";

/**
 * How the images relate to the page. Frames are shrunk to OUTPUT_MAX_WIDTH,
 * but every coordinate a tool prints — change regions, boxes, click points —
 * is in viewport pixels. A reader who measures a position off the image and
 * clicks there lands 1.6× off on the default viewport, so every tool that
 * returns frames says which it is.
 */
export function describeScale(viewport: Viewport): string {
  const base = `viewport ${viewport.width}x${viewport.height}`;
  if (viewport.width <= OUTPUT_MAX_WIDTH) return `${base}, images at full size`;
  const factor = (OUTPUT_MAX_WIDTH / viewport.width).toFixed(2);
  return `${base}, images ${OUTPUT_MAX_WIDTH}px wide (${factor}×) — coordinates and regions are in viewport px`;
}

/** What became of a replayed interaction script. */
export interface InteractionReport {
  /** Steps in the script. */
  total: number;
  /** Steps that ran successfully. */
  completed: number;
  /** One-line description of each completed step, in order. */
  steps: string[];
  /** Message from the step that failed, if any (already a single line). */
  error?: string;
  /** 1-based position of the failing step. */
  failed_index?: number;
}

/** Everything the formatter needs to describe one capture session. */
export interface CaptureSummary {
  cards: DiffCard[];
  total_frames: number;
  duration_ms: number;
  /** URL that was requested. */
  url: string;
  /** URL the page ended on (after redirects / in-page navigation). */
  final_url?: string;
  title?: string;
  /** Frames dropped by the recorder (screenshot failures). */
  dropped?: number;
  /** Present only when an interaction script was replayed. */
  interactions?: InteractionReport;
  /** The viewport the frames were taken at; adds the image-scale line when known. */
  viewport?: Viewport;
  /**
   * Remarks about the capture itself rather than about any one frame — a
   * context layer that hit its cap, requests still in flight when the
   * recording ended. One line each, after the summary.
   */
  notes?: string[];
}

/**
 * Build the MCP CallToolResult for a capture, in the shape the README
 * documents for framewatch_capture: one summary text block, then per card an image block,
 * a metadata text block and (when present) the change-region crop image.
 */
export function formatDiffCards(summary: CaptureSummary): CallToolResult {
  const lines = [formatSummaryLine(summary)];
  if (summary.viewport) {
    const scale = describeScale(summary.viewport);
    lines.push(scale.charAt(0).toUpperCase() + scale.slice(1));
  }
  if (summary.interactions) {
    lines.push(formatInteractionLine(summary.interactions));
  }
  for (const note of summary.notes ?? []) {
    lines.push(note);
  }
  const content: CallToolResult["content"] = [{ type: "text", text: lines.join("\n") }];
  const last = summary.cards.length - 1;
  summary.cards.forEach((card, i) => {
    // First, last and event frames survive the image budget longest; crops go first.
    const keep = i === 0 || i === last || card.trigger !== "animation";
    content.push(markImage({ type: "image", data: card.full_frame, mimeType: "image/png" }, { role: "frame", keep }));
    content.push({ type: "text", text: formatCardMeta(card) });
    if (card.change_region?.crop) {
      content.push(markImage({ type: "image", data: card.change_region.crop, mimeType: "image/png" }, { role: "crop" }));
    }
  });
  return { content };
}

/**
 * One-line description of the whole capture. Always names the requested url;
 * appends the final url only when the page ended somewhere else, the page
 * title when known, and the dropped-frame count only when frames were lost.
 */
function formatSummaryLine(summary: CaptureSummary): string {
  const { cards, total_frames, duration_ms, url, final_url, title, dropped } = summary;
  const recording = `from ${total_frames} raw frames (${duration_ms}ms recording) of ${url}`;
  let text = cards.length === 0 ? `No frames captured ${recording}` : `Captured ${cards.length} meaningful frames ${recording}`;
  if (final_url !== undefined && !isSameUrl(url, final_url)) {
    text += ` → ${final_url}`;
  }
  if (title) {
    text += ` — "${title}"`;
  }
  if (dropped !== undefined && dropped > 0) {
    text += ` (${dropped} frames dropped)`;
  }
  return text;
}

/**
 * How the interaction script went: how many steps ran, what they were, and —
 * when one failed — which one and why. A failed step is a finding about the
 * page, not a tool failure, so it is reported here alongside the frames rather
 * than replacing them with an error.
 */
export function formatInteractionLine(report: InteractionReport): string {
  let text = `Interactions: ${report.completed}/${report.total} replayed`;
  if (report.steps.length > 0) {
    text += ` — ${report.steps.join(", ")}`;
  }
  if (report.error !== undefined) {
    text += `. Step ${report.failed_index ?? report.completed + 1}: ${report.error}`;
  }
  return text;
}

/**
 * Compare two URLs as URLs, not as strings: `page.url()` returns the
 * WHATWG-normalised form, so a request for `http://localhost:3000` comes back
 * as `http://localhost:3000/` without anything having navigated.
 */
function isSameUrl(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/**
 * The metadata text block for one card (exported for tests and for reuse by
 * the interact tool). Line 1 is always `Frame N @ Tms [trigger]`; the
 * optional sections follow in a fixed order — Changed, Console, Network,
 * Performance, DOM — and are omitted entirely when their data is absent.
 */
export function formatCardMeta(card: DiffCard): string {
  const lines: string[] = [`Frame ${card.index} @ ${card.timestamp_ms}ms [${card.trigger}]`];

  const region = card.change_region;
  if (region) {
    if (region.change_percent === 0) {
      lines.push("Changed: 0.0% — no visual change since previous frame");
    } else {
      const { bbox } = region;
      let changed = `Changed: ${region.change_percent.toFixed(1)}% — region: ${bbox.x},${bbox.y} ${bbox.width}x${bbox.height}`;
      if (!region.crop) {
        changed += " (full-frame change, see frame image)";
      }
      lines.push(changed);
    }
  }

  if (card.console_entries?.length) {
    lines.push("Console:");
    for (const entry of card.console_entries) {
      lines.push(`  [${entry.level}] ${entry.text}`);
    }
  }

  if (card.network_events?.length) {
    lines.push("Network:");
    for (const event of card.network_events) {
      // A request that never got a response has no status to print; what
      // stopped it (or that it is still running) is the useful part.
      const outcome = event.status > 0 ? String(event.status) : (event.error ?? "no response");
      const why = event.status > 0 && event.error !== undefined ? ` ${event.error}` : "";
      lines.push(`  ${event.method} ${event.url} → ${outcome}${why} (${event.duration_ms}ms)`);
    }
  }

  const perf = card.performance;
  if (perf) {
    lines.push("Performance:");
    if (perf.paint_time_ms !== undefined) lines.push(`  paint ${perf.paint_time_ms}ms`);
    if (perf.layout_shifts !== undefined) {
      const score = perf.layout_shift_score !== undefined ? ` (score ${perf.layout_shift_score})` : "";
      lines.push(`  layout shifts ${perf.layout_shifts}${score}`);
    }
    if (perf.lcp_ms !== undefined) lines.push(`  lcp ${perf.lcp_ms}ms`);
  }

  if (card.dom_snapshot) {
    lines.push(`DOM:\n${card.dom_snapshot}`);
  }

  return lines.join("\n");
}
