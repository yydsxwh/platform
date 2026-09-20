/**
 * Storage 服务层：所有上传下载的策略都收在这里。
 *
 * 每次上传都必须满足：有调用方身份、namespace 已登记且该调用方有权使用、
 * MIME 在白名单、大小不超上限。下载必须满足：文件属于该调用方、状态为 READY。
 *
 * 文件 metadata 与对象本身分离：这里只存「是什么、谁的、能不能拿」，
 * 业务含义由产品自己的库用 fileId 关联，不要把结构化业务数据塞进 labels。
 */

import { randomUUID } from "node:crypto";

import type {
  CompleteMultipartRequest,
  CompleteUploadRequest,
  CreateDownloadUrlRequest,
  CreateDownloadUrlResponse,
  CreateUploadRequest,
  CreateUploadResponse,
  FileRecord,
  FileVisibility,
  ListFilesQuery,
  ListFilesResponse,
  NamespacePolicy,
  SignMultipartPartsResponse,
} from "@yydsxwh/shared/contracts/storage";
import { inferMimeType, isAllowedUpload } from "@yydsxwh/shared/types/media";

import type { PrismaClient } from "@prisma/client";
import {
  failedPrecondition,
  invalidRequest,
  notFound,
  payloadTooLarge,
  permissionDenied,
  unsupportedMediaType,
} from "../../errors";
import {
  assertNamespaceAccess,
  getNamespace,
  listNamespaces,
  toNamespacePolicy,
  type NamespaceDefinition,
} from "./namespaces";
import type { StorageAdapter } from "./providers/types";

/** 直传签名有效期：够慢网传完一片，又不至于长期可用 */
const UPLOAD_URL_TTL_SECONDS = 6 * 60 * 60;
const DOWNLOAD_URL_TTL_SECONDS = 60 * 60;
const MAX_DOWNLOAD_TTL_SECONDS = 24 * 60 * 60;
/** 与主站现有浏览器直传保持一致 */
const MULTIPART_PART_BYTES = 5 * 1024 * 1024;
/** 经 platform 中转的软上限，超过必须直传，否则会在服务端缓冲整包 */
export const PROXY_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

export type StorageCaller = {
  clientId: string;
  actorId: string | null;
};

type FileRow = {
  id: string;
  namespace: string;
  objectKey: string;
  provider: string;
  fileName: string;
  mimeType: string;
  size: number;
  visibility: string;
  status: string;
  ownerId: string | null;
  clientId: string;
  checksum: string | null;
  labels: string;
  uploadId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export class StorageService {
  constructor(
    private readonly db: PrismaClient,
    private readonly adapter: StorageAdapter,
  ) {}

  listPolicies(): NamespacePolicy[] {
    return listNamespaces().map((d) => toNamespacePolicy(d, this.adapter.provider));
  }

  getPolicy(namespace: string, caller: StorageCaller): NamespacePolicy {
    const definition = getNamespace(namespace);
    assertNamespaceAccess(definition, caller.clientId);
    return toNamespacePolicy(definition, this.adapter.provider);
  }

  async createUpload(
    input: CreateUploadRequest,
    caller: StorageCaller,
  ): Promise<CreateUploadResponse> {
    const definition = getNamespace(input.namespace);
    assertNamespaceAccess(definition, caller.clientId);

    const fileName = sanitizeFileName(input.fileName);
    const mimeType = inferMimeType(input.mimeType, fileName);
    assertUploadAllowed(definition, { fileName, mimeType, size: input.size });

    if (input.multipart && !definition.allowDirectUpload) {
      throw invalidRequest(`namespace ${definition.namespace} 不允许直传`, {
        namespace: definition.namespace,
      });
    }
    if (!input.multipart && input.size > PROXY_UPLOAD_MAX_BYTES && !definition.allowDirectUpload) {
      throw payloadTooLarge(
        `namespace ${definition.namespace} 只支持中转上传，单文件不能超过 ${PROXY_UPLOAD_MAX_BYTES} 字节`,
        { maxBytes: PROXY_UPLOAD_MAX_BYTES },
      );
    }

    const fileId = newFileId();
    const objectKey = buildObjectKey(definition.namespace, fileId, fileName);
    const visibility = input.visibility ?? definition.defaultVisibility;

    let uploadId: string | null = null;
    if (input.multipart) {
      const created = await this.adapter.createMultipartUpload({ objectKey, mimeType });
      uploadId = created.uploadId;
    }

    const row = await this.db.file.create({
      data: {
        id: fileId,
        namespace: definition.namespace,
        objectKey,
        provider: this.adapter.provider,
        fileName,
        mimeType,
        size: input.size,
        visibility,
        // 字节还没到，先记 PENDING；此状态下取不到下载链接
        status: "PENDING",
        ownerId: input.ownerId ?? caller.actorId,
        clientId: caller.clientId,
        labels: JSON.stringify(input.labels ?? {}),
        uploadId,
      },
    });

    const upload = input.multipart
      ? null
      : await this.adapter.createUploadTarget({
          fileId,
          objectKey,
          mimeType,
          expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
        });

    return {
      file: toFileRecord(row as FileRow),
      upload: upload
        ? {
            method: upload.method,
            url: upload.url,
            headers: upload.headers,
            formFields: upload.formFields,
            expiresAt: upload.expiresAt.toISOString(),
          }
        : null,
      multipart: uploadId
        ? { uploadId, partSizeBytes: MULTIPART_PART_BYTES }
        : null,
    };
  }

  async signMultipartParts(
    fileId: string,
    input: { uploadId: string; partNumbers: number[] },
    caller: StorageCaller,
  ): Promise<SignMultipartPartsResponse> {
    const row = await this.requireOwnFile(fileId, caller);
    if (row.uploadId !== input.uploadId) {
      throw failedPrecondition("uploadId 与该文件不匹配", { fileId });
    }
    if (input.partNumbers.length === 0) {
      throw invalidRequest("partNumbers 不能为空");
    }
    if (input.partNumbers.some((n) => !Number.isInteger(n) || n < 1 || n > 10_000)) {
      throw invalidRequest("partNumber 必须是 1..10000 的整数");
    }

    const parts = await this.adapter.signMultipartParts({
      fileId,
      objectKey: row.objectKey,
      uploadId: input.uploadId,
      partNumbers: input.partNumbers,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    });
    return {
      parts: parts.map((p) => ({
        partNumber: p.partNumber,
        url: p.url,
        headers: p.headers,
        expiresAt: p.expiresAt.toISOString(),
      })),
    };
  }

  async completeMultipart(
    fileId: string,
    input: CompleteMultipartRequest,
    caller: StorageCaller,
  ): Promise<FileRecord> {
    const row = await this.requireOwnFile(fileId, caller);
    if (row.uploadId !== input.uploadId) {
      throw failedPrecondition("uploadId 与该文件不匹配", { fileId });
    }
    if (input.parts.length === 0) throw invalidRequest("parts 不能为空");

    await this.adapter.completeMultipartUpload({
      objectKey: row.objectKey,
      uploadId: input.uploadId,
      parts: input.parts,
    });
    return this.markReady(row, {});
  }

  /** 直传完成回执：核对对象真的存在，再置为可下载 */
  async completeUpload(
    fileId: string,
    input: CompleteUploadRequest,
    caller: StorageCaller,
  ): Promise<FileRecord> {
    const row = await this.requireOwnFile(fileId, caller);
    return this.markReady(row, input);
  }

  async proxyUpload(
    input: {
      namespace: string;
      fileName: string;
      mimeType: string;
      body: Buffer;
      ownerId?: string;
      visibility?: FileVisibility;
      labels?: Record<string, string>;
    },
    caller: StorageCaller,
  ): Promise<FileRecord> {
    const definition = getNamespace(input.namespace);
    assertNamespaceAccess(definition, caller.clientId);

    if (input.body.byteLength > PROXY_UPLOAD_MAX_BYTES) {
      throw payloadTooLarge(
        `中转上传单文件不能超过 ${PROXY_UPLOAD_MAX_BYTES} 字节，请改用直传`,
        { maxBytes: PROXY_UPLOAD_MAX_BYTES, size: input.body.byteLength },
      );
    }
    const fileName = sanitizeFileName(input.fileName);
    const mimeType = inferMimeType(input.mimeType, fileName);
    assertUploadAllowed(definition, {
      fileName,
      mimeType,
      size: input.body.byteLength,
    });

    const fileId = newFileId();
    const objectKey = buildObjectKey(definition.namespace, fileId, fileName);
    await this.adapter.putObject({ objectKey, body: input.body, mimeType });

    const row = await this.db.file.create({
      data: {
        id: fileId,
        namespace: definition.namespace,
        objectKey,
        provider: this.adapter.provider,
        fileName,
        mimeType,
        size: input.body.byteLength,
        visibility: input.visibility ?? definition.defaultVisibility,
        status: "READY",
        ownerId: input.ownerId ?? caller.actorId,
        clientId: caller.clientId,
        labels: JSON.stringify(input.labels ?? {}),
      },
    });
    return toFileRecord(row as FileRow);
  }

  async getFile(fileId: string, caller: StorageCaller): Promise<FileRecord> {
    return toFileRecord(await this.requireOwnFile(fileId, caller));
  }

  async listFiles(
    query: ListFilesQuery,
    caller: StorageCaller,
  ): Promise<ListFilesResponse> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const rows = (await this.db.file.findMany({
      where: {
        clientId: caller.clientId,
        namespace: query.namespace,
        ownerId: query.ownerId,
        status: query.status ?? { not: "DELETED" },
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: "desc" },
      take: limit + 1,
    })) as FileRow[];

    const page = rows.slice(0, limit);
    return {
      files: page.map(toFileRecord),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async createDownloadUrl(
    fileId: string,
    input: CreateDownloadUrlRequest,
    caller: StorageCaller,
  ): Promise<CreateDownloadUrlResponse> {
    const row = await this.requireOwnFile(fileId, caller);
    if (row.status !== "READY") {
      throw failedPrecondition("文件尚未上传完成", { fileId, status: row.status });
    }
    const ttl = clampTtl(input.expiresInSeconds ?? DOWNLOAD_URL_TTL_SECONDS);
    const target = await this.adapter.createDownloadTarget({
      fileId,
      objectKey: row.objectKey,
      expiresInSeconds: ttl,
      isPublic: row.visibility === "PUBLIC",
      downloadFileName: input.downloadFileName,
    });
    return {
      url: target.url,
      expiresAt: target.expiresAt.toISOString(),
      signed: target.signed,
    };
  }

  /** 软删除元数据 + 真删对象；重复删除是幂等的 */
  async deleteFile(fileId: string, caller: StorageCaller): Promise<void> {
    const row = await this.requireOwnFile(fileId, caller);
    if (row.uploadId) {
      await this.adapter.abortMultipartUpload({
        objectKey: row.objectKey,
        uploadId: row.uploadId,
      });
    }
    await this.adapter.deleteObject(row.objectKey);
    await this.db.file.update({
      where: { id: fileId },
      data: { status: "DELETED", uploadId: null },
    });
  }

  /** 供 Releases 等内部模块按 fileId 取对象信息，不做调用方归属校验 */
  async getFileInternal(fileId: string): Promise<FileRecord | null> {
    const row = (await this.db.file.findUnique({ where: { id: fileId } })) as FileRow | null;
    return row ? toFileRecord(row) : null;
  }

  async createDownloadUrlInternal(
    fileId: string,
    input: { expiresInSeconds?: number; downloadFileName?: string } = {},
  ): Promise<CreateDownloadUrlResponse> {
    const row = (await this.db.file.findUnique({ where: { id: fileId } })) as FileRow | null;
    if (!row || row.status !== "READY") {
      throw notFound("文件不存在或尚未就绪", { fileId });
    }
    const target = await this.adapter.createDownloadTarget({
      fileId,
      objectKey: row.objectKey,
      expiresInSeconds: clampTtl(input.expiresInSeconds ?? DOWNLOAD_URL_TTL_SECONDS),
      isPublic: row.visibility === "PUBLIC",
      downloadFileName: input.downloadFileName ?? row.fileName,
    });
    return {
      url: target.url,
      expiresAt: target.expiresAt.toISOString(),
      signed: target.signed,
    };
  }

  private async markReady(
    row: FileRow,
    input: CompleteUploadRequest,
  ): Promise<FileRecord> {
    const stat = await this.adapter.statObject(row.objectKey);
    if (!stat) {
      // 只有回执没有字节：保持 PENDING，避免出现能查到却下不动的“幽灵文件”
      throw failedPrecondition("对象尚未上传到存储后端", { fileId: row.id });
    }
    if (input.size !== undefined && input.size !== stat.size) {
      throw invalidRequest("申报大小与实际对象不一致", {
        declared: input.size,
        actual: stat.size,
      });
    }
    const definition = getNamespace(row.namespace);
    if (stat.size > definition.maxBytes) {
      // 直传绕过了建单时的大小检查，这里是最后一道闸
      await this.adapter.deleteObject(row.objectKey);
      await this.db.file.update({
        where: { id: row.id },
        data: { status: "DELETED" },
      });
      throw payloadTooLarge(`文件超过 namespace 上限 ${definition.maxBytes} 字节`, {
        maxBytes: definition.maxBytes,
        actual: stat.size,
      });
    }

    const updated = await this.db.file.update({
      where: { id: row.id },
      data: {
        status: "READY",
        size: stat.size,
        checksum: input.checksum ?? row.checksum,
        uploadId: null,
      },
    });
    return toFileRecord(updated as FileRow);
  }

  private async requireOwnFile(
    fileId: string,
    caller: StorageCaller,
  ): Promise<FileRow> {
    const row = (await this.db.file.findUnique({ where: { id: fileId } })) as FileRow | null;
    if (!row || row.status === "DELETED") {
      throw notFound("文件不存在", { fileId });
    }
    // 不同站点的文件互相不可见：越权与不存在都返回 404，不泄露 id 是否有效
    if (row.clientId !== caller.clientId) {
      throw notFound("文件不存在", { fileId });
    }
    return row;
  }
}

function assertUploadAllowed(
  definition: NamespaceDefinition,
  input: { fileName: string; mimeType: string; size: number },
): void {
  if (!Number.isInteger(input.size) || input.size <= 0) {
    throw invalidRequest("文件大小无效", { size: input.size });
  }
  if (input.size > definition.maxBytes) {
    throw payloadTooLarge(
      `文件超过 namespace ${definition.namespace} 的上限 ${definition.maxBytes} 字节`,
      { maxBytes: definition.maxBytes, size: input.size },
    );
  }
  const allowList = definition.allowedMimeTypes;
  const mimeOk = allowList.length === 0 || allowList.includes(input.mimeType);
  if (!mimeOk) {
    throw unsupportedMediaType(
      `namespace ${definition.namespace} 不接受类型 ${input.mimeType}`,
      { namespace: definition.namespace, mimeType: input.mimeType },
    );
  }
  // 白名单为空的 namespace 仍要过通用上传白名单，别让任意可执行文件混进来
  if (allowList.length === 0 && !isAllowedUpload(input.mimeType, input.fileName)) {
    throw unsupportedMediaType(`不支持的文件类型：${input.mimeType}`, {
      mimeType: input.mimeType,
    });
  }
}

export function sanitizeFileName(raw: string): string {
  const base = (raw || "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^\w.\u4e00-\u9fa5-]+/g, "_").replace(/^\.+/, "");
  return cleaned.slice(0, 120) || "file.bin";
}

export function buildObjectKey(
  namespace: string,
  fileId: string,
  fileName: string,
): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${namespace}/${yyyy}/${mm}/${fileId}-${sanitizeFileName(fileName)}`;
}

function clampTtl(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return DOWNLOAD_URL_TTL_SECONDS;
  return Math.min(Math.floor(seconds), MAX_DOWNLOAD_TTL_SECONDS);
}

function newFileId(): string {
  return `file_${randomUUID().replace(/-/g, "")}`;
}

export function toFileRecord(row: FileRow): FileRecord {
  return {
    fileId: row.id,
    namespace: row.namespace,
    key: row.objectKey,
    provider: row.provider as FileRecord["provider"],
    fileName: row.fileName,
    mimeType: row.mimeType,
    size: row.size,
    visibility: row.visibility as FileVisibility,
    status: row.status as FileRecord["status"],
    ownerId: row.ownerId,
    clientId: row.clientId,
    checksum: row.checksum,
    labels: safeParseLabels(row.labels),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function safeParseLabels(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
  } catch {
    return {};
  }
}

export function assertPermission(condition: boolean, message: string): void {
  if (!condition) throw permissionDenied(message);
}
