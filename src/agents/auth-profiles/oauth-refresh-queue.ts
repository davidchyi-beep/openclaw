import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { enqueueKeyedTask } from "../../plugin-sdk/keyed-async-queue.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { OAUTH_REFRESH_CALL_TIMEOUT_MS } from "./constants.js";
import { observeOAuthRefreshSettlement } from "./oauth-refresh-fence.js";

export type OAuthRefreshTracking = {
  beforeWrite: (databasePath: string) => void;
  trackSettlement: (settlement: Promise<unknown>) => void;
};

export type OAuthRefreshWaitParams = {
  provider: string;
  databasePath: string;
  profileId?: string;
  abortSignal?: AbortSignal;
};

type ActiveOAuthRefresh = {
  databasePaths: Set<string>;
  deadline: number;
  settled: Promise<void>;
};

export function createOAuthRefreshQueue() {
  const tails = new Map<string, Promise<void>>();
  const pending = new Map<string, Set<ActiveOAuthRefresh>>();
  const keyFor = (provider: string, profileId: string) => `${provider}\u0000${profileId}`;
  return {
    enqueue<T>(
      provider: string,
      profileId: string,
      task: (tracking: OAuthRefreshTracking) => Promise<T>,
    ): Promise<T> {
      const key = keyFor(provider, profileId);
      const finished = createDeferredCore();
      let settlement: Promise<void> | undefined;
      let retire: (() => void) | undefined;
      const request = enqueueKeyedTask({
        tails,
        key,
        task: () => {
          const refresh: ActiveOAuthRefresh = {
            databasePaths: new Set(),
            deadline: Date.now() + OAUTH_REFRESH_CALL_TIMEOUT_MS,
            settled: finished.promise,
          };
          const active = pending.get(key) ?? new Set<ActiveOAuthRefresh>();
          active.add(refresh);
          pending.set(key, active);
          retire = () => {
            active.delete(refresh);
            if (active.size === 0) {
              pending.delete(key);
            }
          };
          return task({
            beforeWrite(databasePath) {
              refresh.databasePaths.add(resolvePathViaExistingAncestorSync(databasePath));
            },
            trackSettlement(work) {
              settlement = work.then(
                () => undefined,
                () => undefined,
              );
            },
          });
        },
      });
      void request
        .then(
          () => settlement,
          () => settlement,
        )
        .then(() => {
          retire?.();
          finished.resolve();
        });
      return request;
    },
    async waitForActive(params: OAuthRefreshWaitParams): Promise<void> {
      params.abortSignal?.throwIfAborted();
      const databasePath = resolvePathViaExistingAncestorSync(params.databasePath);
      const key = params.profileId ? keyFor(params.provider, params.profileId) : undefined;
      const active: ActiveOAuthRefresh[] = [];
      for (const [queuedKey, work] of pending) {
        if (key ? queuedKey === key : queuedKey.startsWith(`${params.provider}\u0000`)) {
          active.push(...[...work].filter((refresh) => refresh.databasePaths.has(databasePath)));
        }
      }
      // Join this snapshot of work; the subsequent credential read owns the outcome.
      await Promise.all(
        active.map((refresh) =>
          observeOAuthRefreshSettlement(
            `modelSelection(${params.provider})`,
            OAUTH_REFRESH_CALL_TIMEOUT_MS,
            refresh.settled,
            { deadline: refresh.deadline, signal: params.abortSignal },
          ),
        ),
      );
      params.abortSignal?.throwIfAborted();
    },
  };
}
