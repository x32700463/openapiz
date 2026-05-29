# OpenCode Free Proxy (Cloudflare Workers)

免费调用 OpenCode Zen API 的 Cloudflare Workers 代理。

## 支持的模型

| 模型 | 说明 |
|------|------|
| `deepseek-v4-flash-free` | DeepSeek V4 Flash |
| `big-pickle` | DeepSeek V4 Flash (别名) |
| `mimo-v2.5-free` | 小米 MiMo V2.5 |
| `nemotron-3-super-free` | NVIDIA Nemotron 3 Super |

## API 端点

### OpenAI 格式

```bash
curl https://你的worker域名/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### Anthropic 格式

```bash
curl https://你的worker域名/v1/messages \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 1024,
    "stream": true
  }'
```

### 模型列表

```bash
curl https://你的worker域名/v1/models
```

### 健康检查

```bash
curl https://你的worker域名/health
```

## 部署

### 方式一：GitHub Actions（推荐）

1. Fork 此仓库
2. 在 GitHub 仓库 Settings → Secrets 添加 `CF_API_TOKEN`
3. 推送代码到 main 分支，自动部署

### 方式二：命令行

```bash
npm install
npx wrangler deploy
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `API_KEYS` | JSON 格式的 API 密钥映射，如 `{"admin":"oc-xxx"}`。为空时允许所有请求 |

## 架构

```
你的客户端 → Cloudflare Worker (本代理) → opencode.ai/zen/v1 → AI 模型
```
