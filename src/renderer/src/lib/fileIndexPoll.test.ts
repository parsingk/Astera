import { afterEach, describe, expect, it, vi } from "vitest";
import { pollFileIndex, type FileIndexAnswer, type FileIndexState } from "./fileIndexPoll";

afterEach(() => {
  vi.useRealTimers();
});

/** An ask that answers from a script, one answer per call, repeating the last one. */
const scripted = (answers: FileIndexAnswer[]) => {
  let n = 0;
  const ask = vi.fn(async () => answers[Math.min(n++, answers.length - 1)]);
  return ask;
};

describe("pollFileIndex", () => {
  // Quick Open: when a re-walk outlasts main's grace, the held list answers with `refreshing`; asking again shows the
  // fresh one. It is not "indexing": the box has a whole list to show meanwhile.
  it("asks again while main says the held list is being refreshed, without calling it indexing", async () => {
    vi.useFakeTimers();
    const ask = scripted([
      { paths: ["old"], indexing: false, refreshing: true },
      { paths: ["new"], indexing: false },
    ]);
    const states: FileIndexState[] = [];
    pollFileIndex(ask, (s) => states.push(s), () => {}, { pollMs: 400 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(states[0]).toEqual({ paths: ["old"], indexing: false, unavailable: false });
    expect(states.at(-1)).toEqual({ paths: ["new"], indexing: false, unavailable: false });
  });

  it("stops asking after its poll cap when a refresh never ends, keeping the held list", async () => {
    vi.useFakeTimers();
    const ask = scripted([{ paths: ["old"], indexing: false, refreshing: true }]);
    const states: FileIndexState[] = [];
    pollFileIndex(ask, (s) => states.push(s), () => {}, { pollMs: 400, maxPolls: 3 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ask).toHaveBeenCalledTimes(4);
    expect(states.at(-1)).toEqual({ paths: ["old"], indexing: false, unavailable: false });
  });

  it("passes on that the list was cut at the index's cap", async () => {
    vi.useFakeTimers();
    const ask = scripted([{ paths: ["a"], indexing: false, truncated: true }]);
    const states: FileIndexState[] = [];
    pollFileIndex(ask, (s) => states.push(s), () => {}, { pollMs: 400 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(states.at(-1)).toEqual({ paths: ["a"], indexing: false, unavailable: false, truncated: true });
  });

  it("asks again while main says it is indexing, and stops once the list is whole", async () => {
    vi.useFakeTimers();
    const ask = scripted([
      { paths: ["a"], indexing: true },
      { paths: ["a", "b"], indexing: true },
      { paths: ["a", "b", "c"], indexing: false },
    ]);
    const states: FileIndexState[] = [];
    pollFileIndex(ask, (s) => states.push(s), () => {}, { pollMs: 400 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ask).toHaveBeenCalledTimes(3);
    expect(states.at(-1)).toEqual({ paths: ["a", "b", "c"], indexing: false, unavailable: false });
  });

  // Stage 2 final review, I3: on a dead folder the menu polled every 400 ms without end.
  it("stops asking when main says the index is unavailable, and says so", async () => {
    vi.useFakeTimers();
    const ask = scripted([
      { paths: [], indexing: true },
      { paths: [], indexing: false, unavailable: true },
    ]);
    const states: FileIndexState[] = [];
    pollFileIndex(ask, (s) => states.push(s), () => {}, { pollMs: 400 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toEqual({ paths: [], indexing: false, unavailable: true });
  });

  it("gives up after its poll cap even when main keeps saying indexing, and reads that as unavailable", async () => {
    vi.useFakeTimers();
    const ask = scripted([{ paths: [], indexing: true }]);
    const states: FileIndexState[] = [];
    pollFileIndex(ask, (s) => states.push(s), () => {}, { pollMs: 400, maxPolls: 5 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ask).toHaveBeenCalledTimes(6);
    expect(states.at(-1)).toEqual({ paths: [], indexing: false, unavailable: true });
  });

  it("a rejected ask ends the polling through onFailed", async () => {
    vi.useFakeTimers();
    const ask = vi.fn(async (): Promise<FileIndexAnswer> => {
      throw new Error("gone");
    });
    const failed = vi.fn();
    pollFileIndex(ask, () => {}, failed, { pollMs: 400 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("stop() ends the polling and drops a late answer", async () => {
    vi.useFakeTimers();
    const ask = scripted([{ paths: [], indexing: true }]);
    const states: FileIndexState[] = [];
    const stop = pollFileIndex(ask, (s) => states.push(s), () => {}, { pollMs: 400 });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(states).toHaveLength(1);
  });
});
