// G.711 μ-law conversion. Telephony carries 8 kHz mono; Gemini accepts PCM16.
export function decodeUlaw(value: number): number {
  const u = ~value & 255;
  const sample = (((u & 15) << 3) + 132) << ((u >> 4) & 7);
  return (u & 128) !== 0 ? 132 - sample : sample - 132;
}

export function encodeUlaw(sample: number): number {
  const sign = sample < 0 ? 128 : 0;
  let magnitude = Math.min(Math.abs(sample), 32635) + 132;
  let exponent = 7;
  for (let mask = 16384; exponent > 0 && (magnitude & mask) === 0; mask >>= 1) exponent--;
  magnitude >>= exponent + 3;
  return ~(sign | (exponent << 4) | (magnitude & 15)) & 255;
}

export function ulawToPcm16(input: Buffer): Buffer {
  const output = Buffer.alloc(input.length * 4);
  for (let i = 0; i < input.length; i++) {
    const sample = decodeUlaw(input[i] ?? 255);
    output.writeInt16LE(sample, i * 4);
    output.writeInt16LE(sample, i * 4 + 2);
  }
  return output;
}

// Stateful 3:1 downsampling with a small low-pass averaging filter. Keep partial
// samples across provider chunks; never emit WAV headers into Twilio media.
export class Pcm24ToUlaw8 {
  private remainder = Buffer.alloc(0);
  reset(): void {
    this.remainder = Buffer.alloc(0);
  }
  convert(input: Buffer): Buffer {
    const combined = Buffer.concat([this.remainder, input]);
    const count = Math.floor(combined.length / 6);
    const output = Buffer.alloc(count);
    for (let i = 0; i < count; i++) {
      const p = i * 6;
      const average =
        (combined.readInt16LE(p) + combined.readInt16LE(p + 2) + combined.readInt16LE(p + 4)) / 3;
      output[i] = encodeUlaw(Math.round(average));
    }
    this.remainder = Buffer.from(combined.subarray(count * 6));
    return output;
  }
}
