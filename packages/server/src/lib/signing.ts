export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ]) as Promise<CryptoKeyPair>;
}

export async function signPayload(
  privateKey: CryptoKey,
  timestamp: string,
  body: string,
): Promise<string> {
  const message = new TextEncoder().encode(`${timestamp}.${body}`);
  const signature = await crypto.subtle.sign('Ed25519', privateKey, message);
  return arrayBufferToBase64(signature);
}

export async function verifySignature(
  publicKey: CryptoKey,
  signature: string,
  timestamp: string,
  body: string,
): Promise<boolean> {
  const message = new TextEncoder().encode(`${timestamp}.${body}`);
  const sigBytes = base64ToArrayBuffer(signature);
  return crypto.subtle.verify('Ed25519', publicKey, sigBytes, message);
}

export async function exportPublicKey(publicKey: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('spki', publicKey);
  return arrayBufferToBase64(exported);
}

export async function importPrivateKey(base64: string): Promise<CryptoKey> {
  const keyData = base64ToArrayBuffer(base64);
  return crypto.subtle.importKey('pkcs8', keyData, 'Ed25519', true, ['sign']);
}

export async function importPublicKey(base64: string): Promise<CryptoKey> {
  const keyData = base64ToArrayBuffer(base64);
  return crypto.subtle.importKey('spki', keyData, 'Ed25519', true, ['verify']);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
