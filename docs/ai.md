# AI

未来日事、MathCode、课程、论坛、搜索、写作都会调用 AI。
因此 Provider、模型、API Key、Base URL、模型路由、限流、调用记录、成本统计
统一归 `platform/ai`。

**产品不得自己保存任何厂商 Key。**

```
产品 → shared AI Client → platform AI API → Qwen / OpenAI / 其他模型
```

## 迁移前的问题

同一把 Key 要在主站和软件专栏各填一次，而且能各自改成不同的值：

| 调用方 | 迁移前读哪 |
|---|---|
| 正文一键翻译 | 主站 `SiteSettings.translateApiKey` |
| MathCode 视觉识别 | 同上，或 `MATHCODE_API_KEY` 环境变量覆盖 |
| MathCode 文档转换 | 同上 |
| softwarelist 的同样三处 | **它自己库里的另一份** |

## 配置

Key 不写进配置 JSON，而是用 `apiKeyEnv` 指向另一个环境变量名。这样 provider
清单可以进配置管理、日志与 Studio 展示，**Key 只存在于它自己的变量里**，
可以单独轮换、单独收紧读取权限。

```bash
AI_PROVIDERS='[{"id":"dashscope","label":"阿里云百炼",
  "baseUrl":"https://dashscope.aliyuncs.com/compatible-mode/v1",
  "apiKeyEnv":"AI_KEY_DASHSCOPE",
  "models":[{"id":"qwen-plus","costPerMillionInputMicros":800000},
            {"id":"qwen-vl-max","vision":true}]}]'
AI_KEY_DASHSCOPE=sk-…

AI_ROUTES='{"translate":["dashscope/qwen-plus","openai/gpt-4o-mini"],
            "vision-ocr":["dashscope/qwen-vl-max"]}'
AI_DEFAULT_MODEL=dashscope/qwen-plus
AI_TIMEOUT_MS=60000
AI_RATE_LIMIT_PER_MINUTE=60
AI_FAILURE_THRESHOLD=3
```

配置不合法在**启动时**就报错，不留到第一个请求才 500。

## 用途路由

产品只说用途，不说型号——换模型或换厂商时改 platform 配置即可，产品代码不动。

| 用途 | 谁在用 |
|---|---|
| `translate` | 正文一键翻译 |
| `vision-ocr` | MathCode 截图 / PDF 转 LaTeX（必须路由到视觉模型） |
| `general` | MathCode 文档转换等通用文本任务 |

也可以用 `model: "provider/model"` 钉死型号，但只在确有必要时用。

## fallback 与健康度

`AI_ROUTES` 里一个用途可以配多个候选，按顺序尝试。首选超时或报错时自动走下一个，
响应里 `fallbackUsed: true`。

连续失败达到 `AI_FAILURE_THRESHOLD` 的 provider 被标记为 `DEGRADED`，
**在还有备选时直接跳过**——不拿用户请求去试错。成功一次即恢复。

没有备选时不 fallback，失败即失败，不掩盖问题。

## 限流

按 `clientId + purpose` 的每分钟滑动窗口。

单进程模块化单体下用内存计数是最简实现，进程重启即清零。
将来 platform 跑多副本时要换成共享存储，届时只改 `RateLimiter` 一个类。

## 用量与成本

每次调用（**包括失败**）都落 `AiUsage`：调用方、用途、provider、模型、
token 数、延迟、状态、错误分类。失败也记账，才看得清是谁在烧钱又失败。

成本按模型单价折算成「百万分之一元」整数存储，避免浮点累加误差。
没配单价的模型返回 `costMicros: null`，不瞎算。

**不存提示词与模型输出**——那是产品的业务内容，也可能含用户隐私。

## 安全

- API Key 只在拼 `Authorization` 头时出现，**不写日志、不进任何响应**
- 管理面 `GET /v1/ai/providers` 只报 `hasApiKey: boolean` 与 `apiKeyEnvName`
- 有一条测试专门断言响应 JSON 里不出现 Key 字面量
- 日志按键名自动脱敏

## 接口

```
POST /v1/ai/chat          对话补全（OpenAI 兼容语义）
GET  /v1/ai/providers     Provider 状态与健康度（不含 Key）
GET  /v1/ai/routes        用途 → 模型路由表
GET  /v1/ai/usage         用量与成本汇总
```

## 刻意没做

没有 embedding、流式输出、prompt 模板管理、向量库、Agent 编排。
现在都没有真实调用方——**不要先造一个 AI Gateway**。

## 产品侧接入

适配层在两个站点的 `packages/shared/src/platform-ai.ts`：

- `PLATFORM_AI_ENABLED` 不为 `true` 时完全走原有直连，行为零变化
- 开启后 platform 不可达或没配 Provider 也会自动回落，AI 功能不会消失
- 失败只记错误码与 requestId，提示词与模型输出不进本地日志

Studio 的「AI 接口」面板保留，新增一块 platform 接管状态（Provider 健康度、
路由、近 7 天用量与成本）。本机 Key 配置在接管后只作兜底。
