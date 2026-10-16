// Offline outbox (PRD F14). Every change from the phone is queued here first, persisted, and
// sent in order. Each item gets its idempotency key once, when queued, so a resend after a
// dropped connection never creates a second report or photo on the server.
import type { Assignment, AssignmentStatus } from '@13store/shared';
import { ApiFailure, api, newKey, store } from './api';

export type OutboxKind = 'accept' | 'arrive' | 'report' | 'evidence';

export interface OutboxItem {
  id: string;
  userId: string;
  kind: OutboxKind;
  idempotencyKey: string;
  assignmentId: string;
  incidentId: string;
  createdAt: number;
  state: 'pending' | 'failed';
  attempts: number;
  error?: string;
  /** Report note, or evidence payload. */
  note?: string;
  photo?: { mime: string; base64: string; title: string; capturedAt: number };
}

const STORAGE_KEY = 'ps-field.outbox.v1';
const RANK: Record<AssignmentStatus, number> = { assigned: 0, accepted: 1, on_scene: 2, reported: 3, cancelled: 9 };
const TARGET: Record<'accept' | 'arrive' | 'report', AssignmentStatus> = { accept: 'accepted', arrive: 'on_scene', report: 'reported' };

export type SendResult = 'idle' | 'sent' | 'offline' | 'auth' | 'busy';

export class Outbox {
  private items: OutboxItem[] = [];
  private listeners = new Set<() => void>();
  private running = false;
  /** False if the last write to storage failed (quota or blocked storage). */
  persisted = true;

  constructor() {
    try {
      this.items = JSON.parse(store.get(STORAGE_KEY) ?? '[]') as OutboxItem[];
    } catch {
      this.items = [];
    }
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    this.persisted = store.set(STORAGE_KEY, JSON.stringify(this.items));
    for (const fn of this.listeners) fn();
  }

  list(userId: string) {
    return this.items.filter((i) => i.userId === userId);
  }

  add(item: Omit<OutboxItem, 'id' | 'idempotencyKey' | 'createdAt' | 'state' | 'attempts'>) {
    const full: OutboxItem = { ...item, id: newKey('item'), idempotencyKey: newKey(item.kind), createdAt: Date.now(), state: 'pending', attempts: 0 };
    this.items.push(full);
    this.changed();
    return full;
  }

  discard(id: string) {
    this.items = this.items.filter((i) => i.id !== id);
    this.changed();
  }

  retry(id: string) {
    const it = this.items.find((i) => i.id === id);
    if (it) {
      it.state = 'pending';
      it.error = undefined;
      this.changed();
    }
  }

  /** Status the phone should show: the server's, moved forward by actions still queued. */
  effectiveStatus(a: Assignment, userId: string): AssignmentStatus {
    if (a.status === 'cancelled') return 'cancelled';
    let s: AssignmentStatus = a.status;
    for (const it of this.list(userId)) {
      if (it.assignmentId !== a.id || it.kind === 'evidence' || it.state === 'failed') continue;
      const to = TARGET[it.kind];
      if (RANK[to] > RANK[s]) s = to;
    }
    return s;
  }

  /** Sends pending items in order. Stops at the first network/auth/server problem and keeps the rest. */
  async flush(token: string, userId: string): Promise<SendResult> {
    if (this.running) return 'busy';
    this.running = true;
    let sent = false;
    try {
      for (const it of [...this.list(userId)]) {
        if (it.state !== 'pending') continue;
        it.attempts += 1;
        try {
          await this.send(token, it);
          this.items = this.items.filter((x) => x.id !== it.id);
          sent = true;
          this.changed();
        } catch (e) {
          const f = e instanceof ApiFailure ? e : new ApiFailure(0, 'network', String(e), true);
          if (f.network) return 'offline';
          if (f.status === 401) return 'auth';
          if (f.status === 429 || f.status >= 500) return 'offline';
          if (f.status === 409 && it.kind !== 'evidence' && (await this.alreadyDone(token, it))) {
            this.items = this.items.filter((x) => x.id !== it.id);
            this.changed();
            continue;
          }
          it.state = 'failed';
          it.error = f.message;
          this.changed();
        }
      }
      return sent ? 'sent' : 'idle';
    } finally {
      this.running = false;
    }
  }

  private async send(token: string, it: OutboxItem) {
    if (it.kind === 'evidence') {
      const p = it.photo!;
      await api(token, 'POST', `/incidents/${encodeURIComponent(it.incidentId)}/evidence`, {
        kind: 'photo',
        mime: p.mime,
        contentBase64: p.base64,
        title: p.title,
        capturedAt: p.capturedAt,
        idempotencyKey: it.idempotencyKey,
      });
      return;
    }
    const action = it.kind;
    await api(token, 'POST', `/assignments/${encodeURIComponent(it.assignmentId)}/${action}`, {
      note: it.note,
      idempotencyKey: it.idempotencyKey,
    });
  }

  /** A 409 after a resend usually means the first attempt already went through. */
  private async alreadyDone(token: string, it: OutboxItem) {
    try {
      const list = await api<Assignment[]>(token, 'GET', '/assignments');
      const a = list.find((x) => x.id === it.assignmentId);
      if (!a || a.status === 'cancelled') return false;
      return RANK[a.status] >= RANK[TARGET[it.kind as 'accept' | 'arrive' | 'report']];
    } catch {
      return false;
    }
  }
}

export const outbox = new Outbox();
