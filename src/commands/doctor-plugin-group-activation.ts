import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  createSessionEntryWithTranscript,
  listSessionEntriesReadOnly,
} from "../config/sessions/session-accessor.js";
import { readExactSessionEntryRowForCanonicalRepair } from "../config/sessions/session-accessor.sqlite-canonical-repair.js";
import { rewriteDoctorSessionEntries } from "../config/sessions/session-accessor.sqlite-doctor-rewrite.js";
import {
  buildSessionCreationStamp,
  inheritSessionCreationPolicy,
} from "../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
import type { PluginDoctorRepairAuthority } from "../infra/state-migrations.types.js";
import type {
  PluginDoctorGroupActivationSession,
  PluginDoctorStateMigrationContext,
} from "../plugins/doctor-contract-module.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { withAgentDatabaseMaintenanceSessionRepair } from "../state/openclaw-agent-db-lease.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { backupDoctorMigrationDatabases } from "./doctor-migration-backup.js";
import { listCanonicalSessionStores } from "./doctor-session-canonical-candidates.js";

type InspectedSession = ReturnType<typeof listCanonicalSessionStores>[number] & {
  sessionKey: string;
  entry: SessionEntry;
};

/** Channel policy stays plugin-owned; this capability owns backed-up activation transfer. */
export function createDoctorGroupActivationSessionAccess(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  channelIds: readonly string[];
  authority?: PluginDoctorRepairAuthority;
}): Pick<
  PluginDoctorStateMigrationContext,
  "inspectChannelGroupActivationSessions" | "repairChannelGroupActivationSession"
> {
  const inspected = new WeakMap<PluginDoctorGroupActivationSession, InspectedSession>();
  const channels = new Set(params.channelIds);
  const backedUp = new Set<string>();
  return {
    async inspectChannelGroupActivationSessions() {
      params.authority?.assertCurrent();
      const rows: PluginDoctorGroupActivationSession[] = [];
      for (const store of listCanonicalSessionStores({ cfg: params.config, env: params.env })) {
        for (const { sessionKey } of listSessionEntriesReadOnly({
          agentId: store.agentId,
          storePath: store.storePath,
          env: params.env,
        })) {
          const parsed = parseAgentSessionKey(sessionKey);
          const [channel, kind] = parsed?.rest.split(":") ?? [];
          if (!channel || !channels.has(channel) || kind !== "group") {
            continue;
          }
          const captured = withOpenClawAgentDatabaseReadOnly(
            (database) => readExactSessionEntryRowForCanonicalRepair(database, sessionKey)?.entry,
            { agentId: store.agentId, path: store.sqlitePath, env: params.env },
          );
          if (!captured.found || !captured.value) {
            continue;
          }
          const inspectedEntry = captured.value;
          const row: PluginDoctorGroupActivationSession = {
            scopeId: store.sqlitePath,
            agentId: store.agentId,
            sessionKey,
            entry: structuredClone({
              sessionId: inspectedEntry.sessionId,
              groupActivation: inspectedEntry.groupActivation,
              delivery: inspectedEntry.delivery,
            }),
          };
          inspected.set(row, {
            ...store,
            sessionKey,
            entry: structuredClone(inspectedEntry),
          });
          rows.push(row);
        }
      }
      params.authority?.assertCurrent();
      return rows;
    },
    ...(params.authority
      ? {
          async repairChannelGroupActivationSession(
            input: Parameters<
              NonNullable<PluginDoctorStateMigrationContext["repairChannelGroupActivationSession"]>
            >[0],
          ) {
            const authority = params.authority!;
            authority.assertCurrent();
            const source = inspected.get(input.source);
            if (!source) {
              throw new Error("Group activation repair requires an inspected source.");
            }
            return withAgentDatabaseMaintenanceSessionRepair(
              {
                agentId: source.agentId,
                path: source.sqlitePath,
                env: params.env,
                assertCurrent: () => authority.assertCurrent(),
                assertOwnedInTransaction: (database) =>
                  authority.assertOwnedInTransaction(database),
              },
              async () => {
                let destination = input.destination && inspected.get(input.destination);
                const sourceAddress = parseAgentSessionKey(source.sessionKey);
                const targetAddress = parseAgentSessionKey(input.sessionKey);
                if (
                  (input.destination && !destination) ||
                  !input.sessionKey.startsWith(`${source.sessionKey}:thread:`) ||
                  sourceAddress?.agentId !== targetAddress?.agentId ||
                  sourceAddress?.rest.split(":")[0] !== targetAddress?.rest.split(":")[0] ||
                  targetAddress?.rest.split(":")[1] !== "group" ||
                  (destination &&
                    (destination.sessionKey !== input.sessionKey ||
                      destination.sqlitePath !== source.sqlitePath))
                ) {
                  throw new Error(
                    "Group activation repair requires inspected rows in one channel store.",
                  );
                }
                const activation =
                  destination?.entry.groupActivation ?? source.entry.groupActivation;
                if (activation !== "always" && activation !== "mention") {
                  throw new Error(
                    "Group activation repair requires an existing activation setting.",
                  );
                }
                const backup = backedUp.has(source.sqlitePath)
                  ? { changes: [] }
                  : await backupDoctorMigrationDatabases({
                      env: params.env,
                      pendingDatabasePaths: [source.sqlitePath],
                      databasePaths: [source.sqlitePath],
                      maintenanceAuthority: authority,
                    });
                authority.assertCurrent();
                backedUp.add(source.sqlitePath);
                const scope = {
                  agentId: source.agentId,
                  storePath: source.storePath,
                  env: params.env,
                };
                const readEntry = (sessionKey: string) =>
                  readExactSessionEntryRowForCanonicalRepair(
                    openOpenClawAgentDatabase({
                      agentId: source.agentId,
                      path: source.sqlitePath,
                      env: params.env,
                    }),
                    sessionKey,
                  )?.entry;
                if (!destination) {
                  const sessionId = randomUUID();
                  const now = Date.now();
                  const assertCreationCurrent = () => {
                    authority.assertCurrent();
                    const current = readEntry(input.sessionKey);
                    if (
                      !isDeepStrictEqual(readEntry(source.sessionKey), source.entry) ||
                      (current && current.sessionId !== sessionId)
                    ) {
                      throw new Error(
                        "Group activation session changed during Doctor creation; inspect again.",
                      );
                    }
                  };
                  // Create first, then retire the old field. An interrupted repair can reuse
                  // this valid destination while all historical rows and references remain intact.
                  const created = await createSessionEntryWithTranscript(
                    { ...scope, sessionKey: input.sessionKey },
                    ({ existingEntry }) =>
                      existingEntry
                        ? {
                            ok: false,
                            error:
                              "Scoped group session appeared during Doctor repair; inspect again.",
                          }
                        : {
                            ok: true,
                            entry: {
                              ...buildSessionCreationStamp({
                                via: "plugin",
                                now,
                                ...inheritSessionCreationPolicy(
                                  source.entry,
                                  source.entry.createdActor,
                                ),
                              }),
                              sessionId,
                              sessionStartedAt: now,
                              updatedAt: now,
                              chatType: "group",
                              groupId: source.entry.groupId,
                              delivery: source.entry.delivery,
                              groupActivation: activation,
                            },
                          },
                    {
                      commitGuard: assertCreationCurrent,
                      resolveOwnerAssignment: () => source.entry.owner,
                      withCommit: async (run) => {
                        assertCreationCurrent();
                        const result = await run(assertCreationCurrent);
                        assertCreationCurrent();
                        return result;
                      },
                    },
                  );
                  if (!created.ok) {
                    throw new Error(`Could not create scoped group session: ${created.error}`);
                  }
                  const entry = readEntry(input.sessionKey);
                  if (!entry || entry.sessionId !== sessionId) {
                    throw new Error(
                      "Scoped group session changed after Doctor creation; inspect again.",
                    );
                  }
                  destination = {
                    ...source,
                    sessionKey: input.sessionKey,
                    entry: structuredClone(entry),
                  };
                }
                const target = destination;
                let compared = false;
                const rewritten = rewriteDoctorSessionEntries({
                  scope,
                  sessionKeys: [source.sessionKey, target.sessionKey],
                  assertCurrent: () => authority.assertCurrent(),
                  transform(entry, sessionKey) {
                    authority.assertCurrent();
                    if (!compared) {
                      for (const candidate of [source, target]) {
                        if (!isDeepStrictEqual(readEntry(candidate.sessionKey), candidate.entry)) {
                          throw new Error(
                            "Group activation session changed during Doctor repair; inspect again.",
                          );
                        }
                      }
                      compared = true;
                    }
                    if (sessionKey === source.sessionKey) {
                      const { groupActivation: _retired, ...retained } = entry;
                      return retained;
                    }
                    return entry.groupActivation === undefined
                      ? { ...entry, groupActivation: activation }
                      : entry;
                  },
                });
                if (rewritten === 0) {
                  throw new Error(
                    "Group activation session disappeared during Doctor repair; inspect again.",
                  );
                }
                return { changes: backup.changes };
              },
            );
          },
        }
      : {}),
  };
}
