// SIYI gimbal camera SDK (ZR10, ZR30, ZT30, ZT6, A8 mini, …) over UDP.
// Frame: STX 0x55 0x66 | CTRL | DATA_LEN (u16 LE) | SEQ (u16 LE) | CMD_ID | DATA | CRC16 (u16 LE)
// CRC-16/XMODEM (poly 0x1021, init 0) over every byte before the CRC.
// Default camera address on a SIYI link: 192.168.144.25, UDP port 37260.
// Source: SIYI user manuals (SDK chapter) and the open-source siyi_sdk implementations.

export const SIYI_DEFAULT = { host: '192.168.144.25', port: 37260 };

export const CMD = {
  FIRMWARE: 0x01,
  HARDWARE_ID: 0x02,
  AUTO_FOCUS: 0x04,
  MANUAL_ZOOM: 0x05,
  MANUAL_FOCUS: 0x06,
  GIMBAL_SPEED: 0x07,
  CENTER: 0x08,
  GIMBAL_INFO: 0x0a,
  FUNCTION_FEEDBACK: 0x0b,
  PHOTO_VIDEO: 0x0c,
  GIMBAL_ATTITUDE: 0x0d,
  SET_ATTITUDE: 0x0e,
  ABSOLUTE_ZOOM: 0x0f,
  CURRENT_ZOOM: 0x18,
} as const;

/** Values for PHOTO_VIDEO (0x0c). */
export const PHOTO_VIDEO = { PHOTO: 0, HDR: 1, RECORD_TOGGLE: 2, LOCK: 3, FOLLOW: 4, FPV: 5 } as const;

export function crc16(buf: Uint8Array, len = buf.length) {
  let crc = 0;
  for (let i = 0; i < len; i++) {
    crc ^= buf[i] << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function encode(cmd: number, data: Uint8Array | number[] = [], seq = 0, needAck = true): Buffer {
  const d = Uint8Array.from(data);
  const buf = Buffer.alloc(10 + d.length);
  buf[0] = 0x55;
  buf[1] = 0x66;
  buf[2] = needAck ? 0x01 : 0x00;
  buf.writeUInt16LE(d.length, 3);
  buf.writeUInt16LE(seq & 0xffff, 5);
  buf[7] = cmd;
  buf.set(d, 8);
  buf.writeUInt16LE(crc16(buf, 8 + d.length), 8 + d.length);
  return buf;
}

export interface Frame {
  cmd: number;
  seq: number;
  data: Buffer;
}

/** Decode every complete, CRC-valid frame in a datagram. Bad frames are skipped. */
export function decode(buf: Buffer): Frame[] {
  const out: Frame[] = [];
  let i = 0;
  while (i + 10 <= buf.length) {
    if (buf[i] !== 0x55 || buf[i + 1] !== 0x66) {
      i++;
      continue;
    }
    const len = buf.readUInt16LE(i + 3);
    const end = i + 10 + len;
    if (end > buf.length) break;
    const crc = buf.readUInt16LE(i + 8 + len);
    if (crc16(buf.subarray(i, i + 8 + len)) === crc) {
      out.push({ seq: buf.readUInt16LE(i + 5), cmd: buf[i + 7], data: Buffer.from(buf.subarray(i + 8, i + 8 + len)) });
      i = end;
    } else {
      i++;
    }
  }
  return out;
}

const clampI8 = (v: number) => Math.max(-100, Math.min(100, Math.round(v)));

// ---- requests ---------------------------------------------------------------

export const req = {
  firmware: (seq?: number) => encode(CMD.FIRMWARE, [], seq),
  attitude: (seq?: number) => encode(CMD.GIMBAL_ATTITUDE, [], seq),
  gimbalInfo: (seq?: number) => encode(CMD.GIMBAL_INFO, [], seq),
  currentZoom: (seq?: number) => encode(CMD.CURRENT_ZOOM, [], seq),
  /** Rotation speed, −100…100 each axis. 0,0 stops. */
  gimbalSpeed: (yaw: number, pitch: number, seq?: number) => {
    const d = Buffer.alloc(2);
    d.writeInt8(clampI8(yaw), 0);
    d.writeInt8(clampI8(pitch), 1);
    return encode(CMD.GIMBAL_SPEED, d, seq);
  },
  /** Absolute attitude in degrees (sent as tenths of a degree, int16 LE). */
  setAttitude: (yawDeg: number, pitchDeg: number, seq?: number) => {
    const d = Buffer.alloc(4);
    d.writeInt16LE(Math.round(yawDeg * 10), 0);
    d.writeInt16LE(Math.round(pitchDeg * 10), 2);
    return encode(CMD.SET_ATTITUDE, d, seq);
  },
  center: (seq?: number) => encode(CMD.CENTER, [1], seq),
  /** 1 = zoom in, −1 = zoom out, 0 = stop. */
  manualZoom: (dir: -1 | 0 | 1, seq?: number) => encode(CMD.MANUAL_ZOOM, [dir === 1 ? 0x01 : dir === -1 ? 0xff : 0x00], seq),
  /** Absolute zoom, e.g. 4.5×: integer part then tenths. */
  absoluteZoom: (level: number, seq?: number) => {
    const z = Math.max(1, Math.min(30, level));
    const int = Math.floor(z);
    return encode(CMD.ABSOLUTE_ZOOM, [int, Math.round((z - int) * 10)], seq);
  },
  photo: (seq?: number) => encode(CMD.PHOTO_VIDEO, [PHOTO_VIDEO.PHOTO], seq),
  recordToggle: (seq?: number) => encode(CMD.PHOTO_VIDEO, [PHOTO_VIDEO.RECORD_TOGGLE], seq),
};

// ---- responses ---------------------------------------------------------------

export interface Attitude {
  yaw: number;
  pitch: number;
  roll: number;
  yawSpeed: number;
  pitchSpeed: number;
  rollSpeed: number;
}

export function parseAttitude(d: Buffer): Attitude | null {
  if (d.length < 12) return null;
  return {
    yaw: d.readInt16LE(0) / 10,
    pitch: d.readInt16LE(2) / 10,
    roll: d.readInt16LE(4) / 10,
    yawSpeed: d.readInt16LE(6) / 10,
    pitchSpeed: d.readInt16LE(8) / 10,
    rollSpeed: d.readInt16LE(10) / 10,
  };
}

export function parseFirmware(d: Buffer) {
  if (d.length < 8) return null;
  const v = (n: number) => `${(n >> 16) & 0xff}.${(n >> 8) & 0xff}.${n & 0xff}`;
  return { camera: v(d.readUInt32LE(0)), gimbal: v(d.readUInt32LE(4)), zoom: d.length >= 12 ? v(d.readUInt32LE(8)) : undefined };
}

export function parseGimbalInfo(d: Buffer) {
  if (d.length < 6) return null;
  return { recording: d[3] === 1, motionMode: d[4], mounting: d[5] };
}

export function parseCurrentZoom(d: Buffer) {
  if (d.length < 2) return null;
  return d[0] + d[1] / 10;
}

/** 0 photo ok, 1 photo failed, 2 HDR on, 3 HDR off, 4 record failed. */
export function parseFeedback(d: Buffer) {
  return d.length ? d[0] : null;
}
