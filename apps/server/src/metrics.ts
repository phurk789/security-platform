// Prometheus-style metrics for the platform (no dependency): counters, gauges and one latency
// histogram, exposed at /api/v1/metrics for the customer's monitoring (Grafana, Zabbix, …).
export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, () => number>();
  private latency = { buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], counts: new Array<number>(11).fill(0), sum: 0, n: 0 };
  readonly startedAt = Date.now();

  inc(name: string, labels: Record<string, string | number> = {}, by = 1) {
    const key = `${name}${labelStr(labels)}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  /** A gauge is read when scraped, so it is always current. */
  gauge(name: string, read: () => number, labels: Record<string, string | number> = {}) {
    this.gauges.set(`${name}${labelStr(labels)}`, read);
  }

  observe(seconds: number) {
    const h = this.latency;
    h.sum += seconds;
    h.n++;
    let i = h.buckets.findIndex((b) => seconds <= b);
    if (i < 0) i = h.buckets.length;
    for (let k = i; k < h.counts.length; k++) h.counts[k]++;
  }

  render(): string {
    const out: string[] = [];
    const byName = new Map<string, string[]>();
    for (const [key, v] of this.counters) {
      const name = key.split('{')[0];
      byName.set(name, [...(byName.get(name) ?? []), `${key} ${v}`]);
    }
    for (const [name, lines] of byName) out.push(`# TYPE ${name} counter`, ...lines);
    const gaugeNames = new Map<string, string[]>();
    for (const [key, read] of this.gauges) {
      const name = key.split('{')[0];
      let v = 0;
      try {
        v = read();
      } catch {
        v = NaN;
      }
      gaugeNames.set(name, [...(gaugeNames.get(name) ?? []), `${key} ${v}`]);
    }
    for (const [name, lines] of gaugeNames) out.push(`# TYPE ${name} gauge`, ...lines);
    const h = this.latency;
    out.push('# TYPE ps_http_request_duration_seconds histogram');
    h.buckets.forEach((b, i) => out.push(`ps_http_request_duration_seconds_bucket{le="${b}"} ${h.counts[i]}`));
    out.push(
      `ps_http_request_duration_seconds_bucket{le="+Inf"} ${h.counts[h.buckets.length]}`,
      `ps_http_request_duration_seconds_sum ${h.sum}`,
      `ps_http_request_duration_seconds_count ${h.n}`,
    );
    out.push('# TYPE ps_process_uptime_seconds gauge', `ps_process_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`);
    return out.join('\n') + '\n';
  }
}

function labelStr(labels: Record<string, string | number>) {
  const keys = Object.keys(labels);
  return keys.length ? `{${keys.map((k) => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`).join(',')}}` : '';
}
