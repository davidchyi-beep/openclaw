import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { createGatewayRequestContext } from "../../../gateway/server-request-context.js";
import { makeContextParams } from "../../../gateway/server-request-context.test-support.js";
import { publishSystemEventStoreResolver } from "../../../infra/system-event-ownership.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { ensureTaskRegistryReady, getTaskById } from "../../../tasks/runtime-internal.js";
import { publishTaskRecordAfterAtomicStore } from "../../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-runtime.test-helpers.js";
import { settleSubagentCompletionDelivery } from "../completion/subagent-completion-admission.store.js";
import {
  failedRecords,
  records,
} from "../completion/subagent-completion-admission.test-helpers.js";
import { loadPendingFinalDeliveryPayload } from "./subagent-registry-lifecycle-delivery.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import {
  activateSubagentRegistry,
  initSubagentRegistry,
  leasePendingAgentSteeringItems,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-child-store-replaced-"));
  resetSubagentRegistryForTests({ persist: false });
  testing.setDepsForTest({ getRuntimeConfig: () => ({}) });
  publishSystemEventStoreResolver(() => "original-store");
});

afterEach(() => {
  resetSubagentRegistryForTests({ persist: false });
  resetTaskRegistryForTests({ persist: false });
  publishSystemEventStoreResolver(undefined);
  testing.setDepsForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each(["same", "replaced", "restore", "failed", "delivered"] as const)(
  "keeps automatic child notification disposition through store publication: %s",
  async (change) => {
    const input = change === "failed" ? failedRecords("failed", { status: "error" }) : records();
    input.subagent.requesterStorePath = "original-store";
    input.subagent.controllerStorePath = "original-store";
    input.subagent.cleanupCompletedAt = undefined;
    input.subagent.delivery = {
      status: change === "delivered" ? "delivered" : "pending",
      ...(change === "delivered" ? { deliveredAt: Date.now(), announcedAt: Date.now() } : {}),
      payload: loadPendingFinalDeliveryPayload(input.subagent),
    };
    const taskOutcome = {
      status: input.task.status,
      terminalOutcome: input.task.terminalOutcome,
      error: input.task.error,
    };
    const database = openOpenClawStateDatabase();
    settleSubagentCompletionDelivery({ subagent: input.subagent, task: input.task });
    const receipt = expectDefined(
      loadSubagentRegistryFromSqlite().get(input.subagent.runId)?.delivery,
      "persisted notification receipt",
    );
    subagentRuns.set(input.subagent.runId, input.subagent);
    ensureTaskRegistryReady();
    publishTaskRecordAfterAtomicStore(input.task);
    initSubagentRegistry();
    if (change === "restore") {
      resetSubagentRegistryForTests({ persist: false });
      publishSystemEventStoreResolver(() => "replacement-store");
      initSubagentRegistry();
      const context = createGatewayRequestContext(makeContextParams());
      context.resolveGatewayContext = () => context;
      activateSubagentRegistry(() => context);
    } else {
      publishSystemEventStoreResolver(() =>
        change === "same" ? "original-store" : "replacement-store",
      );
    }
    publishSystemEventStoreResolver(() => "original-store");
    const persisted = loadSubagentRegistryFromSqlite().get(input.subagent.runId);
    expect(persisted?.completion?.resultText).toBe("canonical result");
    const task = getTaskById(input.task.taskId);
    expect({
      status: task?.status,
      terminalOutcome: task?.terminalOutcome,
      error: task?.error,
    }).toEqual(taskOutcome);
    expect(
      database.db
        .prepare("SELECT id FROM delivery_queue_entries WHERE entry_kind = 'systemEvent'")
        .all(),
    ).toEqual([]);
    if (change === "delivered") {
      expect(persisted?.delivery).toEqual(receipt);
    } else if (change !== "same") {
      expect(persisted?.delivery).toMatchObject({
        status: "suspended",
        disposition: "intentional_non_delivery",
        lastError: "store replaced",
        payload: receipt.payload,
      });
      expect(persisted?.requesterSettleWake).toBeUndefined();
    }
    const lease = await leasePendingAgentSteeringItems({
      requesterSessionKey: input.subagent.requesterSessionKey,
      leaseId: "after-store-publication",
    });
    if (change === "same") {
      expect(lease?.prompt).toContain("canonical result");
    } else {
      expect(lease).toBeUndefined();
    }
  },
);
