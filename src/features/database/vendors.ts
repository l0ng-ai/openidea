/**
 * Data source types of New ▸ Data Source: the three drivers the backend speaks,
 * and products that speak their wire protocol (a preset of port, icon and URL scheme).
 */
import type { DataSource, DbDriver, DbSslMode } from "@/platform/ipc";

export interface DbVendor {
  /** Stored in `DataSource.vendor`; a driver's own entry has the driver's id. */
  id: string;
  label: string;
  driver: DbDriver;
  port: number | null;
  icon: string;
  /** JDBC URL scheme (`jdbc:<scheme>://…`). */
  scheme: string;
  /** Managed services that only accept encrypted connections. */
  ssl?: DbSslMode;
}

export const VENDORS: readonly DbVendor[] = [
  { id: "aurora-mysql", label: "Amazon Aurora MySQL", driver: "mysql", port: 3306, icon: "db-aurora", scheme: "mysql" },
  {
    id: "redshift",
    label: "Amazon Redshift",
    driver: "postgres",
    port: 5439,
    icon: "db-redshift",
    scheme: "redshift",
    ssl: "require",
  },
  {
    id: "cockroachdb",
    label: "CockroachDB",
    driver: "postgres",
    port: 26257,
    icon: "db-cockroach",
    scheme: "postgresql",
  },
  { id: "greenplum", label: "Greenplum", driver: "postgres", port: 5432, icon: "db-greenplum", scheme: "postgresql" },
  { id: "mariadb", label: "MariaDB", driver: "mysql", port: 3306, icon: "db-mariadb", scheme: "mariadb" },
  {
    id: "sqlServer",
    label: "Microsoft SQL Server",
    driver: "sqlServer",
    port: 1433,
    icon: "db-sqlserver",
    scheme: "sqlserver",
  },
  { id: "mysql", label: "MySQL", driver: "mysql", port: 3306, icon: "db-mysql", scheme: "mysql" },
  { id: "neon", label: "Neon", driver: "postgres", port: 5432, icon: "db-neon", scheme: "postgresql", ssl: "require" },
  {
    id: "oceanbase",
    label: "OceanBase (MySQL mode)",
    driver: "mysql",
    port: 2881,
    icon: "db-oceanbase",
    scheme: "oceanbase",
  },
  { id: "postgres", label: "PostgreSQL", driver: "postgres", port: 5432, icon: "db-postgres", scheme: "postgresql" },
  {
    id: "singlestore",
    label: "SingleStore",
    driver: "mysql",
    port: 3306,
    icon: "db-singlestore",
    scheme: "singlestore",
  },
  { id: "sqlite", label: "SQLite", driver: "sqlite", port: null, icon: "db-sqlite", scheme: "sqlite" },
  {
    id: "supabase",
    label: "Supabase",
    driver: "postgres",
    port: 5432,
    icon: "db-supabase",
    scheme: "postgresql",
    ssl: "require",
  },
  { id: "tidb", label: "TiDB", driver: "mysql", port: 4000, icon: "db-tidb", scheme: "mysql" },
  {
    id: "timescaledb",
    label: "TimescaleDB",
    driver: "postgres",
    port: 5432,
    icon: "db-timescale",
    scheme: "postgresql",
  },
  { id: "yugabytedb", label: "YugabyteDB", driver: "postgres", port: 5433, icon: "db-yugabyte", scheme: "postgresql" },
];

const BY_ID = new Map(VENDORS.map((v) => [v.id, v]));

/** The type of a data source: its preset, else its driver's own entry. */
export function vendorOf(s: Pick<DataSource, "vendor" | "driver">): DbVendor {
  const v = s.vendor ? BY_ID.get(s.vendor) : undefined;
  return v && v.driver === (s.driver ?? "sqlite") ? v : BY_ID.get(s.driver ?? "sqlite")!;
}

export const vendorById = (id: string): DbVendor | undefined => BY_ID.get(id);

/** The fields a new data source of type `v` starts with. */
export function vendorPreset(v: DbVendor): Partial<DataSource> {
  const preset: Partial<DataSource> = { driver: v.driver, vendor: v.id === v.driver ? "" : v.id, port: v.port };
  if (v.ssl) preset.ssl = v.ssl;
  return preset;
}

/** URL schemes (besides the JDBC ones) that name a type. */
const SCHEMES: Record<string, string> = {
  postgres: "postgres",
  postgresql: "postgres",
  pgsql: "postgres",
  redshift: "redshift",
  cockroachdb: "cockroachdb",
  cockroach: "cockroachdb",
  yugabytedb: "yugabytedb",
  timescaledb: "timescaledb",
  greenplum: "greenplum",
  mysql: "mysql",
  mariadb: "mariadb",
  tidb: "tidb",
  singlestore: "singlestore",
  memsql: "singlestore",
  oceanbase: "oceanbase",
  sqlserver: "sqlServer",
  mssql: "sqlServer",
};

export const vendorOfScheme = (scheme: string): DbVendor | undefined => BY_ID.get(SCHEMES[scheme.toLowerCase()] ?? "");

const bracketed = (host: string) => (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host);

/** The JDBC URL of a data source's fields (the General tab's URL preview). */
export function sourceUrl(s: DataSource): string {
  const v = vendorOf(s);
  if (v.driver === "sqlite") return `jdbc:sqlite:${s.file ?? ""}`;
  const host = bracketed(s.host?.trim() || "localhost");
  const port = s.port ?? v.port;
  const db = s.database ? `/${encodeURIComponent(s.database)}` : "";
  return `jdbc:${v.scheme}://${host}${port ? `:${port}` : ""}${db}`;
}
