# 贴图 Pastepic

粘贴图片，生成临时链接，适合在聊天、工单和代码评审中分享截图。

![贴图界面截图](docs/screenshot.png)

## 功能

- **粘贴即得链接**：在页面上按 Ctrl/⌘ + V，或拖入、点击选择图片。单张上传完成后链接自动复制到剪贴板；一次上传多张时列出全部链接，可逐条或一次性复制。支持 JPG、PNG、GIF、WebP 和 AVIF。
- **闲置自动删除**：图片在上传或最后一次被访问 7 天后自动删除。打开、下载或在网页中嵌入原图链接都算访问，浏览上传记录中的缩略图不算。
- **无需注册**：首次访问时浏览器会获得一个匿名身份，上传记录只在这个浏览器中可见。
- **上传记录**：按时间倒序展示，缩略图上可直接复制链接或下载原图，即将删除的图片会标出剩余时间。点击缩略图查看大图，可用方向键或滑动切换。
- **易于自托管**：单个 Docker 容器，数据保存在 SQLite 和本地文件中，前端资源不依赖外部 CDN。按文件内容识别格式，限制单张大小和上传频率，页面启用严格的内容安全策略（CSP）。

## 使用须知

- 拿到链接的人都能查看图片。链接中的 ID 是随机生成的，无法被猜到或枚举，但图片不能手动删除，只能等它闲置期满。
- 原图按上传时的原样保存，照片中的 EXIF 信息（如拍摄地点）不会被去除。
- 清除浏览器 Cookie 后上传记录无法找回，已分享的链接不受影响。
- 链接不保证长期有效，不要当作图床使用。

## 部署

需要 Docker 和 Docker Compose。

```bash
git clone https://github.com/haowang02/pastepic.git
cd pastepic
cp .env.example .env   # 把 PUBLIC_URL 改成你的站点地址
docker compose up -d --build
```

服务默认只监听 `127.0.0.1:8080`，需要在前面配置提供 HTTPS 的反向代理（如 Nginx、Caddy、Nginx Proxy Manager），因为浏览器只允许 HTTPS 页面自动写入剪贴板。代理允许的请求体大小不能小于 `MAX_UPLOAD_MB`。

图片和数据库保存在 Docker 卷 `pastepic-data` 中，更新版本不会丢失：

```bash
git pull
docker compose up -d --build
```

### 配置

在 `.env` 中设置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PASTEPIC_BIND` | `127.0.0.1:8080` | 服务在宿主机上监听的地址和端口 |
| `PUBLIC_URL` | 按请求推断 | 本站的公开地址，用于生成图片链接，如 `https://img.example.com` |
| `RETENTION_DAYS` | `7` | 图片闲置多少天后删除，从上传或最后一次访问原图起算 |
| `MAX_UPLOAD_MB` | `25` | 单张图片大小上限（MB） |
| `UPLOAD_RATE_MAX` | `120` | 每个 IP 每 10 分钟最多上传的张数 |
| `TRUST_PROXY` | `1` | 前面反向代理的层数，用于识别客户端 IP 和协议；直接对外提供服务时设为 `0` |

## API

上传图片（`multipart/form-data`，字段名 `file`）：

```bash
curl -F file=@screenshot.png https://img.example.com/api/images
```

成功时返回 `201`：

```json
{
  "id": "Ab3dE6gH9k",
  "url": "https://img.example.com/i/Ab3dE6gH9k.png",
  "thumbUrl": "/t/Ab3dE6gH9k.webp",
  "type": "image/png",
  "size": 48213,
  "width": 1280,
  "height": 720,
  "createdAt": 1760000000000,
  "expiresAt": 1760604800000
}
```

`url` 是原图链接。时间均为毫秒时间戳，`expiresAt` 是当前的删除时间，原图被访问后会顺延。失败时返回相应的状态码和 `{ "error": "…", "message": "…" }`，如 `413`（文件过大）、`415`（格式不支持）、`429`（上传过于频繁）。

通过 API 上传的图片不会出现在浏览器的上传记录中。其余 `/api` 接口供网页使用，依赖浏览器会话，不作为公开接口。

图片链接：

| 路径 | 说明 |
| --- | --- |
| `/i/{id}.{ext}` | 原图，每次访问都会重新开始计算闲置时间 |
| `/t/{id}.webp` | 缩略图，宽度不超过 640 像素，访问不计入闲置时间 |

## 开发

需要 Node.js 24 或更高版本。

```bash
npm install
npm run dev:server   # API 服务：http://127.0.0.1:3000，数据写入 ./data
npm run dev          # 前端开发服务器，/api、/i、/t 代理到 API 服务
npm test             # API 测试
npm run build        # 类型检查并构建前端到 dist/
```

技术栈：Fastify、`node:sqlite`、sharp、Vite + 原生 TypeScript。

- 修改 `public/favicon.svg` 后运行 `npm run icons` 重新生成各尺寸图标。
- 标题字体是得意黑的子集，只包含界面用到的汉字。修改界面中的中文文案后，从 [得意黑 v2.0.1](https://github.com/atelier-anchor/smiley-sans/releases/tag/v2.0.1) 下载 `SmileySans-Oblique.ttf`，运行 `python3 scripts/subset-font.py path/to/SmileySans-Oblique.ttf` 重新生成（需要 `pip install fonttools brotli`）。

## 许可证

[MIT](LICENSE)。界面使用了 [Lucide](https://lucide.dev) 图标（ISC）和基于 [得意黑](https://github.com/atelier-anchor/smiley-sans) 的字体子集（SIL OFL 1.1），详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
