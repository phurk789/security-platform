import { describe, expect, it } from 'vitest';
import { polygonArea, polygonPerimeter, polygonSelfIntersects } from '../src';

const sq = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

describe('zone outline geometry', () => {
  it('measures area and perimeter whatever the winding', () => {
    expect(polygonArea(sq)).toBe(100);
    expect(polygonArea([...sq].reverse())).toBe(100);
    expect(polygonPerimeter(sq)).toBe(40);
    expect(polygonArea(sq.slice(0, 2))).toBe(0);
  });

  it('finds an outline that crosses itself, and accepts concave ones', () => {
    const bowTie = [sq[0], sq[2], sq[1], sq[3]];
    expect(polygonSelfIntersects(bowTie)).toBe(true);
    expect(polygonSelfIntersects(sq)).toBe(false);
    expect(polygonSelfIntersects(sq.slice(0, 3))).toBe(false);
    const ell = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 20 },
      { x: 0, y: 20 },
    ];
    expect(polygonSelfIntersects(ell)).toBe(false);
    expect(polygonArea(ell)).toBe(300);
  });
});
