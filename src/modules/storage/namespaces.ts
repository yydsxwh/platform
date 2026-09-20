/**
 * namespace = 一类文件的存放区与策略边界。
 *
 * 每个 namespace 自带 MIME 白名单、大小上限与默认可见性，上传前先按策略拦，
 * 避免「传完 2GB 才告诉你类型不对」。对象 key 一律带 namespace 前缀，
 * 不同业务不会互相覆盖。
 *
 * 新增 namespace 要在这里登记：不允许调用方随便传一个字符串就开出新分区，
 * 否则策略和配额就失控了。
 */

import type {
  FileVisibility,
  NamespacePolicy,
  StorageProvider,
} from "@yydsxwh/shared/contracts/storage";
import {
  ALLOWED_IMAGE_MIME,
  ALLOWED_UPLOAD_MIME,
} from "@yydsxwh/shared/types/media";
import { notFound, permissionDenied } from "../../errors";

const MB = 1024 * 1024;
const GB = 1024 * MB;

export type NamespaceDefinition = {
  namespace: string;
  defaultVisibility: FileVisibility;
  maxBytes: number;
  allowedMimeTypes: string[];
  allowDirectUpload: boolean;
  /** 允许使用该 namespace 的调用方；空数组表示所有已认证调用方 */
  allowedClients: string[];
  /** 覆盖默认 provider，例如安装包固定放 OSS */
  provider?: StorageProvider;
};

const IMAGE_MIME = [...ALLOWED_IMAGE_MIME];
const ANY_UPLOAD_MIME = [...ALLOWED_UPLOAD_MIME];

/** 安装包不是普通上传白名单里的类型，单独列 */
const INSTALLER_MIME = [
  "application/vnd.android.package-archive",
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/octet-stream",
  "application/zip",
  "application/x-apple-diskimage",
];

const DEFINITIONS: NamespaceDefinition[] = [
  {
    namespace: "avatars",
    defaultVisibility: "PUBLIC",
    maxBytes: 5 * MB,
    allowedMimeTypes: IMAGE_MIME,
    allowDirectUpload: false,
    allowedClients: [],
  },
  {
    namespace: "images",
    defaultVisibility: "PRIVATE",
    maxBytes: 20 * MB,
    allowedMimeTypes: IMAGE_MIME,
    allowDirectUpload: true,
    allowedClients: [],
  },
  {
    // 素材中心：课程视频、音频、文档，单文件最大 2GB，必须直传
    namespace: "media",
    defaultVisibility: "PRIVATE",
    maxBytes: 2 * GB,
    allowedMimeTypes: ANY_UPLOAD_MIME,
    allowDirectUpload: true,
    allowedClients: [],
  },
  {
    namespace: "forum-media",
    defaultVisibility: "PRIVATE",
    maxBytes: 200 * MB,
    allowedMimeTypes: ANY_UPLOAD_MIME,
    allowDirectUpload: true,
    allowedClients: ["andyyyds"],
  },
  {
    namespace: "decorate",
    defaultVisibility: "PUBLIC",
    maxBytes: 20 * MB,
    allowedMimeTypes: IMAGE_MIME,
    allowDirectUpload: false,
    allowedClients: ["andyyyds"],
  },
  {
    // 安装包：由 Releases 模块引用，不对普通用户开放上传
    namespace: "app-installers",
    defaultVisibility: "PRIVATE",
    maxBytes: 4 * GB,
    allowedMimeTypes: INSTALLER_MIME,
    allowDirectUpload: true,
    allowedClients: ["andyyyds", "softwarelist", "release-bot"],
  },
  {
    // 日事附件 / 课表原图 / OCR 临时文件。结构化业务数据不进这里。
    namespace: "rishi-files",
    defaultVisibility: "PRIVATE",
    maxBytes: 20 * MB,
    allowedMimeTypes: ANY_UPLOAD_MIME,
    allowDirectUpload: true,
    allowedClients: ["rishi"],
  },
];

const REGISTRY = new Map(DEFINITIONS.map((d) => [d.namespace, d]));

export function listNamespaces(): NamespaceDefinition[] {
  return [...DEFINITIONS];
}

export function getNamespace(namespace: string): NamespaceDefinition {
  const found = REGISTRY.get(namespace);
  if (!found) {
    throw notFound(`未登记的 namespace：${namespace}`, { namespace });
  }
  return found;
}

/** 调用方是否被允许使用该 namespace */
export function assertNamespaceAccess(
  definition: NamespaceDefinition,
  clientId: string,
): void {
  if (definition.allowedClients.length === 0) return;
  if (definition.allowedClients.includes(clientId)) return;
  throw permissionDenied(`调用方 ${clientId} 无权使用 namespace ${definition.namespace}`, {
    namespace: definition.namespace,
  });
}

export function toNamespacePolicy(
  definition: NamespaceDefinition,
  resolvedProvider: StorageProvider,
): NamespacePolicy {
  return {
    namespace: definition.namespace,
    provider: definition.provider ?? resolvedProvider,
    defaultVisibility: definition.defaultVisibility,
    maxBytes: definition.maxBytes,
    allowedMimeTypes: definition.allowedMimeTypes,
    allowDirectUpload: definition.allowDirectUpload,
  };
}
