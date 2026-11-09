import { describe, expect, it } from 'vitest';
import { parseSiteConfig } from '@13store/gateway';
import { tr } from '../i18n';
import { REMOTE_DEFAULTS, piDevices } from './pairing';
import { gearOf, noRemoteFor } from './vehicleControl';

const GEO = { originLat: 13.4367374, originLon: 101.0275798, rotationDeg: -28.5 };
const th = (en: string) => tr(en, undefined, 'th');

describe('vehicle without a hand-held remote (console side)', () => {
  it('reads the gear from the virtual remote part', () => {
    expect(gearOf('Holding the sticks · gear 2 of 3 · the vehicle holds 3 s after the server link is lost')).toBe(2);
    expect(gearOf('Holding the sticks · the vehicle holds 3 s after the server link is lost')).toBeUndefined();
    expect(gearOf(undefined)).toBeUndefined();
  });

  it('pairs a Pi as the remote: RCU-ND gears on channel 11, or no gears; or keeps the SIYI remote', () => {
    const rcu = piDevices({ ...REMOTE_DEFAULTS, piPort: 'usb', remote: 'none-rcu' });
    expect(() => parseSiteConfig({ geo: GEO, devices: rcu })).not.toThrow();
    expect(rcu[0]).toMatchObject({ noRemote: { gearChannel: 11, gears: [1100, 1500, 1900] }, allowRemoteArm: false, teleop: { maxThrottle: 1 } });
    expect(rcu[0].teleop).not.toHaveProperty('gearChannel'); // the virtual remote holds the gears
    expect(piDevices({ ...REMOTE_DEFAULTS, remote: 'none' })[0]).toMatchObject({ noRemote: true });
    expect(piDevices({ ...REMOTE_DEFAULTS, remote: 'remote' })[0]).not.toHaveProperty('noRemote');
    expect(piDevices(REMOTE_DEFAULTS)[0]).not.toHaveProperty('noRemote');
    expect(noRemoteFor('remote')).toBeUndefined();
  });

  it('shows what the vehicle and the server answer in Thai', () => {
    expect(th('Armed in HOLD · gear 1.')).toBe('arm แล้ว · โหมด HOLD · เกียร์ 1');
    expect(th('Gear 3 of 3.')).toBe('เกียร์ 3 จาก 3');
    expect(th('Arming refused: PreArm: Radio failsafe on')).toBe('รถไม่ยอม arm: PreArm: Radio failsafe on');
    expect(th('UGV-01 has a hand-held remote: arming stays on the remote.')).toBe('UGV-01 มีรีโมตมือถือ การ arm ยังทำที่รีโมต');
    expect(th('Holding the sticks · gear 2 of 3 · the vehicle holds 3 s after the server link is lost')).toBe(
      'ถือคันบังคับอยู่ · เกียร์ 2 จาก 3 · ถ้าหลุดจากเซิร์ฟเวอร์ รถจะหยุดใน 3 วินาที',
    );
    expect(th('Not driving. The vehicle is disarmed: a supervisor arms it from the console.')).toBe('ไม่ได้ขับ: รถยังไม่ได้ arm หัวหน้าเวรต้อง arm จากหน้าเว็บ');
  });
});
