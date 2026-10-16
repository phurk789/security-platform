// Edge Gateway CLI.
//   SERVER_URL   ws://localhost:8080
//   GATEWAY_KEY  gw_demo_local_key
//   GATEWAY_ID   edge-civic-01
//   OFFLINE      comma-separated device ids that start offline (default CCTV-04)
import { defaultAdapters } from './adapters';
import { startGateway } from './gateway';

const serverUrl = process.env.SERVER_URL ?? 'ws://localhost:8080';
const key = process.env.GATEWAY_KEY ?? 'gw_demo_local_key';
const gatewayId = process.env.GATEWAY_ID ?? 'edge-civic-01';
const offline = process.env.OFFLINE !== undefined ? process.env.OFFLINE.split(',').filter(Boolean) : undefined;
const gw = startGateway({ serverUrl, key, gatewayId, adapters: defaultAdapters({ offline }) });
const shutdown = async () => {
  console.log('[gw] shutting down');
  await gw.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
