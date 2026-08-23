# Handoff — SiliconFlow (硅基流动) 适配

## 任务目标

为 `litellm-agent-control-plane`（LAP）工程增加对**硅基流动（SiliconFlow）API** 的适配，适配模型为 `deepseek-ai/DeepSeek-V4-Flash`。测试 key 通过**前端 API 输入**（不能环境变量注入）。默认启动 opencode 运行时，验证可通过 LAP 前端（或 API）创建会话并使用硅基流动 API 对话。

## 核心架构与数据流

```
LAP 前端/API → 创建会话 → opencode 运行时 → POST /v1/chat/completions (LAP 网关) → SiliconFlow API
```

关键点：
- opencode 内置 provider 发送的是 **Chat Completions** 格式请求到 LAP 网关。
- LAP 网关原本只处理 `/v1/messages` 和 `/v1/responses`，**没有** `/v1/chat/completions`，因此新增了该直通端点。
- SiliconFlow 提供 OpenAI 兼容的 Chat Completions API：`POST https://api.siliconflow.cn/v1/chat/completions`。

## 改动清单

### 新增文件

| 文件 | 说明 |
|------|------|
| `src/sdk/providers/siliconflow/mod.rs` | 顶层模块，re-export `init` 与 `transformation` |
| `src/sdk/providers/siliconflow/chat_completions/mod.rs` | 注册 `siliconflow` provider，默认 base URL `https://api.siliconflow.cn` |
| `src/sdk/providers/siliconflow/chat_completions/transformation.rs` | Chat Completions 直通 transformation（改写 model、注入 Bearer 认证、原样转发 body）+ 3 个单元测试 |
| `src/http/chat_completions.rs` | 新增 `/v1/chat/completions` 处理器：解析 model → 应用 DB 凭据 → 转发到上游 `/v1/chat/completions` |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/sdk/routing.rs` | 给 `Deployment` 增加 `chat_completions_url()` 方法 |
| `src/http/mod.rs` | 注册 `chat_completions` 模块 |
| `src/http/routes.rs` | 注册 `/v1/chat/completions` 路由（POST） |
| `src/proxy/provider_credentials.rs` | 在 `PROVIDER_CATALOG` 增加 `siliconflow` 条目（category: Model），使前端可保存 key |
| `deploy/render.config.yaml` | 增加 `deepseek-ai/DeepSeek-V4-Flash` 与 `DeepSeek-V4-Flash` 两个 model 条目，路由到 SiliconFlow |
| `config.yaml.example` | 同步增加上述 model 条目（示例） |
| `compose.yaml` | opencode 服务设置 `LITELLM_PROVIDER_ID=deepseek-ai`、`LITELLM_MODELS=DeepSeek-V4-Flash` |
| `tests/sdk_structure.rs` | 更新 provider 目录契约测试，加入 `siliconflow` |

## 关键设计决策

### 1. API key 通过前端 API 输入（非环境变量）
- 通过 `POST /api/providers/siliconflow` 保存 key（body: `{"api_key": "...", "api_base": "https://api.siliconflow.cn"}`）。
- key 加密存储在 Postgres，由 `credential_overrides::apply` 在每次请求时注入到 `Deployment.api_key`。
- 与现有 Anthropic/OpenAI provider 的凭据流程完全一致。

### 2. opencode 模型命名问题（重要）
opencode 会把模型名按第一个 `/` 拆分为 `providerID/modelID`：
- `deepseek-ai/DeepSeek-V4-Flash` → `providerID="deepseek-ai"`, `modelID="DeepSeek-V4-Flash"`

因此：
- 在 `compose.yaml` 中设置 `LITELLM_PROVIDER_ID=deepseek-ai`，让 opencode 注册一个名为 `deepseek-ai` 的 provider，其 baseURL 指向 LAP 网关 `http://lap:4000/v1`。
- 设置 `LITELLM_MODELS=DeepSeek-V4-Flash`，注册该 modelID。
- opencode 发送给 LAP 网关的 model 是**去掉前缀的** `DeepSeek-V4-Flash`。
- 因此 LAP 配置里同时有 `deepseek-ai/DeepSeek-V4-Flash`（前端展示/直接 API）和 `DeepSeek-V4-Flash`（opencode 发送）两个条目，都解析到同一个 SiliconFlow deployment。

### 3. Chat Completions 直通
- 新增 `/v1/chat/completions` 处理器，逻辑与 `/v1/messages` 类似，但转发到 `deployment.chat_completions_url()`（即 `{api_base}/v1/chat/completions`）。
- 使用 `require_any_gateway_key`（与 messages 一致），因为 opencode 会带 `LITELLM_API_KEY`。
- 支持流式（`stream: true`）与非流式。

## 验证结果

### 编译
- `docker compose --build` 成功（Linux 容器内 Rust 编译通过）。
- 注意：本机 Windows 直接 `cargo build` 会因 MSVC linker 环境问题失败，需用 Docker 编译。

### 单元测试（在 Docker 内运行）
- `cargo test --test sdk_structure` → 通过（1 passed）
- `cargo test --lib siliconflow` → 通过（3 passed）
- `cargo test --lib sdk::routing` → 通过（4 passed）

### 端到端（API 验证）
1. 保存 SiliconFlow key：`POST /api/providers/siliconflow` → 成功，`connected_providers` 显示 siliconflow。
2. 直接测试 `/v1/chat/completions`（model=`deepseek-ai/DeepSeek-V4-Flash`）→ 返回 `LAP-SILICONFLOW-OK`。
3. 直接测试流式 `/v1/chat/completions` → 正常 SSE 流。
4. 直接测试 `/v1/chat/completions`（model=`DeepSeek-V4-Flash`，opencode 发送的剥离名）→ 返回 `STRIPPED-MODEL-OK`。
5. 完整流程：创建 agent（model=`deepseek-ai/DeepSeek-V4-Flash`, runtime=`local-opencode`）→ 创建 runtime session → 发送消息 "What is 2+2?" → 会话状态 `running`→`idle`，assistant 回复 **"4"**（正确）。
6. 前端 `http://localhost:4000` 可访问（HTTP 200），`/v1/models` 返回 `deepseek-ai/DeepSeek-V4-Flash` 与 `DeepSeek-V4-Flash`（owned_by=siliconflow）。

## 如何复现/使用

### 启动
```bash
cd litellm-agent-control-plane
docker compose --profile opencode up --build -d
```

### 保存 SiliconFlow key（前端 API）
```bash
curl -X POST http://localhost:4000/api/providers/siliconflow \
  -H "Authorization: Bearer sk-local" \
  -H "Content-Type: application/json" \
  -d '{"api_key":"<你的key>","api_base":"https://api.siliconflow.cn"}'
```

### 创建 agent + 会话 + 对话（API 方式）
```bash
# 1. 创建 agent
curl -X POST http://localhost:4000/api/agents \
  -H "Authorization: Bearer sk-local" -H "Content-Type: application/json" \
  -d '{"name":"SF Agent","owner_id":"local","model":"deepseek-ai/DeepSeek-V4-Flash","system":"You are a helpful assistant.","runtime":"local-opencode"}'

# 2. 创建 runtime session（带初始 prompt）
curl -X POST http://localhost:4000/session \
  -H "Authorization: Bearer sk-local" -H "Content-Type: application/json" \
  -d '{"agent_id":"<agent_id>","runtime":"local-opencode","title":"SF Session","prompt":"Hello"}'

# 3. 查看会话消息 / 运行时事件
curl http://localhost:4000/session/<session_id>/message -H "Authorization: Bearer sk-local"
curl http://localhost:4000/session/<session_id>/runtime_events/list -H "Authorization: Bearer sk-local"
```

## 注意事项 / 后续

- **测试 key**：已通过前端 API 保存到本地 Postgres，重启后仍在（key 本身不写入任何文件）。
- **模型名双条目**：`deepseek-ai/DeepSeek-V4-Flash`（前端展示）与 `DeepSeek-V4-Flash`（opencode 发送）都指向同一 SiliconFlow deployment，这是有意为之，勿删。
- **本机 cargo 编译**：Windows 下 MSVC linker 有问题，请用 Docker 编译/测试。
- **前端 UI**：`http://localhost:4000`（默认 master key `sk-local`）。前端模型列表来自 LAP `/v1/models`，会显示 SiliconFlow 模型。
- 若需适配其他 SiliconFlow 模型，在 `deploy/render.config.yaml` 增加对应 `model_name` 条目，并在 `compose.yaml` 的 `LITELLM_MODELS` 中追加 modelID 即可。
