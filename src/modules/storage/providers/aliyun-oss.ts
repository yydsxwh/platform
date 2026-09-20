/**
 * 阿里云 OSS 适配器。
 *
 * 签名算法沿用主站已在生产跑通的 V1 预签名（HMAC-SHA1），不重新发明：
 *   StringToSign = METHOD\n\nContent-Type\nExpires\nCanonicalizedResource
 *
 * 两条硬性约束：
 * 1. AccessKey 只存在于本进程，任何响应都不得带出去，浏览器只拿短期签名 URL。
 * 2. 上传不发 x-oss-object-acl —— 新版 Bucket 常关闭对象 ACL，带上会直接 403；
 *    对象继承 Bucket 默认私有，读一律走签名。
 */

import { createHmac } from "node:crypto";

import type { StorageProvider } from "@yydsxwh/shared/contracts/storage";
import type { OssConfig } from "../../../config";
import { providerUnavailable } from "../../../errors";
import type {
  DownloadTarget,
  SignedPart,
  SignedTarget,
  StorageAdapter,
} from "./types";

/** 传输加速域名：大陆访问境外 Bucket 走阿里云骨干，比源站公网口快一个数量级 */
const ACCELERATE_HOST_SUFFIX = ".oss-accelerate.aliyuncs.com";

export function ossVirtualHost(config: OssConfig): string {
  if (config.endpoint) return config.endpoint;
  return `${config.bucket}.oss-${config.region}.aliyuncs.com`;
}

/** key 逐段编码：斜杠要保留成路径分隔符，其余字符必须转义 */
export function encodeObjectKey(objectKey: string): string {
  return objectKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function buildStringToSign(input: {
  method: string;
  contentType?: string;
  expiresOrDate: string;
  canonicalizedResource: string;
  ossHeaders?: Record<string, string>;
}): string {
  const headerLines = Object.keys(input.ossHeaders ?? {})
    .filter((key) => key.toLowerCase().startsWith("x-oss-"))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((key) => `${key.toLowerCase()}:${(input.ossHeaders ?? {})[key]!.trim()}`)
    .join("\n");
  const canonicalHeaders = headerLines ? `${headerLines}\n` : "";
  return `${input.method}\n\n${input.contentType ?? ""}\n${input.expiresOrDate}\n${canonicalHeaders}${input.canonicalizedResource}`;
}

export function hmacSha1Base64(secret: string, value: string): string {
  return createHmac("sha1", secret).update(value).digest("base64");
}

/** 从 OSS 的 XML 响应里取标签值 */
export function xmlTag(text: string, tag: string): string {
  const matched = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(text);
  return matched?.[1]?.trim() ?? "";
}

export function ossContentDisposition(fileName: string): string {
  const safe = fileName.replace(/[^\w.\u4e00-\u9fa5-]+/g, "_").slice(0, 80) || "file";
  return `attachment;filename="${safe}"`;
}

export type OssHttp = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string | Uint8Array },
) => Promise<{ ok: boolean; status: number; text: string; headers: Headers }>;

const defaultHttp: OssHttp = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  return {
    ok: response.ok,
    status: response.status,
    text: await response.text(),
    headers: response.headers,
  };
};

export class AliyunOssAdapter implements StorageAdapter {
  readonly provider: StorageProvider = "ALIYUN_OSS";

  constructor(
    private readonly config: OssConfig,
    private readonly http: OssHttp = defaultHttp,
  ) {}

  private get host(): string {
    return ossVirtualHost(this.config);
  }

  private presign(input: {
    method: "GET" | "PUT";
    objectKey: string;
    expiresInSeconds: number;
    query?: Record<string, string>;
    /** 参与签名的子资源，如 partNumber / uploadId / response-content-disposition */
    signedQuery?: Record<string, string>;
    host?: string;
  }): { url: string; expiresAt: Date } {
    const expires = Math.floor(Date.now() / 1000) + input.expiresInSeconds;
    const signedPairs = Object.entries(input.signedQuery ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const suffix = signedPairs.map(([k, v]) => `${k}=${v}`).join("&");
    const canonicalizedResource = suffix
      ? `/${this.config.bucket}/${input.objectKey}?${suffix}`
      : `/${this.config.bucket}/${input.objectKey}`;
    const signature = hmacSha1Base64(
      this.config.accessKeySecret,
      buildStringToSign({
        method: input.method,
        expiresOrDate: String(expires),
        canonicalizedResource,
      }),
    );

    const host = input.host ?? this.host;
    const base =
      input.host || !this.config.publicBaseUrl
        ? `https://${host}`
        : this.config.publicBaseUrl;
    const params = new URLSearchParams({
      ...(input.signedQuery ?? {}),
      ...(input.query ?? {}),
      OSSAccessKeyId: this.config.accessKeyId,
      Expires: String(expires),
      Signature: signature,
    });
    return {
      url: `${base.replace(/\/+$/, "")}/${encodeObjectKey(input.objectKey)}?${params.toString()}`,
      expiresAt: new Date(expires * 1000),
    };
  }

  /** 带密钥的直接请求（服务端专用），用于 init/complete 分片、代传、删除 */
  private async signedRequest(input: {
    method: "GET" | "PUT" | "POST" | "DELETE" | "HEAD";
    objectKey: string;
    subResource?: string;
    contentType?: string;
    body?: string | Uint8Array;
  }): Promise<{ ok: boolean; status: number; text: string; headers: Headers }> {
    const date = new Date().toUTCString();
    const resource = input.subResource
      ? `/${this.config.bucket}/${input.objectKey}?${input.subResource}`
      : `/${this.config.bucket}/${input.objectKey}`;
    const signature = hmacSha1Base64(
      this.config.accessKeySecret,
      buildStringToSign({
        method: input.method,
        contentType: input.contentType,
        expiresOrDate: date,
        canonicalizedResource: resource,
      }),
    );
    const headers: Record<string, string> = {
      authorization: `OSS ${this.config.accessKeyId}:${signature}`,
      date,
    };
    if (input.contentType) headers["content-type"] = input.contentType;

    const path = input.subResource
      ? `/${encodeObjectKey(input.objectKey)}?${input.subResource}`
      : `/${encodeObjectKey(input.objectKey)}`;
    return this.http(`https://${this.host}${path}`, {
      method: input.method,
      headers,
      body: input.body,
    });
  }

  async createUploadTarget(input: {
    fileId: string;
    objectKey: string;
    mimeType: string;
    expiresInSeconds: number;
  }): Promise<SignedTarget> {
    // Content-Type 不进签名串，浏览器可自由带；OSS 以实际请求头为准
    const { url, expiresAt } = this.presign({
      method: "PUT",
      objectKey: input.objectKey,
      expiresInSeconds: input.expiresInSeconds,
    });
    return {
      method: "PUT",
      url,
      headers: { "content-type": input.mimeType || "application/octet-stream" },
      expiresAt,
    };
  }

  async createMultipartUpload(input: {
    objectKey: string;
    mimeType: string;
  }): Promise<{ uploadId: string }> {
    const result = await this.signedRequest({
      method: "POST",
      objectKey: input.objectKey,
      subResource: "uploads",
      contentType: input.mimeType || "application/octet-stream",
      body: "",
    });
    if (!result.ok) {
      throw providerUnavailable(`OSS 初始化分片失败：${explainOssError(result.status, result.text)}`);
    }
    const uploadId = xmlTag(result.text, "UploadId");
    if (!uploadId) throw providerUnavailable("OSS 未返回 UploadId");
    return { uploadId };
  }

  async signMultipartParts(input: {
    fileId: string;
    objectKey: string;
    uploadId: string;
    partNumbers: number[];
    expiresInSeconds: number;
  }): Promise<SignedPart[]> {
    return input.partNumbers.map((partNumber) => {
      const { url, expiresAt } = this.presign({
        method: "PUT",
        objectKey: input.objectKey,
        expiresInSeconds: input.expiresInSeconds,
        signedQuery: {
          partNumber: String(partNumber),
          uploadId: input.uploadId,
        },
      });
      return { partNumber, url, headers: {}, expiresAt };
    });
  }

  async completeMultipartUpload(input: {
    objectKey: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<void> {
    const sorted = [...input.parts].sort((a, b) => a.partNumber - b.partNumber);
    const body =
      "<CompleteMultipartUpload>" +
      sorted
        .map(
          (part) =>
            `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>"${part.etag.replace(/"/g, "")}"</ETag></Part>`,
        )
        .join("") +
      "</CompleteMultipartUpload>";
    const result = await this.signedRequest({
      method: "POST",
      objectKey: input.objectKey,
      subResource: `uploadId=${encodeURIComponent(input.uploadId)}`,
      contentType: "application/xml",
      body,
    });
    if (!result.ok) {
      throw providerUnavailable(`OSS 合并分片失败：${explainOssError(result.status, result.text)}`);
    }
  }

  async abortMultipartUpload(input: {
    objectKey: string;
    uploadId: string;
  }): Promise<void> {
    await this.signedRequest({
      method: "DELETE",
      objectKey: input.objectKey,
      subResource: `uploadId=${encodeURIComponent(input.uploadId)}`,
    });
  }

  async putObject(input: {
    objectKey: string;
    body: Buffer;
    mimeType: string;
  }): Promise<void> {
    const result = await this.signedRequest({
      method: "PUT",
      objectKey: input.objectKey,
      contentType: input.mimeType || "application/octet-stream",
      body: input.body,
    });
    if (!result.ok) {
      throw providerUnavailable(`OSS 上传失败：${explainOssError(result.status, result.text)}`);
    }
  }

  async statObject(objectKey: string): Promise<{ size: number } | null> {
    const result = await this.signedRequest({ method: "HEAD", objectKey });
    if (!result.ok) return null;
    const size = Number(result.headers.get("content-length") ?? "0");
    return { size: Number.isFinite(size) ? size : 0 };
  }

  async deleteObject(objectKey: string): Promise<void> {
    const result = await this.signedRequest({ method: "DELETE", objectKey });
    // 已经不存在也算删成功，调用方重试不该失败
    if (!result.ok && result.status !== 404) {
      throw providerUnavailable(`OSS 删除失败：${explainOssError(result.status, result.text)}`);
    }
  }

  async createDownloadTarget(input: {
    fileId: string;
    objectKey: string;
    expiresInSeconds: number;
    isPublic: boolean;
    downloadFileName?: string;
  }): Promise<DownloadTarget> {
    if (input.isPublic && this.config.publicBaseUrl) {
      return {
        url: `${this.config.publicBaseUrl}/${encodeObjectKey(input.objectKey)}`,
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
        signed: false,
      };
    }
    const signedQuery: Record<string, string> = {};
    if (input.downloadFileName) {
      signedQuery["response-content-disposition"] = ossContentDisposition(
        input.downloadFileName,
      );
    }
    const host = this.config.accelerateEnabled
      ? `${this.config.bucket}${ACCELERATE_HOST_SUFFIX}`
      : undefined;
    const { url, expiresAt } = this.presign({
      method: "GET",
      objectKey: input.objectKey,
      expiresInSeconds: input.expiresInSeconds,
      signedQuery,
      host,
    });
    return { url, expiresAt, signed: true };
  }
}

/**
 * 把 OSS 的 403 翻成可操作的说明。
 * 「because of bucket acl」常被误读成对象 ACL 问题，实际多是 RAM 没给
 * oss:PutObject，或 AccessKey 与 Bucket 不属于同一个账号。
 */
export function explainOssError(status: number, body: string): string {
  const code = xmlTag(body, "Code") || `HTTP_${status}`;
  const message = xmlTag(body, "Message");
  if (message.includes("does not belong to you")) {
    return `${status} ${code}：AccessKey 与 Bucket 不属于同一个阿里云账号`;
  }
  if (xmlTag(body, "AuthAction") === "oss:PutObject" || message.includes("because of bucket acl")) {
    return `${status} AccessDenied：RAM 未授予该 Bucket 的写入权限`;
  }
  const brief = (message || body).replace(/\s+/g, " ").slice(0, 180);
  return `${status} ${code}${brief ? `：${brief}` : ""}`;
}
