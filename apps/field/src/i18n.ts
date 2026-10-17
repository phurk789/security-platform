// Thai / English labels. Thai is the default for field staff.
import type { AssignmentStatus, IncidentStatus } from '@13store/shared';

export type Lang = 'th' | 'en';

const dict = {
  appName: { th: 'เจ้าหน้าที่ภาคสนาม', en: 'Field Responder' },
  signIn: { th: 'เข้าสู่ระบบ', en: 'Sign in' },
  signingIn: { th: 'กำลังเข้าสู่ระบบ…', en: 'Signing in…' },
  username: { th: 'ชื่อผู้ใช้', en: 'Username' },
  password: { th: 'รหัสผ่าน', en: 'Password' },
  signOut: { th: 'ออกจากระบบ', en: 'Sign out' },
  signOutPending: { th: 'ยังมีรายการรอส่ง ออกจากระบบตอนนี้รายการจะยังเก็บไว้ในเครื่องนี้', en: 'Items are still waiting to sync. They stay on this phone after you sign out.' },
  loginFailed: { th: 'เข้าสู่ระบบไม่สำเร็จ', en: 'Sign-in failed' },
  offlineLogin: { th: 'ไม่มีสัญญาณ ต้องเชื่อมต่ออินเทอร์เน็ตเพื่อเข้าสู่ระบบครั้งแรก', en: 'No connection. You need a connection to sign in.' },
  myTasks: { th: 'งานของฉัน', en: 'My tasks' },
  noTasks: { th: 'ยังไม่มีงานที่มอบหมาย ศูนย์จะส่งงานมาที่หน้านี้', en: 'No tasks assigned yet. New tasks from the control room appear here.' },
  loading: { th: 'กำลังโหลด…', en: 'Loading…' },
  back: { th: 'กลับ', en: 'Back' },
  received: { th: 'รับแจ้ง', en: 'Received' },
  place: { th: 'สถานที่', en: 'Place' },
  zone: { th: 'โซน', en: 'Zone' },
  incidentStatus: { th: 'สถานะเหตุ', en: 'Incident status' },
  taskStatus: { th: 'สถานะงาน', en: 'Task status' },
  timeline: { th: 'ลำดับเหตุการณ์', en: 'Timeline' },
  accept: { th: 'รับงาน', en: 'Accept task' },
  arrive: { th: 'ถึงพื้นที่แล้ว', en: 'Arrived on scene' },
  report: { th: 'รายงานผล', en: 'Report result' },
  sendReport: { th: 'ส่งรายงาน', en: 'Send report' },
  savedOnPhone: { th: 'บันทึกรายงานไว้ในเครื่องแล้ว จะส่งให้ศูนย์ทันทีที่มีสัญญาณ', en: 'Report saved on this phone. It will be sent as soon as there is a connection.' },
  done: { th: 'ส่งรายงานแล้ว งานเสร็จสิ้น', en: 'Report sent. Task complete.' },
  cancelledTask: { th: 'งานนี้ถูกยกเลิกโดยศูนย์', en: 'This task was cancelled by the control room.' },
  note: { th: 'บันทึกผล', en: 'What did you find?' },
  notePlaceholder: { th: 'เช่น ทางเดินโล่งแล้ว ย้ายรถเข็นออกจากทางแล้ว', en: 'e.g. Walkway clear. Cart moved aside.' },
  addPhoto: { th: 'ถ่าย/แนบรูป', en: 'Take or attach photo' },
  removePhoto: { th: 'ลบรูป', en: 'Remove photo' },
  noteRequired: { th: 'กรุณาใส่บันทึกผล', en: 'Add a short note' },
  photoFailed: { th: 'อ่านรูปไม่ได้ ลองรูปอื่น', en: 'Could not read that photo. Try another.' },
  cancel: { th: 'ยกเลิก', en: 'Cancel' },
  contact: { th: 'ติดต่อศูนย์ควบคุม', en: 'Contact control room' },
  contactHint: { th: 'โทรหรือวิทยุถึงศูนย์ หมายเลขนี้เลือกคัดลอกได้', en: 'Call or radio the control room. You can select and copy this number.' },
  copy: { th: 'คัดลอก', en: 'Copy' },
  copied: { th: 'คัดลอกแล้ว', en: 'Copied' },
  waitingSync: { th: 'รอส่งข้อมูล', en: 'Waiting to sync' },
  syncNow: { th: 'ส่งตอนนี้', en: 'Sync now' },
  syncing: { th: 'กำลังส่ง…', en: 'Sending…' },
  offlineNote: { th: 'ไม่มีสัญญาณ ข้อมูลจะส่งอัตโนมัติเมื่อกลับมาออนไลน์', en: 'Offline. Items send automatically when you are back online.' },
  pending: { th: 'รอส่ง', en: 'Pending' },
  failed: { th: 'ส่งไม่สำเร็จ', en: 'Not sent' },
  discard: { th: 'ทิ้งรายการ', en: 'Discard' },
  retry: { th: 'ลองใหม่', en: 'Retry' },
  outbox: { th: 'รายการที่ยังไม่ได้ส่ง', en: 'Not yet sent' },
  sessionEnded: { th: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่ รายการที่รอส่งยังอยู่ในเครื่อง', en: 'Session ended. Sign in again. Waiting items are kept on this phone.' },
  live: { th: 'เชื่อมต่อสด', en: 'Live' },
  connecting: { th: 'กำลังเชื่อมต่อ', en: 'Connecting' },
  offline: { th: 'ออฟไลน์', en: 'Offline' },
  noDeviceControl: { th: 'แอปนี้ไม่มีการสั่งการอุปกรณ์ ใช้สำหรับรับงานและรายงานผลเท่านั้น', en: 'No device control in this app. Use it to take tasks and report back.' },
  photo: { th: 'รูปถ่าย', en: 'Photo' },
  storageFull: { th: 'พื้นที่ในเครื่องเต็ม รายการนี้จะหายถ้าปิดแอปก่อนส่ง', en: 'Phone storage is full. This item is lost if you close the app before it sends.' },
  updatedAt: { th: 'อัปเดต', en: 'Updated' },
  notifications: { th: 'การแจ้งเตือน', en: 'Notifications' },
  notifHint: { th: 'รับแจ้งงานใหม่บนมือถือแม้ปิดแอปอยู่', en: 'Get new tasks on this phone even when the app is closed.' },
  notifOn: { th: 'เปิดอยู่', en: 'On' },
  notifOff: { th: 'ปิดอยู่', en: 'Off' },
  notifEnable: { th: 'เปิดการแจ้งเตือน', en: 'Turn on notifications' },
  notifDisable: { th: 'ปิดการแจ้งเตือน', en: 'Turn off notifications' },
  notifBusy: { th: 'กำลังตั้งค่า…', en: 'Setting up…' },
  notifDenied: { th: 'เบราว์เซอร์บล็อกการแจ้งเตือนของแอปนี้ อนุญาตได้ในตั้งค่าของเบราว์เซอร์', en: 'Notifications are blocked for this app. Allow them in the browser settings.' },
  notifUnsupported: {
    th: 'อุปกรณ์นี้ไม่รองรับการแจ้งเตือนแบบพุช (iPhone: เพิ่มแอปไว้ที่หน้าจอโฮมก่อน)',
    en: 'Push notifications are not available here (iPhone: add the app to the Home Screen first).',
  },
  notifFailed: { th: 'เปิดการแจ้งเตือนไม่สำเร็จ ลองใหม่อีกครั้ง', en: 'Could not turn on notifications. Try again.' },
} as const;

export type Key = keyof typeof dict;

export function t(lang: Lang, key: Key): string {
  return dict[key][lang];
}

export const ASSIGNMENT_LABEL: Record<AssignmentStatus, Record<Lang, string>> = {
  assigned: { th: 'รอรับงาน', en: 'Assigned' },
  accepted: { th: 'รับงานแล้ว', en: 'Accepted' },
  on_scene: { th: 'อยู่ที่พื้นที่', en: 'On scene' },
  reported: { th: 'รายงานแล้ว', en: 'Reported' },
  cancelled: { th: 'ยกเลิก', en: 'Cancelled' },
};

export const INCIDENT_LABEL: Record<IncidentStatus, Record<Lang, string>> = {
  new: { th: 'ใหม่ · รอยืนยัน', en: 'New · unverified' },
  triaging: { th: 'กำลังตรวจสอบ', en: 'Triaging' },
  confirmed: { th: 'ยืนยันแล้ว', en: 'Confirmed' },
  responding: { th: 'กำลังตอบสนอง', en: 'Responding' },
  resolved: { th: 'แก้ไขแล้ว', en: 'Resolved' },
  closed: { th: 'ปิดเหตุ', en: 'Closed' },
  duplicate: { th: 'เหตุซ้ำ', en: 'Duplicate' },
  dismissed: { th: 'แจ้งผิด', en: 'Dismissed' },
};

export const OUTBOX_LABEL: Record<'accept' | 'arrive' | 'report' | 'evidence', Record<Lang, string>> = {
  accept: { th: 'รับงาน', en: 'Accept task' },
  arrive: { th: 'ถึงพื้นที่', en: 'Arrived on scene' },
  report: { th: 'รายงานผล', en: 'Report' },
  evidence: { th: 'รูปถ่าย', en: 'Photo' },
};

const TZ = 'Asia/Bangkok';
export function fmtClock(ms: number, lang: Lang) {
  return new Date(ms).toLocaleTimeString(lang === 'th' ? 'th-TH' : 'en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
}
export function fmtAgo(ms: number, now: number, lang: Lang) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return lang === 'th' ? `${s} วินาทีที่แล้ว` : `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return lang === 'th' ? `${m} นาทีที่แล้ว` : `${m} min ago`;
  const h = Math.floor(m / 60);
  return lang === 'th' ? `${h} ชม. ${m % 60} นาทีที่แล้ว` : `${h} h ${m % 60} min ago`;
}
