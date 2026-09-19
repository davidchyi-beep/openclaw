import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import "./oauth-external-auth-passthrough.test-support.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import { isPendingOAuthRefreshFence } from "./oauth-refresh-marker.js";
import { resetOAuthProviderRuntimeMocks } from "./oauth-test-utils.js";
import { resolveApiKeyForProfile } from "./oauth.js";
import { resetOAuthRefreshQueuesForTest } from "./oauth.test-support.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import { loadPersistedAuthProfileStore, loadPersistedSharedAuthProfileStore } from "./persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  runtimeAuthProfileRowsCache,
} from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath, writePersistedAuthProfileStoreRaw } from "./sqlite.js";
import { updateAuthProfileStoreWithLock } from "./store-runtime.js";
import type { OAuthCredential } from "./types.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

// The shared OAuth mocks reset the registry before these transitive runtime imports.
const { withOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
const authProfiles = await import("../auth-profiles.js");
const { resolveDynamicModelAuthProfile } =
  await import("../embedded-agent-runner/model.registry-resolution.js");

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = getOAuthProviderRuntimeMocks();

vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }],
}));

const profileId = "openai:model-selection";
const provider = "openai";

function originalCredential(): OAuthCredential {
  return {
    type: "oauth",
    provider,
    access: "synthetic-original-access",
    refresh: "synthetic-original-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "synthetic-same-account",
  };
}

function controlledRefresh(credential: OAuthCredential) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const rotated: OAuthCredential = {
    ...credential,
    access: "synthetic-rotated-access",
    refresh: "synthetic-rotated-refresh",
    expires: Date.now() + 7_200_000,
  };
  refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return rotated;
  });
  return { entered, release, rotated };
}

function refreshProfile(credential: OAuthCredential, agentDir: string) {
  return resolveApiKeyForProfile({
    cfg: {},
    store: { version: 1, profiles: { [profileId]: credential } },
    profileId,
    agentDir,
    forceRefresh: true,
  }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

beforeEach(() => {
  resetOAuthProviderRuntimeMocks({
    refreshProviderOAuthCredentialWithPluginMock,
    formatProviderAuthProfileApiKeyWithPluginMock,
  });
  resetOAuthRefreshQueuesForTest();
  clearRuntimeAuthProfileStoreSnapshots();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetOAuthRefreshQueuesForTest();
});

it.each([
  "pinned",
  "automatic",
  "historical peer",
  "cancelled",
  "revoked",
  "replaced while refreshing",
  "removed while refreshing",
  "refresh failed",
  "rotated during reread",
  "removed during reread",
] as const)("selects through the OAuth owner after a real refresh: %s", async (scenario) => {
  await withOpenClawTestState({ label: "oauth-model-selection" }, async (state) => {
    const credential = originalCredential();
    await persistAuthProfileBatch({
      stateDir: state.stateDir,
      profiles: [{ profileId, credential }],
    });
    const agentDir = state.agentDir(scenario === "historical peer" ? "peer" : "main");
    if (scenario === "historical peer") {
      await state.writeAuthProfiles({ version: 1, profiles: { [profileId]: credential } }, "peer");
      // Preserve an upgraded historical copy; current writes deduplicate these peers.
      writePersistedAuthProfileStoreRaw(
        { version: 1, profiles: { [profileId]: credential } },
        agentDir,
      );
    }
    const databasePath =
      scenario === "historical peer"
        ? resolveAuthProfileDatabasePath(agentDir)
        : resolveSharedAuthStorePath();
    const refresh = controlledRefresh(credential);
    const reads = [0, 1].map(() => ({
      entered: createDeferredCore(),
      release: createDeferredCore(),
    }));
    const joining = createDeferredCore();
    const prepare = runtimeAuthProfileRowsCache.prepare.bind(runtimeAuthProfileRowsCache);
    let readCount = 0;
    vi.spyOn(runtimeAuthProfileRowsCache, "prepare").mockImplementation((db, reader) => {
      const prepared = prepare(db, reader);
      if (db !== databasePath) {
        return prepared;
      }
      const barrier = reads[readCount++];
      return {
        ...prepared,
        async read() {
          const rows = await prepared.read();
          barrier?.entered.resolve();
          await barrier?.release.promise;
          return rows;
        },
      };
    });
    const join = authProfiles.waitForActiveOAuthRefreshes;
    vi.spyOn(authProfiles, "waitForActiveOAuthRefreshes").mockImplementation((params) => {
      const pending = join(params);
      joining.resolve();
      return pending;
    });
    const controller = new AbortController();
    const refusal = new Error("Selected model owner closed");
    let revoked = false;
    const selecting = resolveDynamicModelAuthProfile({
      provider,
      modelId: "synthetic-model",
      agentDir,
      authProfileId:
        scenario === "automatic" || scenario === "refresh failed" ? undefined : profileId,
      abortSignal: controller.signal,
      assertCurrent: () => {
        if (revoked) {
          throw refusal;
        }
      },
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let refreshing: ReturnType<typeof refreshProfile> | undefined;
    try {
      expect(await Promise.race([reads[0]!.entered.promise, selecting])).toBeUndefined();
      refreshing = refreshProfile(credential, state.agentDir());
      expect(await Promise.race([refresh.entered.promise, refreshing])).toBeUndefined();
      reads[0]!.release.resolve();
      expect(
        await Promise.race([joining.promise, reads[1]!.entered.promise, selecting]),
      ).toBeUndefined();
      expect(readCount).toBe(1);
      if (scenario === "cancelled") {
        controller.abort(refusal);
        expect(await selecting).toMatchObject({
          ok: false,
          error: { name: "AbortError", cause: refusal },
        });
        expect(readCount).toBe(1);
        const pending = loadPersistedSharedAuthProfileStore(state.env)?.profiles[profileId];
        expect(pending?.type === "oauth" && isPendingOAuthRefreshFence(pending)).toBe(true);
      } else if (scenario === "revoked") {
        revoked = true;
      } else if (
        scenario === "replaced while refreshing" ||
        scenario === "removed while refreshing"
      ) {
        await updateAuthProfileStoreWithLock({
          profileId,
          updater: (store) => {
            if (scenario === "removed while refreshing") {
              delete store.profiles[profileId];
            } else {
              store.profiles[profileId] = {
                type: "api_key",
                provider,
                key: "synthetic-replacement-key",
              };
            }
            return true;
          },
        });
      }
      if (scenario === "refresh failed") {
        refresh.release.reject(new Error("Synthetic refresh settlement failure"));
      } else {
        refresh.release.resolve();
      }
      const refreshResult = await refreshing;
      if (
        scenario !== "replaced while refreshing" &&
        scenario !== "removed while refreshing" &&
        scenario !== "refresh failed"
      ) {
        expect(refreshResult).toMatchObject({ ok: true, value: { credential: refresh.rotated } });
        expect(loadPersistedSharedAuthProfileStore(state.env)?.profiles[profileId]).toEqual(
          refresh.rotated,
        );
      } else if (scenario === "refresh failed") {
        expect(refreshResult).toMatchObject({
          ok: false,
          error: {
            name: "OAuthRefreshFailureError",
            cause: { name: "OAuthManagerRefreshError" },
          },
        });
      }
      if (scenario === "cancelled" || scenario === "revoked") {
        const result = await selecting;
        if (scenario === "revoked") {
          expect(result).toEqual({ ok: false, error: refusal });
        }
        expect(readCount).toBe(1);
        return;
      }
      expect(await Promise.race([reads[1]!.entered.promise, selecting])).toBeUndefined();
      if (scenario === "historical peer") {
        expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toBeUndefined();
      }
      if (scenario === "rotated during reread" || scenario === "removed during reread") {
        await updateAuthProfileStoreWithLock({
          profileId,
          updater: (store) => {
            if (scenario === "removed during reread") {
              delete store.profiles[profileId];
            } else {
              store.profiles[profileId] = {
                ...refresh.rotated,
                access: "synthetic-independent-access",
              };
            }
            return true;
          },
        });
      }
      reads[1]!.release.resolve();
      const result = await selecting;
      if (scenario === "rotated during reread" || scenario === "removed during reread") {
        expect(result).toMatchObject({
          ok: false,
          error: { name: "AuthProfileRuntimeReadStaleError" },
        });
      } else if (scenario === "removed while refreshing") {
        expect(result).toMatchObject({
          ok: false,
          error: { code: "selected_auth_profile_unavailable", profileId },
        });
      } else {
        expect(result).toEqual({
          ok: true,
          value:
            scenario === "refresh failed"
              ? {}
              : {
                  authProfileId: profileId,
                  authProfileMode: scenario === "replaced while refreshing" ? "api_key" : "oauth",
                },
        });
      }
      expect(readCount).toBe(2);
      expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledOnce();
    } finally {
      refresh.release.resolve();
      for (const read of reads) {
        read.release.resolve();
      }
      await Promise.allSettled([selecting, ...(refreshing ? [refreshing] : [])]);
    }
  });
});

it("does not join another physical database's refresh for the same provider and profile", async () => {
  await withOpenClawTestState({ label: "oauth-model-selection-isolation" }, async (state) => {
    const credential = originalCredential();
    await persistAuthProfileBatch({
      stateDir: state.stateDir,
      profiles: [{ profileId, credential }],
    });
    const agentDir = state.agentDir("independent");
    const independent: OAuthCredential = {
      ...credential,
      access: "synthetic-independent-access",
      refresh: "synthetic-independent-refresh",
      accountId: "synthetic-independent-account",
      copyToAgents: true,
    };
    await state.writeAuthProfiles(
      { version: 1, profiles: { [profileId]: independent } },
      "independent",
    );
    const databasePath = resolveAuthProfileDatabasePath(agentDir);
    expect(databasePath).not.toBe(resolveSharedAuthStorePath());
    const refresh = controlledRefresh(credential);
    const firstRead = { entered: createDeferredCore(), release: createDeferredCore() };
    const prepare = runtimeAuthProfileRowsCache.prepare.bind(runtimeAuthProfileRowsCache);
    let readCount = 0;
    vi.spyOn(runtimeAuthProfileRowsCache, "prepare").mockImplementation((db, reader) => {
      const prepared = prepare(db, reader);
      if (db !== databasePath || readCount++ > 0) {
        return prepared;
      }
      return {
        ...prepared,
        async read() {
          const rows = await prepared.read();
          firstRead.entered.resolve();
          await firstRead.release.promise;
          return rows;
        },
      };
    });
    let selected: unknown;
    const selecting = resolveDynamicModelAuthProfile({
      provider,
      modelId: "synthetic-model",
      agentDir,
      authProfileId: profileId,
    }).then(
      (value) => (selected = { ok: true, value }),
      (error: unknown) => (selected = { ok: false, error }),
    );
    let refreshing: ReturnType<typeof refreshProfile> | undefined;
    try {
      expect(await Promise.race([firstRead.entered.promise, selecting])).toBeUndefined();
      refreshing = refreshProfile(credential, state.agentDir());
      expect(await Promise.race([refresh.entered.promise, refreshing])).toBeUndefined();
      await updateAuthProfileStoreWithLock({
        agentDir,
        profileId,
        updater: (store) => {
          store.profiles[profileId] = {
            ...independent,
            access: "synthetic-new-independent-access",
          };
          return true;
        },
      });
      firstRead.release.resolve();
      await expect
        .poll(() => selected, {
          message: "Selection must finish while the unrelated database's refresh is held",
        })
        .toEqual({
          ok: true,
          value: { authProfileId: profileId, authProfileMode: "oauth" },
        });
      const pending = loadPersistedSharedAuthProfileStore(state.env)?.profiles[profileId];
      expect(pending?.type === "oauth" && isPendingOAuthRefreshFence(pending)).toBe(true);
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toEqual({
        ...independent,
        access: "synthetic-new-independent-access",
      });
      expect(readCount).toBe(2);
      expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledOnce();
    } finally {
      firstRead.release.resolve();
      refresh.release.resolve();
      await Promise.allSettled([selecting, ...(refreshing ? [refreshing] : [])]);
    }
  });
});
