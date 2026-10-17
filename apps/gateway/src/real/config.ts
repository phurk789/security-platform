// Site hardware configuration for the edge gateway (JSON file, path in GATEWAY_CONFIG).
import { readFileSync } from 'node:fs';
import { PAYLOAD_CATALOG, VEHICLE_CATALOG, type CameraMount, type GeoAnchor, type StreamInfo } from '@13store/shared';
import { defaultAdapters } from '../adapters';
import type { Adapter } from '../sdk';
import { MavlinkVehicleAdapter, UNIRC7_DATALINK, type VehicleProfile } from './mavlinkVehicle';
import { SiyiCameraAdapter } from './siyiCamera';
import { RosNav2Adapter, type RosNav2Config } from './rosNav2';
import { SIYI_DEFAULT } from './siyiProtocol';

export type DeviceConfig =
  | {
      type: 'mavlink';
      deviceId: string;
      kind: 'ugv' | 'uav';
      profile: VehicleProfile;
      model?: string;
      /** Omit to use the UniRC 7 / 7 Pro datalink (192.168.144.20:19856). */
      link?: { mode: 'client'; host: string; port: number } | { mode: 'listen'; port: number };
      missionAltM?: number;
      allowRemoteArm?: boolean;
      firmwareTested?: string;
      /** Names shown in the Equipment tab (e.g. "SIYI UniFC 6 Pico", "SIYI MK32 air unit"). */
      flightController?: string;
      radio?: string;
      /** Catalogue model: D50, D100 or D200. */
      catalogId?: string;
      /** 4-in-1 module wired to flight-controller relays. */
      payload?: { module: 'loudhailer-4in1'; spotlightRelay?: number; beaconRelay?: number };
      /** Indoor vehicle: ArduPilot external navigation (LOCAL_POSITION_NED) instead of GPS. */
      indoor?: { buildingId: string; level: number; origin: { x: number; y: number }; yawDeg?: number };
    }
  | ({ type: 'ros2-nav2' } & RosNav2Config)
  | {
      type: 'siyi-camera';
      deviceId: string;
      host?: string;
      port?: number;
      model?: string;
      pos: { x: number; y: number };
      stream?: StreamInfo;
      firmwareTested?: string;
      yawSign?: 1 | -1;
      /** Bearing of the gimbal's centre position, lens height, field of view: lets the platform point it at alerts. */
      mount?: CameraMount;
    }
  | { type: 'simulated'; offline?: string[] };

export interface SiteConfig {
  gatewayId?: string;
  serverUrl?: string;
  key?: string;
  /** WGS 84 anchor of the site grid. Must match the site registered on the platform. */
  geo: GeoAnchor;
  devices: DeviceConfig[];
}

export class ConfigError extends Error {}

export function parseSiteConfig(json: unknown): SiteConfig {
  const c = json as SiteConfig;
  if (!c || typeof c !== 'object') throw new ConfigError('Config must be a JSON object.');
  if (!c.geo || !Number.isFinite(c.geo.originLat) || !Number.isFinite(c.geo.originLon)) throw new ConfigError('geo.originLat and geo.originLon are required.');
  if (!Array.isArray(c.devices) || !c.devices.length) throw new ConfigError('devices must list at least one device.');
  const ids = new Set<string>();
  for (const d of c.devices) {
    if (d.type === 'simulated') continue;
    if (!d.deviceId || !/^[A-Z0-9-]{3,32}$/.test(d.deviceId)) throw new ConfigError(`Bad deviceId: ${JSON.stringify(d.deviceId)}`);
    if (ids.has(d.deviceId)) throw new ConfigError(`Duplicate deviceId ${d.deviceId}`);
    ids.add(d.deviceId);
    if (d.type === 'ros2-nav2' && !/^wss?:\/\//.test(d.url)) throw new ConfigError(`${d.deviceId}: url must be a ws:// or wss:// rosbridge address.`);
    if (d.type === 'ros2-nav2' && (!d.frame || !Number.isFinite(d.frame.originX) || !Number.isFinite(d.frame.originY)))
      throw new ConfigError(`${d.deviceId}: frame.originX / originY (site metres of the ROS map origin) are required.`);
    if (d.type === 'mavlink' && d.catalogId && !VEHICLE_CATALOG[d.catalogId])
      throw new ConfigError(`${d.deviceId}: unknown catalogId ${d.catalogId} (known: ${Object.keys(VEHICLE_CATALOG).join(', ')})`);
    if (d.type === 'mavlink' && d.payload && !PAYLOAD_CATALOG[d.payload.module]) throw new ConfigError(`${d.deviceId}: unknown payload module ${d.payload.module}`);
    if (d.type === 'mavlink' && !['ardupilot-rover', 'ardupilot-copter', 'px4-rover', 'px4-multicopter'].includes(d.profile))
      throw new ConfigError(`${d.deviceId}: unknown profile ${d.profile}`);
    if (d.type === 'siyi-camera' && (!d.pos || !Number.isFinite(d.pos.x) || !Number.isFinite(d.pos.y)))
      throw new ConfigError(`${d.deviceId}: pos {x, y} (site metres) is required.`);
    if (d.type === 'siyi-camera' && d.mount && (!Number.isFinite(d.mount.bearingDeg) || !Number.isFinite(d.mount.heightM)))
      throw new ConfigError(`${d.deviceId}: mount needs bearingDeg and heightM.`);
  }
  return c;
}

export function loadSiteConfig(path: string) {
  return parseSiteConfig(JSON.parse(readFileSync(path, 'utf8')));
}

export function adaptersFromConfig(c: SiteConfig): Adapter[] {
  const out: Adapter[] = [];
  for (const d of c.devices) {
    if (d.type === 'simulated') out.push(...defaultAdapters({ offline: d.offline }));
    else if (d.type === 'mavlink')
      out.push(
        new MavlinkVehicleAdapter({
          deviceId: d.deviceId,
          kind: d.kind,
          profile: d.profile,
          model: d.model,
          link: d.link ?? { mode: 'client', ...UNIRC7_DATALINK },
          geo: c.geo,
          missionAltM: d.missionAltM,
          allowRemoteArm: d.allowRemoteArm,
          firmwareTested: d.firmwareTested,
          catalogId: d.catalogId,
          payload: d.payload,
          indoor: d.indoor,
        }),
      );
    else if (d.type === 'ros2-nav2') out.push(new RosNav2Adapter(d));
    else
      out.push(
        new SiyiCameraAdapter({
          deviceId: d.deviceId,
          host: d.host ?? SIYI_DEFAULT.host,
          port: d.port ?? SIYI_DEFAULT.port,
          model: d.model,
          pos: d.pos,
          stream: d.stream,
          firmwareTested: d.firmwareTested,
          yawSign: d.yawSign,
          mount: d.mount,
        }),
      );
  }
  return out;
}
