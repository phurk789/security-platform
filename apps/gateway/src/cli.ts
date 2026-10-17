// Edge Gateway CLI.
//   GATEWAY_CONFIG  path to a site hardware config (JSON). Without it, the simulated devices run.
//   SERVER_URL      ws://localhost:8080          (or "serverUrl" in the config)
//   GATEWAY_KEY     gw_demo_local_key            (or "key" in the config)
//   GATEWAY_ID      edge-civic-01                (or "gatewayId" in the config)
//   OFFLINE         simulated device ids that start offline (default CCTV-04)
import { defaultAdapters } from './adapters';
import { startGateway } from './gateway';
import { ConfigError, adaptersFromConfig, loadSiteConfig } from './real/config';

const configPath = process.env.GATEWAY_CONFIG;
let site: ReturnType<typeof loadSiteConfig> | undefined;
try {
  site = configPath ? loadSiteConfig(configPath) : undefined;
} catch (e) {
  console.error(`[gw] cannot load ${configPath}: ${e instanceof ConfigError ? e.message : (e as Error).message}`);
  process.exit(2);
}
const serverUrl = process.env.SERVER_URL ?? site?.serverUrl ?? 'ws://localhost:8080';
const key = process.env.GATEWAY_KEY ?? site?.key ?? 'gw_demo_local_key';
const gatewayId = process.env.GATEWAY_ID ?? site?.gatewayId ?? 'edge-civic-01';
const offline = process.env.OFFLINE !== undefined ? process.env.OFFLINE.split(',').filter(Boolean) : undefined;
let adapters: ReturnType<typeof defaultAdapters>;
try {
  adapters = site ? adaptersFromConfig(site) : defaultAdapters({ offline });
} catch (e) {
  console.error(`[gw] cannot build adapters from ${configPath}: ${(e as Error).message}`);
  process.exit(2);
}
console.log(`[gw] ${site ? `site config ${configPath}` : 'simulated devices'}: ${adapters.map((a) => `${a.declaration.deviceId} (${a.declaration.adapterVersion})`).join(', ')}`);
const gw = startGateway({ serverUrl, key, gatewayId, adapters, geo: site?.geo });
const shutdown = async () => {
  console.log('[gw] shutting down');
  await gw.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
