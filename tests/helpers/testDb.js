import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb } from '../../src/db/database.js';

export function useTempAuditDb(label) {
  closeDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `audit-${label}-`));
  const dbPath = path.join(dir, 'audit.sqlite');
  process.env.AUDIT_DB_PATH = dbPath;
  return {
    dbPath,
    cleanup() {
      closeDb();
      if (process.env.AUDIT_DB_PATH === dbPath) delete process.env.AUDIT_DB_PATH;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}
