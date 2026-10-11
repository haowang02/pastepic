# 贴图 Pastepic

粘贴图片，生成临时链接。

![贴图界面截图](docs/screenshot.png)

## 特性

- **粘贴即得链接**：按 Ctrl/⌘ + V 粘贴、拖拽或点击选择图片；单张上传后链接自动复制到剪贴板，多张上传时列出链接表格，可逐条或一次性复制。
- **用完即走**：图片 7 天后自动删除，适合在聊天、工单、代码评审中临时分享截图。它不是图床，不适合需要长期有效的外链。
- **无需注册**：每个浏览器首次访问时自动获得一个匿名会话，上传记录只在当前浏览器可见；图片链接则对任何拿到它的人开放。
- **上传记录**：瀑布流展示，滚动加载；缩略图为 WebP，动图保留动画；点击查看大图，可复制链接、打开或下载原图。
- **安全默认值**：按文件内容识别格式，仅接受 JPG、PNG、GIF、WebP、AVIF；限制单张大小和上传频率；页面启用严格的 CSP。
- 支持深色模式和移动端，所有资源自托管，不依赖外部 CDN。

## 部署

需要 Docker 和 Docker Compose。

```bash
git clone https://github.com/haowang02/pastepic.git
cd pastepic
cp .env.example .env   # 至少修改 PUBLIC_URL
docker compose up -d --build
```

服务默认发布在 `127.0.0.1:8080`，请在前面放一个提供 HTTPS 的反向代理（Nginx、Caddy、Nginx Proxy Manager 等），并确认代理允许的请求体不小于 `MAX_UPLOAD_MB`。图片和数据库保存在 `pastepic-data` 卷中。

### 配置

在 `.env` 中设置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PASTEPIC_BIND` | `127.0.0.1:8080` | 容器发布到宿主机的地址和端口 |
| `PUBLIC_URL` | 按请求推断 | 生成图片链接所用的站点地址，如 `https://img.example.com` |
| `RETENTION_DAYS` | `7` | 图片保留天数 |
| `MAX_UPLOAD_MB` | `25` | 单张图片大小上限（MB） |
| `UPLOAD_RATE_MAX` | `120` | 每个 IP 每 10 分钟最多上传张数 |
| `TRUST_PROXY` | `1` | 前置反向代理的层数；直接对外提供服务时设为 `0` |

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/images` | 上传图片，`multipart/form-data`，字段名 `file`；返回图片信息，其中 `url` 为图片链接 |
| `GET` | `/api/images?cursor=&limit=` | 当前会话的上传记录，按时间倒序分页 |
| `GET` | `/api/session` | 当前会话的图片数量、占用空间和上传限制 |
| `GET` | `/i/{id}.{ext}` | 原图 |
| `GET` | `/t/{id}.webp` | 缩略图 |

```bash
curl -F file=@screenshot.png https://img.example.com/api/images
```

## 开发

需要 Node.js 24 或更高版本。

```bash
npm install
npm run dev:server   # API 服务，http://127.0.0.1:3000，数据写入 ./data
npm run dev          # 前端开发服务器，/api、/i、/t 代理到 3000 端口
npm test             # API 测试
npm run build        # 类型检查并构建前端到 dist/
```

技术栈：Fastify、`node:sqlite`、sharp（缩略图）、Vite + 原生 TypeScript、Lucide 图标。

- 修改 `public/favicon.svg` 后运行 `npm run icons` 重新生成各尺寸图标。
- 修改界面文案后运行 `python3 scripts/subset-font.py path/to/SmileySans-Oblique.ttf` 重新生成标题字体子集（需要 `pip install fonttools brotli`）。

## 许可证

[MIT](LICENSE)。界面使用了 [Lucide](https://lucide.dev) 图标（ISC）和基于 [得意黑](https://github.com/atelier-anchor/smiley-sans) 的字体子集（SIL OFL 1.1），详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
