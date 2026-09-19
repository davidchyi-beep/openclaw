import { resolveIdentityPathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { publishSystemEventStoreResolver } from "../../infra/system-event-ownership.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { getRuntimeConfig } from "../io.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  resolveExplicitSessionStorePathForScope,
  resolveSessionStorePathCore,
  type SessionStorePathScope,
} from "./paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

export function resolveSessionStoreIdentity(
  scope: SessionStorePathScope,
  cfg?: OpenClawConfig,
): string {
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  return resolveIdentityPathViaExistingAncestorSync(
    resolveSqliteTargetFromSessionStorePath(resolveSessionStorePathForScope(scope, cfg), {
      ...scope,
      agentId,
    }).path,
  );
}

export function publishSystemEventStoreConfig(cfg: OpenClawConfig): void {
  const env = { ...process.env };
  const paths = new Map<string, string>();
  publishSystemEventStoreResolver((sessionKey, owner) => {
    const agentId = resolveAgentIdFromSessionKey(sessionKey, owner);
    const scope = { sessionKey, agentId, env };
    const key = JSON.stringify([agentId, resolveSessionStorePathForScope(scope, cfg)]);
    if (!paths.has(key)) paths.set(key, resolveSessionStoreIdentity(scope, cfg));
    return paths.get(key)!;
  });
}

export function resolveSessionStorePathForScope(
  scope: SessionStorePathScope,
  config?: OpenClawConfig,
): string {
  const explicitStorePath = resolveExplicitSessionStorePathForScope(scope);
  if (explicitStorePath) {
    return explicitStorePath;
  }
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  return resolveSessionStorePathCore((config ?? getRuntimeConfig()).session?.store, {
    agentId,
    env: scope.env,
  });
}
