import { expect, it, vi } from "vitest";
import { whatsappGroupActivationMigration } from "./group-activation-migration.js";

it("retains unknown and conflicting account ownership without dispatching a session move", async () => {
  const repair = vi.fn(async () => ({ changes: [] }));
  const result = await whatsappGroupActivationMigration.migrateLegacyState({
    config: { channels: { whatsapp: { accounts: { work: {}, personal: {} } } } },
    env: {},
    stateDir: "/fixture",
    oauthDir: "/fixture/credentials",
    context: {
      openPluginStateKeyedStore: () => {
        throw new Error("Session repair must not use plugin state");
      },
      inspectChannelGroupActivationSessions: async () => [
        {
          scopeId: "fixture",
          agentId: "main",
          sessionKey: "agent:main:whatsapp:group:unknown@g.us",
          entry: { sessionId: "unknown-account", groupActivation: "always" },
        },
        {
          scopeId: "fixture",
          agentId: "main",
          sessionKey: "agent:main:whatsapp:group:conflict@g.us",
          entry: {
            sessionId: "conflicting-account",
            groupActivation: "always",
            delivery: normalizeSessionDeliveryState({
              context: { channel: "whatsapp", accountId: "work", to: "conflict@g.us" },
              origin: { provider: "whatsapp", accountId: "personal" },
            }),
          },
        },
        {
          scopeId: "fixture",
          agentId: "main",
          sessionKey: "agent:main:whatsapp:group:foreign@g.us",
          entry: {
            sessionId: "foreign-channel",
            groupActivation: "always",
            delivery: normalizeSessionDeliveryState({
              context: { channel: "telegram", accountId: "work", to: "foreign@g.us" },
              origin: { provider: "telegram", accountId: "work" },
            }),
          },
        },
        {
          scopeId: "fixture",
          agentId: "main",
          sessionKey: "agent:main:whatsapp:group:removed-default@g.us",
          entry: {
            sessionId: "removed-default-account",
            groupActivation: "always",
            delivery: normalizeSessionDeliveryState({
              context: { channel: "whatsapp", accountId: "default", to: "removed-default@g.us" },
              origin: { provider: "whatsapp", accountId: "default" },
            }),
          },
        },
      ],
      repairChannelGroupActivationSession: repair,
    },
  });
  expect(repair).not.toHaveBeenCalled();
  expect(result.changes).toEqual([]);
  expect(result.warningDisposition).toBe("recoverable");
  expect(result.warnings).toEqual([
    expect.stringContaining("unknown@g.us; use /activation always"),
    expect.stringContaining("conflict@g.us; use /activation always"),
    expect.stringContaining("foreign@g.us; use /activation always"),
    expect.stringContaining("removed-default@g.us; use /activation always"),
  ]);
});

it.each([
  { accounts: { default: {}, work: {} } },
  { accounts: { Default: {}, work: {} } },
  { accounts: { work: {} }, authDir: "/fixture/default-auth" },
])("preserves the current default account's unscoped activation ($accounts)", async (whatsapp) => {
  const repair = vi.fn(async () => ({ changes: [] }));
  const result = await whatsappGroupActivationMigration.migrateLegacyState({
    config: { channels: { whatsapp } },
    env: {},
    stateDir: "/fixture",
    oauthDir: "/fixture/credentials",
    context: {
      openPluginStateKeyedStore: () => {
        throw new Error("Session repair must not use plugin state");
      },
      inspectChannelGroupActivationSessions: async () => [
        {
          scopeId: "fixture",
          agentId: "main",
          sessionKey: "agent:main:whatsapp:group:123@g.us",
          entry: {
            sessionId: "current-default-session",
            groupActivation: "always",
            delivery: normalizeSessionDeliveryState({
              context: { channel: "whatsapp", accountId: "work", to: "123@g.us" },
              origin: { provider: "whatsapp", accountId: "work" },
            }),
          },
        },
      ],
      repairChannelGroupActivationSession: repair,
    },
  });
  expect(repair).not.toHaveBeenCalled();
  expect(result.changes).toEqual([]);
  expect(result.warnings).toEqual([]);
});

it("preserves recorded account identity when the delivery context omits its channel", async () => {
  const delivery = normalizeSessionDeliveryState({
    context: { channel: "whatsapp", accountId: "work", to: "123@g.us" },
    origin: { provider: "whatsapp" },
  });
  if (delivery.kind !== "external") {
    throw new Error("Expected a canonical external delivery fixture");
  }
  delete delivery.context.channel;
  delete delivery.origin.accountId;
  const repair = vi.fn(async () => ({ changes: [] }));
  const result = await whatsappGroupActivationMigration.migrateLegacyState({
    config: { channels: { whatsapp: { accounts: { personal: {} } } } },
    env: {},
    stateDir: "/fixture",
    oauthDir: "/fixture/credentials",
    context: {
      openPluginStateKeyedStore: () => {
        throw new Error("Session repair must not use plugin state");
      },
      inspectChannelGroupActivationSessions: async () => [
        {
          scopeId: "fixture",
          agentId: "main",
          sessionKey: "agent:main:whatsapp:group:123@g.us",
          entry: { sessionId: "recorded-work-account", groupActivation: "always", delivery },
        },
      ],
      repairChannelGroupActivationSession: repair,
    },
  });
  expect(result.warnings).toEqual([]);
  expect(repair).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionKey: "agent:main:whatsapp:group:123@g.us:thread:whatsapp-account-work",
    }),
  );
});
import { normalizeSessionDeliveryState } from "openclaw/plugin-sdk/session-store-runtime";
