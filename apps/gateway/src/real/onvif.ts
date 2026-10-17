// Minimal ONVIF client (Profile S / T): SOAP 1.2 over HTTP with WS-UsernameToken digest
// authentication, no XML library. Covers what the platform needs from a fixed or PTZ IP camera:
// device information, media profiles and stream/snapshot URIs, PTZ status and moves, and the
// pull-point event stream (motion, intrusion, thermal and other analytics events).
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

export interface OnvifAuth {
  username: string;
  password: string;
}

export interface OnvifEndpoint extends OnvifAuth {
  host: string;
  port?: number;
  /** Use HTTPS to the camera (rare; most cameras speak plain HTTP on the LAN). */
  tls?: boolean;
  /** Request timeout (ms). */
  timeoutMs?: number;
  /** Clock source, so tests can control WS-Security timestamps. */
  now?: () => number;
}

export class OnvifError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const NS = {
  s: 'http://www.w3.org/2003/05/soap-envelope',
  tds: 'http://www.onvif.org/ver10/device/wsdl',
  trt: 'http://www.onvif.org/ver10/media/wsdl',
  tptz: 'http://www.onvif.org/ver20/ptz/wsdl',
  tev: 'http://www.onvif.org/ver10/events/wsdl',
  tt: 'http://www.onvif.org/ver10/schema',
  wsnt: 'http://docs.oasis-open.org/wsn/b-2',
  wsa: 'http://www.w3.org/2005/08/addressing',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
};

export const ONVIF_DEVICE_PATH = '/onvif/device_service';

// ---------------------------------------------------------------------------
// XML helpers (namespace-prefix agnostic, enough for ONVIF responses)
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** Inner text of the first element with this local name. */
export function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`).exec(xml);
  return m ? unesc(m[1].trim()) : undefined;
}

/** Inner XML of every element with this local name. */
export function tags(xml: string, name: string): string[] {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

/** Attributes of the first element with this local name (self-closing or not). */
export function attrs(xml: string, name: string): Record<string, string> {
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}((?:\\s+[\\w.:-]+="[^"]*")*)\\s*/?>`).exec(xml);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const a of m[1].matchAll(/([\w.:-]+)="([^"]*)"/g)) out[a[1].replace(/^[\w.-]+:/, '')] = unesc(a[2]);
  return out;
}

/** Every element with this local name, with its attributes and inner XML. */
export function elements(xml: string, name: string): { attrs: Record<string, string>; inner: string }[] {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}((?:\\s+[\\w.:-]+="[^"]*")*)\\s*(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>)`, 'g');
  const out: { attrs: Record<string, string>; inner: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const a: Record<string, string> = {};
    for (const x of m[1].matchAll(/([\w.:-]+)="([^"]*)"/g)) a[x[1].replace(/^[\w.-]+:/, '')] = unesc(x[2]);
    out.push({ attrs: a, inner: m[2] ?? '' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// WS-Security UsernameToken (PasswordDigest), as every ONVIF camera expects
// ---------------------------------------------------------------------------

export function usernameToken(auth: OnvifAuth, now: number, nonce = randomBytes(16)) {
  const created = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const digest = createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(auth.password)]))
    .digest('base64');
  return (
    `<wsse:Security s:mustUnderstand="1" xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}"><wsse:UsernameToken>` +
    `<wsse:Username>${esc(auth.username)}</wsse:Username>` +
    `<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password>` +
    `<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</wsse:Nonce>` +
    `<wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security>`
  );
}

/** Server side of the digest check (used by the fake camera in tests and by anyone proxying ONVIF). */
export function verifyUsernameToken(header: string, password: string, now: number, skewMs = 5 * 60_000) {
  const nonce = tag(header, 'Nonce');
  const created = tag(header, 'Created');
  const digest = tag(header, 'Password');
  if (!nonce || !created || !digest) return false;
  const at = Date.parse(created);
  if (!Number.isFinite(at) || Math.abs(at - now) > skewMs) return false;
  const expect = createHash('sha1')
    .update(Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created), Buffer.from(password)]))
    .digest('base64');
  return expect === digest;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface OnvifDeviceInfo {
  manufacturer: string;
  model: string;
  firmware: string;
  serial: string;
  hardwareId: string;
}

export interface OnvifProfile {
  token: string;
  name: string;
  width?: number;
  height?: number;
  encoding?: string;
  ptz: boolean;
}

export interface PtzStatus {
  /** Normalised −1…1 (ONVIF generic spaces). */
  pan: number;
  tilt: number;
  /** Normalised 0…1. */
  zoom: number;
  moving: boolean;
}

export interface OnvifEvent {
  topic: string;
  at: number;
  /** SimpleItem name → value from Source and Data. */
  source: Record<string, string>;
  data: Record<string, string>;
}

export class OnvifClient {
  private readonly port: number;
  private readonly now: () => number;
  private services: { device: string; media?: string; ptz?: string; events?: string };

  constructor(private readonly ep: OnvifEndpoint) {
    this.port = ep.port ?? (ep.tls ? 443 : 80);
    this.now = ep.now ?? Date.now;
    this.services = { device: ONVIF_DEVICE_PATH };
  }

  get mediaXAddr() {
    return this.services.media;
  }
  get ptzXAddr() {
    return this.services.ptz;
  }
  get eventsXAddr() {
    return this.services.events;
  }

  /** One SOAP call. `body` is the inner Body XML; `to` a service path or absolute URL on the camera. */
  async call(to: string, body: string, opts: { auth?: boolean; action?: string } = {}): Promise<string> {
    const header = ((opts.auth ?? true) ? usernameToken(this.ep, this.now()) : '') + (opts.action ? `<wsa:Action>${esc(opts.action)}</wsa:Action>` : '');
    const envelope =
      `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="${NS.s}" xmlns:tds="${NS.tds}" xmlns:trt="${NS.trt}" xmlns:tptz="${NS.tptz}" xmlns:tev="${NS.tev}" xmlns:tt="${NS.tt}" xmlns:wsnt="${NS.wsnt}" xmlns:wsa="${NS.wsa}">` +
      `<s:Header>${header}</s:Header><s:Body>${body}</s:Body></s:Envelope>`;
    const url = this.resolve(to);
    const res = await this.post(url, envelope);
    if (res.status === 401) throw new OnvifError('Authentication failed: the camera refused the username or password.', 401);
    const fault = tag(res.body, 'Fault');
    if (fault) {
      const reason = tag(fault, 'Text') ?? tag(fault, 'Reason') ?? tag(fault, 'Value') ?? 'SOAP fault';
      throw new OnvifError(`Camera fault: ${reason.replace(/\s+/g, ' ').trim()}`, res.status);
    }
    if (res.status >= 400) throw new OnvifError(`Camera answered HTTP ${res.status}`, res.status);
    return res.body;
  }

  /** XAddrs often carry the camera's idea of its own address (behind NAT it is wrong): keep the path, use our host. */
  resolve(to: string): URL {
    const base = `${this.ep.tls ? 'https' : 'http'}://${this.ep.host}:${this.port}`;
    if (/^https?:\/\//.test(to)) {
      const u = new URL(to);
      return new URL(u.pathname + u.search, base);
    }
    return new URL(to, base);
  }

  private post(url: URL, xml: string): Promise<{ status: number; body: string }> {
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(
        url,
        { method: 'POST', headers: { 'content-type': 'application/soap+xml; charset=utf-8', 'content-length': Buffer.byteLength(xml) }, timeout: this.ep.timeoutMs ?? 5000 },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('timeout', () => req.destroy(new OnvifError('Camera did not answer in time.')));
      req.on('error', (e) => reject(e instanceof OnvifError ? e : new OnvifError(`Cannot reach camera: ${e.message}`)));
      req.end(xml);
    });
  }

  /** Plain HTTP GET with Basic auth, then Digest if the camera asks for it (snapshot URIs). */
  async getBytes(to: string): Promise<{ mime: string; bytes: Buffer }> {
    const url = this.resolve(to);
    const once = (authHeader?: string) =>
      new Promise<{ status: number; headers: http.IncomingHttpHeaders; bytes: Buffer }>((resolve, reject) => {
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request(url, { method: 'GET', headers: authHeader ? { authorization: authHeader } : {}, timeout: this.ep.timeoutMs ?? 5000 }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes: Buffer.concat(chunks) }));
        });
        req.on('timeout', () => req.destroy(new OnvifError('Camera did not answer in time.')));
        req.on('error', (e) => reject(e instanceof OnvifError ? e : new OnvifError(`Cannot reach camera: ${e.message}`)));
        req.end();
      });
    let r = await once(`Basic ${Buffer.from(`${this.ep.username}:${this.ep.password}`).toString('base64')}`);
    if (r.status === 401 && /^Digest /i.test(String(r.headers['www-authenticate'] ?? '')))
      r = await once(digestAuth(String(r.headers['www-authenticate']), 'GET', url.pathname + url.search, this.ep));
    if (r.status === 401) throw new OnvifError('Authentication failed for the snapshot URI.', 401);
    if (r.status >= 400) throw new OnvifError(`Snapshot HTTP ${r.status}`, r.status);
    return { mime: String(r.headers['content-type'] ?? 'image/jpeg').split(';')[0], bytes: r.bytes };
  }

  // ---- device service ------------------------------------------------------

  async getDeviceInformation(): Promise<OnvifDeviceInfo> {
    const x = await this.call(this.services.device, '<tds:GetDeviceInformation/>');
    return {
      manufacturer: tag(x, 'Manufacturer') ?? '',
      model: tag(x, 'Model') ?? '',
      firmware: tag(x, 'FirmwareVersion') ?? '',
      serial: tag(x, 'SerialNumber') ?? '',
      hardwareId: tag(x, 'HardwareId') ?? '',
    };
  }

  /** Finds the media, PTZ and events services (GetServices, falling back to GetCapabilities). */
  async discover() {
    try {
      const x = await this.call(this.services.device, '<tds:GetServices><tds:IncludeCapability>false</tds:IncludeCapability></tds:GetServices>');
      for (const svc of tags(x, 'Service')) {
        const ns = tag(svc, 'Namespace') ?? '';
        const xaddr = tag(svc, 'XAddr');
        if (!xaddr) continue;
        if (ns.includes('/media/')) this.services.media = xaddr;
        else if (ns.includes('/ptz/')) this.services.ptz = xaddr;
        else if (ns.includes('/events/')) this.services.events = xaddr;
      }
    } catch (e) {
      if (e instanceof OnvifError && e.status === 401) throw e;
    }
    if (!this.services.media) {
      const x = await this.call(this.services.device, '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>');
      const pick = (name: string) => {
        const sect = tag(x, name);
        return sect ? tag(sect, 'XAddr') : undefined;
      };
      this.services.media = pick('Media');
      this.services.ptz = this.services.ptz ?? pick('PTZ');
      this.services.events = this.services.events ?? pick('Events');
    }
    if (!this.services.media) throw new OnvifError('The camera has no media service.');
    return { ...this.services };
  }

  // ---- media service -------------------------------------------------------

  async getProfiles(): Promise<OnvifProfile[]> {
    const x = await this.call(this.services.media ?? (await this.discover()).media!, '<trt:GetProfiles/>');
    return elements(x, 'Profiles').map((p) => {
      const enc = tag(p.inner, 'VideoEncoderConfiguration');
      const res = enc ? tag(enc, 'Resolution') : undefined;
      return {
        token: p.attrs.token ?? '',
        name: tag(p.inner, 'Name') ?? p.attrs.token ?? '',
        width: res ? Number(tag(res, 'Width')) : undefined,
        height: res ? Number(tag(res, 'Height')) : undefined,
        encoding: enc ? tag(enc, 'Encoding') : undefined,
        ptz: /PTZConfiguration/.test(p.inner),
      };
    });
  }

  async getStreamUri(profileToken: string): Promise<string> {
    const x = await this.call(
      this.services.media!,
      `<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${esc(profileToken)}</trt:ProfileToken></trt:GetStreamUri>`,
    );
    const uri = tag(x, 'Uri');
    if (!uri) throw new OnvifError('Camera returned no stream URI.');
    return uri;
  }

  async getSnapshotUri(profileToken: string): Promise<string | undefined> {
    const x = await this.call(this.services.media!, `<trt:GetSnapshotUri><trt:ProfileToken>${esc(profileToken)}</trt:ProfileToken></trt:GetSnapshotUri>`);
    return tag(x, 'Uri');
  }

  // ---- PTZ service ---------------------------------------------------------

  async getStatus(profileToken: string): Promise<PtzStatus> {
    if (!this.services.ptz) throw new OnvifError('The camera has no PTZ service.');
    const x = await this.call(this.services.ptz, `<tptz:GetStatus><tptz:ProfileToken>${esc(profileToken)}</tptz:ProfileToken></tptz:GetStatus>`);
    const pos = tag(x, 'Position') ?? '';
    const pt = attrs(pos, 'PanTilt');
    const z = attrs(pos, 'Zoom');
    const ms = tag(x, 'MoveStatus') ?? '';
    return { pan: Number(pt.x ?? 0), tilt: Number(pt.y ?? 0), zoom: Number(z.x ?? 0), moving: /MOVING/.test(ms) };
  }

  /** Speeds −1…1 (pan, tilt) and zoom −1…1. Zero everywhere stops. */
  async continuousMove(profileToken: string, pan: number, tilt: number, zoom = 0) {
    if (!this.services.ptz) throw new OnvifError('The camera has no PTZ service.');
    if (pan === 0 && tilt === 0 && zoom === 0) return this.stop(profileToken);
    const vel = `${pan || tilt ? `<tt:PanTilt x="${n(pan)}" y="${n(tilt)}"/>` : ''}${zoom ? `<tt:Zoom x="${n(zoom)}"/>` : ''}`;
    await this.call(
      this.services.ptz,
      `<tptz:ContinuousMove><tptz:ProfileToken>${esc(profileToken)}</tptz:ProfileToken><tptz:Velocity>${vel}</tptz:Velocity></tptz:ContinuousMove>`,
    );
  }

  async stop(profileToken: string, what: { panTilt?: boolean; zoom?: boolean } = { panTilt: true, zoom: true }) {
    if (!this.services.ptz) throw new OnvifError('The camera has no PTZ service.');
    await this.call(
      this.services.ptz,
      `<tptz:Stop><tptz:ProfileToken>${esc(profileToken)}</tptz:ProfileToken><tptz:PanTilt>${what.panTilt !== false}</tptz:PanTilt><tptz:Zoom>${what.zoom !== false}</tptz:Zoom></tptz:Stop>`,
    );
  }

  /** Absolute position in the generic spaces: pan/tilt −1…1, zoom 0…1 (omit to leave as is). */
  async absoluteMove(profileToken: string, pos: { pan?: number; tilt?: number; zoom?: number }) {
    if (!this.services.ptz) throw new OnvifError('The camera has no PTZ service.');
    const pt = pos.pan !== undefined || pos.tilt !== undefined ? `<tt:PanTilt x="${n(pos.pan ?? 0)}" y="${n(pos.tilt ?? 0)}"/>` : '';
    const z = pos.zoom !== undefined ? `<tt:Zoom x="${n(Math.max(0, Math.min(1, pos.zoom)))}"/>` : '';
    await this.call(
      this.services.ptz,
      `<tptz:AbsoluteMove><tptz:ProfileToken>${esc(profileToken)}</tptz:ProfileToken><tptz:Position>${pt}${z}</tptz:Position></tptz:AbsoluteMove>`,
    );
  }

  async gotoHome(profileToken: string) {
    if (!this.services.ptz) throw new OnvifError('The camera has no PTZ service.');
    await this.call(this.services.ptz, `<tptz:GotoHomePosition><tptz:ProfileToken>${esc(profileToken)}</tptz:ProfileToken></tptz:GotoHomePosition>`);
  }

  // ---- events (pull point) -------------------------------------------------

  /** Opens a pull-point subscription. Returns the address PullMessages must be sent to. */
  async subscribe(terminationS = 60): Promise<string> {
    if (!this.services.events) throw new OnvifError('The camera has no events service.');
    const x = await this.call(
      this.services.events,
      `<tev:CreatePullPointSubscription><tev:InitialTerminationTime>PT${terminationS}S</tev:InitialTerminationTime></tev:CreatePullPointSubscription>`,
      {
        action: 'http://www.onvif.org/ver10/events/wsdl/EventPortType/CreatePullPointSubscriptionRequest',
      },
    );
    const ref = tag(x, 'SubscriptionReference');
    const addr = ref ? tag(ref, 'Address') : undefined;
    if (!addr) throw new OnvifError('Camera returned no subscription address.');
    return addr;
  }

  async pull(subscription: string, timeoutS = 5, limit = 20): Promise<OnvifEvent[]> {
    const x = await this.call(subscription, `<tev:PullMessages><tev:Timeout>PT${timeoutS}S</tev:Timeout><tev:MessageLimit>${limit}</tev:MessageLimit></tev:PullMessages>`, {
      action: 'http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesRequest',
    });
    return tags(x, 'NotificationMessage').map((m) => {
      const items = (section: string) => {
        const sect = tag(m, section) ?? '';
        const out: Record<string, string> = {};
        for (const it of elements(sect, 'SimpleItem')) if (it.attrs.Name) out[it.attrs.Name] = it.attrs.Value ?? '';
        return out;
      };
      // <wsnt:Message> wraps <tt:Message UtcTime="…">: the time sits on the inner element.
      const utc = /<(?:[\w.-]+:)?Message\s[^>]*?UtcTime="([^"]+)"/.exec(m)?.[1];
      return { topic: (tag(m, 'Topic') ?? '').trim(), at: (utc && Date.parse(utc)) || this.now(), source: items('Source'), data: items('Data') };
    });
  }

  async renew(subscription: string, terminationS = 60) {
    await this.call(subscription, `<wsnt:Renew><wsnt:TerminationTime>PT${terminationS}S</wsnt:TerminationTime></wsnt:Renew>`, {
      action: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/RenewRequest',
    });
  }

  async unsubscribe(subscription: string) {
    await this.call(subscription, '<wsnt:Unsubscribe/>', { action: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/UnsubscribeRequest' });
  }
}

const n = (v: number) => Math.max(-1, Math.min(1, v)).toFixed(3);

/** RFC 2617 Digest for a snapshot GET when the camera insists on it. */
function digestAuth(challenge: string, method: string, uri: string, auth: OnvifAuth) {
  const p: Record<string, string> = {};
  for (const m of challenge.replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) p[m[1]] = m[2] ?? m[3];
  const md5 = (s: string) => createHash('md5').update(s).digest('hex');
  const ha1 = md5(`${auth.username}:${p.realm ?? ''}:${auth.password}`);
  const ha2 = md5(`${method}:${uri}`);
  const nc = '00000001';
  const cnonce = randomBytes(8).toString('hex');
  const qop = p.qop?.split(',')[0].trim();
  const response = qop ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
  return `Digest username="${auth.username}", realm="${p.realm ?? ''}", nonce="${p.nonce ?? ''}", uri="${uri}", response="${response}"${qop ? `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"` : ''}${p.opaque ? `, opaque="${p.opaque}"` : ''}`;
}

// ---------------------------------------------------------------------------
// Event interpretation: ONVIF topics → platform detections
// ---------------------------------------------------------------------------

export type OnvifDetection =
  | {
      type: 'motion' | 'intrusion' | 'person' | 'vehicle' | 'fire' | 'smoke' | 'thermal_hotspot' | 'crowd' | 'lpr' | 'other';
      active: boolean;
      attributes?: { temperatureC?: number; plate?: string; count?: number; label?: string };
    }
  | { type: 'tamper'; active: boolean }
  | null;

/** What an event means, or null for housekeeping topics (storage, time, configuration …). */
export function interpretEvent(e: OnvifEvent): OnvifDetection {
  const topic = e.topic.toLowerCase();
  const truthy = (v?: string) => v !== undefined && /^(true|1|active|start|on)$/i.test(v);
  const active =
    truthy(e.data.IsMotion) || truthy(e.data.State) || truthy(e.data.IsInside) || truthy(e.data.Active) || truthy(e.data.IsTamper) || Object.values(e.data).some(truthy);
  if (/tamper/.test(topic)) return { type: 'tamper', active };
  if (/fire|flame/.test(topic)) return { type: 'fire', active };
  if (/smoke/.test(topic)) return { type: 'smoke', active };
  if (/temperature|thermal|hotspot|heat/.test(topic)) {
    const t = Number(e.data.Temperature ?? e.data.MaxTemperature ?? e.data.Value);
    return { type: 'thermal_hotspot', active: true, attributes: Number.isFinite(t) ? { temperatureC: Math.round(t * 10) / 10 } : undefined };
  }
  if (/licenseplate|licence|lpr|anpr|plate/.test(topic))
    return { type: 'lpr', active: true, attributes: e.data.PlateNumber || e.data.Plate ? { plate: e.data.PlateNumber ?? e.data.Plate } : undefined };
  if (/crowd|peoplecount|counting/.test(topic)) {
    const c = Number(e.data.Count ?? e.data.People);
    return { type: 'crowd', active: true, attributes: Number.isFinite(c) ? { count: c } : undefined };
  }
  if (/human|person|people|face|pedestrian/.test(topic)) return { type: 'person', active };
  if (/vehicle|car/.test(topic)) return { type: 'vehicle', active };
  if (/intrusion|linedetector|linecross|fielddetector|regionentry|loitering|trespass|perimeter/.test(topic)) return { type: 'intrusion', active };
  if (/motion|cellmotion|motiondetector|motionalarm/.test(topic)) return { type: 'motion', active };
  return null;
}
