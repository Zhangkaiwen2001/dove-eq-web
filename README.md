# DOVE EQ WEB · 鸽子耳机自由曲线绘制者

基于 **Vue 3 + Vite** 的耳机 EQ 均衡器调音工具，支持手机 / 平板 / 电脑三端自适应布局。
可在频响曲线上实时绘制、拖拽调试 8 段参量均衡（PEQ），并支持曲线库导入、EQ 预设管理、设备 PEQ 直连与失真补偿。

## 架构

前后端分离，两个容器：

```
浏览器 → localhost:8080 → frontend (nginx:80) → /api → backend (node:3000) → data/ 目录
```

- **frontend**：托管前端构建产物，并把 `/api` 反代到后端
- **backend**：只读 API，扫描 `data/` 目录提供曲线库与 EQ 预设
- **data/**：以只读卷挂载进后端。**加曲线只需丢文件进目录，刷新页面即可，不需要重建镜像**

> 📐 详细架构图（含 Mermaid 图与交互式大图）：[`docs/architecture.md`](docs/architecture.md)

---

## 一、快速开始（Docker）

### 前置条件

本机使用 **Colima**（非 Docker Desktop）。首次执行：

```bash
brew install colima docker-compose docker-buildx
```

> 本仓库已设为**公开（public）**，克隆无需登录：
> `git clone https://github.com/Zhangkaiwen2001/dove-eq-web.git`

### 启动

```bash
colima start
cd /Users/vin/Downloads/web/eq-vue
DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose up -d --build
```

浏览器打开 http://localhost:8080/

> **必须带 `DOCKER_BUILDKIT=0`**：默认的 buildx 构建器会绕过 Colima 配置的 registry-mirrors、直连 Docker Hub，国内网络必然 `i/o timeout`。

### 常用命令

| 操作 | 命令 |
|------|------|
| 启动（后台） | `DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose up -d --build` |
| 改了 data/ 后重启 | `docker compose restart backend` |
| 查看状态 | `docker compose ps` |
| 看日志 | `docker compose logs -f` |
| 停止 | `docker compose down` |
| 只重建前端 | `DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose up -d --build frontend` |
| 停止 Colima VM | `colima stop` |

### 排障

| 现象 | 处理 |
|------|------|
| `docker: command not found` | `colima start` 后重试 |
| `unknown shorthand flag: 'd' in -d` | compose 插件未被识别，见下方「插件注册」 |
| `WARN: requires buildx plugin` | `brew install docker-buildx` |
| `docker ps` 连不上 daemon | `export DOCKER_HOST=unix:///$HOME/.colima/default/docker.sock` |
| `proxyconnect tcp ... connection refused` | 宿主代理被注入 VM 且已失效，见下方「代理」 |
| 拉镜像 `i/o timeout` | Docker Hub 被 DNS 污染，配 registry mirror（见文末第九节） |

**插件注册**：brew 把 compose / buildx 装到 `/opt/homebrew/lib/docker/cli-plugins`，docker CLI 默认不扫该目录，需在 `~/.docker/config.json` 补：

```json
{ "cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"] }
```

**代理**：宿主 shell 的 `HTTP_PROXY` 会被 lima 改写网关 IP 后注入 VM；代理客户端关闭后该端口失效，dockerd 拉取必挂。用无代理环境启动：

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy colima start
```

---

## 二、无 Docker 时的降级方案

```bash
cd /Users/vin/Downloads/web/eq-vue/frontend
npm install
npm start
```

`npm start` 会构建并**前台**启动静态服务器（占用当前终端，关闭终端即停止）。
此模式下没有后端，页面自动回退读取 `public/` 下的静态库文件，功能完整但**数据更新需要重新构建**。

开发模式（改代码实时生效）：

```bash
npm run dev
```

停止服务：在运行命令的终端按 `Ctrl + C`，或直接关闭终端。

---

## 三、目录结构

```
eq-vue/
├─ docker-compose.yml
├─ frontend/
│  ├─ Dockerfile              # 多阶段：node 构建 → nginx 托管
│  ├─ nginx.conf              # 静态托管 + /api 反代
│  ├─ src/
│  │  ├─ engine/eqEngine.js   # 核心逻辑（计算/画布/拖拽/库/设备）
│  │  ├─ components/          # 13 个 UI 组件
│  │  └─ styles/main.css
│  └─ public/vendor/devicepeq # 浏览器端 WebHID/WebSerial 脚本
├─ backend/
│  ├─ Dockerfile
│  └─ src/
│     ├─ server.js            # Express 入口
│     └─ lib/scanData.js      # 扫描 data/ 生成条目
├─ data/                      # 挂载进后端容器，纳入版本库
│  ├─ curves/                 # 频响曲线 CSV + manifest.json
│  └─ presets/                # EQ 预设 JSON
├─ scripts/migrate_library.py # 一次性数据迁移（含中文乱码还原）
└─ docs/plans/                # 设计文档
```

---

## 四、数据管理

### 加一条曲线

把频响文件（`.csv` / `.txt` / `.frd` / `.tsv` / `.dat`，双列：频率 + 幅度）丢进 `data/curves/`。

若 `data/curves/manifest.json` 存在，在其中登记文件名可自定义显示名：

```json
{ "files": [{ "name": "我的曲线", "path": "my-curve.csv" }] }
```

没有 manifest 时会自动扫描目录下所有支持的文件。

### 加一条 EQ 预设

把 `.json` 或 `EQv1|freq,q,gain|...` 格式的预设丢进 `data/presets/`。

**两种方式都不需要重建镜像**，刷新页面即可看到（Docker 模式下）。

### 重新执行数据迁移

`data/` 是从旧的 `generated.js` 产物一次性拆出来的。需要重跑：

```bash
python3 scripts/migrate_library.py
```

---

## 五、后端 API

| 方法 | 路径 | 返回 |
|------|------|------|
| GET | `/api/health` | `{"ok":true,"uptime":秒}` |
| GET | `/api/curves` | `[{name, path, apiPath, text}]` |
| GET | `/api/presets` | `[{name, path, apiPath, text}]` |
| GET | `/api/curves/content?path=curves/xxx.csv` | 曲线文件原文（text/plain） |
| GET | `/api/presets/content?path=presets/xxx.json` | 预设文件原文（application/json） |

全部接口只读，每次请求都重新读磁盘，不缓存——改了 `data/` 里的文件刷新页面即生效。

列表接口返回的 `text` 是文件全文，前端可直接用于渲染；但**导入时走 `apiPath` 重新拉取**，确保拿到的是磁盘上的最新内容，而非页面加载时的快照。`path` 仅作展示用。

---

## 六、使用流程

1. **导入曲线**：左侧「导入频响曲线」→ 搜索或下拉选择 → 点击导入
2. **参考频率对齐**：填入对齐频点（默认 1000 Hz）→ 点「对齐」
3. **调 EQ**：画布上拖拽控制点，或用滤波器列的频点 / Q / 增益滑块
4. **失真补偿**：正增益较多时点「失真补偿」自动回退总增益
5. **保存预设**：写入 EQ 库；也可打开本地 `.json` / `.eqpreset` 文件
6. **设备直连**：展开「设备 PEQ 直连」，用 Chrome / Edge 通过 WebHID / WebSerial 写入设备（见下方）
7. **图例开关**：点击画布下方图例项显示 / 隐藏各条曲线

### 设备 PEQ 直连

**硬性前提**

- 浏览器只能是 **Chrome 89+ / Edge 89+ / Opera 76+ 桌面版**。Safari、Firefox 及所有移动端浏览器不实现 WebHID，`navigator.hid` 不存在。
- 必须通过 **localhost** 访问。用局域网 IP（如 `192.168.x.x:8080`）打开时不是 secure context，WebHID 被禁用。
- 同一时刻只允许一个标签页持有 HID 句柄。其它标签页（含 vendor 官方 demo）占用设备时，`open()` 会失败。

**操作顺序**

```
插好 USB → 点「连接设备」→ 浏览器弹窗选设备并授权
        → 见到连接成功提示 → 点「从设备读取」
        → 调参 → 点「推送到设备」
```

顺序不能颠倒。未连接就点「从设备读取」会抛 `InvalidStateError: The device must be opened first.`——vendor 脚本只检查了设备对象是否存在，没有校验是否真正 `open()`。

**设备兼容性**

vendor 按 **USB vendorId** 过滤设备，被接受的 VID 共 14 个：

| 厂商 | VID |
|------|------|
| FiiO | `0x2972` `0x0A12` |
| WalkPlay / Moondrop / EPZ / Truthear / LETSHUOER / Tanchim / ddHifi | `0x3302` `0x0762` `0x35D8` `0x2FC6` `0x0104` `0xB445` `0x0661` `0x0666` `0x0D8C` |
| KT Micro | `0x31B2` |
| Topping | `0x152A` |

VID 不在其中则设备选择器里不会出现。**型号名不在清单里也能连**——此时套用该厂商的 `defaultModelConfig`，但段数、增益范围、槽位可能与真机不符。**首次连接请先点「从设备读取」核对段数与槽位名，确认无误再写入。**

**安全建议**：调参阶段保持「实时推送」关闭，手动点「推送到设备」写入，避免拖动滑块时误写设备。

---

## 七、常见问题

- **页面白屏**：确认通过 http://localhost:8080/ 访问，而非直接双击 HTML 文件
- **曲线库为空**：检查 `data/curves/` 是否有文件，或点击界面上的「刷新」
- **设备连不上**：需 localhost 或 HTTPS 环境，换 Chrome / Edge
- **改了数据但页面没变**：Docker 模式下确认文件放进了 `data/`（不是 `frontend/public/`）

---

## 八、预设说明

`data/presets/` 下的预设均为合法 JSON（`version` / `name` / `preamp` / `filters` 字段），可直接导入使用。

> `U02正式版（321321）.json` 采用 `EQv1|freq,q,gain|...` 紧凑格式，引擎原生支持，可正常使用。

---

## 九、附：Docker 拉取镜像被墙

### 根因

`docker.io` 的 DNS 被污染，解析到非 Docker Hub 的 IP（`66.220.149.32`、`104.244.43.136` 等），直连必然 `i/o timeout`。给 daemon 配代理可以绕过，但**不想依赖个人代理时，用国内 registry mirror 更干净**。

### 配置镜像源

编辑 `~/.colima/default/colima.yaml`，把 `docker: {}` 改成：

```yaml
docker:
  registry-mirrors:
    - https://docker.m.daocloud.io/
    - https://hub-mirror.c.163.com/
    - https://docker.mirrors.ustc.edu.cn/
```

然后**只 stop+start，千万不要 `colima delete`**：

```bash
colima stop
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy colima start
docker info | grep -i -A3 mirror   # 应列出 3 个镜像源
```

> **关键坑**：`colima delete` 会把整个 `colima.yaml` 重置为默认值，刚写的镜像源会被清空，导致下次构建又超时。镜像源只在 VM 创建 / 重启时下发，`stop && start` 即可生效。

### 两个配套要求

1. **必须关掉 buildx**：默认的 buildkit 构建器会绕过 daemon 的 registry-mirrors、直连 Docker Hub。启动时带 `DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0`，强制用 classic 构建器。
2. **容器内 npm 也要换源**：两个 Dockerfile 的 `npm ci` 前已加 `RUN npm config set registry https://registry.npmmirror.com`，否则容器内直连 `registry.npmjs.org` 同样被墙。

### 已不推荐的旧方案

早期尝试过在 VM 内给 dockerd 配 systemd 代理（`colima ssh -- sudo tee /etc/systemd/system/docker.service.d/http-proxy.conf`）。该方案依赖宿主机代理客户端持续运行，客户端关闭后端口失效，dockerd 拉取会报 `proxyconnect tcp ... connection refused`。**除非你本来就要开代理，否则优先用镜像源。**
