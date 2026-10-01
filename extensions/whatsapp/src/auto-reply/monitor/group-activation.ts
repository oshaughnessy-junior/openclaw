import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getSessionEntryAsync, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveWhatsAppInboundPolicy } from "../../inbound-policy.js";
import { normalizeGroupActivation } from "./group-activation.runtime.js";

/** Reads only the activation attached to this account's canonical session. */
export async function resolveGroupActivationFor(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  agentId: string;
  sessionKey: string;
  conversationId: string;
}) {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const sessionScope = { storePath, agentId: params.agentId };
  const scopedEntry = await getSessionEntryAsync({
    ...sessionScope,
    sessionKey: params.sessionKey,
  });
  const requireMention = resolveWhatsAppInboundPolicy({
    cfg: params.cfg,
    accountId: params.accountId,
  }).resolveConversationRequireMention(params.conversationId);
  const defaultActivation = !requireMention ? "always" : "mention";
  return normalizeGroupActivation(scopedEntry?.groupActivation) ?? defaultActivation;
}
