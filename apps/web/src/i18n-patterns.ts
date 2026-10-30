// Thai for messages from the server and the vehicle that carry a name or a number, so a plain
// dictionary lookup cannot match them ("UGV-01 is on another mission."). Each rule matches the
// whole English message; parts that are themselves messages (a skip reason) are translated too.

type Rule = [RegExp, (m: string[], inner: (s: string) => string) => string];

const VERB: Record<string, string> = { start: 'เริ่ม', resume: 'ทำต่อ', pause: 'พัก', stop: 'หยุด' };
const NOUN: Record<string, string> = { sites: 'ไซต์', devices: 'อุปกรณ์', users: 'ผู้ใช้', incidents: 'เหตุ', missions: 'ภารกิจ', patrols: 'รอบลาดตระเวน', detections: 'การตรวจจับ' };
const ZONE_KIND: Record<string, string> = { 'keep-out': 'ห้ามเข้า', caution: 'ระวัง', 'no-fly': 'ห้ามบิน', 'operating area': 'พื้นที่ปฏิบัติงาน' };

const RULES: Rule[] = [
  // Messages that wrap another message come first, so the inner one is not matched as a whole.
  [/^Patrol "(.+?)" skipped: (.+)$/, (m, inner) => `ข้ามรอบลาดตระเวน "${m[1]}": ${inner(m[2])}`],
  [/^(.+) is on another mission\.$/, (m) => `${m[1]} ติดภารกิจอื่นอยู่`],
  [/^(.+) is not ready\.$/, (m) => `${m[1]} ยังไม่พร้อม`],
  [
    /^(.+) is in (\w+) mode\. A supervisor must promote it to LIVE_MANUAL before (\w+)\. Stop and pause still work\.$/,
    (m) => `${m[1]} อยู่โหมด ${m[2]} หัวหน้าเวรต้องเปลี่ยนเป็น LIVE_MANUAL ก่อนจึงจะ${VERB[m[3]] ?? m[3]}ได้ (สั่งหยุดและพักยังใช้ได้)`,
  ],
  [/^Waiting for (\w+) \((.+)\) to finish\.$/, (m) => `รอคำสั่ง${VERB[m[1]] ?? m[1]} (${m[2]}) ให้เสร็จก่อน`],
  [/^Route uploaded \((\d+) waypoints\)\.$/, (m) => `ส่งเส้นทางให้รถแล้ว (${m[1]} จุด)`],
  [/^Arming refused: (.*)$/, (m) => `รถไม่ยอม arm: ${m[1]}`],
  [/^AUTO mode refused: (.*)$/, (m) => `รถไม่ยอมเข้าโหมด AUTO: ${m[1]}`],
  [/^Mission start refused: (.*)$/, (m) => `รถไม่ยอมเริ่มภารกิจ: ${m[1]}`],
  [/^Hold mode refused: (.*)$/, (m) => `รถไม่ยอมเข้าโหมด HOLD: ${m[1]}`],
  [/^[Cc]heckpoints (.+) are outside the site\.$/, (m) => `จุดตรวจ ${m[1]} อยู่นอกพื้นที่ไซต์`],
  [/^(.+) is outside the operating area during (.+?)\.?$/, (m) => `${m[1]} ออกนอกพื้นที่ปฏิบัติงานระหว่างภารกิจ ${m[2]}`],
  [/^(.+) is outside the operating area\.?$/, (m) => `${m[1]} อยู่นอกพื้นที่ปฏิบัติงาน`],
  [/^(.+) is back inside the operating area\.$/, (m) => `${m[1]} กลับเข้าพื้นที่ปฏิบัติงานแล้ว`],
  [/^(.+?) entered (keep-out|caution|no-fly|operating area) zone "(.+?)"\.?(.*)$/, (m) => `${m[1]} เข้าโซน${ZONE_KIND[m[2]] ?? m[2]} "${m[3]}"${m[4] ? ` ${m[4].trim()}` : ''}`],
  [/^(.+?) left zone "(.+)"\.$/, (m) => `${m[1]} ออกจากโซน "${m[2]}" แล้ว`],
  // Sites: moving devices, removing a site, licence limits.
  [
    /^(.+) is online\. Switch its gateway off \(close the edge app\), move it, then pair the gateway again at (.+)\.$/,
    (m) => `${m[1]} ยังออนไลน์อยู่ ปิด gateway (ปิดแอป edge) ก่อนแล้วจึงย้าย จากนั้นจับคู่ gateway ใหม่ที่ ${m[2]}`,
  ],
  [/^(.+) is on a mission\. Finish or cancel it first\.$/, (m) => `${m[1]} กำลังทำภารกิจ ให้จบหรือยกเลิกก่อน`],
  [/^(.+) is being driven from the console\.$/, (m) => `${m[1]} กำลังถูกขับจากคอนโซล`],
  [/^(.+) runs patrol (.+) at its current site\. Delete or change the patrol first\.$/, (m) => `${m[1]} อยู่ในรอบลาดตระเวน ${m[2]} ของไซต์เดิม ลบหรือแก้รอบลาดตระเวนก่อน`],
  [/^(.+) still has (.+)\. Move or remove them first\.$/, (m) => `${m[1]} ยังมี ${m[2].replace(/\b(devices|incidents|missions|patrols|detections)\b/g, (w) => NOUN[w] ?? w)} ย้ายหรือลบออกก่อน`],
  [/^(.+) can only see (.+)\. Give them another site \(or revoke the key\) first\.$/, (m) => `${m[1]} เห็นได้เฉพาะ ${m[2]} ให้สิทธิ์ไซต์อื่นก่อน (หรือยกเลิกคีย์)`],
  [/^Unknown site: (.+)\.$/, (m) => `ไม่พบไซต์ ${m[1]}`],
  [
    /^License limit reached: (\d+) (sites|devices|users)( \(evaluation\))?\. Contact 13STORE to extend it\.$/,
    (m) => `ถึงขีดจำกัดของ License แล้ว: ${m[1]} ${NOUN[m[2]] ?? m[2]}${m[3] ? ' (รุ่นทดลอง)' : ''} ติดต่อ 13STORE เพื่อขยาย`,
  ],
  // AUTO routes: wrappers first (they carry another message inside).
  [/^Ended after: (.+)$/, (m, inner) => `จบภารกิจหลังจาก: ${inner(m[1])}`],
  [/^(.+) Mission paused: resume when it is safe, or stop it\.$/, (m, inner) => `${inner(m[1])} ภารกิจหยุดรอแล้ว: สั่งวิ่งต่อเมื่อปลอดภัย หรือสั่งหยุดภารกิจ`],
  [/^(.+) Resume when it is safe, or stop the mission\.$/, (m, inner) => `${inner(m[1])} สั่งวิ่งต่อเมื่อปลอดภัย หรือสั่งหยุดภารกิจ`],
  [/^(.+) The zones changed since approval: edit the route\.$/, (m, inner) => `${inner(m[1])} โซนเปลี่ยนไปหลังอนุมัติ ให้แก้เส้นทางใหม่`],
  [/^(\S+): route interrupted\. (.+)$/, (m, inner) => `${m[1]}: เส้นทางถูกขัดจังหวะ ${inner(m[2])}`],
  [/^(\S+): automatic hold not sent \((.+)\)\. Stop it on the remote\.$/, (m, inner) => `${m[1]}: ส่งคำสั่งหยุดรออัตโนมัติไม่สำเร็จ (${inner(m[2])}) ให้หยุดรถที่รีโมต`],
  [/^(.+) — hold not sent: (.+) Stop it on the remote\.$/, (m, inner) => `${inner(m[1])} — ส่งคำสั่งหยุดรอไม่สำเร็จ: ${inner(m[2])} ให้หยุดรถที่รีโมต`],
  [
    /^Mode changed to (\S+) outside the platform \(remote switch or vehicle failsafe\) at checkpoint (\d+) of (\d+)\. The platform will not change it back\.$/,
    (m) => `โหมดถูกเปลี่ยนเป็น ${m[1]} นอกแพลตฟอร์ม (สวิตช์ที่รีโมตหรือระบบป้องกันของรถ) ที่จุดตรวจ ${m[2]} จาก ${m[3]} แพลตฟอร์มจะไม่เปลี่ยนกลับให้`,
  ],
  [
    /^Vehicle disarmed during the route \(remote switch or vehicle failsafe\) at checkpoint (\d+) of (\d+)\. Arm it on the remote to resume\.$/,
    (m) => `รถถูก disarm ระหว่างเส้นทาง (สวิตช์ที่รีโมตหรือระบบป้องกันของรถ) ที่จุดตรวจ ${m[1]} จาก ${m[2]} ให้ arm ที่รีโมตก่อนสั่งวิ่งต่อ`,
  ],
  [/^Mode changed back to (\S+) on the remote; the route continues at checkpoint (\d+) of (\d+)\.$/, (m) => `เปลี่ยนกลับเป็น ${m[1]} ที่รีโมตแล้ว รถวิ่งต่อที่จุดตรวจ ${m[2]} จาก ${m[3]}`],
  [/^(\S+) route interrupted$/, (m) => `${m[1]} เส้นทางถูกขัดจังหวะ`],
  [/^(\S+) resumed on the remote$/, (m) => `${m[1]} วิ่งต่อจากรีโมต`],
  [/^(\S+) held automatically$/, (m) => `${m[1]} ถูกสั่งหยุดรออัตโนมัติ`],
  [/^Automatic hold of (\S+) not sent$/, (m) => `ส่งคำสั่งหยุดรออัตโนมัติให้ ${m[1]} ไม่สำเร็จ`],
  [/^(\S+) stopped — mission failed$/, (m) => `${m[1]} หยุดแล้ว — ภารกิจล้มเหลว`],
  [/^(\S+) left the operating area\.$/, (m) => `${m[1]} ออกนอกพื้นที่ปฏิบัติงาน`],
  [/^(\S+) passed checkpoint (\d+)$/, (m) => `${m[1]} ผ่านจุดตรวจ ${m[2]}`],
  [/^(\S+) reached final checkpoint$/, (m) => `${m[1]} ถึงจุดตรวจสุดท้ายแล้ว`],
  [
    /^Battery (\d+)% on (\S+) \(hold level (\d+)%\)\. Bring it back on the remote or change the battery\.$/,
    (m) => `แบต ${m[2]} เหลือ ${m[1]}% (ระดับหยุดรอ ${m[3]}%) ให้ขับกลับด้วยรีโมตหรือเปลี่ยนแบต`,
  ],
  [/^(\S+) battery low \((\d+)%\)(?:\. It will be held automatically at (\d+)%\.)?$/, (m) => `${m[1]} แบตต่ำ (${m[2]}%)${m[3] ? ` จะหยุดรออัตโนมัติที่ ${m[3]}%` : ''}`],
  [/^It will be held automatically at (\d+)%\.$/, (m) => `จะหยุดรออัตโนมัติที่ ${m[1]}%`],
  [/^No operating area is drawn for this site\. Draw one on the map before sending (\S+) on a route\.$/, (m) => `ไซต์นี้ยังไม่ได้วาดพื้นที่ปฏิบัติงาน ให้วาดบนแผนที่ก่อนส่ง ${m[1]} วิ่งตามเส้นทาง`],
  [/^Checkpoints (.+) are outside the operating area\.$/, (m) => `จุดตรวจ ${m[1]} อยู่นอกพื้นที่ปฏิบัติงาน`],
  [/^Checkpoints (.+) outside$/, (m) => `จุดตรวจ ${m[1]} อยู่นอกพื้นที่`],
  [/^(\d+) checkpoints inside$/, (m) => `จุดตรวจทั้ง ${m[1]} จุดอยู่ในพื้นที่`],
  [/^(\d+) active zones checked$/, (m) => `ตรวจแล้ว ${m[1]} โซนที่เปิดใช้`],
  [/^Enters (.+)$/, (m) => `ผ่าน ${m[1]}`],
  [/^Held by (.+)$/, (m) => `${m[1]} ถือสิทธิ์อยู่`],
  [/^Telemetry (live|stale|offline)$/, (m) => `ข้อมูลอุปกรณ์ ${m[1].toUpperCase()}`],
  // Route commands, as the gateway reports them.
  [/^Sending the route to the vehicle \((\d+) waypoints\)…$/, (m) => `กำลังส่งเส้นทางให้รถ (${m[1]} จุด)…`],
  [/^Route on the vehicle and checked \((\d+) waypoints\)\. Starting…$/, (m) => `รถได้รับเส้นทางและตรวจตรงกันแล้ว (${m[1]} จุด) กำลังเริ่ม…`],
  [/^Reached checkpoint (\d+) of (\d+)\.$/, (m) => `ถึงจุดตรวจ ${m[1]} จาก ${m[2]}`],
  [
    /^No movement (\d+) s after (start|resume) \(mode (\S+), (armed|disarmed)\)\. Set to HOLD\. Check the arming switch, the throttle limit and WP_SPEED, then try again\.$/,
    (m) =>
      `รถไม่ขยับ ${m[1]} วินาทีหลังสั่ง${m[2] === 'start' ? 'เริ่ม' : 'วิ่งต่อ'} (โหมด ${m[3]}, ${m[4] === 'armed' ? 'arm แล้ว' : 'ยังไม่ arm'}) จึงสั่ง HOLD ไว้ ตรวจสวิตช์ arm, ค่าจำกัดคันเร่ง และ WP_SPEED แล้วลองใหม่`,
  ],
  [/^Still moving at ([\d.]+) m\/s (\d+) s after HOLD was asked\. Stop it on the remote\.$/, (m) => `รถยังวิ่งอยู่ ${m[1]} ม./วิ ${m[2]} วินาทีหลังสั่ง HOLD ให้หยุดรถที่รีโมต`],
  [/^Waypoint (\d+) on the vehicle differs from the route sent\. Route not started\.$/, (m) => `จุดที่ ${m[1]} บนรถไม่ตรงกับเส้นทางที่ส่ง จึงไม่เริ่มวิ่ง`],
  [/^The vehicle holds (-?\d+) waypoints instead of (\d+)\. Route not started\.$/, (m) => `รถมีเส้นทาง ${m[1]} จุด แทนที่จะเป็น ${m[2]} จุด จึงไม่เริ่มวิ่ง`],
];

/** Thai for a message with names or numbers in it, or undefined when no rule matches. */
export function thaiPattern(en: string, inner: (s: string) => string): string | undefined {
  for (const [re, th] of RULES) {
    const m = re.exec(en);
    if (m) return th(m, inner);
  }
  return undefined;
}
