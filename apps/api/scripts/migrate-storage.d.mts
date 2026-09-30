export type MigrateStorageS3 = { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean };
export type MigrateStorageSummary = { found: number; moved: number; missing: number; mismatch: number; errors: string[] };
export declare const OBJECT_TABLES: { table: string; key: string; backend: string; sha: string | null }[];
export declare function runMigrateStorage(opts: {
  databaseUrl: string;
  localDir: string;
  s3: MigrateStorageS3;
  apply: boolean;
  log?: (msg: string) => void;
}): Promise<MigrateStorageSummary>;
