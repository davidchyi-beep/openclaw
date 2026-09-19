import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { toErrorObject } from "../../infra/errors.js";
import { redactSensitiveText } from "../../logging/redact.js";
import {
  OAuthRefreshFailureError,
  readProviderOAuthRefreshFailure,
} from "./oauth-refresh-failure.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const oauthRefreshCleanupAggregates = new WeakSet<AggregateError>();

export function appendOAuthRefreshCleanupErrors(
  error: unknown,
  cleanupErrors: readonly unknown[],
): Error {
  const primaryError = toErrorObject(error, "OAuth refresh failed");
  if (cleanupErrors.length === 0) {
    return primaryError;
  }
  const normalizedCleanupErrors = cleanupErrors.map((cleanupError) =>
    toErrorObject(cleanupError, "OAuth refresh cleanup failed"),
  );
  const errors =
    primaryError instanceof AggregateError && oauthRefreshCleanupAggregates.has(primaryError)
      ? [...primaryError.errors, ...normalizedCleanupErrors]
      : [primaryError, ...normalizedCleanupErrors];
  const aggregate = new AggregateError(
    errors,
    "OAuth refresh failed and cleanup could not be completed.",
    { cause: errors[0] },
  );
  oauthRefreshCleanupAggregates.add(aggregate);
  return aggregate;
}

function readOAuthRefreshInitiatingError(error: unknown): unknown {
  return error instanceof AggregateError &&
    oauthRefreshCleanupAggregates.has(error) &&
    error.errors.length > 0
    ? error.errors[0]
    : error;
}

function createOAuthRefreshUserFacingCause(cause: unknown): unknown {
  if (cause instanceof Error && "code" in cause && cause.code === "refresh_contention") {
    // The structured error retains diagnostics; public cause traversal must not expose lock paths.
    return new Error(cause.message);
  }
  return cause;
}

/** Redacted refresh failure with private credentials retained for recovery. */
export class OAuthManagerRefreshError extends OAuthRefreshFailureError {
  override readonly profileId: string;
  readonly code?: string;
  readonly lockPath?: string;
  readonly #refreshedStore: AuthProfileStore;
  readonly #credential: OAuthCredential;

  constructor(params: {
    credential: OAuthCredential;
    attemptedCredentials?: OAuthCredential[];
    profileId: string;
    refreshedStore: AuthProfileStore;
    cause: unknown;
  }) {
    const initiatingCause = readOAuthRefreshInitiatingError(params.cause);
    const structuredCause = asOptionalObjectRecord(initiatingCause);
    const surfacedCause = createOAuthRefreshUserFacingCause(initiatingCause);
    const storedCredential = params.refreshedStore.profiles[params.profileId];
    const secrets = collectOAuthCredentialSecrets(
      params.credential,
      ...(params.attemptedCredentials ?? []),
      storedCredential?.type === "oauth" ? storedCredential : undefined,
    );
    const presentation = readProviderOAuthRefreshFailure(initiatingCause);
    const causeMessage = formatRedactedOAuthRefreshError(surfacedCause, secrets);
    super({
      provider: params.credential.provider,
      profileId: params.profileId,
      message: `OAuth token refresh failed for ${params.credential.provider}: ${causeMessage}`,
      cause: createRedactedOAuthRefreshCause(params.cause, secrets),
      errorType: presentation?.errorType,
      reason: presentation?.reason,
      status: presentation?.status,
      summary: presentation?.summary
        ? formatRedactedOAuthRefreshError(presentation.summary, secrets)
        : undefined,
    });
    this.name = "OAuthManagerRefreshError";
    this.#credential = params.credential;
    this.profileId = params.profileId;
    this.#refreshedStore = params.refreshedStore;
    if (structuredCause) {
      this.code = typeof structuredCause.code === "string" ? structuredCause.code : undefined;
      if (typeof structuredCause.lockPath === "string") {
        this.lockPath = structuredCause.lockPath;
      } else if (
        typeof structuredCause.cause === "object" &&
        structuredCause.cause !== null &&
        "lockPath" in structuredCause.cause &&
        typeof structuredCause.cause.lockPath === "string"
      ) {
        this.lockPath = structuredCause.cause.lockPath;
      }
    }
  }

  getRefreshedStore(): AuthProfileStore {
    return this.#refreshedStore;
  }

  getCredential(): OAuthCredential {
    return this.#credential;
  }

  toJSON(): { name: string; message: string; profileId: string; provider: string } {
    return {
      name: this.name,
      message: this.message,
      profileId: this.profileId,
      provider: this.provider,
    };
  }
}

function collectOAuthCredentialSecrets(
  ...credentials: Array<OAuthCredential | undefined>
): string[] {
  const secrets = new Set<string>();
  for (const credential of credentials) {
    for (const secret of [credential?.access, credential?.refresh, credential?.idToken]) {
      if (secret) {
        secrets.add(secret);
      }
    }
  }
  return Array.from(secrets).toSorted((a, b) => b.length - a.length);
}

function redactOAuthCredentialSecrets(message: string, secrets: string[]): string {
  let redacted = message;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

function formatRawErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    let formatted = error.message || error.name || "Error";
    let cause: unknown = error.cause;
    const seen = new Set<unknown>([error]);
    while (cause && !seen.has(cause)) {
      seen.add(cause);
      if (cause instanceof Error) {
        if (cause.message) {
          formatted += ` | ${cause.message}`;
        }
        cause = cause.cause;
      } else if (typeof cause === "string") {
        formatted += ` | ${cause}`;
        break;
      } else {
        break;
      }
    }
    return formatted;
  }
  if (
    typeof error === "string" ||
    typeof error === "number" ||
    typeof error === "boolean" ||
    typeof error === "bigint"
  ) {
    return String(error);
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}

function formatRedactedOAuthRefreshError(error: unknown, secrets: string[]): string {
  return redactSensitiveText(redactOAuthCredentialSecrets(formatRawErrorMessage(error), secrets));
}

function createRedactedOAuthRefreshCause(cause: unknown, secrets: string[]): Error {
  if (cause instanceof AggregateError) {
    const errors = cause.errors.map((error) => createRedactedOAuthRefreshCause(error, secrets));
    const sanitized = new AggregateError(
      errors,
      formatRedactedOAuthRefreshError(cause.message, secrets),
      errors.length > 0 ? { cause: errors[0] } : undefined,
    );
    sanitized.name = cause.name;
    return sanitized;
  }
  const surfacedCause = createOAuthRefreshUserFacingCause(cause);
  const redacted = formatRedactedOAuthRefreshError(surfacedCause, secrets);
  const sanitized = new Error(redacted);
  if (surfacedCause instanceof Error && surfacedCause.name) {
    sanitized.name = surfacedCause.name;
  }
  return sanitized;
}
