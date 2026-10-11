import { z } from "zod";

export const updateLoginSettingsSchema = z.strictObject({
  expectedVersion: z.number().int().positive().safe(),
  liteauthEnabled: z.boolean(),
});

export type UpdateLoginSettingsInput = z.infer<
  typeof updateLoginSettingsSchema
>;

export type LoginSettings = {
  version: number;
  liteauthEnabled: boolean;
  updatedAt: number;
  updatedByUserId: string | null;
};

export type LoginSettingChange = {
  id: string;
  actorUserId: string;
  actorDisplayName: string;
  previousVersion: number;
  nextVersion: number;
  previousLiteauthEnabled: boolean;
  liteauthEnabled: boolean;
  createdAt: number;
};

export type LoginSettingsResponse = {
  config: LoginSettings;
  recentChanges: LoginSettingChange[];
};
