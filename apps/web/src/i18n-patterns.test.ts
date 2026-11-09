import { describe, expect, it } from 'vitest';
import { tr } from './i18n';

const th = (en: string) => tr(en, undefined, 'th');

describe('Thai for server and vehicle messages', () => {
  it('translates exact messages from the dictionary and messages with names by pattern', () => {
    expect(th('Vehicle is disarmed. Arm it on the remote after the safety check, then send start again.')).toMatch(/^รถยังไม่ได้ arm/);
    expect(th('UGV-01 is on another mission.')).toBe('UGV-01 ติดภารกิจอื่นอยู่');
    expect(th('UGV-01 is not ready.')).toBe('UGV-01 ยังไม่พร้อม');
    expect(th('UGV-01 is in SHADOW mode. A supervisor must promote it to LIVE_MANUAL before start. Stop and pause still work.')).toBe(
      'UGV-01 อยู่โหมด SHADOW หัวหน้าเวรต้องเปลี่ยนเป็น LIVE_MANUAL ก่อนจึงจะเริ่มได้ (สั่งหยุดและพักยังใช้ได้)',
    );
    expect(th('Waiting for start (CMD-0027) to finish.')).toBe('รอคำสั่งเริ่ม (CMD-0027) ให้เสร็จก่อน');
    expect(th('Route uploaded (8 waypoints).')).toBe('ส่งเส้นทางให้รถแล้ว (8 จุด)');
  });

  it('translates the camera jobs at checkpoints and their checks', () => {
    expect(th('Camera at checkpoint 2 (Gate): down 30°, right 45°, 3×, sweeping ±60°')).toBe('กล้องที่จุดตรวจ 2 (Gate): ก้ม 30°, ขวา 45°, 3×, กวาด ±60°');
    expect(th('Camera at checkpoint 1 not turned')).toBe('กล้องที่จุดตรวจ 1 ไม่ได้หัน');
    expect(th('Photo taken at checkpoint 3 (Yard)')).toBe('ถ่ายรูปที่จุดตรวจ 3 (Yard) แล้ว');
    expect(th('UGV-01 has no gimbal the platform can turn.')).toBe('UGV-01 ไม่มีกิมบอลที่ระบบสั่งหันได้');
    expect(th('On UGV-01-CAM.')).toBe('ใช้กล้อง UGV-01-CAM');
    expect(th('UGV-01-CAM is in SHADOW mode. Camera moves need LIVE_MANUAL; a supervisor promotes the device.')).toBe(
      'UGV-01-CAM อยู่โหมด SHADOW การหันกล้องต้องเป็น LIVE_MANUAL หัวหน้าเวรเป็นคนเปลี่ยนโหมด',
    );
    expect(th('UGV-01-CAM rides on UGV-01, which has no position fix, so it cannot be pointed at a place.')).toBe('UGV-01-CAM อยู่บน UGV-01 ซึ่งยังไม่มีตำแหน่ง GNSS จึงสั่งหันไปที่จุดไม่ได้');
    expect(th('Checkpoint 1: the camera tilt (°) must be -90–30.')).toBe('จุดตรวจ 1: มุมก้ม/เงยของกล้องต้องอยู่ระหว่าง -90–30°');
    expect(th('Checkpoint 4: the sweep must be 10–135° either side.')).toBe('จุดตรวจ 4: การกวาดกล้องต้องอยู่ระหว่าง 10–135° แต่ละข้าง');
  });

  it('translates what the gateway says about console driving', () => {
    expect(th('Not driven from the console yet · steering ch1, throttle ch3')).toBe('ยังไม่ได้ขับจากคอนโซล · เลี้ยว ch1 · คันเร่ง ch3');
    expect(th('Driving from the console · throttle ≤30% · steering ≤60%')).toBe('กำลังขับจากคอนโซล · คันเร่ง ≤30% · เลี้ยว ≤60%');
    expect(th('Driving from the console · throttle ≤100% · steering ≤60% · gear 3 of 3')).toBe('กำลังขับจากคอนโซล · คันเร่ง ≤100% · เลี้ยว ≤60% · เกียร์ 3 จาก 3');
    expect(th('Driving from the console · throttle ≤100% · steering ≤60% · gear on the remote')).toBe('กำลังขับจากคอนโซล · คันเร่ง ≤100% · เลี้ยว ≤60% · เกียร์ตามรีโมต');
    expect(th('Idle, the remote has the sticks (no stick input for 1.5 s)')).toBe('ว่าง รีโมตคุมคันบังคับอยู่ (ไม่มีสัญญาณคันบังคับ 1.5 วินาที)');
    expect(th('Not driving. The vehicle is in HOLD: switch it to MANUAL on the remote.')).toBe('ไม่ได้ขับ: รถอยู่โหมด HOLD ให้สลับเป็น MANUAL ที่รีโมต');
    expect(th('Idle')).toBe('ว่าง');
  });

  it('translates the reason inside a skipped patrol, and leaves unknown text alone', () => {
    expect(th('Patrol "Gggg" skipped: UGV-01 is on another mission.')).toBe('ข้ามรอบลาดตระเวน "Gggg": UGV-01 ติดภารกิจอื่นอยู่');
    expect(th('Patrol "Night" skipped: checkpoints 2, 3 are outside the site.')).toBe('ข้ามรอบลาดตระเวน "Night": จุดตรวจ 2, 3 อยู่นอกพื้นที่ไซต์');
    expect(th('UGV-01 is outside the operating area during MSN-0002.')).toBe('UGV-01 ออกนอกพื้นที่ปฏิบัติงานระหว่างภารกิจ MSN-0002');
    expect(th('UGV-01 entered keep-out zone "Test crane zone".')).toBe('UGV-01 เข้าโซนห้ามเข้า "Test crane zone"');
    expect(th('UAV-02 entered no-fly zone "Roof". Offices below.')).toBe('UAV-02 เข้าโซนห้ามบิน "Roof" Offices below.');
    expect(th('UGV-01 left zone "Test crane zone".')).toBe('UGV-01 ออกจากโซน "Test crane zone" แล้ว');
    expect(th('Something new from the server.')).toBe('Something new from the server.');
    expect(tr('UGV-01 is on another mission.', undefined, 'en')).toBe('UGV-01 is on another mission.');
  });
});
