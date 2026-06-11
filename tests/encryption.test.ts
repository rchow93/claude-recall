import { describe, test, expect } from 'bun:test';
import { randomBytes } from 'crypto';
import { encrypt, decrypt, isEncrypted } from '../src/services/encryption';

const key = randomBytes(32);

describe('encryption', () => {
  test('encrypt → decrypt round-trip', () => {
    const plaintext = 'Hello, world! This is sensitive data.';
    const ciphertext = encrypt(plaintext, key);
    expect(ciphertext).not.toBe(plaintext);
    expect(ciphertext.startsWith('$ENCRYPTED$')).toBe(true);
    expect(decrypt(ciphertext, key)).toBe(plaintext);
  });

  test('isEncrypted detects encrypted content', () => {
    const ciphertext = encrypt('test', key);
    expect(isEncrypted(ciphertext)).toBe(true);
    expect(isEncrypted('plain text')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
  });

  test('decrypt passes through plaintext', () => {
    expect(decrypt('not encrypted', key)).toBe('not encrypted');
  });

  test('handles empty string', () => {
    const ciphertext = encrypt('', key);
    expect(decrypt(ciphertext, key)).toBe('');
  });

  test('handles large payloads', () => {
    const large = 'x'.repeat(100_000);
    const ciphertext = encrypt(large, key);
    expect(decrypt(ciphertext, key)).toBe(large);
  });

  test('handles unicode content', () => {
    const unicode = '日本語テスト 🔑 données chiffrées';
    const ciphertext = encrypt(unicode, key);
    expect(decrypt(ciphertext, key)).toBe(unicode);
  });

  test('different encryptions of same plaintext produce different ciphertext', () => {
    const a = encrypt('same', key);
    const b = encrypt('same', key);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe('same');
    expect(decrypt(b, key)).toBe('same');
  });

  test('wrong key fails decryption', () => {
    const wrongKey = randomBytes(32);
    const ciphertext = encrypt('secret', key);
    expect(() => decrypt(ciphertext, wrongKey)).toThrow();
  });
});
