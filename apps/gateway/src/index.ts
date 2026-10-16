// Edge Gateway library entry. The command-line program is src/cli.ts.
export { startGateway, type GatewayHandle, type GatewayOptions } from './gateway';
export { defaultAdapters, SimCctv, SimUav, SimUgv, SimDevice, declarationFrom } from './adapters';
export * from './sdk';
