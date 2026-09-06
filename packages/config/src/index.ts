import { z } from "zod";

function csv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const postgresUrl = z.url().refine(
  (value) => {
    const protocol = new URL(value).protocol;
    return protocol === "postgres:" || protocol === "postgresql:";
  },
  { message: "must use the PostgreSQL protocol" },
);

const nonEmptyCsv = z
  .string()
  .refine((value) => csv(value).length > 0, "must contain at least one value");

const requiredNonnegativeInteger = z
  .string()
  .trim()
  .min(1)
  .transform(Number)
  .pipe(z.number().int().min(0));

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DATABASE_URL: postgresUrl,
    APP_ORIGIN: z.url(),
    OIDC_ISSUER: z.url(),
    OIDC_CLIENT_ID: z.string().min(1),
    OIDC_CLIENT_SECRET: z.string().min(1),
    ARK_API_BASE_URL: z.url(),
    ARK_API_KEY: z.string().min(1),
    ARK_ENVIRONMENT_ID: z.string().min(1),
    TOS_ENDPOINT: z.url(),
    TOS_BUCKET: z.string().min(1),
    MODEL_ALLOWLIST: nonEmptyCsv,
    OUTBOUND_HOST_ALLOWLIST: nonEmptyCsv,
    PERSONAL_AGENT_LIMIT: z.coerce.number().int().min(0).default(10),
    CONCURRENT_SESSION_LIMIT: z.coerce.number().int().min(0).default(2),
    SESSION_DAILY_LIMIT: requiredNonnegativeInteger,
    MONTHLY_TOKEN_LIMIT: requiredNonnegativeInteger,
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  })
  .passthrough();

export function parseServerConfig(
  environment: Record<string, string | undefined>,
) {
  const env = environmentSchema.parse(environment);
  const publicConfig = Object.freeze({
    appOrigin: env.APP_ORIGIN,
    modelAllowlist: csv(env.MODEL_ALLOWLIST),
    personalAgentLimit: env.PERSONAL_AGENT_LIMIT,
    concurrentSessionLimit: env.CONCURRENT_SESSION_LIMIT,
    dailySessionLimit: env.SESSION_DAILY_LIMIT,
    monthlyTokenLimit: env.MONTHLY_TOKEN_LIMIT,
  });

  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
    appOrigin: env.APP_ORIGIN,
    oidc: {
      issuer: env.OIDC_ISSUER,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
    },
    ark: {
      baseUrl: env.ARK_API_BASE_URL,
      apiKey: env.ARK_API_KEY,
      environmentId: env.ARK_ENVIRONMENT_ID,
    },
    tos: {
      endpoint: env.TOS_ENDPOINT,
      bucket: env.TOS_BUCKET,
    },
    modelAllowlist: publicConfig.modelAllowlist,
    outboundHostAllowlist: csv(env.OUTBOUND_HOST_ALLOWLIST),
    personalAgentLimit: env.PERSONAL_AGENT_LIMIT,
    concurrentSessionLimit: env.CONCURRENT_SESSION_LIMIT,
    dailySessionLimit: env.SESSION_DAILY_LIMIT,
    monthlyTokenLimit: env.MONTHLY_TOKEN_LIMIT,
    port: env.PORT,
    public: publicConfig,
  });
}

export type ServerConfig = ReturnType<typeof parseServerConfig>;
