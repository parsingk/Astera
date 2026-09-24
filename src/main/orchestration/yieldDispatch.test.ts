// The app's side of yielding dispatch to a Host that drives (S4+S5 Task 14; §4.2, §5.1, D5, N3, R25,
// C7, and the m6 ruling). Each seam below is what ipc.ts's bootOrch and its run.stop handler call with
// the one `hostDrives()` closure (N8), so the two answers of that closure are tested here: a Host that
// announces `dispatch`, and an older one (S3 or S2) in front of which the app goes on driving.
import { describe, it, expect, vi } from "vitest";
import {
  appDiscardRunWorktree,
  appTimerTick,
  stopRunFromPanel,
  HOST_STOP_BOUND_MS,
} from "./yieldDispatch";
import { hostSpeaksDispatch } from "../host/outdated";
import {
  createDispatchLoop,
  type DispatchLoopContext,
} from "../../core/orchestration/exec/dispatchLoop";
import {
  handleCommand,
  type OrchServerDeps,
} from "../../core/orchestration/command";
import { emptyState, type OrchState } from "../../core/orchestration/state";

const NOW = "2026-09-25T00:00:00.000Z";
const TEMPLATE = "job_every_minute";

/** A Host that announces dispatch (S4), and the two older ones the app still drives in front of. */
const S4_HOST = {
  connected: true,
  features: ["proc", "ping", "spawn", "worktrees", "dispatch"],
};
const S3_HOST = {
  connected: true,
  features: ["proc", "ping", "spawn", "worktrees"],
};
const S2_HOST = { connected: true, features: ["proc", "ping", "spawn"] };

/** A real dispatch loop over one schedule template, with every start recorded. */
const loopRig = () => {
  let clock = Date.parse(NOW);
  const state: OrchState = {
    ...emptyState(),
    jobs: [
      {
        id: TEMPLATE,
        objective: "every minute",
        cwd: "/p",
        createdAt: NOW,
        schedule: { kind: "interval", minutes: 1 },
      },
    ],
  };
  const handled: string[] = [];
  const ctx: DispatchLoopContext = {
    handle: async (cmd) => {
      handled.push(cmd);
      return { status: 200, body: {} };
    },
    getState: () => state,
    accounts: () => [],
    loginStatus: async () => true,
    lang: () => "en",
    forkRunWorktree: async () => "/wt",
    integrate: async () =>
      ({ merged: [], conflicted: [], failed: [] }) as never,
    reap: async () => true,
    isRegisteredWorktree: () => false,
    sessionAlive: () => false,
    sessionBusy: () => null,
    typeInto: () => {},
    mayStart: () => true,
    log: () => {},
    nowMs: () => clock,
  };
  const loop = createDispatchLoop(ctx);
  return {
    loop,
    handled,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

/** Lets the fire-and-forget promises the tick sends off settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("appTimerTick (N3, D5)", () => {
  it("in front of a Host that drives, arms without firing, so the sidebar keeps its next-fire time", async () => {
    const h = loopRig();
    appTimerTick(h.loop, {
      serving: true,
      hostDrives: hostSpeaksDispatch(S4_HOST),
      log: () => {},
    });
    const armed = h.loop.nextFireOf(TEMPLATE);
    expect(typeof armed).toBe("number");
    h.advance(61_000);
    appTimerTick(h.loop, {
      serving: true,
      hostDrives: hostSpeaksDispatch(S4_HOST),
      log: () => {},
    });
    await flush();
    expect(h.handled).toEqual([]);
    // Re-armed past the time that came due, which the Host fired: the sidebar shows the next one.
    expect(h.loop.nextFireOf(TEMPLATE)).toBeGreaterThan(armed!);
  });

  it("does not nudge coordinators in front of a Host that drives: the Host does", () => {
    const loop = {
      forgetArming: vi.fn(),
      armOnly: vi.fn(),
      fireTick: vi.fn(async () => {}),
      nudge: vi.fn(async () => {}),
    };
    appTimerTick(loop, { serving: true, hostDrives: true, log: () => {} });
    expect(loop.armOnly).toHaveBeenCalledTimes(1);
    expect(loop.fireTick).not.toHaveBeenCalled();
    expect(loop.nudge).not.toHaveBeenCalled();
  });

  it.each([
    ["an S3 Host", S3_HOST],
    ["an S2 Host", S2_HOST],
    ["no Host", { connected: false, features: [] }],
  ])(
    "in front of %s, fires the schedule and nudges as it always has",
    async (_name, status) => {
      const h = loopRig();
      appTimerTick(h.loop, {
        serving: true,
        hostDrives: hostSpeaksDispatch(status),
        log: () => {},
      });
      await flush();
      // The first tick only arms (D2) — the app's old behaviour — and the next due one fires.
      expect(h.handled).toEqual([]);
      h.advance(61_000);
      appTimerTick(h.loop, {
        serving: true,
        hostDrives: hostSpeaksDispatch(status),
        log: () => {},
      });
      await flush();
      expect(h.handled).toEqual(["run-spawn"]);
      const loop = {
        forgetArming: vi.fn(),
        armOnly: vi.fn(),
        fireTick: vi.fn(async () => {}),
        nudge: vi.fn(async () => {}),
      };
      appTimerTick(loop, {
        serving: true,
        hostDrives: hostSpeaksDispatch(status),
        log: () => {},
      });
      expect(loop.nudge).toHaveBeenCalledTimes(1);
      expect(loop.armOnly).not.toHaveBeenCalled();
    },
  );

  it("with orchestration not serving, drops the arming and fires nothing", () => {
    const loop = {
      forgetArming: vi.fn(),
      armOnly: vi.fn(),
      fireTick: vi.fn(async () => {}),
      nudge: vi.fn(async () => {}),
    };
    appTimerTick(loop, { serving: false, hostDrives: false, log: () => {} });
    expect(loop.forgetArming).toHaveBeenCalledTimes(1);
    expect(loop.fireTick).not.toHaveBeenCalled();
    expect(loop.armOnly).not.toHaveBeenCalled();
  });

  it("logs rather than throws when arming throws (a setInterval body must not throw in main)", () => {
    const logs: string[] = [];
    const loop = {
      forgetArming: vi.fn(),
      armOnly: vi.fn(() => {
        throw new Error("boom");
      }),
      fireTick: vi.fn(async () => {}),
      nudge: vi.fn(async () => {}),
    };
    expect(() =>
      appTimerTick(loop, {
        serving: true,
        hostDrives: true,
        log: (m) => logs.push(m),
      }),
    ).not.toThrow();
    expect(logs.join("\n")).toMatch(/boom/);
  });
});

describe("stopRunFromPanel (§5.1, Task 10 carry)", () => {
  const rig = (
    over: { answer?: () => Promise<{ status: number; body: unknown }> } = {},
  ) => {
    const asked: string[] = [];
    const marked: string[] = [];
    const stopped: string[] = [];
    const logs: string[] = [];
    return {
      asked,
      marked,
      stopped,
      logs,
      deps: {
        askHost: (runId: string) => {
          asked.push(runId);
          return over.answer
            ? over.answer()
            : Promise.resolve({ status: 200, body: { stopped: true } });
        },
        markStopped: (runId: string) => void marked.push(runId),
        stop: (runId: string) => void stopped.push(runId),
        log: (m: string) => void logs.push(m),
      },
    };
  };

  it("while the Host drives, sends a validation run to validation-stop and does not kill it itself", async () => {
    const h = rig();
    await stopRunFromPanel({
      runId: "r1",
      isValidation: true,
      hostDrives: hostSpeaksDispatch(S4_HOST),
      ...h.deps,
    });
    expect(h.asked).toEqual(["r1"]);
    // The Host marks and kills: a kill here too would be an exit the Host did not mark.
    expect(h.stopped).toEqual([]);
    expect(h.marked).toEqual([]);
  });

  it("a validation run the Host did not start (stopped: false) is stopped the app’s way", async () => {
    const h = rig({
      answer: async () => ({ status: 200, body: { stopped: false } }),
    });
    await stopRunFromPanel({
      runId: "r1",
      isValidation: true,
      hostDrives: true,
      ...h.deps,
    });
    expect(h.marked).toEqual(["r1"]);
    expect(h.stopped).toEqual(["r1"]);
  });

  it.each([
    [
      "a 501 (a Host that runs no validations)",
      async () => ({ status: 501, body: { error: "no" } }),
    ],
    [
      "a rejection",
      async (): Promise<{ status: number; body: unknown }> => {
        throw new Error("the connection to the Host dropped");
      },
    ],
  ])(
    "degrades on %s: logs it and kills the run, so its exit reads as a result",
    async (_n, answer) => {
      const h = rig({ answer });
      await stopRunFromPanel({
        runId: "r1",
        isValidation: true,
        hostDrives: true,
        ...h.deps,
      });
      expect(h.stopped).toEqual(["r1"]);
      expect(h.logs.join("\n")).toMatch(/validation-stop/);
    },
  );

  it(`does not wait past ${HOST_STOP_BOUND_MS} ms for the Host`, async () => {
    vi.useFakeTimers();
    try {
      const h = rig({ answer: () => new Promise(() => {}) });
      const done = stopRunFromPanel({
        runId: "r1",
        isValidation: true,
        hostDrives: true,
        ...h.deps,
      });
      await vi.advanceTimersByTimeAsync(HOST_STOP_BOUND_MS - 1);
      expect(h.stopped).toEqual([]);
      await vi.advanceTimersByTimeAsync(2);
      await done;
      expect(h.stopped).toEqual(["r1"]);
      expect(h.logs.join("\n")).toMatch(/validation-stop/);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["an S3 Host", S3_HOST],
    ["an S2 Host", S2_HOST],
  ])(
    "in front of %s, marks and kills in the app as before, and asks the Host nothing",
    async (_n, status) => {
      const h = rig();
      await stopRunFromPanel({
        runId: "r1",
        isValidation: true,
        hostDrives: hostSpeaksDispatch(status),
        ...h.deps,
      });
      expect(h.asked).toEqual([]);
      expect(h.marked).toEqual(["r1"]);
      expect(h.stopped).toEqual(["r1"]);
    },
  );

  it("an ordinary run is just stopped, whoever drives", async () => {
    const h = rig();
    await stopRunFromPanel({
      runId: "r2",
      isValidation: false,
      hostDrives: true,
      ...h.deps,
    });
    expect(h.asked).toEqual([]);
    expect(h.marked).toEqual([]);
    expect(h.stopped).toEqual(["r2"]);
  });
});

describe("appDiscardRunWorktree (R25, C7)", () => {
  it("answers removed from reapWorktree, and never in use", async () => {
    expect(await appDiscardRunWorktree(async () => true)("/wt/a")).toEqual({
      removed: true,
      inUse: false,
    });
    expect(await appDiscardRunWorktree(async () => false)("/wt/a")).toEqual({
      removed: false,
      inUse: false,
    });
  });

  // Through the real run-start: reapWorktree's false is "not removed" for any reason, so the 400
  // says the folder could not be removed, not that it is in use.
  it("makes run-start’s failed coordinator say the fresh worktree could not be removed", async () => {
    const box = { state: emptyState() };
    const reaped: string[] = [];
    const deps = {
      getState: () => box.state,
      setState: async (next: OrchState) => {
        box.state = next;
      },
      startWorker: async () => ({
        sessionId: "s",
        cwd: "/p",
        specPath: "/s.md",
      }),
      releaseWorker: async () => {},
      readWorker: async () => "",
      now: () => NOW,
      listAccounts: () => [
        { id: "cl1", label: "claude1", provider: "claude" as const },
      ],
      makeRunWorktree: async (a: { name: string }) => `/wt/${a.name}`,
      startCoordinator: async () => {
        throw new Error("spawn failed");
      },
      // A fallback that would say "in use": it must not be the branch taken.
      removeWorktrees: async (paths: string[]) => ({ failed: paths }),
      discardRunWorktree: appDiscardRunWorktree(async (p) => {
        reaped.push(p);
        return false;
      }),
    } as unknown as OrchServerDeps;
    const created = await handleCommand(
      deps,
      { sessionId: "coordinator" },
      "run-create",
      {
        objective: "o",
        cwd: "/p",
        auto: true,
        coordinatorAccount: "cl1",
      },
    );
    const runId = (created.body as { id: string }).id;
    const r = await handleCommand(
      deps,
      { sessionId: "coordinator" },
      "run-start",
      { run: runId },
    );
    expect(r.status).toBe(400);
    expect(reaped).toHaveLength(1);
    const error = (r.body as { error: string }).error;
    expect(error).toMatch(/could not be removed and was left behind/);
    expect(error).not.toMatch(/in use/);
  });
});
