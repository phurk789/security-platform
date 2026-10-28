import { describe, expect, it } from 'vitest';
import { tr } from './i18n';

const th = (en: string) => tr(en, undefined, 'th');

describe('Thai for server and vehicle messages', () => {
  it('translates exact messages from the dictionary and messages with names by pattern', () => {
    expect(th('Vehicle is disarmed. Arm it on the remote after the safety check, then send start again.')).toMatch(/^รถยังไม่ได้ arm/);
    expect(th('UGV-01 is on another mission.')).toBe('UGV-01 ติดภารกิจอื่นอยู่');
    expect(th('UGV-01 is in SHADOW mode. A supervisor must promote it to LIVE_MANUAL before start. Stop and pause still work.')).toBe(
      'UGV-01 อยู่โหมด SHADOW หัวหน้าเวรต้องเปลี่ยนเป็น LIVE_MANUAL ก่อนจึงจะเริ่มได้ (สั่งหยุดและพักยังใช้ได้)',
    );
    expect(th('Waiting for start (CMD-0027) to finish.')).toBe('รอคำสั่งเริ่ม (CMD-0027) ให้เสร็จก่อน');
    expect(th('Route uploaded (8 waypoints).')).toBe('ส่งเส้นทางให้รถแล้ว (8 จุด)');
  });

  it('translates the reason inside a skipped patrol, and leaves unknown text alone', () => {
    expect(th('Patrol "Gggg" skipped: UGV-01 is on another mission.')).toBe('ข้ามรอบลาดตระเวน "Gggg": UGV-01 ติดภารกิจอื่นอยู่');
    expect(th('Patrol "Night" skipped: checkpoints 2, 3 are outside the site.')).toBe('ข้ามรอบลาดตระเวน "Night": จุดตรวจ 2, 3 อยู่นอกพื้นที่ไซต์');
    expect(th('UGV-01 is outside the operating area during MSN-0002.')).toBe('UGV-01 ออกนอกพื้นที่ปฏิบัติงานระหว่างภารกิจ MSN-0002');
    expect(th('Something new from the server.')).toBe('Something new from the server.');
    expect(tr('UGV-01 is on another mission.', undefined, 'en')).toBe('UGV-01 is on another mission.');
  });
});
