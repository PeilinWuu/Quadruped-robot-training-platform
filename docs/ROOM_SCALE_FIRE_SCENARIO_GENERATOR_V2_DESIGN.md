# Room-scale Fire Scenario Generator v2 设计与审计

> 范围：只审计现有系统并设计架构。本轮不修改 FieryGS solver、renderer、semantic bridge、UI 或机器人系统，不运行长时间模拟。

## 1. Current Pipeline Audit

### 1.1 现有火灾 scenario 系统

真实文件位于 `FieryGS/adapter/fire_scenario/`。

可复用能力包括：

- `scenario_schema.yaml`：当前 schema v2，定义 name、seed、ignition、fire_level、simulation、environment、propagation、render 等字段。
- `common.py`：加载 YAML、默认值补全、旧字段到 solver 参数映射和基础校验。
- `fire_level_presets.py`：LOW/MEDIUM/HIGH 预设。
- `generate_scenario_batch.py`：从候选对象生成小批量 YAML。
- `select_fire_candidates.py`、`filter_flammable_objects.py`：候选对象筛选。
- `generate_ignition.py`：对象 ID 到 Gaussian ID 的解析。
- `generate_object_surface_ignition.py`：对象表面体素起火区域生成。
- `fuel_initializer.py`、`material_voxel_builder.py`：燃料和材料体素准备。
- `generate_propagation_report.py`、`track_object_propagation.py`：传播候选和传播结果分析。
- `run_scenario_solver.py`、`run_long_scenario_solver.py`：调用既有 solver。
- `validate_initialization.py`、`validate_fire_render.py`、`validate_smoke_test.py`：初始化、渲染和烟雾验证。
- `analyze_fire_stages.py`、`analyze_long_run_metrics.py`：火灾阶段和长时指标分析。

当前 schema 的点火对象通过 `ignition.object_ids` 指定；点火方式通过 `ignition.mode` 指定，目前支持 `object_center` 和 `object_top_surface`。实际点火表面由 `surface_layers`、`patch_count`、`target_ignition_voxels` 或 `target_ignition_fraction` 控制。

当前火势等级并不是 solver 内部的新物理模型，而是通过预设改变表面层数、patch 数、目标初始体素数和模拟帧数：

- low：1 层、1 个 patch、25 个目标体素、60 帧；
- medium：2 层、1 个 patch、50 个目标体素、120 帧；
- high：3 层、3 个 patch、150 个目标体素、200 帧。

传播规则目前由 `propagation.enabled`、`allowed_object_ids` 和 `blocked_object_ids` 控制。`allowed_object_ids: auto` 会使用候选报告中 `recommended_for_ignition` 的对象集合；这仍是对象白名单机制，不是完整空间图上的传播规划。

已有 scenario 样例位于：

```text
FieryGS/adapter/fire_scenario/scenarios/
```

包括 office table fire、surface fire 和 smoke 等验证场景。

### 1.2 当前系统结论

当前系统已经具备“材料感知的单对象/小批量场景生成和验证”能力，但还不是 room-scale 自动生成器。`generate_scenario_batch.py` 已经是原型入口，不过其家庭集合固定为 table、sofa、curtain，且每个场景只选择一个初始对象。

## 2. Semantic bridge 审计

数据目录：

```text
D:\interiorgs_data\office_01\semantic_bridge_all
```

已确认文件：

- `parts.json`
- `objects_material_catalog.json`
- `gaussian_instance_ids.npy`
- `points_label_mulscale.npy`
- `points_materials.npy`
- `points_burnability.npy`
- `material_quality_report.json`
- `batch_preparation_report.json`
- `label_mapping_hierachical.json`
- `material_predictions.jsonl`

### 2.1 对象级能力

`parts.json` 提供 514 个解析对象，包含 part/instance ID、对象名称、Gaussian 数量、映射状态、bbox 体积、最佳视图等。

`objects_material_catalog.json` 为 514 个对象提供材料理解、可燃性、置信度、bbox corners/min/max/center、Gaussian 数量和质量状态。

因此对象级能力为：

| 能力 | 状态 |
|---|---|
| instance id | 有 | 
| object category/name | 有 |
| material | 有 |
| burnability | 有 |
| Gaussian 数量 | 有 |
| bbox | 有 |
| 材料理解置信度 | 有 |
| 可燃性质量状态 | 有 |

### 2.2 空间关系能力

当前 `semantic_bridge_all` 文件清单中没有发现已经持久化的对象关系表，未发现 distance、overlap、adjacency、contact 或 vertical relation 的正式输出。

但是 bbox center、bbox min/max 和 corners 已存在，因此可以离线派生：

- distance：bbox 最近点距离或中心距离；
- overlap：AABB/OBB 交叠体积；
- adjacency：距离阈值和表面间距联合判断；
- vertical relation：中心高度和 bbox 垂直区间关系；
- contact：bbox 接触加距离阈值，必要时使用 Gaussian 最近邻或 voxel 占据验证。

当前 semantic graph 能力评估：**PARTIAL**。

它足以支持第一版图构建，但不足以直接声称已有完整 room semantic graph。

## 3. Object Semantic Graph 设计

### 3.1 Node

每个对象实例作为一个 node：

```yaml
node_id: 113
instance_id: "113"
category: table
material: wood
burnability: burnable
burnability_confidence: high
gaussian_count: 18234
bbox:
  min: [x, y, z]
  max: [x, y, z]
  center: [x, y, z]
  size: [sx, sy, sz]
height_m: 0.75
exposed_surface_ratio: 0.42
quality_status: reliable
```

### 3.2 Edge

边采用有向或无向关系记录：

```yaml
source: 113
target: 135
distance_m: 0.21
surface_gap_m: 0.04
overlap_ratio: 0.0
adjacency: true
contact: false
vertical_relation: same_level
confidence: derived_bbox
```

关系派生优先级：

1. bbox 粗筛；
2. Gaussian/voxel 精确距离；
3. 对接触和重叠关系做 occupancy 验证；
4. 将推导方法和置信度写入 graph，避免把 bbox 推导误当作真实接触。

建议输出：

```text
semantic_graph.json
semantic_graph_edges.parquet 或 semantic_graph_edges.jsonl
semantic_graph_report.json
```

## 4. Ignition Selection Strategy

不再固定 table/sofa/curtain。为每个可燃对象计算候选分数：

```text
ignition_score =
  0.30 * material_factor
+ 0.20 * burnability_factor
+ 0.15 * size_factor
+ 0.15 * exposed_surface_factor
+ 0.15 * neighbor_factor
+ 0.05 * location_factor
```

建议定义：

- `material_factor`：材料燃烧先验；
- `burnability_factor`：材料理解的 burnability 与 confidence；
- `size_factor`：可燃体积或 Gaussian 数量的饱和归一化；
- `exposed_surface_factor`：暴露表面比例；
- `neighbor_factor`：附近可燃对象数量、距离和接触程度；
- `location_factor`：避免 wall、glass、metal 等不可燃或不适合作为起火源的对象。

选择策略：

- 按 score 分层采样，而非永远选最高分；
- 约束同一场景初始点火对象数量；
- 对相邻对象使用 diversity penalty，避免所有样本集中在同一家具簇；
- 保存 score 分解，保证样本可解释和可复现。

## 5. Propagation Planning

Generator 只规划初始条件和允许传播集合，不修改 FieryGS solver。

传播候选分数建议为：

```text
propagation_score =
  0.30 * distance_factor
+ 0.25 * material_factor
+ 0.20 * burnability_factor
+ 0.15 * contact_or_adjacency_factor
+ 0.10 * vertical_factor
```

规则：

- 距离越近，分数越高；
- wood、fabric、foam、paper、plastic 等材料优先；
- metal、glass、stone、concrete 等直接阻断；
- contact/adjacency 是强正向因素；
- 楼层或高度差过大时降低传播优先级；
- wall、window、door frame 等结构对象默认加入 blocked 集合，除非有明确可燃标注。

输出中应区分：

- `initial_ignition_object_ids`；
- `propagation_candidate_ids`；
- `blocked_object_ids`；
- 每条边的 score、距离和规则解释。

## 6. Fire Severity Schema

保留 low/medium/high 兼容字段，同时增加训练数据需要的阶段和参数：

```yaml
severity:
  stage: EARLY
  intensity: 0.35
  initial_ignition_object_count: 1
  initial_ignition_volume_scale: 0.5
  simulation_duration_s: 12
  propagation_horizon_s: 8
  max_secondary_ignitions: 3
  smoke_scale: 0.7
  fire_scale: 0.6
```

建议阶段：

- `IGNITION`：局部初始点火；
- `EARLY`：初始对象持续燃烧，少量周边升温；
- `ESTABLISHED`：火焰稳定，开始形成明显烟雾；
- `SPREAD`：多个可燃对象参与传播；
- `SEVERE`：大范围高温、高烟雾和多源燃烧。

这些字段只由 generator 映射到现有 `fire_level_presets`、initial ignition 和 render 参数，不修改 solver 物理。

## 7. Dataset Generation Pipeline

目标接口：

```text
generate_fire_dataset(
  scene,
  semantic_graph,
  scenarios,
  robot_paths,
  cameras,
  output_dir,
)
```

处理链：

```text
room semantic graph
  → ignition selector
  → propagation planner
  → scenario.yaml
  → FieryGS existing initialization
  → FieryGS solver
  → native renderer
  → robot camera trajectory
  → RGB / depth / semantic / fire mask / smoke mask
  → metadata and quality report
```

每个样本至少保存：

```text
rgb/frame_XXXX.png
depth/frame_XXXX.npy
semantic/frame_XXXX.png
fire_mask/frame_XXXX.png
smoke_mask/frame_XXXX.png
metadata/frame_XXXX.json
scenario.yaml
robot_path.yaml
camera.json
```

metadata 应包含 scenario seed、frame、camera pose、intrinsics、scene transform、source Gaussian model、ignition objects、propagation candidates、depth units 和有效像素比例。

## 8. 机器人系统衔接

当前机器人项目已经有 GS Viewer、Go2 overlay 和第一视角相机。未来衔接不应让机器人 UI 直接驱动 FieryGS solver，而应使用离线/批量数据接口：

```text
scenario.yaml
robot_path.yaml
camera_rig.yaml
        ↓
dataset generator
        ↓
RGB / Depth / Semantic / Fire / Smoke
```

第一视角 camera rig 应复用机器人挂点定义：

- 机身局部位置；
- 机身局部旋转；
- FOV；
- near/far；
- PlayCanvas/FieryGS 坐标变换。

这样离线训练相机和前端第一视角相机可以共用同一套外参。

## 9. Required Future Modules

建议新增但暂不实现：

1. `build_semantic_graph.py`：从 catalog、parts、Gaussian 坐标和 voxel 数据建立节点与边。
2. `validate_semantic_graph.py`：检查 bbox、距离、接触和材料冲突。
3. `select_ignition_objects.py`：可解释候选评分和多样性采样。
4. `plan_fire_propagation.py`：根据图关系输出传播候选和阻断集合。
5. `generate_room_scenarios.py`：生成 scenario.yaml 和 manifest。
6. `validate_room_scenarios.py`：schema、可燃性、对象存在性和 solver 兼容性校验。
7. `generate_robot_camera_trajectories.py`：机器人路径与相机轨迹采样。
8. `generate_multimodal_dataset.py`：统一生成 RGB、Depth、Semantic、Fire、Smoke 和 metadata。

## 10. Implementation Order

1. 先落地 semantic graph 的 bbox 派生关系，并输出方法与置信度。
2. 用已确认 514 个对象建立 graph validation report。
3. 实现 ignition selector，只生成候选清单，不运行 solver。
4. 实现 propagation planner，只生成 allowed/blocked IDs。
5. 生成 scenario manifest，并用现有 `common.py` 做静态兼容验证。
6. 选择少量短场景做 smoke test，再决定是否批量运行。
7. 接入 robot path 和 camera rig。
8. 最后扩展多模态数据生成与训练集质量报告。

## 11. Risks

- bbox 推导的接触关系可能误报，必须保留置信度并用 voxel/Gaussian 精确验证。
- 514 个对象中有大量对象需要 fallback，材料质量不应被视为同等可靠。
- Gaussian 的视觉表面和火灾 voxel 几何可能存在配准误差。
- 传播候选只是 solver 的初始允许集合，不等于物理上一定发生二次点火。
- 训练数据若只覆盖 table/sofa/curtain，会产生严重场景偏差。
- fire、smoke、depth 和 semantic 的坐标、分辨率、时间戳必须统一。
- 机器人路径与相机轨迹需要避免只采样静态正面视角。
- 生成数量越大，必须保留 seed、版本、输入清单和失败报告，保证可复现。

## 12. Final Answers

1. **可复用代码**：scenario schema/common、fire level presets、candidate filter、ignition generation、surface ignition、propagation report、solver runner、render validation 和 stage analysis。
2. **semantic_bridge_all 是否足够**：PARTIAL。对象、材料、可燃性和 bbox 足够建立第一版图，但没有现成完整空间关系表。
3. **缺少关键数据**：持久化对象空间关系、精确接触/重叠、暴露表面、可靠的对象到 voxel 映射质量、统一相机和坐标元数据。
4. **需要新增模块**：semantic graph builder/validator、ignition selector、propagation planner、room scenario generator、scenario validator、robot trajectory generator、multimodal dataset generator。
5. **下一阶段最小实现**：先从 bbox center/min/max 建立 graph，输出 distance/adjacency/vertical relation，再生成可被现有 schema 接受的多对象 scenario manifest，不运行长模拟。
6. **预计场景数量**：514 个对象中实际可燃对象约 237 个。若按单对象、3 个 severity、若干 seed 生成，理论上可达数百至数千个场景；实际可用数量取决于空间关系、材料置信度、火灾可见性和质量筛选，不能仅按组合数承诺。
7. **连接机器人视觉训练**：scenario.yaml + robot_path.yaml + camera rig 作为统一输入，经 FieryGS 生成 RGB/Depth/Semantic/Fire/Smoke，并以包含位姿、内参、时间戳、坐标变换和生成版本的 metadata 输出训练样本。

## 13. 本轮结论

当前项目已经具备材料感知火灾场景生成的关键输入和若干可复用原型，但距离 room-scale 自动场景生成还缺少对象空间图、自动起火选择、传播规划和统一数据集接口。本轮只完成审计和设计，不应把现有 table/sofa/curtain 批量脚本称为 v2 generator。
