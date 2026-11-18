import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { config, ensureDataDirs } from '../config.js';
import type { CheckoutProfile } from '../types.js';

const KEY_SALT = 'consiler-checkout-profile-v1';

function deriveKey(): Buffer {
  return crypto.scryptSync(config.SESSION_SECRET, KEY_SALT, 32);
}

export async function saveEncryptedJson<T>(
  data: T,
  filePath: string
): Promise<void> {
  ensureDataDirs();
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload = JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64'),
  });

  await fs.writeFile(filePath, payload, 'utf8');
}

export async function loadEncryptedJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      v: number;
      iv: string;
      tag: string;
      data: string;
    };
    const key = deriveKey();
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(parsed.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(parsed.data, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function encryptProfileJson(
  profile: CheckoutProfile,
  filePath = config.checkoutProfilePath
): Promise<void> {
  return saveEncryptedJson(profile, filePath);
}

export async function saveCheckoutProfile(
  profile: CheckoutProfile,
  filePath = config.checkoutProfilePath
): Promise<void> {
  return saveEncryptedJson(profile, filePath);
}

export async function loadCheckoutProfile(
  filePath = config.checkoutProfilePath
): Promise<CheckoutProfile | null> {
  return loadEncryptedJson<CheckoutProfile>(filePath);
}

export async function hasCheckoutProfile(
  filePath = config.checkoutProfilePath
): Promise<boolean> {
  const profile = await loadCheckoutProfile(filePath);
  return Boolean(
    profile &&
      profile.fullName.trim() &&
      profile.email.trim() &&
      profile.phone.trim()
  );
}

export function maskValue(val: string, visibleEnd = 2): string {
  const s = val.trim();
  if (!s) return '';
  if (s.length <= visibleEnd + 2) return '*'.repeat(s.length);
  return `${s.slice(0, 2)}${'*'.repeat(Math.min(6, s.length - 2 - visibleEnd))}${s.slice(-visibleEnd)}`;
}

export async function getMaskedCheckoutProfile(
  filePath = config.checkoutProfilePath
): Promise<{
  configured: boolean;
  profile: CheckoutProfile | null;
  masked: Record<string, string> | null;
}> {
  const profile = await loadCheckoutProfile(filePath);
  if (!profile) {
    return { configured: false, profile: null, masked: null };
  }
  const configured = Boolean(
    profile.fullName.trim() && profile.email.trim() && profile.phone.trim()
  );
  return {
    configured,
    profile,
    masked: {
      fullName: maskValue(profile.fullName, 2),
      email: maskValue(profile.email, 6),
      phone: maskValue(profile.phone, 3),
      city: profile.city,
      preferredLocker: profile.preferredLocker,
    },
  };
}
