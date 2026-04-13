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

先基于示例创建 `.env`，至少配置这些项：

```env
HOST=0.0.0.0
ACCESS_TOKEN=换成你自己的
TAILSCALE_ONLY=true
DEFAULT_CWD=你的工作区路径
CODEX_APP_SERVER_ENABLED=true
```

安装依赖并做一次检查：

```bash
npm install
npm run check
```

## 启动方式

Windows：

```bash
npm run dev
```

macOS / Linux：

```bash
npm run dev
```

电脑本地打开：

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

## 关于桌面 Codex App 的同步

- 手机和桌面可以写入同一个底层 Codex 线程
- 但桌面 Codex App 不一定会对外部写入做热刷新
- 如果你在手机上继续了某个会话，电脑端建议手动重开该会话以看到最新内容

## Windows 兼容说明

这个仓库已经包含 Windows 下的 Codex 兼容处理：

- 通过 `cmd.exe /c` 拉起 Codex 进程
- 避免 PowerShell shim 导致的 `spawn EPERM`

## 常用命令

```bash
npm run dev
npm run check
npm run service:start
npm run service:status
npm run service:logs
```

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

### 手机端会话列表慢

- 现在默认优先加载最近会话
- 更老的会话按需点击加载
- 历史消息默认只加载最近 3 条，减少手机端首屏同步负担

## 开源说明

- [LICENSE](./LICENSE)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [SECURITY.md](./SECURITY.md)
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
