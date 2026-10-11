export type LocalMigration = { name: string; queries: string[] };
export interface LocalMigrationStatement {
  bind(...values: unknown[]): LocalMigrationStatement;
  all(): Promise<{ results: Record<string, unknown>[] }>;
  first(column: string): Promise<unknown>;
}
export interface LocalMigrationDatabase {
  prepare(query: string): LocalMigrationStatement;
  batch(statements: LocalMigrationStatement[]): Promise<unknown>;
}
export function applyLocalMigrations(
  database: LocalMigrationDatabase,
  migrations: LocalMigration[],
): Promise<{ applied: number; total: number }>;
