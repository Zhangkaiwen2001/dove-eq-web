# DOVE EQ WEB 前后端分离 + Docker 容器化设计

> 日期：2026-09-01
> 仓库：`Zhangkaiwen2001/dove-eq-web`（本地 `/Users/vin/Downloads/web/eq-vue`）
> 运行环境：Colima（aarch64 / 2 CPU / 4GiB / 20GiB）+ Docker CLI

## 一、目标与验收标准

把现有纯前端 SPA 重构为「前后端分离 + Docker 编排」形态，**EQ 计算逻辑一行不改**。

验收标准（全部可核查）：

| 编号 | 验收项 | 核查方式 |
|---|---|---|
| 1 | `colima start` 后 `docker version` 客户端+服务端均返回 | 命令输出 |
| 2 | `docker compose up -d --build` 两容器均 `Up` | `docker compose ps` |
| 3 | `curl http://localhost:8080` 返回 200 HTML | curl |
| 4 | `curl http://localhost:8080/api/health` 返回 `{"ok":true}` | curl |
| 5 | `curl http://localhost:8080/api/curves` 返回 5 条曲线条目 | curl + 条目数 |
| 6 | `curl http://localhost:8080/api/presets` 返回 EQ 预设条目，中文名正常 | curl + 肉眼 |
| 7 | 浏览器打开 `http://localhost:8080`，导入一条曲线**不报错**、曲线正常绘制 | 人工 |
| 8 | 往 `data/curves/` 丢一个新 CSV，刷新页面即出现，**不重建任何镜像** | 人工 |
| 9 | `npm start`（无 Docker 降级路径）仍可用 | 人工 |
| 10 | 全部变更 commit + push 到 `main` | `git log` / GitHub |

## 二、目录结构（monorepo，现有仓库改造）

```
eq-vue/                      # 仓库根 = monorepo 根
├── frontend/                # 原根目录整体迁入
│   ├── Dockerfile           # 多阶段：node:20-alpine 构建 → nginx:1.27-alpine 托管
│   ├── nginx.conf           # 静态托管 + /api 反代到 backend:3000
│   ├── index.html
│   ├── package.json         # 保留 start 脚本（降级路径）
│   ├── public/
│   │   └── vendor/          # devicepeq 浏览器端脚本（WebHID/WebSerial，不能挪后端）
│   ├── src/
│   │   ├── api/             # 新增：后端 API 客户端层
│   │   ├── engine/eqEngine.js   # 1820 行，逻辑不动
│   │   ├── components/
│   │   └── styles/main.css
│   └── vite.config.js
├── backend/
│   ├── Dockerfile           # node:20-alpine
│   ├── package.json         # express + cors + compression
│   └── src/
│       ├── server.js        # Express 入口
│       ├── routes/library.js    # /api/curves, /api/presets
│       ├── lib/scanData.js      # 扫描 data/ 目录生成条目
│       └── data/            # 运行期挂载点（内容来自仓库 data/）
├── data/                    # 纳入版本库，bind mount 进后端容器
│   ├── curves/              # 5 个 CSV + manifest.json
│   └── presets/             # 从 generated.js 拆出的散落 JSON
├── legacy/                  # Windows 更新脚本（Linux 下不可用，仅存档）
│   ├── 双击更新曲线库.cmd
│   ├── 双击更新EQ库.cmd
│   └── GX-QD.ps1
├── scripts/
│   ├── migrate-eq-library.mjs   # 一次性：generated.js → data/presets/*.json
│   ├── up.sh                    # colima start + compose up 封装
│   └── down.sh
├── docker-compose.yml
├── .dockerignore
├── .gitignore              # 追加 dist/、node_modules/ 已忽略
└── README.md               # 重写：Docker 为主路径，npm start 为备用
```

## 三、后端 API 设计

约定：返回结构与引擎现有消费结构**完全一致** `{ name, path, text }`，下游零改动。

| 方法 | 路径 | 返回 | 说明 |
|---|---|---|---|
| GET | `/api/health` | `{"ok":true,"uptime":<秒>}` | 健康检查，供前端探测与运维 |
| GET | `/api/curves` | `[{name,path,text}]` | 扫描 `data/curves/`，按 manifest 顺序，缺 manifest 则按文件名 |
| GET | `/api/curves/:name` | `{name,path,text}` | 单条曲线（CSV 原文） |
| GET | `/api/presets` | `[{name,path,text}]` | 扫描 `data/presets/*.json` |
| GET | `/api/presets/:name` | `{name,path,text}` | 单条预设 |
| GET | `/api/manifest` | `{curves:[...],presets:[...]}` | 聚合清单（无 text，仅 name/path，供列表快速渲染） |

设计约束：
- **只读 API**。本期不做写操作、不做数据库（YAGNI）
- 每次请求重新扫描目录 —— 数据量小（5 曲线 + 数十预设），加 `ETag`/内存缓存即可，不做文件监听
- `text` 内联返回，前端拿到即用，与现有 `entry.text` 逻辑完全对齐
- 编码统一 UTF-8，BOM 剥离

## 四、前端改动点（微创，仅两处）

1. **新增 `src/api/client.js`**：封装 `fetchApi(base)`，返回 `{ curves, presets }`
2. **`eqEngine.js` 替换数据源**：
   - `loadCurveLibraryEmbeddedData()` → 改为调 `/api/curves`（返回结构一致）
   - `loadEqLibraryManifest()` → 改为调 `/api/presets`
   - 保留 fallback：API 不可用时回退读 `public/` 静态文件（降级路径兼容）
3. `public/曲线库`、`public/eq库` 保留（供 `npm start` 降级路径使用）

**不改动**：1820 行 EQ 计算、滤波器、曲线拟合、拖拽、设备 PEQ 逻辑全部原样保留。

## 五、容器与编排

```yaml
services:
  backend:
    build: ./backend
    expose: ["3000"]          # 仅容器内网，宿主不占 3000
    volumes:
      - ./data:/app/data:ro   # 只读挂载，更新数据不需重建镜像
  frontend:
    build: ./frontend
    ports: ["8080:80"]        # 宿主唯一入口
    depends_on: [backend]
```

- 平台：显式 `platform: linux/arm64`（Apple Silicon）
- 前端多阶段构建：`node:20-alpine`（npm ci + build）→ `nginx:1.27-alpine`（仅 COPY dist，镜像极小）
- 后端：`node:20-alpine` + `npm ci --omit=dev`
- `.dockerignore` 排除 `node_modules/`、`dist/`、`.git/`

Colima 适配要点：
- 启动前 `colima start`（当前 Stopped）
- 用 `DOCKER_HOST=unix:///Users/vin/.colima/default/docker.sock` 直连，避免 context 权限问题
- 需先 `brew install docker-compose`（本机当前无 compose 插件）
- 拉取镜像若被墙：优先试国内 registry mirror，其次按 viki 指南给 Colima VM 的 docker daemon 配代理

## 六、数据迁移

1. **曲线库**：`public/曲线库/*.csv` + `manifest.json` → `data/curves/`（原样复制，UTF-8 化、剥离 BOM）
2. **EQ 库**：写 `scripts/migrate-eq-library.mjs` 从 `eq-library.generated.js` 反解
   - 正则提取 `window.__EQ_PRESET_LIBRARY_DATA = [...]` → `JSON.parse`
   - 每个元素写成 `data/presets/<name>.json`
   - **修复中文乱码**：源文件中 `"鎴戠殑EQ"` 是 UTF-8 字节被当 GBK 解码的产物，迁移时做 UTF-8↔GBK 转码还原
3. **Windows 脚本**（`.cmd`/`.ps1`）→ `legacy/`，附说明

## 七、执行步骤

| 步 | 动作 | 校验 |
|---|---|---|
| 1 | 环境准备：`colima start` + `brew install docker-compose` + 验证 daemon 通 | 验收 1 |
| 2 | git 移动前端代码到 `frontend/`（保留历史） | `git log --follow` 可追溯 |
| 3 | 数据迁移脚本 + 执行，产出 `data/curves`、`data/presets` | 验收 5、6（先用 node 直跑） |
| 4 | 写后端 Express + Dockerfile，本地 `node` 直跑验证 API | curl 三个接口 |
| 5 | 前端加 API 客户端层 + 改数据源（带 fallback） | `npm run build` 通过 |
| 6 | 写前端 Dockerfile + nginx.conf + docker-compose.yml | 验收 2 |
| 7 | `docker compose up -d --build` 起容器 | 验收 2、3、4 |
| 8 | 浏览器实测：导入曲线、导入预设、检查中文 | 验收 7 |
| 9 | 丢新 CSV 进 `data/curves/`，验证免重建 | 验收 8 |
| 10 | 重写 README，验证 `npm start` 降级路径 | 验收 9 |
| 11 | commit + push | 验收 10 |

## 八、风险与回退

| 风险 | 影响 | 预案 |
|---|---|---|
| Docker Hub 拉不到镜像 | 第 1 步就卡住 | 配 registry mirror；仍不行则退回 `npm start` 降级路径，容器化延后 |
| EQ 库中文乱码无法自动还原 | 预设名显示异常 | 迁移脚本记录无法还原的条目，人工核对；乱码不影响曲线数据本身 |
| Colima 2C/4G 跑构建吃力 | vite build 慢或 OOM | 前端构建放在主机做、只把 dist COPY 进镜像；或调大 Colima 到 4C/8G |
| `data/` bind mount 在 Colima 下权限/同步异常 | 后端读不到文件 | 改用 named volume + 一次性 `docker cp` 导入；或退回 COPY 进镜像 |
| 前端改数据源引入回归 | 曲线导入报错 | 引擎逻辑零改动 + fallback 保留；出问题可一键切回静态文件模式 |

## 九、关键决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 后端职责 | Node + Express 轻量 API | 数据更新免重建前端；计算留浏览器保实时性 |
| 目录结构 | 现有仓库改 monorepo | 保留 3 次提交历史与仓库名 |
| 重构深度 | 结构重构，不动算法 | 1820 行数学逻辑重写回归风险高 |
| 容器划分 | 双容器 + compose | 前端可独立重建；Nginx 仅占 5-10MB |
| 数据存放 | 仓库 `data/` + bind mount | 加曲线只需丢文件，不重建镜像 |
| EQ 库迁移 | 一次性拆成散落 JSON | 与曲线库对称，摆脱 Windows 生成产物 |
| 端口 | 宿主 8080 → nginx:80 → backend:3000 | 沿用原 8080 习惯；3000 仅内网 |
| 旧启动方式 | 保留为降级路径 | 无 Docker 环境仍可用 |
| GitHub | 容器跑通后再推送 | 避免未验证代码上远端 |

## 十、执行结果（2026-09-01 实施记录）

### 相对设计的偏差（均为主动做减法）

| 计划 | 实际 | 原因 |
|---|---|---|
| 6 个 API 端点 | 3 个（health / curves / presets） | 单条查询与 `/api/manifest` 无人调用，按 YAGNI 删除 |
| 依赖 express + cors + compression | 仅 express | cors 由 nginx 同域解决，compression 由 nginx gzip 解决 |
| 迁移脚本用 Node (.mjs) | 用 Python | 中文 mojibake 还原需 GBK 编解码，Python 内置、Node 要额外依赖 |
| 显式 `platform: linux/arm64` | 不指定 | 让 Docker 自动匹配平台，x86 机器也能跑 |
| 内存缓存 / ETag | 不做 | 全量数据仅约 200 KB，每次请求直接读取 |
| 前端数据源需 fallback 分支 | 无需分支 | 引擎本就是多级 fallback 链，API 插到链首即天然降级 |

### 实施中发现的问题

1. **EQ 库存在两种不同程度的编码损坏**
   - `我的EQ` 系列：UTF-8 字节被按 GBK 解读，可逆，已完美还原（6 处）
   - `U02正式版` 系列：中文末尾字节被**有损替换成 `?`**（0x3F），不可逆。未做猜测性修复，保持原样并在迁移报告中列出
2. **1 条预设不是 JSON 而是 `EQv1|freq,q,gain\|...` 紧凑格式**，引擎原生支持，迁移保持原样
3. **沙箱限制**：本会话无法启动 Colima（`unlink ~/.colima/_lima/_networks` 被拦截，跳出沙箱仍失败），容器端到端验证需用户在自己终端完成

### 已完成的验证

| 项 | 结果 |
|---|---|
| 后端 API 本地直跑 | `/api/health` 200；`/api/curves` 5 条；`/api/presets` 9 条 |
| 前端构建 | 24 模块通过（CSS 22.54 kB / JS 116.78 kB） |
| 前后端联调 | 8080 端口静态资源与 `/api` 全部 200，返回字段 `{name, path, text}` 与引擎期望一致 |

### 待用户在自己终端验证

- `docker compose up -d --build` 两容器均 Up
- 浏览器打开 http://localhost:8080/ 导入曲线、导入预设
- 往 `data/curves/` 丢新 CSV，刷新页面即出现（免重建镜像）
