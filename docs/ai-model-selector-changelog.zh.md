# AI 模型配置与输入框内选择器 — 变更说明

## 功能摘要

1. **API Provider 设置增强**：保存/校验 API Key 后自动拉取 `/models` 列表；支持基础模型 + 变体（variant）分层配置；失败时回退到手动输入。
2. **聊天输入框内模型工具栏**：模型选择、深度思考开关、发送按钮内嵌于圆角输入卡片底部（对齐参考布局）。

## 模型变体拼接规则

- 持久化字段：`baseModel`、`variant`、`variantFormat`、`model`（最终请求 ID）。
- `variantFormat`：
  - `dash`（默认）：`{baseModel}-{variant}`，例 `glm-5-2-260617-high`
  - `colon`：`{baseModel}:{variant}`，例 `glm-5-2-260617:xhigh`
  - `none`：忽略变体，仅用 `baseModel`
- 解析：从完整 `model` 字符串识别尾部 `-high|xhigh|max|fast|thinking` 或 `:...` 后缀拆回 base/variant。
- 启发式「支持变体」：模型 id 含 glm/claude/o1/o3/gpt-5/deepseek-r1 等，或已带变体后缀。

## 设计取舍

| 取舍 | 原因 |
|------|------|
| 变体列表用通用后缀而非各厂商完整目录 | OpenAI-compatible `/models` 通常不返回 variant 元数据；通用后缀 + 可配置拼接格式覆盖主流用法 |
| 聊天侧切换模型会写回 provider 默认 model | 与现有「一 provider 一默认模型」一致；同时 `ChatSendRequest.model` 支持单次覆盖 |
| 深度思考以 system prompt 增强实现，非独立 API 参数 | 多数兼容端点无统一 reasoning 参数；避免绑定单一厂商 |
| 附件按钮占位 disabled | 规格要求左侧布局对齐，附件能力未在本次范围 |
| 未引入新 UI 依赖 | 原生 popover + 现有 Tailwind / lucide |

## 主要改动文件

- `src/shared/modelVariant.ts` — 拼接/解析工具
- `backend/refora_server/db/migrations/0006_ai_provider_model_variant.sql`
- `src/main/services/aiProviders.ts` — `listModels` + 字段解析
- `src/renderer/components/SettingsModal.tsx` — 模型列表 / 变体 UI
- `src/renderer/components/workspace/ChatPanel.tsx` — 输入框内工具栏
- `tests/unit/modelVariant.test.ts`、`tests/component/ChatPanel.test.tsx`
