import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { assignSessionOwner } from "../config/sessions/session-accessor.sqlite-owner.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.js";
import { coercePluginDoctorContractModule } from "../plugins/doctor-contract-module.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  withAgentDatabaseMaintenanceLease,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { createDoctorGroupActivationSessionAccess } from "./doctor-plugin-group-activation.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

const sourceKey = "agent:main:whatsapp:group:123@g.us";
const scopedKey = `${sourceKey}:thread:whatsapp-account-work`;
const childKey = "agent:main:subagent:activation-child";

it.each([
  { scoped: false, revokeAtCommit: false },
  { scoped: true, revokeAtCommit: false },
  { scoped: false, revokeAtCommit: true },
])(
  "migrates WhatsApp activation with backup and authority (scoped=$scoped, revoke=$revokeAtCommit)",
  async ({ scoped, revokeAtCommit }) => {
    await withOpenClawTestState({ label: "whatsapp-activation-doctor" }, async (state) => {
      const config: OpenClawConfig = {
        agents: { entries: { main: {} } },
        channels: { whatsapp: { accounts: { work: {}, personal: {} } } },
      };
      const storePath = resolveSessionStorePathCore(undefined, { agentId: "main", env: state.env });
      const source = { agentId: "main", storePath, env: state.env, sessionKey: sourceKey };
      replaceSessionEntrySync(source, {
        sessionId: "legacy-group",
        updatedAt: 100,
        groupActivation: "always",
        createdActor: { type: "human", source: "channel", id: "fixture-whatsapp-sender" },
        sandbox: "required",
        chatType: "group",
        groupId: "123@g.us",
        label: "retained source metadata",
        delivery: normalizeSessionDeliveryState({
          context: { channel: "whatsapp", accountId: "work", to: "123@g.us" },
          origin: { provider: "whatsapp", accountId: "work" },
        }),
      });
      const message = await appendTranscriptMessage(
        { ...source, sessionId: "legacy-group" },
        {
          message: { role: "user", content: "retained history" },
        },
      );
      expect(message?.appended).toBe(true);
      const transcriptBefore = await loadTranscriptEvents({ ...source, sessionId: "legacy-group" });
      expect(transcriptBefore).toMatchObject([
        { type: "session", id: "legacy-group" },
        { id: message.messageId, message: { content: "retained history" } },
      ]);
      const owner = assignSessionOwner(source, {
        owner: { type: "human", id: "fixture-owner" },
        assignedBy: { type: "human", id: "fixture-operator" },
        assignedAt: 99,
      });
      expect(owner).not.toBeNull();
      if (scoped) {
        replaceSessionEntrySync(
          { ...source, sessionKey: scopedKey },
          {
            sessionId: "scoped-group",
            updatedAt: 50,
            groupActivation: "mention",
          },
        );
      }
      replaceSessionEntrySync(
        { ...source, sessionKey: childKey },
        {
          sessionId: "activation-child",
          updatedAt: 101,
          parentSessionKey: sourceKey,
          spawnedBy: sourceKey,
          forkSource: {
            sessionKey: sourceKey,
            sessionId: "legacy-group",
            entryId: message!.messageId,
          },
        },
      );
      const before = loadExactSessionEntryReadOnly(source)?.entry;
      const sqlite = resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "main",
        env: state.env,
      }).path;
      const sourceRowBefore = openOpenClawAgentDatabase({
        agentId: "main",
        path: sqlite,
        env: state.env,
      })
        .db.prepare("SELECT * FROM session_nodes WHERE session_key = ?")
        .get(sourceKey);
      const artifact = new URL("../../extensions/whatsapp/doctor-contract-api.ts", import.meta.url)
        .href;
      const migration = coercePluginDoctorContractModule(
        await import(artifact),
      ).stateMigrations?.find((entry) => entry.id === "whatsapp-group-activation-account-scope");
      expect(migration).toBeDefined();
      let retiredRepair: (() => Promise<unknown>) | undefined;
      await withDoctorSqliteMaintenanceLock({
        env: state.env,
        operation: "WhatsApp group activation test",
        run: async (authority) =>
          withAgentDatabaseMaintenanceLease({ env: state.env }, async (lease) => {
            let revoked = false;
            const assertCurrent = () => {
              authority.assertCurrent();
              lease.assertOwned();
              if (revoked) {
                throw new Error("fixture authority expired before commit");
              }
            };
            const assertOwnedInTransaction = (database: DatabaseSync) => {
              lease.assertOwnedInTransaction(database);
              if (revokeAtCommit) {
                const agentDatabase = getOpenClawAgentDatabaseIfOpen({
                  agentId: "main",
                  path: sqlite,
                  env: state.env,
                });
                revoked ||= Boolean(
                  agentDatabase?.db
                    .prepare("SELECT 1 FROM session_nodes WHERE session_key = ?")
                    .get(scopedKey),
                );
              }
              assertCurrent();
            };
            const access = createDoctorGroupActivationSessionAccess({
              config,
              env: state.env,
              channelIds: ["whatsapp"],
              authority: { assertCurrent, assertOwnedInTransaction },
            });
            const captured = await access.inspectChannelGroupActivationSessions!();
            const capturedSource = captured.find((row) => row.sessionKey === sourceKey)!;
            retiredRepair = () =>
              access.repairChannelGroupActivationSession!({
                source: capturedSource,
                sessionKey: scopedKey,
              });
            const input = {
              config,
              env: state.env,
              stateDir: state.stateDir,
              oauthDir: state.statePath("credentials"),
              context: {
                ...access,
                openPluginStateKeyedStore: () => {
                  throw new Error("Session repair must not use plugin state");
                },
              },
            };
            expect(await migration!.detectLegacyState(input)).not.toBeNull();
            const result = await migration!.migrateLegacyState(input);
            if (revokeAtCommit) {
              expect(result.warnings.join(" ")).toContain(
                "fixture authority expired before commit",
              );
              expect(loadExactSessionEntryReadOnly(source)?.entry).toEqual(before);
              expect(
                loadExactSessionEntryReadOnly({ ...source, sessionKey: scopedKey }),
              ).toBeUndefined();
              expect(
                withOpenClawAgentDatabaseReadOnly(
                  ({ db }) => ({
                    target: db
                      .prepare("SELECT session_key FROM session_nodes WHERE session_key = ?")
                      .get(scopedKey),
                    history: db.prepare("SELECT count(*) AS count FROM transcript_events").get(),
                  }),
                  { agentId: "main", path: sqlite, env: state.env },
                ),
              ).toMatchObject({
                found: true,
                value: {
                  target: undefined,
                  history: { count: transcriptBefore.length },
                },
              });
            } else {
              expect(result.warnings).toEqual([]);
              expect(loadExactSessionEntryReadOnly(source)?.entry).toMatchObject({
                sessionId: "legacy-group",
                label: "retained source metadata",
              });
              expect(loadExactSessionEntryReadOnly(source)?.entry.groupActivation).toBeUndefined();
              const target = loadExactSessionEntryReadOnly({
                ...source,
                sessionKey: scopedKey,
              })?.entry;
              expect(target).toMatchObject({
                groupActivation: scoped ? "mention" : "always",
              });
              if (scoped) {
                expect(target?.sessionId).toBe("scoped-group");
              } else {
                expect(target?.sessionId).toBeTruthy();
                expect(target?.sessionId).not.toBe("legacy-group");
                expect(target).toMatchObject({
                  createdVia: "plugin",
                  createdActor: before?.createdActor,
                  owner,
                  sandbox: "required",
                  groupId: "123@g.us",
                  delivery: before?.delivery,
                });
                expect(target).not.toHaveProperty("label");
                expect(
                  await loadTranscriptEvents({
                    ...source,
                    sessionKey: scopedKey,
                    sessionId: target!.sessionId,
                  }),
                ).toEqual([expect.objectContaining({ type: "session", id: target!.sessionId })]);
              }
              expect(
                await loadTranscriptEvents({
                  ...source,
                  sessionKey: sourceKey,
                  sessionId: "legacy-group",
                }),
              ).toEqual(transcriptBefore);
              expect(await migration!.detectLegacyState(input)).toBeNull();
            }
            const parentKey = sourceKey;
            expect(
              loadExactSessionEntryReadOnly({ ...source, sessionKey: childKey })?.entry,
            ).toMatchObject({
              parentSessionKey: parentKey,
              spawnedBy: parentKey,
              forkSource: {
                sessionKey: parentKey,
                sessionId: "legacy-group",
                entryId: message!.messageId,
              },
            });
            const backups = (await fs.readdir(path.dirname(sqlite))).filter((name) =>
              name.startsWith(`${path.basename(sqlite)}.pre-startup-migration-`),
            );
            expect(backups).toHaveLength(1);
            const backup = new DatabaseSync(path.join(path.dirname(sqlite), backups[0]!), {
              readOnly: true,
            });
            try {
              const row = backup
                .prepare("SELECT * FROM session_nodes WHERE session_key = ?")
                .get(sourceKey);
              expect(row).toEqual(sourceRowBefore);
              expect(
                backup
                  .prepare(
                    "SELECT count(*) AS count FROM transcript_events WHERE session_id = 'legacy-group'",
                  )
                  .get(),
              ).toMatchObject({ count: transcriptBefore.length });
            } finally {
              backup.close();
            }
          }),
      });
      await expect(retiredRepair!()).rejects.toThrow("authority has expired");
    });
  },
);
