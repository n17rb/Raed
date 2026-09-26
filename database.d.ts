declare module '@rayed/database/scripts/migrate.mjs' {
  export function runMigrations(options?: { statusOnly?: boolean; log?: (message: string) => void }): Promise<void>;
}

declare module '@rayed/database/seeds/seed.mjs' {
  export function seed(): Promise<void>;
}
