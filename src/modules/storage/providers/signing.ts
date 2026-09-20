/**
 * 本地 provider 的短期链接签名。
 *
 * 浏览器拿到的上传/下载地址只在有效期内成立，过期或被改一个字符即失效，
 * 与 OSS 预签名是同一套思路：不下发长期凭证。
 *
 * 签名密钥不额外要求运维再管一个 secret：从已有的服务凭证派生。
 * 服务凭证轮换时链接随之失效，这正是期望行为。
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const KEY_INFO = "platform-local-storage-v1";

export function deriveLocalSigningKey(serviceTokens: Iterable<string>): string {
  const material = [...serviceTokens].sort().join("\u0000");
  return createHmac("sha256", KEY_INFO).update(material).digest("hex");
}

export type LocalSignatureInput = {
  action: "upload" | "download";
  fileId: string;
  expiresAt: number;
};

export function signLocalUrl(key: string, input: LocalSignatureInput): string {
  const payload = `${input.action}\n${input.fileId}\n${input.expiresAt}`;
  return createHmac("sha256", key).update(payload).digest("hex");
}

export type LocalSignatureVerdict =
  | { ok: true }
  | { ok: false; reason: "EXPIRED" | "BAD_SIGNATURE" };

export function verifyLocalUrl(
  key: string,
  input: LocalSignatureInput & { signature: string },
  now: number = Date.now(),
): LocalSignatureVerdict {
  const expected = signLocalUrl(key, input);
  if (!constantTimeEquals(expected, input.signature)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }
  // 先验签再看过期：否则可以用过期提示来探测签名是否正确
  if (input.expiresAt * 1000 <= now) {
    return { ok: false, reason: "EXPIRED" };
  }
  return { ok: true };
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
