// Edge Gateway CLI.
//   SERVER_URL   ws://localhost:8080
//   GATEWAY_KEY  gw_demo_local_key
//   GATEWAY_ID   edge-civic-01
//   OFFLINE      comma-separated device ids that start offline (default CCTV-04)
import { defaultAdapters } from './adapters';
import { startGateway } from './gateway';

export { startGateway, type GatewayHandle, type GatewayOptions } from './gateway';
export { defaultAdapters, SimCctv, SimUav, SimUgv, SimDevice, declarationFrom } from './adapters';
export * from './sdk';

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/gateway/src/index.ts');

if (isMain) {
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
}
