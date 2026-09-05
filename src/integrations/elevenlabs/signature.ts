import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyElevenLabsSignature(input: {
  rawBody: string;
  signatureHeader: string | undefined;
  secret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): boolean {
  if (!input.signatureHeader) return false;
  const parts = Object.fromEntries(
    input.signatureHeader.split(',').map((part) => {
      const [key, ...valueParts] = part.split('=');
      return [key, valueParts.join('=')];
    }),
  );
  const timestamp = parts.t;
  const signature = parts.v0;
  if (!timestamp || !signature || !/^\d+$/.test(timestamp) || !/^[a-f\d]+$/i.test(signature)) {
    return false;
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const tolerance = input.toleranceSeconds ?? 1_800;
  if (Math.abs(now - Number(timestamp)) > tolerance) return false;

  const expected = createHmac('sha256', input.secret)
    .update(`${timestamp}.${input.rawBody}`)
    .digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const signatureBuffer = Buffer.from(signature, 'hex');
  if (expectedBuffer.length !== signatureBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, signatureBuffer);
}
