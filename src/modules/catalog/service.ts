/**
 * Catalog：公司产品目录的唯一机器可读来源。
 *
 * 这里只存「这个产品是什么、在哪些端有、正式页面在哪」这类事实。
 * 营销文案、分类、卡片排版属于软件产品中心的运营内容，不要往这里塞，
 * 否则运营改一句话就要发一次 platform。
 */

import type {
  CatalogProduct,
  CatalogProductStatus,
  ListCatalogQuery,
  ProductPlatform,
} from "@yydsxwh/shared/contracts/catalog";
import {
  CATALOG_PRODUCT_STATUSES,
  PRODUCT_PLATFORMS,
} from "@yydsxwh/shared/contracts/catalog";

import type { PrismaClient } from "@prisma/client";
import { alreadyExists, invalidRequest, notFound } from "../../errors";

type CatalogRow = {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  status: string;
  webUrl: string | null;
  iconUrl: string | null;
  supportedPlatforms: string;
  releaseProductKey: string | null;
  listed: boolean;
  sortWeight: number;
  createdAt: Date;
  updatedAt: Date;
};

export type UpsertCatalogProductInput = {
  productId: string;
  slug: string;
  name: string;
  tagline?: string;
  status: CatalogProductStatus;
  webUrl?: string | null;
  iconUrl?: string | null;
  supportedPlatforms: ProductPlatform[];
  releaseProductKey?: string | null;
  listed?: boolean;
  sortWeight?: number;
};

export class CatalogService {
  constructor(private readonly db: PrismaClient) {}

  async listProducts(query: ListCatalogQuery = {}): Promise<CatalogProduct[]> {
    const rows = (await this.db.catalogProduct.findMany({
      where: {
        status: query.status,
        ...(query.includeUnlisted ? {} : { listed: true }),
      },
      orderBy: [{ sortWeight: "desc" }, { slug: "asc" }],
    })) as CatalogRow[];

    const products = rows.map(toCatalogProduct);
    if (!query.platform) return products;
    // 端过滤放在内存：SQLite 存的是 JSON 数组，没必要为此上专门的关联表
    return products.filter((p) => p.supportedPlatforms.includes(query.platform!));
  }

  /** productId 或 slug 都能查到：外部链接常用 slug，系统间引用用 productId */
  async getProduct(idOrSlug: string): Promise<CatalogProduct> {
    const row = (await this.db.catalogProduct.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    })) as CatalogRow | null;
    if (!row) throw notFound(`产品不存在：${idOrSlug}`, { idOrSlug });
    return toCatalogProduct(row);
  }

  /**
   * 登记或更新产品。
   * productId 是稳定机器标识，一经发布不可改；slug 可改，改了要在产品侧留 redirect。
   */
  async upsertProduct(input: UpsertCatalogProductInput): Promise<CatalogProduct> {
    assertProductId(input.productId);
    assertSlug(input.slug);
    if (!CATALOG_PRODUCT_STATUSES.includes(input.status)) {
      throw invalidRequest(`未知产品状态：${input.status}`);
    }
    for (const platform of input.supportedPlatforms) {
      if (!PRODUCT_PLATFORMS.includes(platform)) {
        throw invalidRequest(`未知平台：${platform}`);
      }
    }

    const slugOwner = (await this.db.catalogProduct.findUnique({
      where: { slug: input.slug },
    })) as CatalogRow | null;
    if (slugOwner && slugOwner.id !== input.productId) {
      throw alreadyExists(`slug ${input.slug} 已被产品 ${slugOwner.id} 占用`, {
        slug: input.slug,
      });
    }

    const data = {
      slug: input.slug,
      name: input.name,
      tagline: input.tagline ?? "",
      status: input.status,
      webUrl: input.webUrl ?? null,
      iconUrl: input.iconUrl ?? null,
      supportedPlatforms: JSON.stringify(input.supportedPlatforms),
      releaseProductKey: input.releaseProductKey ?? null,
      listed: input.listed ?? true,
      sortWeight: input.sortWeight ?? 0,
    };
    const row = (await this.db.catalogProduct.upsert({
      where: { id: input.productId },
      create: { id: input.productId, ...data },
      update: data,
    })) as CatalogRow;
    return toCatalogProduct(row);
  }
}

function assertProductId(value: string): void {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(value)) {
    throw invalidRequest("productId 须为小写字母开头的 2–64 位字母、数字或短横线", {
      productId: value,
    });
  }
}

function assertSlug(value: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw invalidRequest("slug 只能是小写字母、数字与短横线", { slug: value });
  }
}

export function toCatalogProduct(row: CatalogRow): CatalogProduct {
  return {
    productId: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    status: row.status as CatalogProductStatus,
    webUrl: row.webUrl,
    iconUrl: row.iconUrl,
    supportedPlatforms: parsePlatforms(row.supportedPlatforms),
    releaseProductKey: row.releaseProductKey,
    listed: row.listed,
    sortWeight: row.sortWeight,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parsePlatforms(raw: string): ProductPlatform[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    // 忽略不认识的值：新增端时老版本 platform 不该整条记录读不出来
    return parsed.filter((p): p is ProductPlatform =>
      PRODUCT_PLATFORMS.includes(p as ProductPlatform),
    );
  } catch {
    return [];
  }
}
