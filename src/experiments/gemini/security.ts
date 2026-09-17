import twilio from 'twilio';

export function mediaToken(path: string): string | undefined {
  return /^\/gemini\/media\/([\w-]+)\/?$/.exec(path)?.[1];
}

// Only configured-origin variants are accepted; never derive origin from Host.
// Twilio documents a trailing slash variation for Voice WSS signatures.
export function validateMediaSignature(
  authToken: string,
  baseUrl: string,
  path: string,
  signature: unknown,
): boolean {
  if (typeof signature !== 'string' || !mediaToken(path)) return false;
  const origin = baseUrl.replace(/\/+$/, '');
  const exact = `${origin}${path}`;
  const urls = [exact, exact.endsWith('/') ? exact.slice(0, -1) : `${exact}/`];
  // Some transports sign the configured WSS URI rather than its HTTPS upgrade URI.
  const variants = [...urls, ...urls.map((url) => url.replace(/^https:/, 'wss:'))];
  return variants.some((url) => twilio.validateRequest(authToken, signature, url, {}));
}
