// ONVIF camera adapter against a protocol-accurate fake camera: SOAP 1.2 over HTTP with
// WS-UsernameToken digest authentication, media/PTZ/events services, snapshot URI with Basic auth.
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { OnvifClient, interpretEvent, tag, usernameToken, verifyUsernameToken } from '../src/real/onvif';
import { OnvifCameraAdapter } from '../src/real/onvifCamera';
import { fakeCtx } from './helpers';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await wait(20);
  }
  throw new Error('until timed out');
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

const PASSWORD = 'cam-secret';
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

interface Fake {
  port: number;
  calls: string[];
  ptz: { pan: number; tilt: number; zoom: number; moving: boolean };
  events: string[];
  close: () => void;
}

/** A fake ONVIF camera: one HTTP server answering the device, media, PTZ and events services. */
function fakeCamera(): Promise<Fake> {
  const calls: string[] = [];
  const ptz = { pan: 0.25, tilt: -0.1, zoom: 0.2, moving: false };
  let pulls = 0;
  const events: string[] = [];
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const base = `http://${req.headers.host ?? '127.0.0.1'}`;
      const soap = (inner: string, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/soap+xml; charset=utf-8' });
        res.end(
          `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:wsa="http://www.w3.org/2005/08/addressing"><s:Body>${inner}</s:Body></s:Envelope>`,
        );
      };
      if (req.url === '/onvif/snapshot.jpg') {
        const auth = String(req.headers.authorization ?? '');
        if (auth !== `Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}`) {
          res.writeHead(401, { 'www-authenticate': 'Basic realm="cam"' });
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        return res.end(JPEG);
      }
      const security = tag(body, 'Security');
      if (!security || !verifyUsernameToken(security, PASSWORD, Date.now()) || tag(security, 'Username') !== 'admin') {
        return soap(
          '<s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>ter:NotAuthorized</s:Value></s:Subcode></s:Code><s:Reason><s:Text xml:lang="en">Sender not authorized</s:Text></s:Reason></s:Fault>',
          401,
        );
      }
      const op =
        /<(?:\w+:)?(GetDeviceInformation|GetServices|GetCapabilities|GetProfiles|GetStreamUri|GetSnapshotUri|GetStatus|ContinuousMove|Stop|AbsoluteMove|GotoHomePosition|CreatePullPointSubscription|PullMessages|Renew|Unsubscribe)\b/.exec(
          body,
        )?.[1] ?? 'unknown';
      calls.push(op);
      switch (op) {
        case 'GetDeviceInformation':
          return soap(
            '<tds:GetDeviceInformationResponse><tds:Manufacturer>FakeCam</tds:Manufacturer><tds:Model>FC-PTZ-1</tds:Model><tds:FirmwareVersion>V5.7.3</tds:FirmwareVersion><tds:SerialNumber>FC0001</tds:SerialNumber><tds:HardwareId>88</tds:HardwareId></tds:GetDeviceInformationResponse>',
          );
        case 'GetServices':
          // XAddrs carry the camera's own (NAT) idea of its address: the client must keep the path only.
          return soap(
            `<tds:GetServicesResponse><tds:Service><tds:Namespace>http://www.onvif.org/ver10/device/wsdl</tds:Namespace><tds:XAddr>http://10.0.0.5/onvif/device_service</tds:XAddr></tds:Service><tds:Service><tds:Namespace>http://www.onvif.org/ver10/media/wsdl</tds:Namespace><tds:XAddr>http://10.0.0.5/onvif/media</tds:XAddr></tds:Service><tds:Service><tds:Namespace>http://www.onvif.org/ver20/ptz/wsdl</tds:Namespace><tds:XAddr>http://10.0.0.5/onvif/ptz</tds:XAddr></tds:Service><tds:Service><tds:Namespace>http://www.onvif.org/ver10/events/wsdl</tds:Namespace><tds:XAddr>http://10.0.0.5/onvif/events</tds:XAddr></tds:Service></tds:GetServicesResponse>`,
          );
        case 'GetProfiles':
          return soap(
            `<trt:GetProfilesResponse><trt:Profiles token="prof_main" fixed="true"><tt:Name>MainStream</tt:Name><tt:VideoEncoderConfiguration token="venc1"><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>2560</tt:Width><tt:Height>1440</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration><tt:PTZConfiguration token="ptz1"><tt:Name>ptz</tt:Name></tt:PTZConfiguration></trt:Profiles><trt:Profiles token="prof_sub" fixed="true"><tt:Name>SubStream</tt:Name><tt:VideoEncoderConfiguration token="venc2"><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>704</tt:Width><tt:Height>576</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles></trt:GetProfilesResponse>`,
          );
        case 'GetStreamUri':
          return soap(`<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://10.0.0.5:554/Streaming/Channels/101</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>`);
        case 'GetSnapshotUri':
          return soap(`<trt:GetSnapshotUriResponse><trt:MediaUri><tt:Uri>http://10.0.0.5/onvif/snapshot.jpg</tt:Uri></trt:MediaUri></trt:GetSnapshotUriResponse>`);
        case 'GetStatus':
          return soap(
            `<tptz:GetStatusResponse><tptz:PTZStatus><tt:Position><tt:PanTilt x="${ptz.pan}" y="${ptz.tilt}" space="http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace"/><tt:Zoom x="${ptz.zoom}"/></tt:Position><tt:MoveStatus><tt:PanTilt>${ptz.moving ? 'MOVING' : 'IDLE'}</tt:PanTilt><tt:Zoom>IDLE</tt:Zoom></tt:MoveStatus><tt:UtcTime>2026-01-01T00:00:00Z</tt:UtcTime></tt:PTZStatus></tptz:GetStatusResponse>`,
          );
        case 'ContinuousMove': {
          const v = /<(?:\w+:)?PanTilt x="([-\d.]+)" y="([-\d.]+)"/.exec(body);
          const z = /<(?:\w+:)?Zoom x="([-\d.]+)"/.exec(body);
          events.push(`move ${v ? `${v[1]},${v[2]}` : '-'} zoom ${z ? z[1] : '-'}`);
          ptz.moving = true;
          return soap('<tptz:ContinuousMoveResponse/>');
        }
        case 'Stop':
          events.push('stop');
          ptz.moving = false;
          return soap('<tptz:StopResponse/>');
        case 'AbsoluteMove': {
          const v = /<(?:\w+:)?PanTilt x="([-\d.]+)" y="([-\d.]+)"/.exec(body);
          const z = /<(?:\w+:)?Zoom x="([-\d.]+)"/.exec(body);
          if (v) {
            ptz.pan = Number(v[1]);
            ptz.tilt = Number(v[2]);
          }
          if (z) ptz.zoom = Number(z[1]);
          events.push(`abs ${v ? `${v[1]},${v[2]}` : '-'} zoom ${z ? z[1] : '-'}`);
          return soap('<tptz:AbsoluteMoveResponse/>');
        }
        case 'GotoHomePosition':
          ptz.pan = 0;
          ptz.tilt = 0;
          events.push('home');
          return soap('<tptz:GotoHomePositionResponse/>');
        case 'CreatePullPointSubscription':
          return soap(
            `<tev:CreatePullPointSubscriptionResponse><tev:SubscriptionReference><wsa:Address>${base}/onvif/Subscription?Idx=7</wsa:Address></tev:SubscriptionReference><wsnt:CurrentTime>2026-01-01T00:00:00Z</wsnt:CurrentTime><wsnt:TerminationTime>2026-01-01T00:01:00Z</wsnt:TerminationTime></tev:CreatePullPointSubscriptionResponse>`,
          );
        case 'PullMessages': {
          pulls++;
          if (pulls === 1)
            return soap(
              `<tev:PullMessagesResponse><tev:CurrentTime>2026-01-01T00:00:01Z</tev:CurrentTime><tev:TerminationTime>2026-01-01T00:01:00Z</tev:TerminationTime>` +
                `<wsnt:NotificationMessage><wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">tns1:RuleEngine/CellMotionDetector/Motion</wsnt:Topic><wsnt:Message><tt:Message UtcTime="2026-01-01T00:00:01Z" PropertyOperation="Changed"><tt:Source><tt:SimpleItem Name="VideoSourceConfigurationToken" Value="vsconf"/><tt:SimpleItem Name="Rule" Value="MyMotionDetectorRule"/></tt:Source><tt:Data><tt:SimpleItem Name="IsMotion" Value="true"/></tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>` +
                `<wsnt:NotificationMessage><wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">tns1:RuleEngine/FieldDetector/ObjectsInside</wsnt:Topic><wsnt:Message><tt:Message UtcTime="2026-01-01T00:00:02Z"><tt:Source><tt:SimpleItem Name="Rule" Value="Perimeter"/></tt:Source><tt:Data><tt:SimpleItem Name="IsInside" Value="true"/></tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>` +
                `<wsnt:NotificationMessage><wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">tns1:Thermal/Temperature/Alarm</wsnt:Topic><wsnt:Message><tt:Message UtcTime="2026-01-01T00:00:03Z"><tt:Source><tt:SimpleItem Name="Rule" Value="Transformer"/></tt:Source><tt:Data><tt:SimpleItem Name="State" Value="true"/><tt:SimpleItem Name="Temperature" Value="84.2"/></tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>` +
                `<wsnt:NotificationMessage><wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">tns1:Device/HardwareFailure/StorageFailure</wsnt:Topic><wsnt:Message><tt:Message UtcTime="2026-01-01T00:00:03Z"><tt:Data><tt:SimpleItem Name="Failed" Value="true"/></tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>` +
                `<wsnt:NotificationMessage><wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">tns1:RuleEngine/CellMotionDetector/Motion</wsnt:Topic><wsnt:Message><tt:Message UtcTime="2026-01-01T00:00:04Z"><tt:Data><tt:SimpleItem Name="IsMotion" Value="false"/></tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>` +
                `</tev:PullMessagesResponse>`,
            );
          // Nothing new: answer after a short wait like a real long-poll.
          return void setTimeout(
            () =>
              soap(
                '<tev:PullMessagesResponse><tev:CurrentTime>2026-01-01T00:00:05Z</tev:CurrentTime><tev:TerminationTime>2026-01-01T00:01:00Z</tev:TerminationTime></tev:PullMessagesResponse>',
              ),
            150,
          );
        }
        case 'Renew':
          return soap('<wsnt:RenewResponse><wsnt:TerminationTime>2026-01-01T00:02:00Z</wsnt:TerminationTime></wsnt:RenewResponse>');
        case 'Unsubscribe':
          return soap('<wsnt:UnsubscribeResponse/>');
        default:
          return soap('<s:Fault><s:Reason><s:Text>ActionNotSupported</s:Text></s:Reason></s:Fault>', 400);
      }
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as { port: number }).port, calls, ptz, events, close: () => srv.close() })));
}

describe('ONVIF client', () => {
  it('builds a WS-UsernameToken digest the camera side accepts, and rejects a wrong password', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const header = usernameToken({ username: 'admin', password: PASSWORD }, now);
    expect(header).toMatch(/PasswordDigest/);
    expect(verifyUsernameToken(header, PASSWORD, now)).toBe(true);
    expect(verifyUsernameToken(header, 'other', now)).toBe(false);
    expect(verifyUsernameToken(header, PASSWORD, now + 10 * 60_000)).toBe(false); // stale timestamp (replay)
  });

  it('reads device information, profiles, stream and snapshot URIs, keeping our host for NAT-ed XAddrs', async () => {
    const cam = await fakeCamera();
    cleanup.push(cam.close);
    const c = new OnvifClient({ host: '127.0.0.1', port: cam.port, username: 'admin', password: PASSWORD });
    expect(await c.getDeviceInformation()).toMatchObject({ manufacturer: 'FakeCam', model: 'FC-PTZ-1', firmware: 'V5.7.3' });
    const svc = await c.discover();
    expect(svc.ptz).toBe('http://10.0.0.5/onvif/ptz');
    expect(c.resolve(svc.ptz!).toString()).toBe(`http://127.0.0.1:${cam.port}/onvif/ptz`);
    const profiles = await c.getProfiles();
    expect(profiles).toHaveLength(2);
    expect(profiles[0]).toMatchObject({ token: 'prof_main', width: 2560, height: 1440, ptz: true });
    expect(profiles[1].ptz).toBe(false);
    expect(await c.getStreamUri('prof_main')).toBe('rtsp://10.0.0.5:554/Streaming/Channels/101');
    expect(await c.getSnapshotUri('prof_main')).toMatch(/snapshot\.jpg$/);
    const st = await c.getStatus('prof_main');
    expect(st).toEqual({ pan: 0.25, tilt: -0.1, zoom: 0.2, moving: false });
  });

  it('fails clearly on a wrong password', async () => {
    const cam = await fakeCamera();
    cleanup.push(cam.close);
    const c = new OnvifClient({ host: '127.0.0.1', port: cam.port, username: 'admin', password: 'nope' });
    await expect(c.getDeviceInformation()).rejects.toThrow(/Authentication failed/);
  });

  it('turns ONVIF topics into platform detections and ignores housekeeping', () => {
    const ev = (topic: string, data: Record<string, string>) => interpretEvent({ topic, at: 0, source: {}, data });
    expect(ev('tns1:RuleEngine/CellMotionDetector/Motion', { IsMotion: 'true' })).toEqual({ type: 'motion', active: true });
    expect(ev('tns1:RuleEngine/CellMotionDetector/Motion', { IsMotion: 'false' })).toEqual({ type: 'motion', active: false });
    expect(ev('tns1:RuleEngine/LineDetector/Crossed', { ObjectId: '12' })).toMatchObject({ type: 'intrusion' });
    expect(ev('tns1:VideoAnalytics/HumanDetection', { State: 'true' })).toEqual({ type: 'person', active: true });
    expect(ev('tns1:Thermal/Temperature/Alarm', { State: 'true', Temperature: '84.2' })).toEqual({ type: 'thermal_hotspot', active: true, attributes: { temperatureC: 84.2 } });
    expect(ev('tns1:RuleEngine/LicensePlateRecognition', { PlateNumber: '1กข 1234' })).toMatchObject({ type: 'lpr', attributes: { plate: '1กข 1234' } });
    expect(ev('tns1:VideoSource/ImageTooBlurry/ImagingService', { State: 'true' })).toBeNull();
    expect(ev('tns1:Device/HardwareFailure/StorageFailure', { Failed: 'true' })).toBeNull();
    expect(ev('tns1:VideoSource/GlobalSceneChange/ImagingService', { State: 'true' })).toBeNull();
    expect(ev('tns1:RuleEngine/TamperDetector/Tamper', { IsTamper: 'true' })).toEqual({ type: 'tamper', active: true });
  });
});

describe('ONVIF camera adapter', () => {
  it('connects, reports equipment and PTZ attitude, controls the camera, takes a photo and raises detections', async () => {
    const cam = await fakeCamera();
    cleanup.push(cam.close);
    const ad = new OnvifCameraAdapter({
      deviceId: 'CAM-PTZ-01',
      host: '127.0.0.1',
      port: cam.port,
      username: 'admin',
      password: PASSWORD,
      model: 'FakeCam FC-PTZ-1',
      pos: { x: 262, y: 152 },
      panRangeDeg: 360,
      tiltRangeDeg: 180,
      maxZoom: 25,
      pollMs: 200,
    });
    expect(ad.declaration.capabilities).toEqual(expect.arrayContaining(['video', 'camera', 'photo', 'gimbal', 'zoom']));
    const { ctx, got } = fakeCtx();
    ad.start(ctx);
    cleanup.push(() => ad.stop());
    await until(() => got.telemetry.length >= 2);
    const t = got.telemetry[got.telemetry.length - 1];
    expect(t.pos).toEqual({ x: 262, y: 152 });
    expect(t.gimbal).toEqual({ yaw: 45, pitch: -9, zoom: 5.8 });
    const comps = got.telemetry.flatMap((x) => x.components ?? []);
    expect(comps.find((c) => c.id === 'cam')).toMatchObject({ status: 'ok', version: 'V5.7.3' });
    expect(comps.find((c) => c.id === 'ptz')?.status).toBe('ok');
    expect(comps.find((c) => c.id === 'media')?.detail).toMatch(/rtsp:\/\/10\.0\.0\.5.*2560×1440/);

    // Analytics events from the first pull: motion, intrusion and a thermal alarm; storage failure and "motion ended" are dropped.
    await until(() => got.events.filter((e) => e.kind === 'detection').length >= 3);
    const det = got.events.filter((e) => e.kind === 'detection').map((e) => e.detection!);
    expect(det.map((d) => d.type)).toEqual(['motion', 'intrusion', 'thermal_hotspot']);
    expect(det[2].attributes).toEqual({ temperatureC: 84.2 });
    expect(got.events.find((e) => e.kind === 'detection' && e.detection!.type === 'motion')!.at).toBe(Date.UTC(2026, 0, 1, 0, 0, 1));
    expect(comps.concat(got.telemetry.flatMap((x) => x.components ?? [])).some((c) => c.id === 'events' && c.status === 'ok')).toBe(true);

    // Pan right at 80%, then stop.
    ad.onCamera('r1', { action: 'gimbal_speed', yaw: 80, pitch: 0 });
    await until(() => got.camera.some((c) => c.requestId === 'r1'));
    expect(got.camera.find((c) => c.requestId === 'r1')).toMatchObject({ ok: true, confirmed: true });
    expect(cam.events).toContain('move 0.800,0.000 zoom -');
    ad.onCamera('r2', { action: 'gimbal_speed', yaw: 0, pitch: 0 });
    await until(() => got.camera.some((c) => c.requestId === 'r2'));
    expect(cam.events).toContain('stop');
    // Absolute angle: 90° of a 360° range is pan 0.5; −45° of 180° tilt is −0.5.
    ad.onCamera('r3', { action: 'gimbal_angle', yaw: 90, pitch: -45 });
    await until(() => got.camera.some((c) => c.requestId === 'r3'));
    expect(cam.events).toContain('abs 0.500,-0.500 zoom -');
    await until(() => (got.telemetry[got.telemetry.length - 1].gimbal?.yaw ?? 0) === 90);
    // Zoom to 13× of 25× → ONVIF 0.5.
    ad.onCamera('r4', { action: 'zoom_to', level: 13 });
    await until(() => got.camera.some((c) => c.requestId === 'r4'));
    expect(cam.events).toContain('abs - zoom 0.500');
    ad.onCamera('r5', { action: 'center' });
    await until(() => got.camera.some((c) => c.requestId === 'r5'));
    expect(cam.events).toContain('home');
    // Photo: snapshot URI (with the camera's NAT address) fetched from our host with Basic auth → snapshot event.
    ad.onCamera('r6', { action: 'photo' });
    await until(() => got.camera.some((c) => c.requestId === 'r6'));
    expect(got.camera.find((c) => c.requestId === 'r6')).toMatchObject({ ok: true, confirmed: true });
    const snap = got.events.find((e) => e.kind === 'snapshot');
    expect(snap?.frame?.mime).toBe('image/jpeg');
    expect(Buffer.from(snap!.frame!.base64, 'base64').equals(JPEG)).toBe(true);
    ad.onCamera('r7', { action: 'record' });
    await until(() => got.camera.some((c) => c.requestId === 'r7'));
    expect(got.camera.find((c) => c.requestId === 'r7')!.ok).toBe(false);
  }, 15_000);

  it('reports an authentication fault instead of retrying forever, and sends no telemetry', async () => {
    const cam = await fakeCamera();
    cleanup.push(cam.close);
    const ad = new OnvifCameraAdapter({ deviceId: 'CAM-X', host: '127.0.0.1', port: cam.port, username: 'admin', password: 'wrong', pos: { x: 0, y: 0 }, pollMs: 100 });
    const { ctx, got } = fakeCtx();
    ad.start(ctx);
    cleanup.push(() => ad.stop());
    await until(() => (ad as unknown as { comps: { get(id: string): { status: string; detail?: string } | undefined } }).comps.get('cam')?.status === 'fault');
    expect((ad as unknown as { comps: { get(id: string): { detail?: string } | undefined } }).comps.get('cam')?.detail).toMatch(/Authentication failed/);
    await wait(300);
    expect(got.telemetry).toHaveLength(0);
    ad.onCamera('x', { action: 'center' });
    await until(() => got.camera.length === 1);
    expect(got.camera[0].ok).toBe(false);
  });

  it('declares a fixed camera without PTZ when ptz is off', () => {
    const ad = new OnvifCameraAdapter({ deviceId: 'CAM-T', host: '10.0.0.9', username: 'u', password: 'p', pos: { x: 1, y: 2 }, ptz: false, events: false });
    expect(ad.declaration.capabilities).toEqual(['video', 'camera', 'photo']);
    expect(ad.declaration.components!.map((c) => c.id)).toEqual(['cam', 'media']);
  });
});
