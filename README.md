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

---

## 一、快速开始（Docker）

### 前置条件

本机使用 **Colima**（非 Docker Desktop）。首次或重启后执行：

```bash
colima start
brew install docker-compose
```

> 没有 `colima` 请先 `brew install colima`。已装过 compose 插件的可跳过第二行。

### 启动

```bash
cd /Users/vin/Downloads/web/eq-vue
docker compose up -d --build
```

浏览器打开 http://localhost:8080/

### 常用命令

| 操作 | 命令 |
|------|------|
| 启动（后台） | `docker compose up -d --build` |
| 查看状态 | `docker compose ps` |
| 看日志 | `docker compose logs -f` |
| 停止 | `docker compose down` |
| 只重建前端 | `docker compose up -d --build frontend` |
| 停止 Colima VM | `colima stop` |

### 排障

| 现象 | 处理 |
|------|------|
| `docker: command not found` | `colima start` 后重试 |
| `unknown command: docker compose` | `brew install docker-compose` |
| `docker ps` 连不上 daemon | `export DOCKER_HOST=unix:///$HOME/.colima/default/docker.sock` |
| 拉镜像卡住 / TLS 报错 | Docker Hub 被墙，配 daemon 代理或 registry mirror（见文末） |

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
├─ legacy/                    # Windows 更新脚本，Linux 下不可用，仅存档
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
| GET | `/api/curves` | `[{name, path, text}]` |
| GET | `/api/presets` | `[{name, path, text}]` |

`text` 为文件全文，前端拿到即用。全部接口只读。

---

## 六、使用流程

1. **导入曲线**：左侧「导入频响曲线」→ 搜索或下拉选择 → 点击导入
2. **参考频率对齐**：填入对齐频点（默认 1000 Hz）→ 点「对齐」
3. **调 EQ**：画布上拖拽控制点，或用滤波器列的频点 / Q / 增益滑块
4. **失真补偿**：正增益较多时点「失真补偿」自动回退总增益
5. **保存预设**：写入 EQ 库；也可打开本地 `.json` / `.eqpreset` 文件
6. **设备直连**：展开「设备 PEQ 直连」，用 Chrome / Edge 通过 WebHID / WebSerial 写入设备
7. **图例开关**：点击画布下方图例项显示 / 隐藏各条曲线

---

## 七、常见问题

- **页面白屏**：确认通过 http://localhost:8080/ 访问，而非直接双击 HTML 文件
- **曲线库为空**：检查 `data/curves/` 是否有文件，或点击界面上的「刷新」
- **设备连不上**：需 localhost 或 HTTPS 环境，换 Chrome / Edge
- **改了数据但页面没变**：Docker 模式下确认文件放进了 `data/`（不是 `frontend/public/`）

---

## 八、已知问题

`data/presets/` 中有 2 条预设在 Windows 端生成时已损坏（中文名末尾字节被替换成 `?` 导致 JSON 非法）：

- `U02正式版（21312）.json`
- `U02正式版（jm1调试）.json`

迁移动作保持了原样未做猜测性修复。这两条在改造前的版本里同样无法加载。如需使用，请从原始 EQ 文件重新导出，或直接编辑文件修正 `name` 字段。

> 另外 1 条 `U02正式版（321321）.json` 是 `EQv1|freq,q,gain|...` 紧凑格式，引擎原生支持，可正常使用。

---

## 九、附：Docker 拉取镜像被墙

Docker daemon 不读 shell 的代理环境变量，需要在 Colima VM 内配置：

```bash
colima ssh -- sudo mkdir -p /etc/systemd/system/docker.service.d
colima ssh -- sudo tee /etc/systemd/system/docker.service.d/http-proxy.conf <<'EOF'
[Service]
Environment="HTTP_PROXY=http://宿主机VM可见IP:端口"
Environment="HTTPS_PROXY=http://宿主机VM可见IP:端口"
Environment="NO_PROXY=localhost,127.0.0.1"
EOF
colima ssh -- sudo systemctl restart docker
```

> VM 内访问宿主机要用 VM 可见的 IP（如 `192.168.5.2`），不是 `127.0.0.1`。
