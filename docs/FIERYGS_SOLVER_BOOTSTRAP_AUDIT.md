# FieryGS Solver Bootstrap Audit

审计范围：项目内 FireSolver 启动入口、Taichi 初始化时机、类装饰/继承关系，以及自动 dry-run 路径。仅做静态检查；本轮未修改 solver、renderer 或启动代码，也未运行长时模拟。

## A. 已知启动路径

### 原生 FireSolver 路径

`FieryGS/simulation/fire_main.py` 是原生入口模块。模块导入 `taichi as ti` 后在模块级执行一次 `ti.init(arch=ti.gpu)`，随后定义 `@ti.data_oriented class FireSolver`。文件底部的 `main(args)` 直接实例化 `FireSolver`，设置最大迭代次数、开启 wood simulation，然后调用 `run()`。

### 手工 fire-scenario 编排路径

`FieryGS/adapter/fire_scenario/run_office_table_fire.ps1` 使用固定环境 `D:\anaconda\envs\fire_gaussian_win\python.exe`，将工作目录切换到 `FieryGS`，按以下顺序调用 Python module：

```text
filter_flammable_objects
→ generate_ignition
→ material_voxel_builder
→ fuel_initializer
→ validate_initialization
```

solver 阶段由 `adapter.fire_scenario.run_scenario_solver` 负责。该模块导入 `simulation.fire_main.FireSolver`，定义 adapter 层的 `ScenarioFireSolver(FireSolver)`，实例化后调用 `run()`。其用途是导出当前 Taichi buffer 和支持精确 ignition mask；solver 数值逻辑仍来自 `FireSolver`。

`run_long_scenario_solver.py` 进一步继承 `ScenarioFireSolver`，用于长时审计输出。`tools/launch_office_01_fire_viewer.ps1` 是 viewer/渲染入口，直接启动 `tools/fire_viewer.py`，不是 solver bootstrap 的替代入口。

### Python 环境

已有 PowerShell 入口明确固定 `fire_gaussian_win` conda Python，并从 `FieryGS` 目录运行 `-m adapter...`。这是目前可复现历史链路的环境和 import 根目录组合。

## B. 当前失败路径

自动 dry runner `FieryGS/adapter/fire_scenario/scenario_dry_runner/real_dry_runner.py` 为每个场景启动独立子进程，依次运行初始化模块，最后执行：

```text
python -m adapter.fire_scenario.run_scenario_solver --config-file ... --frames 30
```

它使用了同一 `fire_gaussian_win` Python 和 `FieryGS` 工作目录，因此没有发现 `ti.init` 被 runner 重复调用的证据。已记录的失败发生在 solver 首次初始化 wood 时：

```text
ScenarioFireSolver.init_wood()
→ FireSolver.init_wood()
→ Taichi kernel wrapper
AssertionError: assert not hasattr(clsobj, "_data_oriented")
```

失败发生在进入物理时间步之前；因此这不是数组 finite、场景 YAML 结构或 renderer 输出问题。

## C. 差异与根因定位

| 项目 | 原生/历史路径 | 当前自动 dry-run | 判断 |
|---|---|---|---|
| Taichi 初始化 | `fire_main` 导入时一次 `ti.init(arch=ti.gpu)` | 同样由子进程导入 `fire_main` 初始化 | 未见重复初始化证据 |
| FireSolver 加载 | `simulation.fire_main.FireSolver` | 同一模块，但实例类型为 `ScenarioFireSolver` | 关键差异 |
| data-oriented 装饰 | `FireSolver` 被 `@ti.data_oriented` 装饰一次 | 子类继承已装饰类，并调用继承的 Taichi kernel 方法 | 触发断言的最可能原因 |
| runner import | 从 `simulation.fire_main` 导入 | `run_scenario_solver` 先导入同一类，再定义子类 | 与 traceback 一致 |
| Python/工作目录 | 固定 conda 环境、`FieryGS` 根目录 | 当前 runner 使用相同环境和 module 根目录 | 非首要差异 |
| solver 核心 | 直接调用原生类 | adapter 子类只重载 `init_wood`/`save_npz` | 失败发生于子类调用 super 的 Taichi 方法 |

`FireSolver` 本身已经带有 `_data_oriented` 标记。Taichi 的 kernel 包装器在 `ScenarioFireSolver` 实例上解析继承方法时再次检查 class 标记，最终命中 `assert not hasattr(clsobj, "_data_oriented")`。因此当前可定位到的第二次触发对象是 `ScenarioFireSolver`（长时入口还会把同样风险传递给 `AuditedLongFireSolver`），而不是 `FireSolver` 的第二次模块导入或 `ti.init` 调用。

## D. 最小修复方案

1. 保留 `fire_main.py` 的模块级 Taichi 初始化和 `FireSolver` 核心实现，不在 runner 中添加第二次 `ti.init()`。
2. 在 adapter 层避免让带 Taichi kernel 的 `FireSolver` 通过 data-oriented 子类重载路径运行。最小安全方向是直接实例化原生 `FireSolver`，把 NPZ/指标导出放在 solver 运行后的外部适配器中；或者提供不继承 `FireSolver` 的组合式导出包装器。
3. 继续使用历史启动组合：`D:\anaconda\envs\fire_gaussian_win\python.exe`、工作目录 `FieryGS`、`python -m adapter.fire_scenario...`。
4. 修复后先用单个 30-frame 场景验证 import、Taichi 初始化和首个 `init_wood`，再恢复批量 dry run。不得通过修改 solver 核心或重复装饰类来绕过断言。

本审计未修改任何代码，未启动 solver 长模拟，也未生成新的火焰结果。
