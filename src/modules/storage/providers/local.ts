/**
 * 本地磁盘存储。
 *
 * 用于开发、测试，以及 OSS 未配置时的兜底。直传与下载都走 platform 自己的
 * 签名端点，因此上传链接同样是短期的，行为与 OSS 尽量一致，避免「本地能用、
 * 线上不行」这类只在生产暴露的差异。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { StorageProvider } from "@yydsxwh/shared/contracts/storage";
import { failedPrecondition, invalidRequest } from "../../../errors";
import { signLocalUrl } from "./signing";
import type {
  DownloadTarget,
  SignedPart,
  SignedTarget,
  StorageAdapter,
} from "./types";

export type LocalAdapterOptions = {
  root: string;
  publicBaseUrl: string;
  signingKey: string;
};

/** 分片直传时各片先单独落盘，complete 时再按序拼接 */
function partPath(root: string, uploadId: string, partNumber: number): string {
  return path.join(root, ".multipart", uploadId, `${partNumber}.part`);
}

export class LocalStorageAdapter implements StorageAdapter {
  readonly provider: StorageProvider = "LOCAL";

  constructor(private readonly options: LocalAdapterOptions) {}

  /** objectKey 来自服务层，仍然兜一层：绝不允许跳出根目录 */
  private resolve(objectKey: string): string {
    const full = path.resolve(this.options.root, objectKey);
    const root = path.resolve(this.options.root);
    if (full !== root && !full.startsWith(`${root}${path.sep}`)) {
      throw invalidRequest("对象 key 非法", { objectKey });
    }
    return full;
  }

  private signedUrl(
    action: "upload" | "download",
    fileId: string,
    expiresInSeconds: number,
    extraQuery: Record<string, string> = {},
  ): { url: string; expiresAt: Date } {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const signature = signLocalUrl(this.options.signingKey, {
      action,
      fileId,
      expiresAt,
    });
    const url = new URL(
      `${this.options.publicBaseUrl.replace(/\/+$/, "")}/v1/storage/local-objects/${encodeURIComponent(fileId)}`,
    );
    url.searchParams.set("action", action);
    url.searchParams.set("expires", String(expiresAt));
    url.searchParams.set("signature", signature);
    for (const [k, v] of Object.entries(extraQuery)) url.searchParams.set(k, v);
    return { url: url.toString(), expiresAt: new Date(expiresAt * 1000) };
  }

  async createUploadTarget(input: {
    fileId: string;
    objectKey: string;
    mimeType: string;
    expiresInSeconds: number;
  }): Promise<SignedTarget> {
    const { url, expiresAt } = this.signedUrl("upload", input.fileId, input.expiresInSeconds);
    return {
      method: "PUT",
      url,
      headers: { "content-type": input.mimeType || "application/octet-stream" },
      expiresAt,
    };
  }

  async createMultipartUpload(input: { objectKey: string }): Promise<{ uploadId: string }> {
    const uploadId = createHash("sha256")
      .update(`${input.objectKey}:${Date.now()}:${Math.random()}`)
      .digest("hex")
      .slice(0, 32);
    await mkdir(path.join(this.options.root, ".multipart", uploadId), {
      recursive: true,
    });
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
      const { url, expiresAt } = this.signedUrl(
        "upload",
        input.fileId,
        input.expiresInSeconds,
        { uploadId: input.uploadId, partNumber: String(partNumber) },
      );
      return {
        partNumber,
        url,
        headers: { "content-type": "application/octet-stream" },
        expiresAt,
      };
    });
  }

  async completeMultipartUpload(input: {
    objectKey: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<void> {
    const sorted = [...input.parts].sort((a, b) => a.partNumber - b.partNumber);
    const chunks: Buffer[] = [];
    for (const part of sorted) {
      try {
        chunks.push(await readFile(partPath(this.options.root, input.uploadId, part.partNumber)));
      } catch {
        throw failedPrecondition(`分片 ${part.partNumber} 尚未上传`, {
          uploadId: input.uploadId,
          partNumber: part.partNumber,
        });
      }
    }
    const full = this.resolve(input.objectKey);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, Buffer.concat(chunks));
    await rm(path.join(this.options.root, ".multipart", input.uploadId), {
      recursive: true,
      force: true,
    });
  }

  async abortMultipartUpload(input: { uploadId: string }): Promise<void> {
    await rm(path.join(this.options.root, ".multipart", input.uploadId), {
      recursive: true,
      force: true,
    });
  }

  async putObject(input: {
    objectKey: string;
    body: Buffer;
    mimeType: string;
  }): Promise<void> {
    const full = this.resolve(input.objectKey);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, input.body);
  }

  async writePart(input: {
    uploadId: string;
    partNumber: number;
    body: Buffer;
  }): Promise<string> {
    const target = partPath(this.options.root, input.uploadId, input.partNumber);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, input.body);
    return createHash("md5").update(input.body).digest("hex");
  }

  async statObject(objectKey: string): Promise<{ size: number } | null> {
    try {
      const info = await stat(this.resolve(objectKey));
      return { size: info.size };
    } catch {
      return null;
    }
  }

  async readObject(objectKey: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolve(objectKey));
    } catch {
      return null;
    }
  }

  async deleteObject(objectKey: string): Promise<void> {
    await rm(this.resolve(objectKey), { force: true });
  }

  async createDownloadTarget(input: {
    fileId: string;
    objectKey: string;
    expiresInSeconds: number;
    isPublic: boolean;
    downloadFileName?: string;
  }): Promise<DownloadTarget> {
    const extra: Record<string, string> = {};
    if (input.downloadFileName) extra.filename = input.downloadFileName;
    const { url, expiresAt } = this.signedUrl(
      "download",
      input.fileId,
      input.expiresInSeconds,
      extra,
    );
    // 本地 provider 没有公开直链，PUBLIC 对象同样走签名，只是有效期更长
    return { url, expiresAt, signed: true };
  }
}
