/**
 * Shared TypeScript interfaces for FrameWatch.
 *
 * Phase 1 only needs a handful of these, but the full DiffCard shape is
 * declared up front so later phases (recorder, differ, context layers) share
 * one vocabulary.
 */

export type FrameTrigger =
  | "initial"
  | "animation"
  | "navigation"
  | "interaction"
  | "network"
  | "dom_change"
  | "error";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ConsoleEntry {
  level: "log" | "warn" | "error" | "info";
  text: string;
  timestamp_ms: number;
}

export interface NetworkEvent {
  method: string;
  url: string;
  /** HTTP status, or 0 when the request never got a response (see `error`). */
  status: number;
  duration_ms: number;
  /** Relative to recording start, at the moment the request settled. */
  timestamp_ms: number;
  /**
   * Why the request never completed — Chromium's error text
   * (e.g. "net::ERR_CONNECTION_REFUSED"), or "pending" for a request still in
   * flight when the recording ended. Absent for requests that got a response.
   */
  error?: string;
}

export interface PerformanceInfo {
  /** First Contentful Paint, ms since this document's navigation start. */
  paint_time_ms?: number;
  /** Layout shifts observed since the previous card. */
  layout_shifts?: number;
  /**
   * Summed `value` of those shifts. This is the total for the window, not
   * Chrome's CLS metric (which is the largest shift *session* over the whole
   * page life), so it is comparable between cards but not with a Lighthouse score.
   */
  layout_shift_score?: number;
  /** Largest Contentful Paint, ms since this document's navigation start. */
  lcp_ms?: number;
}

export interface ChangeRegion {
  /**
   * Base64 PNG cropped to the bounding box of the change. Omitted when the
   * padded bounding box already covers nearly the whole frame (the full frame
   * image shows the same thing).
   */
  crop?: string;
  bbox: BoundingBox;
  /** Percentage (0–100) of total pixels that changed. */
  change_percent: number;
}

export interface DiffCard {
  index: number;
  timestamp_ms: number;
  trigger: FrameTrigger;
  /** Base64 PNG — full frame, resized to max OUTPUT_MAX_WIDTH wide. */
  full_frame: string;
  change_region?: ChangeRegion;
  dom_snapshot?: string;
  console_entries?: ConsoleEntry[];
  network_events?: NetworkEvent[];
  performance?: PerformanceInfo;
  component_state?: object;
}

/** One raw screenshot taken by the frame recorder. */
export interface RawFrame {
  /** Encoded PNG of the full viewport. */
  buffer: Buffer;
  /** Milliseconds since recording start. */
  timestamp_ms: number;
  /** True for frames captured immediately after a replayed interaction. */
  is_interaction: boolean;
  /**
   * Set on frames the recorder captured because of an event (navigation,
   * interaction, error). These frames are always kept by the differ.
   * Undefined for ordinary interval frames, which the differ classifies as
   * "initial" (first frame) or "animation".
   */
  trigger?: FrameTrigger;
}

/** Result of the low-res grid comparison between two frames. */
export interface GridDiffResult {
  changedCells: number;
  totalCells: number;
  /** changedCells / totalCells, 0..1 */
  changeRatio: number;
  /** Union of changed cells, in the coordinates of the compared buffers. null when nothing changed. */
  bbox: BoundingBox | null;
}

/** Result of a full-resolution per-pixel comparison between two frames. */
export interface PixelDiffResult {
  /** Pixels whose absolute grayscale difference exceeds PIXEL_THRESHOLD. */
  changedPixels: number;
  totalPixels: number;
  /** 0..100 */
  changePercent: number;
  /** Tight bounding box of all changed pixels (no padding). null when nothing changed. */
  bbox: BoundingBox | null;
}

/** A per-pixel change mask alongside the counts, for rendering a diff overlay. */
export interface PixelMaskResult extends PixelDiffResult {
  /** One byte per pixel, row-major: 1 where the pixel changed, 0 where it did not. */
  mask: Uint8Array;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface DevServerConfig {
  command: string;
  port: number;
  ready_pattern: string;
  cwd?: string;
  env?: Record<string, string>;
}
