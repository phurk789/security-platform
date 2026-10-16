// Connect the example rover to the developer sandbox.
//   SERVER_URL=ws://localhost:8080 npx tsx examples/run-custom-adapter.ts
// Uses the sandbox gateway key and the pre-registered device SBX-ROVER-01.
import { startGateway } from '../apps/gateway/src/gateway';
import { PatrolRover } from './custom-adapter';

const gw = startGateway({
  serverUrl: process.env.SERVER_URL ?? 'ws://localhost:8080',
  key: process.env.GATEWAY_KEY ?? 'gw_sandbox_demo_key',
  gatewayId: 'my-rover-gateway',
  adapters: [new PatrolRover({ deviceId: process.env.DEVICE_ID ?? 'SBX-ROVER-01', start: { x: 120, y: 220 } })],
});
process.on('SIGINT', async () => {
  await gw.stop();
  process.exit(0);
});
