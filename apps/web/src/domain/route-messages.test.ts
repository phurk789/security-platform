import { describe, expect, it } from 'vitest';
import { tr } from '../i18n';

const th = (en: string) => tr(en, undefined, 'th');

describe('Thai for AUTO route messages', () => {
  it('translates what the vehicle and the platform report during a route', () => {
    expect(th('UGV-01: route interrupted. Mode changed to MANUAL outside the platform (remote switch or vehicle failsafe) at checkpoint 2 of 5. The platform will not change it back.')).toBe(
      'UGV-01: เส้นทางถูกขัดจังหวะ โหมดถูกเปลี่ยนเป็น MANUAL นอกแพลตฟอร์ม (สวิตช์ที่รีโมตหรือระบบป้องกันของรถ) ที่จุดตรวจ 2 จาก 5 แพลตฟอร์มจะไม่เปลี่ยนกลับให้',
    );
    expect(th('Ended after: UGV-01 left the operating area.')).toBe('จบภารกิจหลังจาก: UGV-01 ออกนอกพื้นที่ปฏิบัติงาน');
    expect(th('UGV-01 left the operating area. Resume when it is safe, or stop the mission.')).toBe('UGV-01 ออกนอกพื้นที่ปฏิบัติงาน สั่งวิ่งต่อเมื่อปลอดภัย หรือสั่งหยุดภารกิจ');
    expect(th('UGV-01 battery low (19%). It will be held automatically at 15%.')).toBe('UGV-01 แบตต่ำ (19%) จะหยุดรออัตโนมัติที่ 15%');
    expect(th('Battery 14% on UGV-01 (hold level 15%). Bring it back on the remote or change the battery.')).toBe(
      'แบต UGV-01 เหลือ 14% (ระดับหยุดรอ 15%) ให้ขับกลับด้วยรีโมตหรือเปลี่ยนแบต',
    );
    expect(th('UGV-01 passed checkpoint 3')).toBe('UGV-01 ผ่านจุดตรวจ 3');
    expect(th('Sending the route to the vehicle (12 waypoints)…')).toBe('กำลังส่งเส้นทางให้รถ (12 จุด)…');
    expect(th('Checkpoints 2, 3 are outside the operating area. The zones changed since approval: edit the route.')).toBe(
      'จุดตรวจ 2, 3 อยู่นอกพื้นที่ปฏิบัติงาน โซนเปลี่ยนไปหลังอนุมัติ ให้แก้เส้นทางใหม่',
    );
    expect(th('No movement 15 s after start (mode AUTO, armed). Set to HOLD. Check the arming switch, the throttle limit and WP_SPEED, then try again.')).toMatch(
      /^รถไม่ขยับ 15 วินาทีหลังสั่งเริ่ม/,
    );
  });
});
