import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { loadExactSessionEntryCandidatesReadOnlyBatch } from "./session-accessor.sqlite-exact-read.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("exact SQLite session batch availability", () => {
  it.each(["database-missing", "schema-missing", "table-missing"] as const)(
    "preserves %s as a failed read for every requested key",
    (reason) => {
      const scope = {
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-exact-unavailable-") },
      };
      const databasePath = resolveOpenClawAgentSqlitePath(scope);
      if (reason === "schema-missing") {
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        new DatabaseSync(databasePath).close();
      } else if (reason === "table-missing") {
        const { db } = openOpenClawAgentDatabase(scope);
        clearNodeSqliteKyselyCacheForDatabase(db);
        const prepare = db.prepare.bind(db);
        const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
          if (sql.includes('from "session_key_contract"')) {
            // Lose the table after schema admission, before reading its metadata.
            prepareSpy.mockRestore();
            db.exec("DROP TABLE session_key_contract");
          }
          return prepare(sql);
        });
      }
      const healthy = {
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-exact-available-") },
      };
      openOpenClawAgentDatabase(healthy);
      const results = loadExactSessionEntryCandidatesReadOnlyBatch([
        { ...scope, sessionKeys: ["agent:main:first"] },
        { ...healthy, sessionKeys: ["agent:main:absent"] },
        { ...scope, sessionKeys: ["agent:main:second"] },
      ]);
      const error =
        reason === "table-missing"
          ? { code: "ERR_SQLITE_ERROR", message: expect.stringContaining("no such table:") }
          : { name: "SessionMetadataUnavailableError", reason };
      expect(results).toMatchObject([
        { ok: false, error },
        { ok: true, value: [] },
        { ok: false, error },
      ]);
    },
  );

  it("keeps a present empty store and an empty key request successful", () => {
    const scope = {
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-exact-empty-") },
    };
    openOpenClawAgentDatabase(scope);
    expect(
      loadExactSessionEntryCandidatesReadOnlyBatch([
        { ...scope, sessionKeys: ["agent:main:absent"] },
        { ...scope, sessionKeys: [" "] },
      ]),
    ).toEqual([
      { ok: true, value: [] },
      { ok: true, value: [] },
    ]);
  });
});
