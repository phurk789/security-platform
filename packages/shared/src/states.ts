// Allowed status transitions (PRD §4). The server rejects anything not listed here.
import type { AssignmentStatus, CommandStatus, IncidentStatus, MissionStatus } from './types';

export const INCIDENT_FLOW: Record<IncidentStatus, IncidentStatus[]> = {
  new: ['triaging', 'confirmed', 'duplicate', 'dismissed'],
  triaging: ['confirmed', 'duplicate', 'dismissed'],
  confirmed: ['responding', 'resolved', 'duplicate'],
  responding: ['resolved'],
  resolved: ['closed', 'triaging'],
  // Reopen always needs a reason and goes back to triage.
  closed: ['triaging'],
  duplicate: ['triaging'],
  dismissed: ['triaging'],
};

export const MISSION_FLOW: Record<MissionStatus, MissionStatus[]> = {
  draft: ['pending_approval', 'cancelled'],
  pending_approval: ['approved', 'rejected', 'cancelled', 'pending_approval'],
  approved: ['assigned', 'pending_approval', 'cancelled'],
  assigned: ['executing', 'pending_approval', 'cancelled'],
  executing: ['paused', 'completed', 'cancelled', 'failed'],
  paused: ['executing', 'completed', 'cancelled', 'failed'],
  rejected: ['pending_approval', 'cancelled', 'rejected'],
  completed: [],
  cancelled: [],
  failed: [],
};

export const COMMAND_FLOW: Record<CommandStatus, CommandStatus[]> = {
  requested: ['authorized', 'rejected'],
  authorized: ['sent', 'rejected', 'timed_out'],
  sent: ['acknowledged', 'rejected', 'timed_out'],
  acknowledged: ['executing', 'succeeded', 'failed', 'rejected', 'unknown'],
  executing: ['succeeded', 'failed', 'unknown'],
  succeeded: [],
  rejected: [],
  failed: [],
  timed_out: [],
  unknown: [],
};

export const ASSIGNMENT_FLOW: Record<AssignmentStatus, AssignmentStatus[]> = {
  assigned: ['accepted', 'cancelled'],
  accepted: ['on_scene', 'cancelled'],
  on_scene: ['reported', 'cancelled'],
  reported: [],
  cancelled: [],
};

export const TERMINAL_COMMAND: CommandStatus[] = ['succeeded', 'rejected', 'failed', 'timed_out', 'unknown'];
export const isTerminalCommand = (s: CommandStatus) => TERMINAL_COMMAND.includes(s);

export function canMove<S extends string>(flow: Record<S, S[]>, from: S, to: S) {
  return flow[from]?.includes(to) ?? false;
}
