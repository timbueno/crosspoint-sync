export interface Config {
  registrationDisabled: boolean;
  /** Max requests per IP per minute on sensitive endpoints (0 = disabled). */
  authRateLimitPerMinute: number;
  /** Trust the deployment's reverse proxy to set X-Forwarded-Proto. */
  trustProxy: boolean;
}

export function fromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    registrationDisabled: env.REGISTRATION_DISABLED === 'true' || env.REGISTRATION_DISABLED === '1',
    authRateLimitPerMinute: env.AUTH_RATE_LIMIT_PER_MINUTE
      ? Number(env.AUTH_RATE_LIMIT_PER_MINUTE)
      : 30,
    trustProxy: env.TRUST_PROXY === 'true' || env.TRUST_PROXY === '1',
  };
}
