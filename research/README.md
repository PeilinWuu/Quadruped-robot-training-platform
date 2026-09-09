# 后端研究协作入口

本目录用于 **重新求解火灾、处理已有场景和研究原生物理**。前端演示入口见 [协作者指南](../docs/COLLABORATOR_QUICKSTART.md)。本次审计结论见 [后端审计](../docs/BACKEND_RESEARCH_AUDIT.md)。

## 交付物

| 内容 | 获取方式 |
| --- | --- |
| GUI、MuJoCo/MPC、后端启动工具 | 本 Git 仓库 |
| FieryGS 基线 | `setup-fierygs.py` 拉取固定上游提交 |
| 本地生产适配 | Git 中的 `fierygs/local-production.patch` 和 `overlay/`，启动工具自动应用 |
| 求解与场景处理输入 | 维护者另发 `office_01-research-inputs-v1.zip`，约 71.3 MB |
| 展示资产 | 原夸克网盘中的 `office_01-collaboration-v1.json.gz`，独立于研究输入包 |
| 原始照片/COLMAP | 在已审计数据目录中未找到，不能承诺提供原始重建复现 |

**研究输入包尚未上传到现有网盘。** 请向维护者索取；已有网盘链接只确认由维护者提供用于展示包，不代表其中包含研究包。

## A. 恢复火灾源码

在项目根目录，使用 Python 3.9+ 和 Git：

```powershell
python research/setup-fierygs.py
```

默认得到 `.cache/research/FieryGS`，不会覆盖你已有的 `FieryGS/`。它检出 `source-lock.json` 的完整上游提交，校验补丁/附加脚本 SHA-256 后应用。无需依赖原开发者未推送的 `defda1d` 提交。

离线或本机验证可用 `python research/setup-fierygs.py --source C:/已有的/FieryGS`。目标必须不存在。原始 `.gitmodules` 格式存在问题，本工具没有声称自动准备 Grounded-SAM-2；纯体积求解不需要它。

恢复后的本地改动会显示为未提交，这是有意保留的生产适配，**不要执行 `git reset --hard` 丢弃它们**。原本机 checkout 不被改动。使用源码须保留 [FieryGS Apache-2.0](fierygs/LICENSE) 和上游第三方许可证。

## B. Python/GPU 环境

本机实测 Python 3.9.23、PyTorch 2.5.1 / CUDA 11.8、Taichi 1.7.4、RTX 4060 Laptop。需要兼容的 NVIDIA 驱动；新机器环境安装尚未实测。建议独立 Conda 环境，避免污染桌面项目：

```powershell
conda create -n robot-fire-research python=3.9.23 pip -y
conda activate robot-fire-research
python -m pip install torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cu118
python -m pip install -r research/environment/solver-requirements.txt
python -c "import torch,taichi; print(torch.__version__,torch.version.cuda,torch.cuda.is_available())"
```

`noise` 等包在 Windows 可能需要 C++ Build Tools。`environment/fire-gaussian-win-observed.json` 是已安装环境的版本调查，**不是可直接安装的通用锁文件**。

纯求解使用 Taichi 和 PyTorch，不要求先编译全部 GS rasterizer。若做原生 GS 渲染/PGSR 训练，还需 CUDA Toolkit 11.8、匹配编译器、各 rasterizer/simple-knn、SAM/CLIP/PyTorch3D 等依赖及模型权重。恢复后上游 README 提供这些入口，但尚未在新环境完整验证；不要运行那套全流程并误以为 office_01 原始重建数据已齐全。

## C. 安装研究输入

```powershell
python research/install-inputs.py "C:/Downloads/office_01-research-inputs-v1.zip"
```

默认解压到 `data/research/office_01`，逐文件校验，拒绝覆盖已有目录。包中含显式 PLY、语义/结构信息，以及九组生产配置引用的燃料、材料、点火 mask 和 Gaussian/voxel 映射；不含全量历史输出、数据库或凭据。

## D. 最小火灾实验

保持上述 Python 环境激活，从本项目根目录执行：

```powershell
python research/run-fire.py --data data/research/office_01 --scenario table_high --frames 2 --name first_table_test
```

工具复制生产 YAML，递归改写其中原 D 盘路径，并把输出隔离到恢复源码中的 `output/first_table_test/`。同名输出存在时拒绝重跑，请更换 `--name`。

支持 table/sofa/curtain × low/medium/high。默认一帧用于初始化检查；导出播放至少需要两帧。两帧只是技术冒烟检查，不是火势发展或物理准确性验收。正式实验应自行选择帧数、种子和对照配置，不要一开始启动整个 1080 样本生产流程。

输出 `run-report.json` 与 `sim_output/`，其中温度、燃料、固体温度等以 NPZ 保存。验证这些文件存在、数值有限、尺寸与 YAML 一致。

## E. 导出到展示格式

两帧实验完成后，可运行桌子 V1 导出：

```powershell
python .cache/research/FieryGS/adapter/fire_showcase/export_fire_playback.py --simulation-dir .cache/research/FieryGS/output/first_table_test/sim_output --output-dir data/research-export/fire_playback/table_high --first-frame 0 --last-frame 1 --frame-step 1
python scripts/export-thermal-playback.py data/research-export/fire_playback/table_high
```

原始实验配置含大量 office_01 默认值。桌子导出链已用于本次检查；其他物体不能只改目录名就假设包围盒、场景 ID 和材料映射正确。`export_room_fire_playback.py` 仍读取生产目录布局及桌子模板，完整多点重导出须另行组织。

前端测试新导出时，设置 `GS_SCENE_DATA_ROOT` 为导出根目录，并确保需要的其余播放目录存在，或只测试单桌模式。不要覆盖现有共享包中的基线输出。

## F. 原生 MuJoCo/MPC

这部分已经在主 Git 仓库，不依赖网盘研究包或 FieryGS。安装 Windows C++/CMake/Rust 开发工具后：

```powershell
npm ci
npm run setup:mpc
npm run build:sidecar
```

构建脚本准备锁定 MuJoCo 并运行 CTest。代码入口为 `native/mujoco-sidecar/src/`，说明见 [Sidecar](../native/mujoco-sidecar/README.md)。当前控制基线为 Go2 平地 MPC；GS 空气墙和前端台阶并非 MuJoCo 碰撞模型。

## G. 如何提交后端修改

不依赖 GPU 的交付检查：`python -m unittest discover -s research -p "test_*.py"`，验证源码清单、输入导入、重复安装保护和损坏包拒绝。

本阶段不把独立 FieryGS 仓库或大数据直接嵌套提交进主仓库。原生物理直接修改主仓库文件；FieryGS 的修改在恢复后的 checkout 中开发，再更新补丁/overlay 与哈希清单，并附实验配置、结果指标和必要截图。不要只提交主仓库文档而把实际改动留在被忽略目录里。

补丁基线必须保持 `source-lock.json` 中的上游版本；新建源码文件需要纳入补丁或 overlay。后续团队若持续大量修改求解器，建议建立专用 FieryGS fork，再把本仓库入口改为固定 fork 提交；当前没有擅自创建或推送新远端。
