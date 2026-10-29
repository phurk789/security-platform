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
];

/** Thai for a message with names or numbers in it, or undefined when no rule matches. */
export function thaiPattern(en: string, inner: (s: string) => string): string | undefined {
  for (const [re, th] of RULES) {
    const m = re.exec(en);
    if (m) return th(m, inner);
  }
  return undefined;
}
