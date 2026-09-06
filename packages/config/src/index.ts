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

const tosEndpoint = z.url().refine(
  (value) => {
    const endpoint = new URL(value);
    return (
      (endpoint.protocol === "http:" || endpoint.protocol === "https:") &&
      endpoint.pathname === "/" &&
      endpoint.search === "" &&
      endpoint.hash === "" &&
      endpoint.username === "" &&
      endpoint.password === ""
    );
  },
  { message: "must be an HTTP(S) origin without credentials or a path" },
);

function normalizedTosEndpoint(input: {
  endpoint: string;
  region: string;
  nodeEnv: "development" | "test" | "production";
}): string | undefined {
  const endpoint = new URL(input.endpoint);
  const localHost =
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "127.0.0.1" ||
    endpoint.hostname === "::1";
  const localOrTest =
    input.nodeEnv === "test" || (input.nodeEnv === "development" && localHost);
  if (endpoint.protocol !== "https:" && !localOrTest) return undefined;

  const official = endpoint.hostname.match(
    /^tos(-s3)?-([a-z0-9-]+)\.((?:i)?volces\.(?:com|cn))$/,
  );
  if (official) {
    if (official[2] !== input.region || endpoint.port !== "") return undefined;
    if (!official[1])
      endpoint.hostname = `tos-s3-${official[2]}.${official[3]}`;
    return endpoint.origin;
  }
  return localOrTest ? endpoint.origin : undefined;
}

const nonEmptyCsv = z
  .string()
  .refine((value) => csv(value).length > 0, "must contain at least one value");

const tosBucket = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);

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
    TOS_ENDPOINT: tosEndpoint,
    TOS_BUCKET: tosBucket,
    TOS_REGION: z.string().trim().min(1),
    TOS_ACCESS_KEY_ID: z.string().trim().min(1),
    TOS_SECRET_ACCESS_KEY: z.string().trim().min(1),
    TOS_SESSION_TOKEN: z.string().trim().min(1).optional(),
    MODEL_ALLOWLIST: nonEmptyCsv,
    OUTBOUND_HOST_ALLOWLIST: nonEmptyCsv,
    PERSONAL_AGENT_LIMIT: z.coerce.number().int().min(0).default(10),
    CONCURRENT_SESSION_LIMIT: z.coerce.number().int().min(0).default(2),
    SESSION_DAILY_LIMIT: requiredNonnegativeInteger,
    MONTHLY_TOKEN_LIMIT: requiredNonnegativeInteger,
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  })
  .passthrough()
  .superRefine((env, context) => {
    if (
      normalizedTosEndpoint({
        endpoint: env.TOS_ENDPOINT,
        region: env.TOS_REGION,
        nodeEnv: env.NODE_ENV,
      }) === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["TOS_ENDPOINT"],
        message:
          "must match the configured TOS region and use HTTPS S3 compatibility outside local/test mode",
      });
    }
  });

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
      endpoint: normalizedTosEndpoint({
        endpoint: env.TOS_ENDPOINT,
        region: env.TOS_REGION,
        nodeEnv: env.NODE_ENV,
      })!,
      bucket: env.TOS_BUCKET,
      region: env.TOS_REGION,
      accessKeyId: env.TOS_ACCESS_KEY_ID,
      accessKeySecret: env.TOS_SECRET_ACCESS_KEY,
      ...(env.TOS_SESSION_TOKEN ? { stsToken: env.TOS_SESSION_TOKEN } : {}),
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
