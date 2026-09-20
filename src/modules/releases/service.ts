/**
 * Releases：统一软件版本与安装包下载。
 *
 * 解决的是现状里「安装包文件名写死在前端、两个站点各维护一套下载逻辑」的问题：
 * 发新版只在这里登记 Release + Asset，各端查 latest 即可，不用回去改代码。
 *
 * 安装包字节由 Storage 保管，这里只存版本元数据与 fileId 关联，下载时现签。
 */

import { randomUUID } from "node:crypto";

import type {
  AddReleaseAssetRequest,
  CreateReleaseRequest,
  LatestReleaseQuery,
  ListReleasesQuery,
  Release,
  ReleaseArchitecture,
  ReleaseAsset,
  ReleaseChannel,
  ReleaseDownloadResponse,
  ReleaseStatus,
} from "@yydsxwh/shared/contracts/releases";
import {
  RELEASE_ARCHITECTURES,
  RELEASE_CHANNELS,
} from "@yydsxwh/shared/contracts/releases";
import type { ProductPlatform } from "@yydsxwh/shared/contracts/catalog";
import { PRODUCT_PLATFORMS } from "@yydsxwh/shared/contracts/catalog";

import type { PrismaClient } from "@prisma/client";
import {
  alreadyExists,
  failedPrecondition,
  invalidRequest,
  notFound,
} from "../../errors";
import type { StorageService } from "../storage/service";

/** 安装包下载链接有效期：够慢网拉完几百 MB，又不至于被长期转发 */
const DOWNLOAD_TTL_SECONDS = 2 * 60 * 60;

type ReleaseRow = {
  id: string;
  productKey: string;
  version: string;
  channel: string;
  status: string;
  releasedAt: Date | null;
  changelog: string;
  minimumUpgradeFrom: string | null;
  createdAt: Date;
  updatedAt: Date;
  assets?: AssetRow[];
};

type AssetRow = {
  id: string;
  releaseId: string;
  fileId: string;
  platform: string;
  architecture: string;
  checksum: string | null;
  labels: string;
  file?: { fileName: string; size: number } | null;
};

export class ReleaseService {
  constructor(
    private readonly db: PrismaClient,
    private readonly storage: StorageService,
  ) {}

  async listReleases(
    productKey: string,
    query: ListReleasesQuery = {},
  ): Promise<Release[]> {
    const rows = (await this.db.release.findMany({
      where: {
        productKey,
        channel: query.channel,
        status: query.status ?? "PUBLISHED",
      },
      include: { assets: { include: { file: true } } },
      orderBy: [{ releasedAt: "desc" }, { createdAt: "desc" }],
      take: Math.min(Math.max(query.limit ?? 20, 1), 100),
    })) as ReleaseRow[];

    const releases = rows.map(toRelease);
    if (!query.platform) return releases;
    return releases.filter((r) => r.assets.some((a) => a.platform === query.platform));
  }

  async getVersion(productKey: string, version: string): Promise<Release> {
    const row = (await this.db.release.findFirst({
      where: { productKey, version },
      include: { assets: { include: { file: true } } },
    })) as ReleaseRow | null;
    if (!row) {
      throw notFound(`版本不存在：${productKey}@${version}`, { productKey, version });
    }
    return toRelease(row);
  }

  /**
   * 取最新可用版本。
   * 只认 PUBLISHED：DRAFT 还没发、REVOKED 已撤回，都不能被 latest 命中，
   * 否则撤回一个版本还得手忙脚乱改前端。
   */
  async getLatest(
    productKey: string,
    query: LatestReleaseQuery = {},
  ): Promise<Release> {
    const channel = query.channel ?? "STABLE";
    const rows = (await this.db.release.findMany({
      where: { productKey, channel, status: "PUBLISHED" },
      include: { assets: { include: { file: true } } },
      orderBy: [{ releasedAt: "desc" }, { createdAt: "desc" }],
    })) as ReleaseRow[];

    for (const row of rows) {
      const release = toRelease(row);
      if (!matchesAsset(release, query.platform, query.architecture)) continue;
      return release;
    }
    throw notFound(`没有符合条件的已发布版本：${productKey}`, {
      productKey,
      channel,
      platform: query.platform,
    });
  }

  /** 换取安装包的短期下载链接；不要把返回的 URL 写进页面或缓存 */
  async createDownload(input: {
    productKey: string;
    version: string | "latest";
    platform: ProductPlatform;
    architecture?: ReleaseArchitecture;
    channel?: ReleaseChannel;
  }): Promise<ReleaseDownloadResponse> {
    if (!PRODUCT_PLATFORMS.includes(input.platform)) {
      throw invalidRequest(`未知平台：${input.platform}`);
    }
    const release =
      input.version === "latest"
        ? await this.getLatest(input.productKey, {
            channel: input.channel,
            platform: input.platform,
            architecture: input.architecture,
          })
        : await this.getVersion(input.productKey, input.version);

    if (release.status !== "PUBLISHED") {
      throw failedPrecondition(`版本 ${release.version} 尚未发布`, {
        status: release.status,
      });
    }
    const asset = pickAsset(release, input.platform, input.architecture);
    if (!asset) {
      throw notFound(`版本 ${release.version} 没有 ${input.platform} 安装包`, {
        version: release.version,
        platform: input.platform,
      });
    }

    const download = await this.storage.createDownloadUrlInternal(asset.fileId, {
      expiresInSeconds: DOWNLOAD_TTL_SECONDS,
      downloadFileName: asset.fileName,
    });
    return {
      releaseId: release.releaseId,
      version: release.version,
      asset,
      url: download.url,
      expiresAt: download.expiresAt,
    };
  }

  async createRelease(input: CreateReleaseRequest): Promise<Release> {
    if (!RELEASE_CHANNELS.includes(input.channel)) {
      throw invalidRequest(`未知发布通道：${input.channel}`);
    }
    assertVersion(input.version);

    const existing = await this.db.release.findFirst({
      where: {
        productKey: input.productKey,
        channel: input.channel,
        version: input.version,
      },
    });
    if (existing) {
      throw alreadyExists(`版本已存在：${input.productKey}@${input.version}`, {
        productKey: input.productKey,
        version: input.version,
      });
    }

    const row = (await this.db.release.create({
      data: {
        id: `rel_${randomUUID().replace(/-/g, "")}`,
        productKey: input.productKey,
        version: input.version,
        channel: input.channel,
        // 先建草稿：没有安装包就发布出去，用户点下载只会拿到 404
        status: "DRAFT",
        changelog: input.changelog ?? "",
        minimumUpgradeFrom: input.minimumUpgradeFrom ?? null,
      },
      include: { assets: { include: { file: true } } },
    })) as ReleaseRow;
    return toRelease(row);
  }

  async addAsset(
    releaseId: string,
    input: AddReleaseAssetRequest,
  ): Promise<Release> {
    const release = await this.requireRelease(releaseId);
    if (!PRODUCT_PLATFORMS.includes(input.platform)) {
      throw invalidRequest(`未知平台：${input.platform}`);
    }
    if (!RELEASE_ARCHITECTURES.includes(input.architecture)) {
      throw invalidRequest(`未知架构：${input.architecture}`);
    }

    const file = await this.storage.getFileInternal(input.fileId);
    if (!file) throw notFound(`文件不存在：${input.fileId}`, { fileId: input.fileId });
    if (file.status !== "READY") {
      throw failedPrecondition("安装包尚未上传完成", { fileId: input.fileId });
    }

    const duplicate = await this.db.releaseAsset.findFirst({
      where: {
        releaseId,
        platform: input.platform,
        architecture: input.architecture,
      },
    });
    if (duplicate) {
      throw alreadyExists(
        `该版本已有 ${input.platform}/${input.architecture} 的安装包`,
        { releaseId, platform: input.platform },
      );
    }

    await this.db.releaseAsset.create({
      data: {
        id: `rasset_${randomUUID().replace(/-/g, "")}`,
        releaseId,
        fileId: input.fileId,
        platform: input.platform,
        architecture: input.architecture,
        checksum: input.checksum ?? file.checksum,
        labels: JSON.stringify(input.labels ?? {}),
      },
    });
    return this.getById(release.id);
  }

  /** 发布：必须已经有安装包，避免发出去的版本点下载是 404 */
  async publish(releaseId: string, releasedAt?: string): Promise<Release> {
    const release = await this.getById(releaseId);
    if (release.assets.length === 0) {
      throw failedPrecondition("没有任何安装包，不能发布", { releaseId });
    }
    const row = (await this.db.release.update({
      where: { id: releaseId },
      data: {
        status: "PUBLISHED",
        releasedAt: releasedAt ? new Date(releasedAt) : new Date(),
      },
      include: { assets: { include: { file: true } } },
    })) as ReleaseRow;
    return toRelease(row);
  }

  /** 撤回：latest 立即跳过它，但历史下载链接对应的版本记录仍可解释 */
  async revoke(releaseId: string): Promise<Release> {
    await this.requireRelease(releaseId);
    const row = (await this.db.release.update({
      where: { id: releaseId },
      data: { status: "REVOKED" },
      include: { assets: { include: { file: true } } },
    })) as ReleaseRow;
    return toRelease(row);
  }

  async getById(releaseId: string): Promise<Release> {
    const row = (await this.db.release.findUnique({
      where: { id: releaseId },
      include: { assets: { include: { file: true } } },
    })) as ReleaseRow | null;
    if (!row) throw notFound(`版本不存在：${releaseId}`, { releaseId });
    return toRelease(row);
  }

  private async requireRelease(releaseId: string): Promise<ReleaseRow> {
    const row = (await this.db.release.findUnique({
      where: { id: releaseId },
    })) as ReleaseRow | null;
    if (!row) throw notFound(`版本不存在：${releaseId}`, { releaseId });
    return row;
  }
}

function matchesAsset(
  release: Release,
  platform?: ProductPlatform,
  architecture?: ReleaseArchitecture,
): boolean {
  if (!platform) return true;
  return Boolean(pickAsset(release, platform, architecture));
}

/**
 * 选安装包：先按架构精确匹配，退而求其次用 UNIVERSAL，
 * 最后才用该端的任意一个——这样单架构产品不必把每种架构都登记一遍。
 */
function pickAsset(
  release: Release,
  platform: ProductPlatform,
  architecture?: ReleaseArchitecture,
): ReleaseAsset | null {
  const candidates = release.assets.filter((a) => a.platform === platform);
  if (candidates.length === 0) return null;
  if (architecture) {
    return (
      candidates.find((a) => a.architecture === architecture) ??
      candidates.find((a) => a.architecture === "UNIVERSAL") ??
      null
    );
  }
  return candidates.find((a) => a.architecture === "UNIVERSAL") ?? candidates[0]!;
}

function assertVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw invalidRequest(`版本号须为语义化版本，如 1.2.3：${version}`, { version });
  }
}

export function toRelease(row: ReleaseRow): Release {
  return {
    releaseId: row.id,
    productKey: row.productKey,
    version: row.version,
    channel: row.channel as ReleaseChannel,
    status: row.status as ReleaseStatus,
    releasedAt: row.releasedAt ? row.releasedAt.toISOString() : null,
    changelog: row.changelog,
    minimumUpgradeFrom: row.minimumUpgradeFrom,
    assets: (row.assets ?? []).map(toReleaseAsset),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toReleaseAsset(row: AssetRow): ReleaseAsset {
  return {
    assetId: row.id,
    fileId: row.fileId,
    platform: row.platform as ProductPlatform,
    architecture: row.architecture as ReleaseArchitecture,
    fileName: row.file?.fileName ?? "",
    sizeBytes: row.file?.size ?? 0,
    checksum: row.checksum,
    labels: safeLabels(row.labels),
  };
}

function safeLabels(raw: string): Record<string, string> {
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
