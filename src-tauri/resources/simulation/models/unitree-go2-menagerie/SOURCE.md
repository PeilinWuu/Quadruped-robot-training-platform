# Unitree Go2 model source

- Repository: https://github.com/google-deepmind/mujoco_menagerie.git
- Commit: 71f066ad0be9cd271f7ed58c030243ef157af9f4
- Upstream directory: unitree_go2/
- Retrieved: 2026-08-03T09:55:54.992Z
- License: BSD-3-Clause (see upstream/LICENSE)

The files under upstream/ are copied byte-for-byte from the fixed upstream commit. Only go2.xml and its 16 referenced OBJ meshes are included, together with README.md, CHANGELOG.md, and LICENSE. Preview PNG and MJX files are intentionally excluded.

unitree-go2-scene.xml is project-owned. It includes the unmodified upstream/go2.xml, resolves the official meshes from upstream/assets, and adds only a floor, light, and headlight. The upstream home keyframe is reused without modification.
