# 共同开发者：首次运行完整展示

本页面向主界面展示开发。**重新求解火灾、处理已有 PLY 场景或研究 MuJoCo/MPC，请先看 [后端研究入口](../research/README.md)**；需要另一个研究输入包，不能只下载本页的展示包。

你需要两样东西：本 GitHub 仓库，以及 **`office_01-collaboration-v1.json.gz`**（约 21.6 MB）。不需要自行寻找 GS、火焰或热像文件。

## 下载展示资产

打开维护者提供的 [夸克网盘分享](https://pan.quark.cn/s/4a16f7a62ef6)，下载 `office_01-collaboration-v1.json.gz`，保留原文件，不要手动解压。若分享失效、要求未提供的提取码，或找不到该文件，请联系维护者。

网盘分享链接不是文件直链，不能直接传给 `assets:setup`；请先下载，再传入本地文件路径。导入脚本会验证文件与仓库清单是否匹配，避免误用其他版本。

## 一次性环境准备

Windows x64，安装 Git、Node.js 24、Rust stable MSVC、Visual Studio 2022 C++ Build Tools（C++ 桌面开发与 Windows SDK）、WebView2。详细要求见 [快速开始](GETTING_STARTED.md)。这些是源码开发工具，资产包不会安装它们。

## 拉取、导入、运行

PowerShell：

```powershell
git clone https://github.com/PeilinWuu/Quadruped-robot-training-platform.git
cd Quadruped-robot-training-platform
npm ci
npm run assets:setup -- "C:/Users/你的用户名/Downloads/office_01-collaboration-v1.json.gz"
npm run tauri -- dev
```

把示例中的资产包路径换成收到文件的位置。不必手动解压，也不必创建 D 盘目录或手动修改环境变量。

`assets:setup` 根据已提交的 `assets/collaboration.lock.json` 校验整个包及每个文件，安装到被 Git 忽略的 `data/collaboration/<包哈希>/office_01/`，只更新 `.env.local` 的两个资产配置项，保留其他配置。安装成功后会打印 SOG 的完整路径。

在桌面应用中注册自己的本地账号，通过场景库导入刚打印的 `scene_yup.sog`。这是首次使用仍需完成的一次手动操作。然后可加载 V1 火焰、启动多点火场、查看深度/热像、加载机器人运动并检查空气墙和台阶样例。

已安装后可用 `npm run assets:verify` 复核文件；再次运行 `npm run assets:setup` 可重新配置路径，不必再次传包。资源损坏时校验会报错，不会悄悄覆盖损坏内容或跳过校验。

## 包含与不包含

包含当前完整**主界面展示**所需的外部资源：office_01 SOG、V1 桌子/沙发/窗帘火焰、V1 固体热像帧、V2 桌子实验回放。Go2 模型源文件、地面、空气墙和台阶配置已经在 Git 中。

不包含原始 PLY、全量仿真 NPZ、FieryGS 求解器源码、个人账户、开发工具和 MuJoCo 下载缓存。因此可以共同开发前端展示；如需重新求解火灾、重建场景或研究原生物理，请另行确认专项数据需求。原生模块准备见 [快速开始](GETTING_STARTED.md)。

## 共同修改代码

不要直接在 `master` 上开发。先拉取最新代码，再创建各自的主题分支，通过 PR 审核合并；见 [贡献指南](../CONTRIBUTING.md)。推送权限由仓库维护者授予；没有权限时可用 fork + PR。

日常检查：

```powershell
npm run typecheck
npm run lint
npm test
```

首次启动已经生成 Go2 GLB；若尚未启动过，测试前执行 `npm run build:go2-visuals`。资产文件和 `.env.local` 不提交。

## 维护者：更新共享包

```powershell
npm run assets:pack -- "D:/interiorgs_data/office_01" "tmp/collaboration-share/office_01-collaboration-v1.json.gz"
```

脚本只读取展示资产白名单，不收集整个数据目录；会生成压缩包并更新 `assets/collaboration.lock.json`。提交新的清单，并将匹配的包发给协作者。清单不匹配会拒绝导入。打包采用 gzip 压缩的内部 JSON/base64 容器，由 setup 脚本读取，不是通用 ZIP。

分享前确认对目标协作者的场景/数据使用授权；本流程不会自动把资产上传到 GitHub，也不赋予额外分发许可。
