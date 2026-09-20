/**
 * 存储后端适配器接口。
 *
 * 上层服务只认这个接口，换后端（本地盘 / OSS / 将来 S3）不改业务代码。
 * 任何实现都必须保证：不把长期密钥交给调用方，只下发短期签名。
 */

import type { StorageProvider } from "@yydsxwh/shared/contracts/storage";

export type SignedTarget = {
  method: "PUT" | "POST";
  url: string;
  headers: Record<string, string>;
  formFields?: Record<string, string>;
  expiresAt: Date;
};

export type SignedPart = {
  partNumber: number;
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
};

export type DownloadTarget = {
  url: string;
  expiresAt: Date;
  /** false 表示返回的是公开直链，没有过期语义 */
  signed: boolean;
};

export type StorageAdapter = {
  readonly provider: StorageProvider;

  /** 单条 PUT 直传 */
  createUploadTarget(input: {
    fileId: string;
    objectKey: string;
    mimeType: string;
    expiresInSeconds: number;
  }): Promise<SignedTarget>;

  createMultipartUpload(input: {
    objectKey: string;
    mimeType: string;
  }): Promise<{ uploadId: string }>;

  signMultipartParts(input: {
    fileId: string;
    objectKey: string;
    uploadId: string;
    partNumbers: number[];
    expiresInSeconds: number;
  }): Promise<SignedPart[]>;

  completeMultipartUpload(input: {
    objectKey: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<void>;

  abortMultipartUpload(input: {
    objectKey: string;
    uploadId: string;
  }): Promise<void>;

  /** 服务端代传小文件 */
  putObject(input: {
    objectKey: string;
    body: Buffer;
    mimeType: string;
  }): Promise<void>;

  /** 对象不存在返回 null；用于直传回执时核对字节是否真的到了 */
  statObject(objectKey: string): Promise<{ size: number } | null>;

  deleteObject(objectKey: string): Promise<void>;

  createDownloadTarget(input: {
    fileId: string;
    objectKey: string;
    expiresInSeconds: number;
    isPublic: boolean;
    downloadFileName?: string;
  }): Promise<DownloadTarget>;
};
