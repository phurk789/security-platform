// Outbound notifications: webhooks (HMAC-signed JSON), LINE Messaging API push and any HTTP SMS
// gateway. Deliveries are retried and every attempt is logged for the administrator.
import { createHmac, randomUUID } from 'node:crypto';
import { SEVERITY_RANK, type Incident, type NotificationChannel, type NotificationDelivery, type NotifyEvent } from '@13store/shared';
import type { DB } from './db';

export interface Outbound {
  event: NotifyEvent;
  title: string;
  text: string;
  severity?: Incident['severity'];
  incidentId?: string;
  data?: Record<string, unknown>;
}

export interface NotifierOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Waits between attempts (ms). Three attempts by default. */
  retryDelaysMs?: number[];
  /** LINE Messaging API push endpoint (overridable for tests). */
  lineApiUrl?: string;
  timeoutMs?: number;
  /** Where the platform says it is, for the message footer. */
  consoleUrl?: string;
}

export class Notifier {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly delays: number[];
  private readonly lineApiUrl: string;
  private readonly timeoutMs: number;
  private inflight = 0;
  /** Listeners for delivery results (metrics). */
  onDelivery?: (d: NotificationDelivery, orgId: string) => void;

  constructor(
    private readonly db: DB,
    private readonly opts: NotifierOptions = {},
  ) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.delays = opts.retryDelaysMs ?? [1000, 5000];
    this.lineApiUrl = opts.lineApiUrl ?? 'https://api.line.me/v2/bot/message/push';
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  /** Channels that want this message. */
  static matching(channels: NotificationChannel[], msg: Outbound) {
    return channels.filter((c) => c.enabled && c.events.includes(msg.event) && (!c.minSeverity || !msg.severity || SEVERITY_RANK[msg.severity] >= SEVERITY_RANK[c.minSeverity]));
  }

  /** Sends to every matching channel; never throws. Resolves when all deliveries are settled. */
  async dispatch(orgId: string, channels: NotificationChannel[], msg: Outbound): Promise<NotificationDelivery[]> {
    const targets = Notifier.matching(channels, msg);
    return Promise.all(targets.map((c) => this.deliver(orgId, c, msg)));
  }

  /** One channel, with retries. */
  async deliver(orgId: string, c: NotificationChannel, msg: Outbound): Promise<NotificationDelivery> {
    const id = `NTF-${randomUUID().slice(0, 8)}`;
    let attempts = 0;
    let detail = '';
    let ok = false;
    this.inflight++;
    try {
      for (let i = 0; i <= this.delays.length && !ok; i++) {
        attempts++;
        try {
          detail = await this.send(c, msg, id);
          ok = true;
        } catch (e) {
          detail = e instanceof Error ? e.message : String(e);
          if (i < this.delays.length) await sleep(this.delays[i]);
        }
      }
    } finally {
      this.inflight--;
    }
    const d: NotificationDelivery = {
      id,
      at: this.now(),
      channelId: c.id,
      channelName: c.name,
      kind: c.kind,
      event: msg.event,
      title: msg.title,
      status: ok ? 'sent' : 'failed',
      attempts,
      detail: detail.slice(0, 300),
      incidentId: msg.incidentId,
    };
    try {
      this.db
        .prepare('INSERT INTO notifications (id, org_id, at, channel_id, event, status, data) VALUES (?,?,?,?,?,?,?)')
        .run(id, orgId, d.at, c.id, msg.event, d.status, JSON.stringify(d));
    } catch (e) {
      console.error('[notify] log failed', e);
    }
    this.onDelivery?.(d, orgId);
    return d;
  }

  get pending() {
    return this.inflight;
  }

  private async send(c: NotificationChannel, msg: Outbound, deliveryId: string): Promise<string> {
    const text = `${msg.title}\n${msg.text}${this.opts.consoleUrl ? `\n${this.opts.consoleUrl}` : ''}`;
    if (c.kind === 'webhook' && c.webhook) {
      const body = JSON.stringify({
        id: deliveryId,
        event: msg.event,
        at: this.now(),
        title: msg.title,
        text: msg.text,
        severity: msg.severity,
        incidentId: msg.incidentId,
        data: msg.data ?? {},
      });
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'user-agent': '13store-public-security-twin',
        'x-pst-event': msg.event,
        'x-pst-delivery': deliveryId,
      };
      if (c.webhook.secret) headers['x-pst-signature'] = `sha256=${createHmac('sha256', c.webhook.secret).update(body).digest('hex')}`;
      const r = await this.fetchFn(c.webhook.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return `HTTP ${r.status}`;
    }
    if (c.kind === 'line' && c.line) {
      const r = await this.fetchFn(this.lineApiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${c.line.token}`, 'x-line-retry-key': deliveryId.padEnd(36, '0').slice(0, 36) },
        body: JSON.stringify({ to: c.line.to, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!r.ok) throw new Error(`LINE HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 120)}`);
      return `LINE HTTP ${r.status}`;
    }
    if (c.kind === 'sms' && c.sms) {
      const results: string[] = [];
      for (const to of c.sms.to) {
        const fill = (s: string) =>
          s
            .replace(/\{to\}/g, encodeURIComponent(to))
            .replace(/\{text\}/g, encodeURIComponent(text.slice(0, 450)))
            .replace(/\{text_raw\}/g, text.slice(0, 450).replace(/"/g, "'"));
        const url = fill(c.sms.url);
        const method = c.sms.method ?? 'POST';
        const headers: Record<string, string> = { 'user-agent': '13store-public-security-twin', ...(c.sms.headers ?? {}) };
        let body: string | undefined;
        if (method === 'POST') {
          body = c.sms.body ? fill(c.sms.body) : JSON.stringify({ to, text: text.slice(0, 450) });
          if (!headers['content-type']) headers['content-type'] = c.sms.body ? 'application/x-www-form-urlencoded' : 'application/json';
        }
        const r = await this.fetchFn(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
        if (!r.ok) throw new Error(`SMS HTTP ${r.status} for ${to}`);
        results.push(`${to}: ${r.status}`);
      }
      return results.join(', ');
    }
    throw new Error('Channel is not configured.');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
