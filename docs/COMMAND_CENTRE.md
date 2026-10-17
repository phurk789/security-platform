# Command centre: playbooks, SLA, notifications, KPIs

What turns the console from a map with alerts into a control room: every alert follows a
standard operating procedure with time limits, people outside the room are told when it matters,
and the month can be reported on with numbers.

## Playbooks (SOP) and SLA stages

A playbook names the steps for a kind of incident and the minutes allowed for each stage, counted
from the alert:

| Stage       | Means                                      | Done when the timeline shows                                              |
| ----------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| Acknowledge | Somebody is looking                        | _Camera opened_ / _Operator reviewing_ (triage)                           |
| Verify      | A decision: confirmed, dismissed or merged | _Verified — action required_, _Dismissed as false alarm_, _Merged into …_ |
| Respond     | Something is on its way                    | _Mission … started_, _Assigned to …_ (field responder)                    |
| Resolve     | Outcome recorded                           | _Resolved_ / _Closed_                                                     |

The platform picks the first playbook whose match (incident types, severities, source text) fits
a new incident, copies its steps onto the incident as a **checklist** and keeps the SLA limits.
Defaults: _Fire, smoke or thermal hotspot_ (1 / 3 / 5 / 90 min), _Intrusion or person in a
protected area_ (2 / 5 / 10 / 60), _Equipment fault_ (5 / 15 / – / 480), _General alert_
(3 / 10 / 20 / 120). Administrators change them under Administration → settings API
(`playbooks` in `PATCH /admin/settings`); the console shows the result on every incident.

In the console:

- **Incident details** shows one chip per stage: time left, _overdue_, or ✓ with the time it took.
  The incident queue marks **SLA at risk** / **SLA breached**.
- **Playbook** section: the checklist with tick boxes; who ticked and when goes on the incident
  and the timeline (`POST /incidents/{id}/steps/{stepId}`), audited `incident.step`.
- Every 10 s the server checks open incidents. A stage that passes its limit is raised **once**:
  timeline entry _SLA breached: verify within 5 min_, console notice, audit `sla.breach`, metric
  `ps_sla_breaches_total{stage}` and the `sla.breach` notification.

Scheduled patrols are incidents of type _Scheduled patrol_ and are left out of SLA and alert KPIs.

## Outbound notifications

Administration → **Notification channels**. Each channel has a kind, the events it wants and an
optional minimum severity for incident events.

| Kind        | How                                                                                                                                                                                                  | Set-up                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Webhook** | `POST` JSON `{ id, event, at, title, text, severity, incidentId, data }` with headers `X-PST-Event`, `X-PST-Delivery` and, when a secret is set, `X-PST-Signature: sha256=<HMAC-SHA256 of the body>` | Any SIEM, ticketing tool or automation; verify the signature with the shared secret                                                       |
| **LINE**    | LINE Messaging API push (`/v2/bot/message/push`) to a group, room or user                                                                                                                            | A LINE Official Account with a channel access token; add the bot to the group and use the group id (LINE Notify was discontinued in 2025) |
| **SMS**     | Any HTTP SMS gateway: URL and optional body template with `{to}` and `{text}` placeholders; one request per number                                                                                   | ThaiBulkSMS, Twilio-style gateways, an on-premises GSM modem with an HTTP front end                                                       |

Events: new alert, alert confirmed, incident resolved, SLA breached, geofence breach, AI detection
raised an incident, patrol skipped, device offline. Deliveries are retried (three attempts) and
every attempt is logged (`GET /admin/notifications/log`); **Test** sends a message through one
channel. Secrets are stored on the server and shown masked in the console. Metric:
`ps_notifications_total{kind,status}`.

## KPIs and the period report

Reports → **Operations KPIs** (last 7 days, 30 days or this month):

- Alerts (total, open), false-alarm rate (dismissed or duplicate), alerts per day and by hour,
  by type and by zone.
- Response times per stage (median and 90th percentile, from the alert) and **SLA compliance**
  (stages met ÷ stages measured), per stage.
- Missions (completed, cancelled, failed, scheduled patrols), AI detections by outcome, patrol
  runs and skips.
- **Export period report**: a Markdown report with all of the above (`GET /kpi/report?from&to&download=1`),
  audited like an incident report (`evidence.export`).

The same computation (`packages/shared/src/ops.ts → computeKpi`) runs on the server over
everything it holds and in the browser over what the console has, so the offline booth shows the
same dashboard labelled with its data source.

## Status

| Part                                                                                     | Status                                                                                | Tests         |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------- |
| Playbook matching, checklist, SLA stages and breach raising                              | Done                                                                                  | `ops.test.ts` |
| Notification channels (webhook HMAC + retry, LINE push, SMS gateway), test, log, masking | Done — verified against fake endpoints; real LINE / SMS accounts needed for the pilot | `ops.test.ts` |
| KPIs and period report                                                                   | Done                                                                                  | `ops.test.ts` |
