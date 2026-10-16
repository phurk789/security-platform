// Seed an empty database (normally done automatically on first start).
import { loadConfig } from '../config';
import { openDb } from '../db';
import { seed } from '../seed';

const cfg = loadConfig();
const r = seed(openDb(cfg.dbFile), cfg);
console.log(r.created ? `Seeded ${cfg.env} data.` : 'Database already has data. Nothing changed.');
for (const line of r.created ? r.printed ?? [] : []) console.log(line);
