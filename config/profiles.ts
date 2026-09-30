import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { SUPPORTED_ENVIRONMENTS, type TestEnvironment } from '../src/types/config.types';
import { ConfigurationError } from './errors';

/**
 * Tester profiles – each QA keeps their own brand ID + API key per environment
 * in `profiles.local.json` (git-ignored, never committed). Select one with
 * `TEST_PROFILE=<id>` or from the launcher UI (`npm run launcher`).
 */
export const PROFILES_FILE = path.resolve(__dirname, '..', 'profiles.local.json');

const dashboardSchema = z.object({
  username: z.string().trim().min(1, 'dashboard username is required'),
  password: z.string().min(1, 'dashboard password is required'),
});

const credentialsSchema = z.object({
  brandId: z.string().trim().min(1, 'brandId is required'),
  apiKey: z.string().trim().min(1, 'apiKey is required'),
  /** Back-office (dashboard) login – used to read transactions and PSP logs. */
  dashboard: dashboardSchema.optional(),
  /** Dashboard merchant the brand belongs to – limits currencies / payment methods per MID. */
  merchant: z.object({ id: z.number().int(), name: z.string() }).optional(),
  /** KYC runs are offered for this merchant (it has a KYC Bank MID in Merchant Details → Kyc Configuration). */
  kyc: z.object({ enabled: z.boolean(), mid: z.string().optional() }).optional(),
});

const environmentsShape = Object.fromEntries(
  SUPPORTED_ENVIRONMENTS.map((env) => [env, credentialsSchema.optional()]),
) as Record<TestEnvironment, z.ZodOptional<typeof credentialsSchema>>;

export const testerProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be lowercase letters, digits or "-"'),
  name: z.string().trim().min(1),
  environments: z.object(environmentsShape),
});

export const profilesFileSchema = z.object({
  profiles: z.array(testerProfileSchema),
});

export type TesterProfile = z.infer<typeof testerProfileSchema>;
export type ProfileCredentials = z.infer<typeof credentialsSchema>;
export type DashboardCredentials = z.infer<typeof dashboardSchema>;

/** Reads all profiles. Returns an empty list when the file does not exist. */
export function loadProfiles(file: string = PROFILES_FILE): TesterProfile[] {
  if (!fs.existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error: unknown) {
    throw new ConfigurationError(
      `${path.basename(file)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = profilesFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigurationError(
      `${path.basename(file)} is invalid:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data.profiles;
}

/** Resolves the credentials of profile `id` for `env`, failing with a clear message. */
export function resolveProfile(
  id: string,
  env: TestEnvironment,
  file: string = PROFILES_FILE,
): { profile: TesterProfile; credentials: ProfileCredentials } {
  const profiles = loadProfiles(file);
  const profile = profiles.find((candidate) => candidate.id === id);
  if (!profile) {
    const known = profiles.map((candidate) => candidate.id).join(', ') || '(none)';
    throw new ConfigurationError(
      `TEST_PROFILE "${id}" not found in ${path.basename(file)}. Known profiles: ${known}.`,
    );
  }
  const credentials = profile.environments[env];
  if (!credentials) {
    throw new ConfigurationError(
      `Profile "${id}" has no credentials for ${env.toUpperCase()}. Add them in the launcher or ${path.basename(file)}.`,
    );
  }
  return { profile, credentials };
}
