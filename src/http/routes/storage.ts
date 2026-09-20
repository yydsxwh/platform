/**
 * Storage HTTP 层：只做参数解析与转换，策略判断全在 StorageService。
 */

import { Hono } from "hono";
import { z } from "zod";

import type { AppEnv } from "../context";
import { invalidRequest, notFound } from "../../errors";
import { parseSchema as parse, readJson } from "./shared";
import type { StorageService } from "../../modules/storage/service";
import { PROXY_UPLOAD_MAX_BYTES } from "../../modules/storage/service";
import type { LocalStorageAdapter } from "../../modules/storage/providers/local";
import { verifyLocalUrl } from "../../modules/storage/providers/signing";
import { PlatformError } from "../../errors";

const visibilitySchema = z.enum(["PUBLIC", "PRIVATE"]);

const createUploadSchema = z.object({
  namespace: z.string().min(1).max(64),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().max(255).default(""),
  size: z.number().int().positive(),
  ownerId: z.string().max(128).optional(),
  visibility: visibilitySchema.optional(),
  labels: z.record(z.string(), z.string()).optional(),
  multipart: z.boolean().optional(),
});

const signPartsSchema = z.object({
  uploadId: z.string().min(1),
  partNumbers: z.array(z.number().int()).min(1).max(1000),
});

const completeMultipartSchema = z.object({
  uploadId: z.string().min(1),
  parts: z
    .array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) }))
    .min(1),
});

const completeUploadSchema = z.object({
  size: z.number().int().nonnegative().optional(),
  checksum: z.string().max(200).optional(),
});

const downloadUrlSchema = z.object({
  expiresInSeconds: z.number().int().positive().optional(),
  downloadFileName: z.string().max(255).optional(),
});

export type StorageRouterDeps = {
  storage: StorageService;
  /** 仅本地 provider 需要：platform 自己承载签名上传/下载端点 */
  local: { adapter: LocalStorageAdapter; signingKey: string } | null;
};

export function createStorageRouter(deps: StorageRouterDeps) {
  const router = new Hono<AppEnv>();

  router.get("/namespaces/:namespace", (c) => {
    const caller = c.get("caller");
    return c.json(deps.storage.getPolicy(c.req.param("namespace"), caller));
  });

  router.post("/uploads", async (c) => {
    const body = parse(createUploadSchema, await readJson(c.req.raw));
    return c.json(await deps.storage.createUpload(body, c.get("caller")), 201);
  });

  router.post("/files/:fileId/multipart/parts", async (c) => {
    const body = parse(signPartsSchema, await readJson(c.req.raw));
    return c.json(
      await deps.storage.signMultipartParts(c.req.param("fileId"), body, c.get("caller")),
    );
  });

  router.post("/files/:fileId/multipart/complete", async (c) => {
    const body = parse(completeMultipartSchema, await readJson(c.req.raw));
    return c.json(
      await deps.storage.completeMultipart(c.req.param("fileId"), body, c.get("caller")),
    );
  });

  router.post("/files/:fileId/complete", async (c) => {
    const body = parse(completeUploadSchema, await readJson(c.req.raw));
    return c.json(
      await deps.storage.completeUpload(c.req.param("fileId"), body, c.get("caller")),
    );
  });

  router.post("/files/:fileId/download-url", async (c) => {
    const body = parse(downloadUrlSchema, await readJson(c.req.raw));
    return c.json(
      await deps.storage.createDownloadUrl(c.req.param("fileId"), body, c.get("caller")),
    );
  });

  // 服务端代传小文件；大文件请走 /uploads 直传
  router.post("/files", async (c) => {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw invalidRequest("缺少 file 字段");
    }
    if (file.size > PROXY_UPLOAD_MAX_BYTES) {
      throw new PlatformError(
        "PAYLOAD_TOO_LARGE",
        `中转上传单文件不能超过 ${PROXY_UPLOAD_MAX_BYTES} 字节，请改用直传`,
        { maxBytes: PROXY_UPLOAD_MAX_BYTES },
      );
    }
    const namespace = String(form.get("namespace") ?? "");
    if (!namespace) throw invalidRequest("缺少 namespace");

    const record = await deps.storage.proxyUpload(
      {
        namespace,
        fileName: String(form.get("fileName") ?? file.name ?? "file.bin"),
        mimeType: file.type || "",
        body: Buffer.from(await file.arrayBuffer()),
        ownerId: optionalString(form.get("ownerId")),
        visibility: parseVisibility(form.get("visibility")),
        labels: parseLabels(form.get("labels")),
      },
      c.get("caller"),
    );
    return c.json(record, 201);
  });

  router.get("/files", async (c) => {
    const query = c.req.query();
    return c.json(
      await deps.storage.listFiles(
        {
          namespace: query.namespace,
          ownerId: query.ownerId,
          status: query.status as never,
          limit: query.limit ? Number(query.limit) : undefined,
          cursor: query.cursor,
        },
        c.get("caller"),
      ),
    );
  });

  router.get("/files/:fileId", async (c) =>
    c.json(await deps.storage.getFile(c.req.param("fileId"), c.get("caller"))),
  );

  router.delete("/files/:fileId", async (c) => {
    await deps.storage.deleteFile(c.req.param("fileId"), c.get("caller"));
    return c.body(null, 204);
  });

  return router;
}

/**
 * 本地 provider 的对象端点。
 *
 * 不走服务凭证：签名本身就是凭证，与 OSS 预签名地址同理——浏览器直接 PUT/GET，
 * 不可能在这里再带 Bearer。签名覆盖 action + fileId + 过期时间。
 */
export function createLocalObjectRouter(deps: {
  storage: StorageService;
  adapter: LocalStorageAdapter;
  signingKey: string;
}) {
  const router = new Hono();

  router.on(["PUT", "GET"], "/:fileId", async (c) => {
    const fileId = c.req.param("fileId");
    const action = c.req.method === "PUT" ? "upload" : "download";
    const expiresAt = Number(c.req.query("expires") ?? "0");
    const signature = c.req.query("signature") ?? "";
    const verdict = verifyLocalUrl(deps.signingKey, {
      action,
      fileId,
      expiresAt,
      signature,
    });
    if (!verdict.ok) {
      throw new PlatformError(
        "PERMISSION_DENIED",
        verdict.reason === "EXPIRED" ? "链接已过期" : "链接签名无效",
      );
    }

    const record = await deps.storage.getFileInternal(fileId);
    if (!record || record.status === "DELETED") throw notFound("文件不存在", { fileId });

    if (action === "upload") {
      const body = Buffer.from(await c.req.arrayBuffer());
      const partNumber = c.req.query("partNumber");
      const uploadId = c.req.query("uploadId");
      if (partNumber && uploadId) {
        const etag = await deps.adapter.writePart({
          uploadId,
          partNumber: Number(partNumber),
          body,
        });
        c.header("etag", `"${etag}"`);
        return c.body(null, 200);
      }
      await deps.adapter.putObject({
        objectKey: record.key,
        body,
        mimeType: record.mimeType,
      });
      return c.body(null, 200);
    }

    const bytes = await deps.adapter.readObject(record.key);
    if (!bytes) throw notFound("对象不存在", { fileId });
    const fileName = c.req.query("filename");
    c.header("content-type", record.mimeType || "application/octet-stream");
    if (fileName) {
      c.header("content-disposition", `attachment;filename="${encodeURIComponent(fileName)}"`);
    }
    return c.body(new Uint8Array(bytes), 200);
  });

  return router;
}

function optionalString(value: File | string | null): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value;
}

function parseVisibility(value: File | string | null) {
  const parsed = visibilitySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseLabels(value: File | string | null): Record<string, string> | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
  } catch {
    throw invalidRequest("labels 不是合法 JSON");
  }
}
