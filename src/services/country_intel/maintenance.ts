export const PERSISTENT_DB_PATH = '/data/sora.db';

export function ephemeralDbWarning(dbPath: string | undefined): string | undefined {
  if (!dbPath) return 'SORA_DB_PATH is unset; SQLite defaults to an ephemeral working-directory database.';
  const normalized = dbPath.trim();
  if (normalized === PERSISTENT_DB_PATH || normalized.startsWith('/data/')) return undefined;
  if (normalized === ':memory:') return 'SORA_DB_PATH uses :memory:; country intelligence history will not persist.';
  return `SORA_DB_PATH=${normalized} is not on the persistent /data volume; mount a volume and use SORA_DB_PATH=${PERSISTENT_DB_PATH}.`;
}
