"use client";

export const CLASS_CODE_LENGTH = 6;

const classCodeAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function generateClassCode() {
  const values = new Uint8Array(CLASS_CODE_LENGTH);

  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(values);
  } else {
    for (let index = 0; index < values.length; index += 1) {
      values[index] = Math.floor(Math.random() * 256);
    }
  }

  return Array.from(values, (value) => classCodeAlphabet[value % classCodeAlphabet.length]).join("");
}

export function normalizeClassCode(classCode: string) {
  const cleanClassCode = classCode.trim();

  if (cleanClassCode.length === CLASS_CODE_LENGTH && /^[a-z]+$/i.test(cleanClassCode)) {
    return cleanClassCode.toUpperCase();
  }

  return cleanClassCode;
}

export function formatClassCodeInput(classCode: string) {
  return classCode
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, CLASS_CODE_LENGTH);
}
