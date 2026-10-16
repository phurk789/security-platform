// Restore a backup. Stop the server first.
//   npm run restore -w @13store/server -- <backup-id> [target-data-dir]
import { loadConfig } from '../config';
import { listBackups, restoreBackup } from '../backup';

const cfg = loadConfig();
const [id, target] = process.argv.slice(2);
if (!id) {
  console.log('Backups:');
  for (const b of listBackups(cfg.dataDir)) console.log(`  ${b.id}  by ${b.createdBy}  incidents=${b.counts.incidents} evidence=${b.counts.evidence}`);
  console.log('\nUsage: npm run restore -w @13store/server -- <backup-id> [target-data-dir]');
  process.exit(0);
}
const m = restoreBackup(cfg.dataDir, id, target ?? cfg.dataDir);
console.log(`Restored ${m.id} (${m.files.length} files verified) into ${target ?? cfg.dataDir}.`);
