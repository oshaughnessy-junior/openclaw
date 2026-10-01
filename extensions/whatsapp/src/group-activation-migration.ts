import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { listWhatsAppAccountIds } from "./account-ids.js";
import { resolveWhatsAppGroupSessionKey } from "./group-session-key.js";

type Input = Parameters<PluginDoctorStateMigration["migrateLegacyState"]>[0];

async function inspectGroupActivations(input: Input) {
  const { context, config } = input;
  const accounts = [...new Set(listWhatsAppAccountIds(config).map(normalizeAccountId))];
  // The unscoped key is the current default account's key, not a migration source.
  if (accounts.includes(DEFAULT_ACCOUNT_ID)) {
    return { repairs: [], warnings: [] };
  }
  if (!context.inspectChannelGroupActivationSessions) {
    throw new Error(
      "WhatsApp group activation migration requires the current Doctor session owner.",
    );
  }
  const rows = await context.inspectChannelGroupActivationSessions();
  const warnings: string[] = [];
  const repairs = rows.flatMap((source) => {
    if (
      !source.sessionKey.includes(":whatsapp:group:") ||
      source.sessionKey.includes(":thread:") ||
      source.entry.groupActivation === undefined
    ) {
      return [];
    }
    const delivery = source.entry.delivery;
    const channels =
      delivery?.kind === "external"
        ? [delivery.route.channel, delivery.context.channel, delivery.origin.provider]
            .map((channel) => channel?.trim().toLowerCase())
            .filter(Boolean)
        : [];
    const recorded =
      delivery?.kind === "external"
        ? [delivery.route.accountId, delivery.context.accountId, delivery.origin.accountId]
            .filter((account): account is string => Boolean(account?.trim()))
            .map(normalizeAccountId)
        : [];
    if (
      channels.some((channel) => channel !== "whatsapp") ||
      (recorded.length > 0 && !channels.includes("whatsapp"))
    ) {
      warnings.push(
        `Retained conflicting WhatsApp delivery provenance at ${source.sessionKey}; use /activation ${source.entry.groupActivation} in the intended account's group session, then clear groupActivation on this obsolete source with sessions.patch and rerun openclaw doctor --fix.`,
      );
      return [];
    }
    const identities = [...new Set(recorded)];
    const accountId =
      identities.length === 1
        ? identities[0]
        : identities.length === 0 && accounts.length === 1
          ? accounts[0]
          : undefined;
    if (accountId === DEFAULT_ACCOUNT_ID) {
      warnings.push(
        `Retained WhatsApp group activation for an unconfigured default account at ${source.sessionKey}; use /activation ${source.entry.groupActivation} in the intended account's group session, then clear groupActivation on this obsolete source with sessions.patch and rerun openclaw doctor --fix.`,
      );
      return [];
    }
    if (!accountId) {
      warnings.push(
        `Retained ambiguous WhatsApp group activation at ${source.sessionKey}; use /activation ${source.entry.groupActivation} in the intended account's group session, then clear groupActivation on this obsolete source with sessions.patch and rerun openclaw doctor --fix.`,
      );
      return [];
    }
    const sessionKey = resolveWhatsAppGroupSessionKey({ sessionKey: source.sessionKey, accountId });
    const destination = rows.find(
      (candidate) =>
        candidate.scopeId === source.scopeId &&
        candidate.agentId === source.agentId &&
        candidate.sessionKey === sessionKey,
    );
    return [{ source, destination, sessionKey }];
  });
  return { repairs, warnings };
}

export const whatsappGroupActivationMigration: PluginDoctorStateMigration = {
  id: "whatsapp-group-activation-account-scope",
  label: "WhatsApp account-scoped group activation",
  phase: "after-session-repair",
  async collectBackupResources({ config, env }) {
    const { listAgentIds } = await import("openclaw/plugin-sdk/agent-scope-runtime");
    const { resolveSessionStoreBackupPaths, resolveStorePath } =
      await import("openclaw/plugin-sdk/session-store-runtime");
    return listAgentIds(config).flatMap((agentId) =>
      resolveSessionStoreBackupPaths({
        agentId,
        storePath: resolveStorePath(config.session?.store, { agentId, env }),
      })
        .filter((path) => path.endsWith(".sqlite"))
        .map((path) => ({ path, kind: "sqlite" as const })),
    );
  },
  async detectLegacyState(input) {
    if (!input.config.channels?.whatsapp) {
      return null;
    }
    const { repairs, warnings } = await inspectGroupActivations(input);
    const preview = [
      ...(repairs.length
        ? [`- WhatsApp group activation: ${repairs.length} account-scoped session repair(s)`]
        : []),
      ...warnings,
    ];
    return preview.length ? { preview } : null;
  },
  async migrateLegacyState(input) {
    const { repairs, warnings } = await inspectGroupActivations(input);
    if (repairs.length && !input.context.repairChannelGroupActivationSession) {
      throw new Error(
        "WhatsApp group activation repair requires offline Doctor maintenance ownership.",
      );
    }
    const changes: string[] = [];
    for (const repair of repairs) {
      try {
        const result = await input.context.repairChannelGroupActivationSession!(repair);
        changes.push(
          ...result.changes,
          `Migrated WhatsApp group activation to ${repair.sessionKey}.`,
        );
      } catch (error) {
        warnings.push(
          `WhatsApp group activation repair for ${repair.source.sessionKey} did not complete: ${String(error)}. Inspect Doctor's pre-migration backups and rerun openclaw doctor --fix.`,
        );
      }
    }
    return { changes, warnings, warningDisposition: "recoverable" };
  },
};
