// Thai for messages from the server and the vehicle that carry a name or a number, so a plain
// dictionary lookup cannot match them ("UGV-01 is on another mission."). Each rule matches the
// whole English message; parts that are themselves messages (a skip reason) are translated too.

type Rule = [RegExp, (m: string[], inner: (s: string) => string) => string];

const VERB: Record<string, string> = { start: 'เริ่ม', resume: 'ทำต่อ', pause: 'พัก', stop: 'หยุด' };

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
];

/** Thai for a message with names or numbers in it, or undefined when no rule matches. */
export function thaiPattern(en: string, inner: (s: string) => string): string | undefined {
  for (const [re, th] of RULES) {
    const m = re.exec(en);
    if (m) return th(m, inner);
  }
  return undefined;
}
