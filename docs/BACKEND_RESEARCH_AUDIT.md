# 后端研究交付审计（2026-09-10）

## 范围与结论

检查本机主仓库、独立 `FieryGS/`、`D:/interiorgs_data/office_01` 和 `fire_gaussian_win` 环境。审计没有搜索整台电脑，也未确认外部数据的公开分发许可。

**现有材料可以支持重新运行体积火灾求解、处理已有场景和原生平地物理实验；尚不足以交付从原始照片重建 office_01 的完整流程。** 使用步骤统一见 [研究入口](../research/README.md)。

## 代码缺口

- FieryGS 上游为 `PKU-VCL-Geometry/FieryGS`，本地历史包含基线 `f70fbe2` 和定制生产提交 `defda1d`，两者间 176 个文件改动（约 1.4 万新增行）。关键改动涉及 `simulation/fire_main.py`、体积渲染、材料/点火/数据集适配，并非只有前端。
- 另有 4 个未提交导出脚本：depth proxy、V2、room、smooth depth。已纳入主仓库 `research/fierygs/overlay/`。
- 已跟踪的未提交修改仅为多个 CUDA 扩展的 `.egg-info` 安装元数据，未作为业务源码交付。
- 本地未跟踪的 `third_party/pytorch3d/`、编译缓存、`tmp/` 未复制；PyTorch3D 依赖仍需单独准备。
- 上游 `.gitmodules` 中 segment-anything 与 Grounded-SAM-2 配置存在拼接格式问题。已记录，未假装 `--recursive` 能一键完成整个重建环境。
- 用固定上游 + binary patch 恢复定制代码；176 个文件忽略 LF/CRLF 后内容一致。补丁保留历史空白差异，不以清理格式改写数值实现。

## 数据库存

| 已发现 | 用途与边界 |
| --- | --- |
| `3dgs_explicit.ply`（约 218.8 MB） | 已有 927,067 Gaussian 场景；不是原始照片 |
| SOG / compressed PLY | 查看与已有重建结果处理 |
| labels / structure / occupancy / material catalog | 语义映射、结构和材料研究 |
| 九组生产 YAML 引用的 NPY/PTH | 可重新求解的现有燃料、材料、点火与映射输入 |
| production_regression / dataset 输出目录 | 历史结果；本次未将全量结果视为训练真值或全部打包 |

在 office_01 与 FieryGS/data 递归检查中，未发现 COLMAP `cameras.bin`/`images.bin`/`points3D.bin` 或 transforms JSON。未找到可确认与该场景匹配的原始照片及相机标定集合，因此原始重建仍需数据提供方补充。合成的展示 camera.json 不能替代原始采集标定。

新研究包：`office_01-research-inputs-v1.zip`，32 个输入，71,305,291 字节。选择依据是九个 production YAML 的实际引用，另含显式 PLY/结构/材料 catalog/现有相机 JSON。manifest 为 `research/inputs.lock.json`。它不替代原展示包，也不是全量原始研究数据归档。

## 环境与运行验证

- 实测 Python 3.9.23、Torch 2.5.1 CUDA 11.8、Taichi 1.7.4、RTX 4060 Laptop，CUDA 可用。
- 使用独立恢复后的源码、从新 ZIP 校验解压的数据，完成 `table_high` 一帧实际 CUDA 求解；输出网格 252 × 203 × 71，报告 completed=true。
- 继续完成独立两帧求解，V1 导出为 2 帧、每帧 7,600 字节；固体温度导出 2 帧、每帧 2,622 字节。仅验证求解到导出的技术链路，未进行新火势视觉/物理质量验收。
- 旧 `FIERYGS_SOLVER_BOOTSTRAP_AUDIT.md` 的子类失败属于历史记录。当前生产源码已使用组合式 `ScenarioFireSolver`，本次恢复后运行通过。
- 原生已有 Release 构建的 4 个 CTest 套件全部通过（协议、MPC 核心、集成、运动验收，约 56 秒）。本次未重新下载/编译全套原生依赖，也未验证全新机器安装。
- 不把本机环境可运行等同于全平台可复现：新环境 GS CUDA 扩展构建、PGSR 训练、VLM/SAM 权重及服务配置尚需专项验证。

## 提交安排

保留已建立的前端协作者入口，不重写其历史。新增后端研究分支，单独提交求解器恢复材料、输入清单/工具和审计指南；ZIP 留网盘分发，环境缓存、原始输出和个人文件不进 Git。没有推送上游 FieryGS，也没有公开上传数据。
