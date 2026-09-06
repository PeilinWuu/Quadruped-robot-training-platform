# 自动场景接入已有 FieryGS Pipeline 审计

## A. 已有手工 fire scenario 执行链路

现有入口和职责：

1. `FieryGS/adapter/fire_scenario/scenarios/*.yaml`：手工 scenario 输入。典型文件为 `office_table_fire.yaml`，使用 `ignition.object_ids`、`ignition_mode`、`initial_temperature`、`duration`、`environment`、`fire_parameters` 和 `voxelization`。
2. `FieryGS/adapter/fire_scenario/common.py`：`load_scenario()` 补默认值、映射 physics/solver 参数，并校验 scenario。
3. `generate_ignition.py`：将对象 ID 解析为精确 Gaussian ID 和 mask。
4. `generate_object_surface_ignition.py`：根据对象表面和体素网格生成 `ignition_voxel_mask.npy`、坐标和预览。
5. `fuel_initializer.py`：建立可用燃料网格、初始燃料和 solver 配置字段。
6. `validate_initialization.py`：静态验证点火 mask 是否位于可用燃料中。
7. `run_scenario_solver.py`：实例化 `simulation.fire_main.FireSolver`，运行 simulation loop 并保存 NPZ；它不是 renderer。
8. `run_long_scenario_solver.py`：长时 solver 包装入口。
9. `validate_fire_render.py`、`validate_smoke_test.py`、`track_object_propagation.py`：分别验证渲染输入、烟雾缓冲和对象传播。
10. `run_office_table_fire.ps1`：已有手工 pipeline 的编排脚本，串联 ignition、surface ignition、fuel initializer、validation 和 solver。

已有成功运行配置还包括：

- `FieryGS/arguments/office_01_native_200f.yaml`
- `FieryGS/adapter/fire_scenario/production_regression/table_high_production_200.yaml`
- `FieryGS/adapter/fire_scenario/production_regression/sofa_high_production_200.yaml`
- `FieryGS/adapter/fire_scenario/production_regression/curtain_high_production_200.yaml`

## B. 自动 scenario 与成功 YAML 的差异

自动生成文件位于：

```text
D:\interiorgs_data\office_01\generated_scenarios\scenarios\
```

自动 YAML 主要包含：

- `name`
- `scene`
- `ignition.object_id/category/material/gaussian_count/ignition_mode`
- `severity`
- `propagation_targets`

与成功执行 YAML 相比，缺少或不兼容的字段包括：

- `ignition.object_ids`：现有初始化脚本读取复数对象列表，自动 YAML 使用单数 `object_id`。
- `center_half_extent_voxels` 或可执行的 `surface_layers/patch_count/target_ignition_voxels`。
- 顶层 `ignition_mode`；自动 YAML 将其放在 `ignition.ignition_mode`。
- `initial_temperature`。
- `duration` 或 solver 使用的 `sim_frames`。
- `environment.wind` 及 smoke 参数。
- `fire_parameters.fuel_scale`。
- `voxelization` 参数。
- `solver_parameters` 或展开后的 `k/alpha/beta/epsilon/nu/burn_rate`。
- `voxel_grid`、`bounding_box`、`load_path`、`load_path_indices_pts_in_grids`、`load_path_mask_pts_in_grids`。
- `T_white`、`T_max`、`T_air`。
- `fire_sim_root`、`save_npz` 等执行输出设置。
- 精确的 `ignition_voxel_mask.npy` 和对象 Gaussian 到 voxel 的映射结果。

`propagation_targets` 当前只是规划元数据；现有 solver 并不会自动读取这些对象 ID 来实现或验证二次点火。

## C. 最小转换需求

不应重写 execution adapter，也不应修改 solver 核心。最小接入应复用既有编排链路：

```text
generated scenario
  → 转换为兼容 scenario schema
  → generate_ignition.py
  → generate_object_surface_ignition.py
  → fuel_initializer.py
  → validate_initialization.py
  → run_scenario_solver.py
```

转换层至少需要：

1. `ignition.object_id` 转为 `ignition.object_ids: [id]`。
2. `ignition.ignition_mode` 提升为顶层 `ignition_mode`。
3. 将 LOW/MEDIUM/HIGH 映射到现有 `fire_level_presets.py` 的层数、patch 数、目标体素数和帧数；dry run 时覆盖为 30 帧。
4. 从 `FieryGS/arguments/office_01_native_200f.yaml` 或已成功运行的 production 配置复用 voxel grid、边界、温度和 solver 参数，不重新设计。
5. 为每个对象先生成独立的 ignition mask 和 fuel initializer 输出，再调用既有 solver。
6. 将 `propagation_targets` 保存到 scenario metadata，供 `track_object_propagation.py` 或后续分析使用，而不是假设 solver 会执行传播规划。

## D. 可直接复用代码

可直接复用：

- `common.load_scenario()` 和 `fire_level_presets.apply_fire_level()`；
- `generate_ignition.py`；
- `generate_object_surface_ignition.py`；
- `fuel_initializer.py`；
- `validate_initialization.py`；
- `run_scenario_solver.py` / `ScenarioFireSolver`；
- `validate_fire_render.py`、`validate_smoke_test.py`；
- `track_object_propagation.py`；
- `run_office_table_fire.ps1` 的步骤顺序；
- 已成功配置中的 voxel、温度、solver 和路径字段。

不应复用为自动传播执行的部分：

- `propagation_targets` 本身不能直接替代 solver 的燃料/温度初始化；
- `scenario_generator.py` 产出的轻量 YAML 不能直接作为 `run_scenario_solver.py --config-file` 输入。

## 结论

当前自动 scenario 已通过结构级 Scenario Validator，但尚未满足 FieryGS 物理执行前提。正确的接入方式是增加薄转换层，复用已有“对象点火 → 表面体素 → 燃料初始化 → 初始化验证 → solver”链路。此审计未修改文件、未运行 solver、未生成新火焰结果。
