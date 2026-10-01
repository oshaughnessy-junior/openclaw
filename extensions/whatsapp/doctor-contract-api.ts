import { definePluginDoctorMigrationFromPlans } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { whatsappGroupActivationMigration } from "./src/group-activation-migration.js";
import { detectWhatsAppLegacyStateMigrations } from "./src/state-migrations.js";

export { legacyConfigRules, normalizeCompatibilityConfig } from "./config-doctor-api.js";

export const stateMigrations = [
  definePluginDoctorMigrationFromPlans({
    id: "whatsapp-legacy-state",
    label: "WhatsApp legacy state",
    resolvePlans: detectWhatsAppLegacyStateMigrations,
  }),
  whatsappGroupActivationMigration,
];
