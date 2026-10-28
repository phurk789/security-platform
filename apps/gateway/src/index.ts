// Edge Gateway library entry. The command-line program is src/cli.ts.
export { startGateway, type DroppedCounts, type GatewayHandle, type GatewayOptions, type GatewayStatus } from './gateway';
export { defaultAdapters, SimCctv, SimUav, SimUgv, SimDevice, declarationFrom } from './adapters';
export * from './sdk';
export { SiyiCameraAdapter, type SiyiCameraConfig } from './real/siyiCamera';
export { MavlinkVehicleAdapter, UNIRC7_DATALINK, type MavlinkVehicleConfig, type VehicleProfile } from './real/mavlinkVehicle';
export { adaptersFromConfig, loadSiteConfig, parseSiteConfig, type SiteConfig, type DeviceConfig } from './real/config';
export * as siyi from './real/siyiProtocol';
export { RosNav2Adapter, type RosNav2Config } from './real/rosNav2';
export { OnvifCameraAdapter, type OnvifCameraConfig } from './real/onvifCamera';
export { OnvifClient, OnvifError, interpretEvent, verifyUsernameToken, type OnvifEvent } from './real/onvif';
export * from './vision';
