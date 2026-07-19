# 构建与运行

[返回入口](00_START_HERE.md) · [调试指南](08_DEBUGGING_GUIDE.md)

## 当前环境

- 有效工作区：`C:\Users\Administrator\Documents\quadruped_robot_research`
- GS 源码：`C:\Users\Administrator\Documents\quadruped_robot_research\vk_gaussian_splatting`
- 当前 Vulkan SDK：`C:\VulkanSDK\1.4.341.1`（环境变量 `VULKAN_SDK`）
- CMake 生成器：`Visual Studio 17 2022`
- Slang 版本：`2025.13.1`
- Slang_ROOT：`C:/Users/Administrator/Documents/quadruped_robot_research/vk_gaussian_splatting/build/_deps/Slang-windows-x86_64-2025.13.1`

## 前置检查（CMD）

```cmd
echo %VULKAN_SDK%
dir "%VULKAN_SDK%\Include\vulkan\vulkan.h"
dir "%VULKAN_SDK%\Lib\vulkan-1.lib"
dir "%VULKAN_SDK%\Bin\glslangValidator.exe"
dir "C:\Users\Administrator\Documents\quadruped_robot_research\vk_gaussian_splatting\build\_deps\Slang-windows-x86_64-2025.13.1\bin\slangc.exe"
dir "C:\Users\Administrator\Documents\quadruped_robot_research\vk_gaussian_splatting\build\_deps\Slang-windows-x86_64-2025.13.1\include\slang.h"
```

## 两个构建目录

- `build/` 是工作区迁移前生成的旧目录，内部可能保存失效的绝对路径。不要用它做当前增量构建，也不要删除它，因为其中保存可复用的 Slang SDK 和阶段 1A 记录。
- `build_phase1b/` 是当前工作区的有效构建目录。其 `CMakeCache.txt` 的 `CMAKE_HOME_DIRECTORY` 应指向当前 `vk_gaussian_splatting`。

检查 Cache：

```cmd
findstr /B "CMAKE_HOME_DIRECTORY:INTERNAL= Slang_ROOT: Vulkan_ROOT: CMAKE_GENERATOR:INTERNAL=" "C:\Users\Administrator\Documents\quadruped_robot_research\vk_gaussian_splatting\build_phase1b\CMakeCache.txt"
```

## 配置（CMD 单行）

仅在 `build_phase1b` 不存在，或明确需要重新生成工程文件时运行：

```cmd
cmake -S "C:\Users\Administrator\Documents\quadruped_robot_research\vk_gaussian_splatting" -B "C:\Users\Administrator\Documents\quadruped_robot_research\vk_gaussian_splatting\build_phase1b" -G "Visual Studio 17 2022" -A x64 -DVulkan_ROOT="%VULKAN_SDK%" -DCMAKE_PREFIX_PATH="%VULKAN_SDK%" -DSlang_ROOT="C:/Users/Administrator/Documents/quadruped_robot_research/vk_gaussian_splatting/build/_deps/Slang-windows-x86_64-2025.13.1"
```

如果输出显示准备下载 Slang，立即停止并检查 `Slang_ROOT`；不要联网替换既有 SDK。

## Release 构建（CMD 单行）

```cmd
cmake --build "C:\Users\Administrator\Documents\quadruped_robot_research\vk_gaussian_splatting\build_phase1b" --config Release --parallel
```

Visual Studio 是多配置生成器，因此不要依赖 `-DCMAKE_BUILD_TYPE=Release`。

## 运行 flowers_1.ply

- EXE：`vk_gaussian_splatting\_bin\Release\vk_gaussian_splatting.exe`
- 场景：`vk_gaussian_splatting\flowers_1.ply`

```cmd
"C:\Users\Administrator\Documents\quadruped_robot_research\vk_gaussian_splatting\_bin\Release\vk_gaussian_splatting.exe" --inputFile "C:\Users\Administrator\Documents\quadruped_robot_research\vk_gaussian_splatting\flowers_1.ply"
```

场景文件被 `.gitignore` 忽略，是本地测试资产；Git 中不存在不等于本地文件应被删除。

## 确认产物最新

```cmd
dir /T:W "C:\Users\Administrator\Documents\quadruped_robot_research\vk_gaussian_splatting\_bin\Release\vk_gaussian_splatting.exe"
git status --short
```

确认构建日志最后指向上述 EXE，并比较 EXE 时间与刚修改源码的时间。新增 `src/*` 文件后，因 `CMakeLists.txt` 使用 `file(GLOB SOURCE_FILES src/*.*)`，通常需要重新运行 CMake 配置，让 Visual Studio 工程包含新文件。

## 常见错误

| 错误 | 首查 | 处理 |
|---|---|---|
| 找不到 Vulkan | `%VULKAN_SDK%` 与三个前置文件 | 修正环境变量后重新开 CMD；不要复制散落 DLL 冒充 SDK |
| CMake 要下载 Slang | `-DSlang_ROOT` 拼写和目录内容 | 停止配置，指向现有 2025.13.1 SDK |
| 工程仍引用其他路径 | `build_phase1b/CMakeCache.txt` | 不要删除旧 `build`；先确认当前 `build_phase1b` 来源再处理 |
| 链接后找不到 EXE | 构建是否为 `--config Release` | 检查 `_bin/Release` 和最后一条链接日志 |
| 启动缺 DLL | `_bin/Release/slang*.dll`、`shaderc_shared.dll` | 重新构建触发 CMake 的 runtime copy；不要手工下载未知版本 |
| MSB8065 Slang `.spv` 警告 | 最终链接是否成功 | 当前已知为 VRDX 增量构建警告；若 EXE 成功生成先记录，不要清缓存 |

## 禁止删除

- `vk_gaussian_splatting/build/_deps/`
- `vk_gaussian_splatting/build/`
- `vk_gaussian_splatting/build_phase1b/`
- `vk_gaussian_splatting/_bin/`
- `vk_gaussian_splatting/flowers_1.ply`

