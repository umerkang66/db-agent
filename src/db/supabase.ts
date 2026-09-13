import pg from 'pg';

export interface SupabaseDirectParams {
  projectRef: string;
  username: string;
  password?: string;
  database: string;
  port: string;
  search: string;
}

export interface ResolvedSupabaseResult {
  poolerUrl: string;
  region: string;
  projectRef: string;
}

/**
 * Checks if a connection string uses a direct Supabase host (e.g. db.<ref>.supabase.co).
 * Direct connections are IPv6-only and will fail on IPv4 networks.
 */
export function isSupabaseDirectUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  return /db\.([a-z0-9_-]+)\.supabase\.(co|in|net)/i.test(url);
}

/**
 * Parses a direct Supabase database URL into its constituent components.
 */
export function parseSupabaseDirectUrl(rawUrl: string): SupabaseDirectParams | null {
  try {
    const url = new URL(rawUrl);
    const hostMatch = url.hostname.match(/^db\.([a-z0-9_-]+)\.supabase\.(co|in|net)$/i);
    if (!hostMatch) return null;

    const projectRef = hostMatch[1];
    const username = url.username || 'postgres';
    const password = url.password ? decodeURIComponent(url.password) : undefined;
    const database = url.pathname.replace(/^\//, '') || 'postgres';
    const port = url.port || '5432';
    const search = url.search || '';

    return {
      projectRef,
      username,
      password,
      database,
      port,
      search,
    };
  } catch {
    const match = rawUrl.match(
      /^(postgresql|postgres):\/\/([^:]+)(?::([^@]+))?@db\.([a-z0-9_-]+)\.supabase\.(?:co|in|net)(?::(\d+))?(?:\/([^?]*))?(\?.*)?$/i
    );
    if (!match) return null;
    return {
      username: match[2] || 'postgres',
      password: match[3] ? decodeURIComponent(match[3]) : undefined,
      projectRef: match[4],
      port: match[5] || '5432',
      database: match[6] || 'postgres',
      search: match[7] || '',
    };
  }
}

/**
 * Builds an IPv4-compatible Supabase connection pooler URL (Supavisor).
 * Username format is `<user>.<projectRef>` and default port is 5432 (Session mode).
 */
export function buildSupabasePoolerUrl(params: {
  region: string;
  projectRef: string;
  username?: string;
  password?: string;
  database?: string;
  port?: number | string;
  search?: string;
}): string {
  const user = params.username || 'postgres';
  const poolerUser = user.includes('.') ? user : `${user}.${params.projectRef}`;
  const encodedUser = encodeURIComponent(poolerUser);
  const encodedPass = params.password !== undefined ? `:${encodeURIComponent(params.password)}` : '';
  const port = params.port || 5432;
  const db = params.database || 'postgres';
  const search = params.search || '';

  return `postgresql://${encodedUser}${encodedPass}@aws-0-${params.region}.pooler.supabase.com:${port}/${db}${search}`;
}

/**
 * List of known Supabase pooler AWS regions to probe.
 */
export const SUPABASE_REGIONS = [
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-south-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'eu-central-1',
  'eu-central-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-north-1',
  'ca-central-1',
  'sa-east-1',
  'me-central-1',
  'af-south-1',
];

/**
 * Quickly probes Supabase pooler regions in parallel to determine which region
 * hosts the tenant. Supavisor immediately rejects non-existent tenants, allowing
 * detection across all regions concurrently in 1-2 seconds.
 */
export async function probeSupabaseRegion(params: {
  projectRef: string;
  username?: string;
  password?: string;
  database?: string;
  search?: string;
  timeoutMs?: number;
}): Promise<string | null> {
  const timeoutMs = params.timeoutMs || 3500;
  const probeOne = async (region: string): Promise<string> => {
    const poolerUrl = buildSupabasePoolerUrl({
      region,
      projectRef: params.projectRef,
      username: params.username,
      password: params.password,
      database: params.database,
      search: params.search,
    });

    const client = new pg.Client({
      connectionString: poolerUrl,
      connectionTimeoutMillis: timeoutMs,
    });

    client.on('error', () => {}); // swallow unhandled async errors

    try {
      await client.connect();
      await client.end().catch(() => {});
      return region;
    } catch (err: any) {
      await client.end().catch(() => {});
      // If error indicates password auth failed or pg_hba issue, the tenant DOES exist in this region
      const msg = (err?.message || '').toLowerCase();
      if (
        err?.code === '28P01' ||
        msg.includes('password authentication failed') ||
        msg.includes('pg_hba.conf')
      ) {
        return region;
      }
      throw err;
    }
  };

  try {
    return await Promise.any(SUPABASE_REGIONS.map((r) => probeOne(r)));
  } catch {
    return null;
  }
}

/**
 * If the given URL is a direct Supabase URL, auto-probes the pooler region
 * and returns the IPv4-compatible pooler URL.
 */
export async function resolveSupabaseUrl(
  rawUrl: string,
  onProgress?: (message: string) => void
): Promise<ResolvedSupabaseResult | null> {
  if (!isSupabaseDirectUrl(rawUrl)) return null;

  const parsed = parseSupabaseDirectUrl(rawUrl);
  if (!parsed) return null;

  onProgress?.(`Probing Supabase pooler regions for project ${parsed.projectRef}...`);

  const region = await probeSupabaseRegion({
    projectRef: parsed.projectRef,
    username: parsed.username,
    password: parsed.password,
    database: parsed.database,
    search: parsed.search,
  });

  if (!region) return null;

  const poolerUrl = buildSupabasePoolerUrl({
    region,
    projectRef: parsed.projectRef,
    username: parsed.username,
    password: parsed.password,
    database: parsed.database,
    port: 5432,
    search: parsed.search,
  });

  return {
    poolerUrl,
    region,
    projectRef: parsed.projectRef,
  };
}
