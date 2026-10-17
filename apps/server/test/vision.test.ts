// Edge vision on the platform: analytics health lands on the device, detections keep their box,
// consoles that may view media get a live detection event, and the frame becomes evidence.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { GATEWAY_PROTOCOL } from '@13store/shared';
import { SANDBOX_GATEWAY_KEY } from '../src/seed';
import { Client, consoleSocket, startServer, waitFor, type TestServer } from './helpers';

let srv: TestServer;
let devop: Client;
let ws: WebSocket;

beforeAll(async () => {
  srv = await startServer({ gateway: false });
  devop = await Client.login(srv.url, 'devop');
  ws = new WebSocket(`${srv.wsUrl}/api/v1/gateway`, { headers: { authorization: `Bearer ${SANDBOX_GATEWAY_KEY}` } });
  await new Promise((r) => ws.on('open', r));
  const welcome = new Promise<any>((r) => ws.once('message', (m) => r(JSON.parse(String(m)))));
  ws.send(
    JSON.stringify({
      t: 'hello',
      protocol: GATEWAY_PROTOCOL,
      gatewayId: 'vision-edge',
      adapters: [
        {
          deviceId: 'SBX-ROVER-01',
          kind: 'cctv',
          model: 'NVR channel 7',
          adapterVersion: 'edge-vision 1.0',
          integration: 'testing',
          capabilities: ['video', 'analytics'],
          commands: [],
          rateMs: 5000,
          limitations: '',
          linkLossBehavior: '',
        },
      ],
    }),
  );
  expect((await welcome).accepted).toEqual(['SBX-ROVER-01']);
}, 30_000);
afterAll(async () => {
  ws?.close();
  await srv?.close();
});

// A tiny valid JPEG (1×1) as the evidence crop.
const JPEG_1X1 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

describe('vision on the platform', () => {
  it('stores analytics health on the camera and shows it to consoles', async () => {
    const con = await consoleSocket(srv.wsUrl, devop.token);
    ws.send(
      JSON.stringify({
        t: 'event',
        deviceId: 'SBX-ROVER-01',
        at: Date.now(),
        kind: 'analytics',
        analytics: {
          provider: 'edge-vision',
          running: true,
          source: 'ffmpeg',
          fps: 1.98,
          frames: 1200,
          detections: 7,
          detectors: { onnx: { model: '/opt/pst/models/yolov8n.onnx', inferenceMs: 180 }, motion: { frames: 1200 } },
          model: '/opt/pst/models/yolov8n.onnx',
          errors: 0,
          updatedAt: Date.now(),
        },
      }),
    );
    await waitFor(async () => !!((await devop.get('/devices')).body as any[]).find((d) => d.id === 'SBX-ROVER-01')?.analytics);
    const d = ((await devop.get('/devices')).body as any[]).find((d) => d.id === 'SBX-ROVER-01');
    expect(d.analytics).toMatchObject({ provider: 'edge-vision', running: true, source: 'ffmpeg', fps: 1.98, frames: 1200, detections: 7, model: '/opt/pst/models/yolov8n.onnx' });
    expect(d.analytics.detectors.onnx.inferenceMs).toBe(180);
    await waitFor(() => con.events.some((e) => e.type === 'device' && e.device.id === 'SBX-ROVER-01' && e.device.analytics));
    con.close();
  });

  it('a detection with a box and a frame raises an incident with the frame as evidence and reaches consoles live', async () => {
    const con = await consoleSocket(srv.wsUrl, devop.token);
    ws.send(
      JSON.stringify({
        t: 'event',
        deviceId: 'SBX-ROVER-01',
        at: Date.now() - 500,
        kind: 'detection',
        detail: 'intrusion (person) 91%',
        detection: {
          type: 'intrusion',
          confidence: 0.91,
          source: 'Edge vision',
          bbox: [0.41, 0.52, 0.09, 0.3],
          zone: 'Zone B',
          place: 'Service gate',
          attributes: { label: 'person' },
          snapshot: { mime: 'image/jpeg', base64: JPEG_1X1 },
          externalId: 'vision-1',
        },
      }),
    );
    await waitFor(() => con.events.some((e) => e.type === 'detection'));
    const ev = con.events.find((e) => e.type === 'detection')!;
    expect(ev.detection).toMatchObject({ type: 'intrusion', deviceId: 'SBX-ROVER-01', bbox: [0.41, 0.52, 0.09, 0.3], outcome: 'incident', source: 'Edge vision' });
    expect(ev.detection.snapshotEvidenceId).toMatch(/EV-/);
    const inc = (await devop.get(`/incidents/${ev.detection.incidentId}`)).body;
    expect(inc.title).toBe('Intrusion detected (person) · SBX-ROVER-01');
    expect(inc.type).toBe('Detection: Intrusion');
    const evidence = (await devop.get(`/incidents/${inc.id}/evidence`)).body as any[];
    const snap = evidence.find((e) => e.kind === 'snapshot');
    expect(snap).toMatchObject({ recordedBy: 'Edge vision', mime: 'image/jpeg' });
    // The record keeps the box for later overlays and reports.
    const list = (await devop.get('/detections?limit=5')).body as any[];
    expect(list.find((d) => d.externalId === 'vision-1' || d.id === ev.detection.id)?.bbox).toEqual([0.41, 0.52, 0.09, 0.3]);
    con.close();
  });
});
