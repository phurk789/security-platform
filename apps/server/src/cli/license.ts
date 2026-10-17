// License tool (vendor side):
//   npx tsx src/cli/license.ts keygen                       → prints a new Ed25519 key pair
//   npx tsx src/cli/license.ts sign --key vendor.key --org org-pilot --customer "Port Authority" \
//        --days 365 --sites 2 --devices 40 --users 50 --features analytics,patrols,sso > license.json
//   npx tsx src/cli/license.ts verify --pub vendor.pub license.json
import { readFileSync } from 'node:fs';
import { generateKeys, signLicense, verifyLicense, type LicenseBody, type LicenseFile } from '../license';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name: string, d?: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : d;
};

if (cmd === 'keygen') {
  const k = generateKeys();
  console.log(k.privateKey);
  console.log(k.publicKey);
  console.error('Keep the private key offline. Set LICENSE_PUBLIC_KEY on every server to the public key.');
} else if (cmd === 'sign') {
  const key = readFileSync(opt('key')!, 'utf8');
  const days = Number(opt('days', '365'));
  const now = Date.now();
  const body: LicenseBody = {
    v: 1,
    org: opt('org', '*')!,
    customer: opt('customer', 'Customer')!,
    issuedAt: now,
    expiresAt: now + days * 86_400_000,
    limits: { sites: Number(opt('sites', '1')), devices: Number(opt('devices', '20')), users: Number(opt('users', '20')) },
    features: (opt('features', '') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
  console.log(JSON.stringify(signLicense(body, key), null, 2));
} else if (cmd === 'verify') {
  const pub = readFileSync(opt('pub')!, 'utf8');
  const file = JSON.parse(readFileSync(rest[rest.length - 1], 'utf8')) as LicenseFile;
  const v = verifyLicense(file, pub);
  console.log(v.ok ? `OK: ${file.customer}, org ${file.org}, expires ${new Date(file.expiresAt).toISOString()}, limits ${JSON.stringify(file.limits)}` : `INVALID: ${v.reason}`);
  process.exit(v.ok ? 0 : 1);
} else {
  console.error(
    'usage: license.ts keygen | sign --key K [--org ID] [--customer NAME] [--days N] [--sites N] [--devices N] [--users N] [--features a,b] | verify --pub P file.json',
  );
  process.exit(2);
}
