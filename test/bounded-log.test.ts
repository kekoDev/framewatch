import { describe, expect, it } from "vitest";
import { BoundedLog } from "../src/utils/bounded-log.js";

interface Entry {
  id: number;
  important?: boolean;
}

const important = (entry: Entry): boolean => entry.important === true;
const ids = (log: BoundedLog<Entry>): number[] => log.items.map((entry) => entry.id);

describe("BoundedLog below the limit", () => {
  it("keeps everything in order and drops nothing", () => {
    const log = new BoundedLog<Entry>(3);
    log.add({ id: 1 });
    log.add({ id: 2 });
    expect(ids(log)).toEqual([1, 2]);
    expect(log.size).toBe(2);
    expect(log.dropped).toBe(0);
  });

  it("hands out a plain copy that does not alias the log", () => {
    const log = new BoundedLog<Entry>(3);
    log.add({ id: 1 });
    const copy = log.toArray();
    copy.push({ id: 99 });
    expect(ids(log)).toEqual([1]);
  });
});

describe("BoundedLog at the limit", () => {
  it("refuses further ordinary entries and counts them as dropped", () => {
    const log = new BoundedLog<Entry>(2);
    log.add({ id: 1 });
    log.add({ id: 2 });
    log.add({ id: 3 });
    log.add({ id: 4 });
    expect(ids(log)).toEqual([1, 2]);
    expect(log.dropped).toBe(2);
  });

  it("lets an important entry in by evicting the oldest ordinary one", () => {
    const log = new BoundedLog<Entry>(3, important);
    log.add({ id: 1 });
    log.add({ id: 2 });
    log.add({ id: 3 });
    log.add({ id: 4, important: true });
    // Entry 1 made way; the newcomer goes on the end so order still reads forwards.
    expect(ids(log)).toEqual([2, 3, 4]);
    expect(log.dropped).toBe(1);
  });

  it("keeps every important entry when they arrive amongst noise", () => {
    const log = new BoundedLog<Entry>(3, important);
    for (let id = 1; id <= 20; id++) {
      log.add({ id, ...(id % 7 === 0 ? { important: true } : {}) });
    }
    expect(log.items.filter(important).map((entry) => entry.id)).toEqual([7, 14]);
    expect(log.size).toBe(3);
  });

  it("refuses a new important entry rather than evicting an earlier one", () => {
    const log = new BoundedLog<Entry>(2, important);
    log.add({ id: 1, important: true });
    log.add({ id: 2, important: true });
    log.add({ id: 3, important: true });
    // How the trouble started is worth more than how it continued.
    expect(ids(log)).toEqual([1, 2]);
    expect(log.dropped).toBe(1);
  });
});

describe("BoundedLog limit handling", () => {
  it("treats a limit below 1 as 1 rather than discarding everything", () => {
    const log = new BoundedLog<Entry>(0);
    log.add({ id: 1 });
    log.add({ id: 2 });
    expect(ids(log)).toEqual([1]);
    expect(log.dropped).toBe(1);
  });

  it("defaults to treating nothing as important", () => {
    const log = new BoundedLog<Entry>(1);
    log.add({ id: 1 });
    log.add({ id: 2, important: true });
    expect(ids(log)).toEqual([1]);
  });
});
