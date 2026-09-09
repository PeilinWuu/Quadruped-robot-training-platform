# Ignition Selector v2 设计

## 1. v1 问题分析

v1 当前实现位于 `FieryGS/adapter/fire_scenario/ignition_selector/ignition_selector.py`，公式为：

```text
0.30*material - 0.20*burnability - 0.15*size
-0.15*neighbor -0.10*gaussian -0.10*quality
```

该公式不符合“选择适合作为初始火源的对象”的目标：唯一明显奖励项是材料，burnability、规模、Gaussian 覆盖、邻居和质量全部被扣分。结果是小对象因 `log1p(gaussian_count)` 较小、邻居较少、质量惩罚较低而获得较高分。当前报告中 instance 474（cup/fabric）排名第一，正是这一数学偏差的直接结果。

此外，v1 的 `neighbor_factor` 混合了邻近、adjacency 和 contact，且归一化基于候选集合，导致分数受场景中极端节点影响；v1 还只用 `quality_status` 二值化，未将低质量映射作为硬风险处理。

## 2. v2 目标

v2 选择的是：可燃、可见、具有足够空间尺度、能够产生稳定视觉火焰并具有传播潜力的初始对象。评分项统一为 0–1，全部正向；不满足物理或数据质量底线的对象先过滤，不靠负分补偿。

## 3. v2 评分公式

```text
score = 0.25 * material_suitability
      + 0.20 * burnability_confidence
      + 0.20 * object_scale
      + 0.15 * gaussian_coverage
      + 0.10 * propagation_potential
      + 0.05 * spatial_exposure
      + 0.05 * semantic_quality
```

建议保留原始 factor 和加权项，便于审计、重排和复现。若训练目标偏重传播，可将 propagation 提升至 0.15，并从 object_scale 减少 0.05。

## 4. Factor 定义

### material_suitability

材料燃烧先验，不再只分高/低：

- wood、fabric、foam、paper：1.0；
- plastic、leather、plant、food：0.75；
- composite 或未知但 burnable：0.45；
- metal、glass、stone、concrete 等：进入硬过滤。

### burnability_confidence

由 burnability 和 confidence 联合计算：

- burnable + high：1.0；
- burnable + medium：0.8；
- burnable + low/缺失：0.5；
- unknown：进入过滤或单独低可信集合。

### object_scale

使用 bbox 体积和高度的饱和归一化，而不是仅按 Gaussian 数量：

```text
volume_score = clip(log1p(volume) / log1p(P95(volume)), 0, 1)
height_score = clip(height / P95(height), 0, 1)
object_scale = 0.7*volume_score + 0.3*height_score
```

这会抑制 cup 等小物体，同时避免最大家具完全垄断。

### gaussian_coverage

Gaussian 数量是可见性和渲染稳定性的代理，但不是物体大小本身：

```text
gaussian_coverage = clip(log1p(gaussian_count) / log1p(P95(gaussian_count)), 0, 1)
```

低于最小数量阈值的对象应过滤或标记为 fallback，不应靠低分留在主候选池。

### propagation_potential

根据 0.5 m 内可燃邻居、adjacency、contact 计算：

```text
neighbor_presence = min(nearby_burnable_count / 3, 1)
adjacency_presence = min(nearby_burnable_adjacency_count / 2, 1)
contact_presence = 1 if burnable_contact_exists else 0
propagation_potential = 0.5*neighbor_presence + 0.3*adjacency_presence + 0.2*contact_presence
```

它奖励有传播价值的对象，但不让邻居数量压过材料和规模。

### spatial_exposure

第一版可由 bbox 暴露代理：

- 与不可燃结构重叠较少；
- 与其他对象的 bbox overlap 较少；
- 有至少一个自由方向。

没有可靠表面法线前，必须标记为 `derived_bbox`，不能声称是真实暴露面积。

### semantic_quality

建议分层：

- reliable + material complete：1.0；
- reliable 但材料需 fallback：0.75；
- fallback 或 review：0.5；
- 无 bbox/无 Gaussian 映射：过滤。

## 5. 过滤规则

以下条件应在评分前直接过滤：

- `burnability != burnable`；
- category 包含 wall、floor、ceiling、window、door、light、lamp；
- material 属于 metal、glass、stone、concrete、cement、ceramic、soil、sand；
- bbox 缺失、体积为 0、尺寸非有限；
- Gaussian 数量低于最小阈值（建议 100，需由数据分布校准）；
- semantic mapping 缺失或无法定位到 Gaussian。

以下情况不必过滤，但应降级并标记：

- confidence 低；
- fallback 材料；
- 体积较小；
- 没有可燃邻居；
- spatial exposure 只能由 bbox 推导。

建议输出 `eligible_main` 与 `eligible_low_confidence` 两个集合，避免低质量对象污染主训练候选。

## 6. 预期 Top 候选类型

合理的 Top 候选应优先出现：

1. sofa、curtain、carpet、wooden furniture、large fabric objects；
2. 具有可靠材料判定和较高 Gaussian 覆盖的中大型物体；
3. 靠近其他可燃对象、具备传播潜力的家具簇。

cup、plate、bottle、fruit 等小物体即使可燃，也应因规模、覆盖或最小 Gaussian 阈值落入低优先级。若 cup 仍排名第一，应触发异常检查。

## 7. 与 Propagation Planner 的接口

Ignition Selector 只输出初始点火候选，不决定后续物理传播。每个候选应提供：

```json
{
  "instance_id": "113",
  "score": 0.82,
  "score_breakdown": {},
  "propagation_seed": {
    "nearby_burnable_ids": [135, 62],
    "adjacent_ids": [135],
    "contact_ids": [],
    "candidate_radius_m": 0.5
  }
}
```

Propagation Planner 接收候选对象及其 graph 边，输出：

- `initial_ignition_object_ids`；
- `propagation_candidate_ids`；
- `blocked_object_ids`；
- 每条传播边的距离、关系、材料和置信度。

## 8. 验证与异常规则

v2 设计完成后应静态检查：

- 最高分是否为 cup/plate/bottle 等 tiny object；
- 最高分是否为 unknown/fallback 材料；
- 最高分 Gaussian 数量是否低于 P50；
- Top 20 是否被单一 category 占满；
- score breakdown 是否能解释排序。

当前 v1 报告已经证明异常存在：234 个候选中 instance 474（cup/fabric）最高，且 size_factor 仅 0.0668、quality_factor 为 0.5。这不是数据偶然，而是负向规模项造成的系统性偏差。

## 9. 实施建议

下一步应先人工审查 v2 设计中的 factor 和过滤阈值，再修改 selector 代码。修改后只需重新生成候选和报告，不应在 selector 阶段运行 fire solver 或生成 scenario.yaml。
