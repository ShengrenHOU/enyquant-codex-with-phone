# ENYQUANT Codex With Phone

[English](./README.md) | 简体中文

把你电脑上的本地 `codex` 会话延伸到手机上使用。

这个仓库主要解决四件事：

- 在手机上继续已有的 Codex 线程
- 在手机上新建 Codex 会话
- 在手机上优先浏览最近会话
- 通过 Tailscale 在外网访问电脑上的会话服务

## 截图

<p align="center">
  <img src="./docs/images/codex-web-terminal.jpg" alt="手机会话列表" width="280" />
  <img src="./docs/images/codex-web-terminal2.jpg" alt="手机聊天页面" width="280" />
</p>

## 环境要求

- Node.js 22+
- 电脑端已经安装并能正常使用 `codex`
- 电脑端必须先具备正常调用 Codex 的能力
  - 如果你所在地区需要电脑开 VPN 才能正常使用 Codex，就保持电脑端 VPN 在线
- 如果要远程外网访问：电脑和手机都安装 Tailscale，并登录同一个账号

## 分支模型

- 默认分支：`develop`
- 稳定分支：`main`
- 新任务分支从 `develop` 开出
- PR 目标分支为 `develop`

## 快速开始

```bash
git clone -b develop https://github.com/ShengrenHOU/enyquant-codex-with-phone.git
cd enyquant-codex-with-phone
```

## 傻瓜式安装：直接复制给 Codex

如果你希望让 Codex 帮你把本地环境基本配好，直接把下面这段完整贴给电脑上的 Codex：

```text
请帮我把这个仓库配置成电脑和手机都能用的状态。

目标：
1. 检查这台电脑是否已安装 Node.js、codex CLI、Tailscale。
2. 如果缺少 .env，就从 .env.example 创建。
3. 在 .env 里至少配置：
   - HOST=0.0.0.0
   - TAILSCALE_ONLY=true
   - ACCESS_TOKEN=<帮我生成一个本地可用的强 token，并在最后明确展示给我>
   - DEFAULT_CWD=<设置成我的主工作目录>
   - CODEX_APP_SERVER_ENABLED=true
   - MOBILE_CODEX_PROFILE=<如果有更快的手机 profile，就设成它>
   - MOBILE_CODEX_MODEL=<如果有更快的手机模型，就设成它>
4. 执行 npm install。
5. 执行 npm run check。
6. 启动服务。
7. 最后明确输出：
   - 电脑本地访问地址
   - 后端地址
   - 手机端通过 Tailscale 访问的地址
   - 手机登录时要输入的 ACCESS_TOKEN

限制：
- 不要改 repo 里的源码，除非为运行所必需。
- 如果这台电脑上的 Codex 依赖 VPN，请明确提醒我保持电脑端 VPN 在线。
- 如果 Tailscale 没装或没登录，请停止并明确告诉我下一步该做什么。
```

## 手工安装版

1. 基于示例创建 `.env`
2. 至少配置这些值：

```env
HOST=0.0.0.0
ACCESS_TOKEN=换成你自己的 token
TAILSCALE_ONLY=true
DEFAULT_CWD=你的工作区路径
CODEX_APP_SERVER_ENABLED=true
MOBILE_CODEX_PROFILE=
MOBILE_CODEX_MODEL=
```

3. 安装依赖并做检查：

```bash
npm install
npm run check
```

4. 启动服务：

```bash
npm run dev
```

如果你要长期稳定用，建议直接启动常驻服务：

```bash
npm run service:start
npm run service:status
```

5. 电脑本地打开：

- `http://127.0.0.1:5173/#/sessions`
- 或后端直连：`http://127.0.0.1:3210/#/sessions`

## 手机远程访问

这个仓库本身不提供公网穿透。  
远程访问依赖 Tailscale。

1. 保持电脑开机
2. 保持电脑端 Tailscale 在线
3. 保持电脑端 Codex 可正常使用
   - 如果你的电脑需要 VPN 才能访问 Codex，就保持电脑端 VPN 在线
4. 保持本服务正在运行
5. 在电脑上执行：

```bash
tailscale status
tailscale ip -4
```

6. 手机上打开：

```text
http://<电脑的100.x.x.x>:3210/#/sessions
```

7. 用 `ACCESS_TOKEN` 登录

## 手机快速模式

现在这个项目支持一套手机优先的默认 Codex 运行配置。

- `CODEX_*` 继续作为通用/桌面兜底
- `MOBILE_CODEX_*` 作为这个 Web terminal 创建或恢复会话时的默认运行参数

推荐用法：

```env
CODEX_PROFILE=deep-desktop
CODEX_MODEL=
MOBILE_CODEX_PROFILE=mobile-fast
MOBILE_CODEX_MODEL=
MOBILE_CODEX_FULL_ACCESS=true
MOBILE_CODEX_EXTRA_ARGS=
```

适用场景：

- 电脑端做更深、更重的工作
- 手机端主要做接力、补位、短回合处理

如果没有设置 `MOBILE_CODEX_*`，系统会自动回退到 `CODEX_*`。

## 会话同步限制：为什么手机更新了，桌面 Codex App 没更新

这个问题必须单独讲清楚。

### 发生了什么

- 手机网页和桌面 Codex App 共享同一个底层 Codex thread
- 但是桌面 Codex App 当前 **不保证** 对外部写入做实时热刷新

### 这是不是 bug

- 不一定是 bug
- 很多情况下 thread 实际已经写进去了
- 只是桌面 Codex App 的当前会话页面没有立刻刷新出来

### 正确动作是什么

- 如果你在手机上继续了某个会话
- 回到电脑上的 Codex App
- 退出这个会话页面
- 再重新进入同一个会话
- 通常就能看到最新记录

一句话总结：

- 手机和桌面共享同一个底层 thread
- 但桌面 Codex App 不保证热刷新
- 所以手机继续后，桌面端通常需要重新进入该会话才能看到更新

## Windows 兼容说明

这个仓库已经包含 Windows 下的 Codex 兼容处理：

- 通过 `cmd.exe /c` 拉起 Codex 进程
- 避免 PowerShell shim 导致的 `spawn EPERM`

## 常用命令

```bash
npm run dev
npm run check
npm run pm2:prod
npm run pm2:save
npm run service:start
npm run service:restart
npm run service:status
npm run service:logs
npm run service:resurrect
```

## Windows 常驻运行

如果你想把它当成长期入口使用，不要一直靠临时前台终端维持。

推荐 Windows 路线：

1. 安装依赖：

```bash
npm install
```

2. 用 PM2 启动生产服务：

```bash
npm run pm2:prod
```

3. 保存 PM2 进程列表：

```bash
npm run pm2:save
```

4. 检查状态：

```bash
npm run service:status
```

5. 如果重启后服务没有自动恢复，用：

```bash
npm run service:resurrect
```

健康检查方法：

- `http://127.0.0.1:3210/api/health`
- `npm run service:status`
- `npm run service:logs`
- 检查 `3210` 端口是否在监听

## 常见问题

### 手机打不开

- 确认手机和电脑已登录同一个 Tailscale 账号
- 确认电脑端 Tailscale 在线
- 确认服务正在监听 `3210`
- 确认你走的是 Tailscale 地址，而不是普通局域网地址

### Codex 回复慢

- 一般不是 Tailscale 本身慢
- 主要瓶颈通常在电脑端自己的 Codex 网络链路
- 如果你在中国并且电脑端要依赖 VPN 访问 Codex，请优先保证电脑端 VPN 稳定
- 如果已经配置 `MOBILE_CODEX_*`，手机端会默认优先走更快的运行配置，这也是当前最推荐的提速方式

### 手机突然连不上

- 最常见原因是电脑上的服务没在跑
- 先看 `npm run service:status`
- 再看 `/api/health`
- 必要时执行 `npm run service:start` 或 `npm run service:resurrect`

### 手机端会话列表慢

- 现在默认优先加载最近会话
- 更老的会话按需点击加载
- 历史消息默认只加载最近 3 条，减少手机端首屏同步负担

## 开源说明

- [LICENSE](./LICENSE)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [SECURITY.md](./SECURITY.md)
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
