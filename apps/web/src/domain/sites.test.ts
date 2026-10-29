import { describe, expect, it } from 'vitest';
import { nextSiteAccess, parseLatLon } from './sites';
import { tr } from '../i18n';

describe('site anchor typed or pasted', () => {
  it('reads "lat, lon" as Google Maps copies it, and refuses out-of-range or partial input', () => {
    expect(parseLatLon('13.95055, 100.46209')).toEqual({ lat: 13.95055, lon: 100.46209 });
    expect(parseLatLon(' -33.9 151.2 ')).toEqual({ lat: -33.9, lon: 151.2 });
    expect(parseLatLon('13.95055')).toBeNull();
    expect(parseLatLon('95, 100')).toBeNull();
    expect(parseLatLon('13.9, 190')).toBeNull();
    expect(parseLatLon('Bangkok')).toBeNull();
  });
});

describe('site access ticks', () => {
  const all = ['a', 'b', 'c'];
  it('unticking one site of "all sites" keeps the others; ticking "all" means every site', () => {
    expect(nextSiteAccess([], all, 'b')).toEqual(['a', 'c']);
    expect(nextSiteAccess(['a', 'c'], all, 'all')).toEqual([]);
    expect(nextSiteAccess([], all, 'all')).toEqual(all);
  });
  it('adds in site order and never leaves an empty list (empty would mean every site)', () => {
    expect(nextSiteAccess(['c'], all, 'a')).toEqual(['a', 'c']);
    expect(nextSiteAccess(['a'], all, 'a')).toEqual(['a']);
  });
});

describe('Thai for site messages from the server', () => {
  const th = (en: string) => tr(en, undefined, 'th');
  it('translates the move and remove refusals with their names', () => {
    expect(th('UGV-01 is online. Switch its gateway off (close the edge app), move it, then pair the gateway again at Event hall.')).toBe(
      'UGV-01 ยังออนไลน์อยู่ ปิด gateway (ปิดแอป edge) ก่อนแล้วจึงย้าย จากนั้นจับคู่ gateway ใหม่ที่ Event hall',
    );
    expect(th('Yard B still has 2 devices, 1 incidents. Move or remove them first.')).toBe('Yard B ยังมี 2 อุปกรณ์, 1 เหตุ ย้ายหรือลบออกก่อน');
    expect(th('License limit reached: 1 sites (evaluation). Contact 13STORE to extend it.')).toBe('ถึงขีดจำกัดของ License แล้ว: 1 ไซต์ (รุ่นทดลอง) ติดต่อ 13STORE เพื่อขยาย');
    expect(th('This is the only site. Create another one first.')).toBe('นี่เป็นไซต์เดียวที่มี สร้างไซต์อื่นก่อน');
  });
});
