import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { OAUTH_REFRESH_CALL_TIMEOUT_MS } from "./constants.js";
import { createOAuthRefreshQueue } from "./oauth-refresh-queue.js";

const owner = {
  provider: "openai",
  profileId: "openai:selected",
  databasePath: path.resolve("synthetic-oauth-owner.sqlite"),
};
const unrelatedDatabasePath = path.resolve("synthetic-oauth-unrelated.sqlite");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

it.each([
  { callerFails: false, durableFails: false },
  { callerFails: false, durableFails: true },
  { callerFails: true, durableFails: false },
  { callerFails: true, durableFails: true },
])(
  "joins durable refresh settlement after caller completion (caller fails: $callerFails, durable fails: $durableFails)",
  async ({ callerFails, durableFails }) => {
    const queue = createOAuthRefreshQueue();
    const entered = createDeferredCore();
    const caller = createDeferredCore<string>();
    const durable = createDeferredCore();
    const callerFailure = new Error("Synthetic caller timeout");
    const durableFailure = new Error("Synthetic durable settlement failure");
    const request = queue.enqueue(
      owner.provider,
      owner.profileId,
      async ({ beforeWrite, trackSettlement }) => {
        beforeWrite(owner.databasePath);
        trackSettlement(durable.promise);
        entered.resolve();
        return caller.promise;
      },
    );
    const result = request.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await entered.promise;
    if (callerFails) {
      caller.reject(callerFailure);
    } else {
      caller.resolve("caller complete");
    }
    expect(await result).toEqual(
      callerFails ? { error: callerFailure } : { value: "caller complete" },
    );

    let providerSettled = false;
    let profileSettled = false;
    let unrelatedSettled = false;
    const providerWait = queue
      .waitForActive({ provider: owner.provider, databasePath: owner.databasePath })
      .then(() => {
        providerSettled = true;
      });
    const profileWait = queue.waitForActive(owner).then(() => {
      profileSettled = true;
    });
    const unrelated = Promise.all([
      queue.waitForActive({ ...owner, provider: "other" }),
      queue.waitForActive({ ...owner, profileId: "openai:other" }),
      queue.waitForActive({ ...owner, databasePath: unrelatedDatabasePath }),
    ]).then(() => {
      unrelatedSettled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect([providerSettled, profileSettled, unrelatedSettled]).toEqual([false, false, true]);
      if (durableFails) {
        durable.reject(durableFailure);
      } else {
        durable.resolve();
      }
      await Promise.all([providerWait, profileWait]);
      expect([providerSettled, profileSettled]).toEqual([true, true]);
      await expect(queue.waitForActive(owner)).resolves.toBeUndefined();
    } finally {
      durable.resolve();
      await Promise.allSettled([providerWait, profileWait, unrelated]);
    }
  },
);

it("keeps the owner's deadline for late waiters without retiring durable work", async () => {
  const queue = createOAuthRefreshQueue();
  const durable = createDeferredCore();
  const callerFailure = new Error("Synthetic caller timeout");
  await expect(
    queue.enqueue(owner.provider, owner.profileId, async ({ beforeWrite, trackSettlement }) => {
      beforeWrite(owner.databasePath);
      trackSettlement(durable.promise);
      throw callerFailure;
    }),
  ).rejects.toBe(callerFailure);

  await vi.advanceTimersByTimeAsync(OAUTH_REFRESH_CALL_TIMEOUT_MS / 2);
  let firstOutcome: unknown;
  const timedOut = queue.waitForActive(owner).then(
    () => {
      firstOutcome = { completed: true };
    },
    (error: unknown) => {
      firstOutcome = { error };
    },
  );
  let later: Promise<void> | undefined;
  try {
    await vi.advanceTimersByTimeAsync(OAUTH_REFRESH_CALL_TIMEOUT_MS / 2);
    expect(firstOutcome).toMatchObject({
      error: {
        message: expect.stringContaining(
          `exceeded hard timeout (${OAUTH_REFRESH_CALL_TIMEOUT_MS}ms)`,
        ),
      },
    });
    let laterOutcome: unknown;
    later = queue.waitForActive(owner).then(
      () => {
        laterOutcome = { completed: true };
      },
      (error: unknown) => {
        laterOutcome = { error };
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(laterOutcome).toMatchObject({
      error: { message: expect.stringContaining("exceeded hard timeout") },
    });
    durable.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(queue.waitForActive(owner)).resolves.toBeUndefined();
  } finally {
    durable.resolve();
    await Promise.allSettled([timedOut, ...(later ? [later] : [])]);
  }
});

it("cancels one waiter while another still joins the durable refresh", async () => {
  const queue = createOAuthRefreshQueue();
  const durable = createDeferredCore();
  await queue.enqueue(owner.provider, owner.profileId, async ({ beforeWrite, trackSettlement }) => {
    beforeWrite(owner.databasePath);
    trackSettlement(durable.promise);
  });
  const controller = new AbortController();
  const reason = new Error("Synthetic selection cancellation");
  const cancelled = queue.waitForActive({ ...owner, abortSignal: controller.signal }).then(
    () => ({ completed: true }),
    (error: unknown) => ({ error }),
  );
  let survivorSettled = false;
  let survivor: Promise<void> | undefined;
  try {
    controller.abort(reason);
    expect(await cancelled).toMatchObject({ error: { name: "AbortError", cause: reason } });
    survivor = queue.waitForActive(owner).then(() => {
      survivorSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(survivorSettled).toBe(false);
    durable.resolve();
    await survivor;
    expect(survivorSettled).toBe(true);
  } finally {
    durable.resolve();
    await Promise.allSettled([cancelled, ...(survivor ? [survivor] : [])]);
  }
});

it("starts a queued refresh's deadline when its task starts", async () => {
  const queue = createOAuthRefreshQueue();
  const firstEntered = createDeferredCore();
  const releaseFirst = createDeferredCore();
  const durable = createDeferredCore();
  const first = queue.enqueue(owner.provider, owner.profileId, async ({ beforeWrite }) => {
    beforeWrite(unrelatedDatabasePath);
    firstEntered.resolve();
    return releaseFirst.promise;
  });
  await firstEntered.promise;
  let secondStarted = false;
  const second = queue.enqueue(
    owner.provider,
    owner.profileId,
    async ({ beforeWrite, trackSettlement }) => {
      beforeWrite(owner.databasePath);
      trackSettlement(durable.promise);
      secondStarted = true;
    },
  );
  let idleOutcome: unknown;
  const idleWait = queue.waitForActive(owner).then(
    () => {
      idleOutcome = { completed: true };
    },
    (error: unknown) => {
      idleOutcome = { error };
    },
  );
  let activeWait: Promise<void> | undefined;
  try {
    await vi.advanceTimersByTimeAsync(OAUTH_REFRESH_CALL_TIMEOUT_MS);
    expect(secondStarted).toBe(false);
    expect(idleOutcome).toEqual({ completed: true });
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(secondStarted).toBe(true);
    let outcome: unknown;
    activeWait = queue.waitForActive(owner).then(
      () => {
        outcome = { completed: true };
      },
      (error: unknown) => {
        outcome = { error };
      },
    );
    await vi.advanceTimersByTimeAsync(OAUTH_REFRESH_CALL_TIMEOUT_MS - 1);
    expect(outcome).toBeUndefined();
    durable.resolve();
    await activeWait;
    expect(outcome).toEqual({ completed: true });
  } finally {
    releaseFirst.resolve();
    durable.resolve();
    await Promise.allSettled([first, second, idleWait, ...(activeWait ? [activeWait] : [])]);
  }
});
