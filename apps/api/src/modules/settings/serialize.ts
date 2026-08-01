import type { QuietHours, WorkspaceSettings } from "../../db/schema.js";
import { normalizeAmount } from "../../lib/money.js";

export interface SettingsDto {
  workspaceId: string;
  aiMonthlyBudget: string | null;
  approvalMode: WorkspaceSettings["approvalMode"];
  spendCeiling: string | null;
  killSwitch: boolean;
  categoryCeilings: Record<string, string>;
  quietHours: QuietHours | null;
  primaryChannel: WorkspaceSettings["primaryChannel"];
  policyVersion: number;
  currency: string;
  updatedAt: string;
}

export function serializeSettings(settings: WorkspaceSettings): SettingsDto {
  const currency = settings.currency;
  return {
    workspaceId: settings.workspaceId,
    aiMonthlyBudget: settings.aiMonthlyBudget
      ? normalizeAmount(settings.aiMonthlyBudget, currency)
      : null,
    approvalMode: settings.approvalMode,
    spendCeiling: settings.spendCeiling
      ? normalizeAmount(settings.spendCeiling, currency)
      : null,
    killSwitch: settings.killSwitch,
    categoryCeilings: Object.fromEntries(
      Object.entries(settings.categoryCeilings ?? {}).map(([key, value]) => [
        key,
        normalizeAmount(value, currency),
      ]),
    ),
    quietHours: settings.quietHoursJson ?? null,
    primaryChannel: settings.primaryChannel,
    policyVersion: settings.policyVersion,
    currency,
    updatedAt: settings.updatedAt.toISOString(),
  };
}
