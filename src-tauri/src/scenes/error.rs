use serde::Serialize;
use std::{error::Error, fmt, io};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SceneError {
    pub code: &'static str,
    pub message: &'static str,
}

impl SceneError {
    pub const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }

    pub const fn invalid_input() -> Self {
        Self::new("INVALID_INPUT", "场景请求无效")
    }

    pub const fn file_not_found() -> Self {
        Self::new("FILE_NOT_FOUND", "所选文件不可用")
    }

    pub const fn invalid_file_type() -> Self {
        Self::new("INVALID_FILE_TYPE", "请选择单个 SOG 文件")
    }

    pub const fn empty_file() -> Self {
        Self::new("EMPTY_FILE", "SOG 文件为空")
    }

    pub const fn file_too_large() -> Self {
        Self::new("FILE_TOO_LARGE", "SOG 文件超过 50 MiB 限制")
    }

    pub const fn invalid_sog() -> Self {
        Self::new("INVALID_SOG", "SOG 文件已损坏或结构无效")
    }

    pub const fn unsupported_sog() -> Self {
        Self::new("UNSUPPORTED_SOG", "当前版本不支持此 SOG 变体")
    }

    pub const fn import_cancelled() -> Self {
        Self::new("IMPORT_CANCELLED", "场景导入已取消")
    }

    pub const fn disk_full() -> Self {
        Self::new("DISK_FULL", "应用数据目录可用空间不足")
    }

    pub const fn scene_not_found() -> Self {
        Self::new("SCENE_NOT_FOUND", "场景不存在")
    }

    pub const fn scene_busy() -> Self {
        Self::new("SCENE_BUSY", "已有场景导入正在进行")
    }

    pub const fn database_unavailable() -> Self {
        Self::new("DATABASE_UNAVAILABLE", "场景数据库暂时不可用")
    }

    pub const fn internal() -> Self {
        Self::new("INTERNAL_ERROR", "本地场景处理失败")
    }

    pub fn from_write_error(error: &io::Error) -> Self {
        if matches!(error.raw_os_error(), Some(28 | 39 | 112)) {
            Self::disk_full()
        } else {
            Self::internal()
        }
    }
}

impl fmt::Display for SceneError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl Error for SceneError {}
