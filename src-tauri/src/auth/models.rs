use scrypt::{
    password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier},
    Params, Scrypt,
};
use serde::{Deserialize, Serialize};
use std::{error::Error, fmt};

const SCRYPT_LOG_N: u8 = 14;
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;
const SCRYPT_OUTPUT_LEN: usize = 64;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AuthError {
    pub code: &'static str,
    pub message: &'static str,
}

impl AuthError {
    pub fn invalid_input(message: &'static str) -> Self {
        Self {
            code: "INVALID_INPUT",
            message,
        }
    }

    pub fn user_exists() -> Self {
        Self {
            code: "USER_ALREADY_EXISTS",
            message: "用户名或邮箱已被注册",
        }
    }

    pub fn invalid_credentials() -> Self {
        Self {
            code: "INVALID_CREDENTIALS",
            message: "账号或密码错误",
        }
    }

    pub fn not_authenticated() -> Self {
        Self {
            code: "NOT_AUTHENTICATED",
            message: "未登录",
        }
    }

    pub fn database_unavailable() -> Self {
        Self {
            code: "DATABASE_UNAVAILABLE",
            message: "本地认证数据库暂时不可用",
        }
    }

    pub fn internal() -> Self {
        Self {
            code: "INTERNAL_ERROR",
            message: "桌面认证处理失败",
        }
    }
}

impl fmt::Display for AuthError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl Error for AuthError {}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginInput {
    pub account: String,
    pub password: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterInput {
    pub username: String,
    pub email: String,
    pub display_name: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: i64,
    pub username: String,
    pub email: String,
    pub display_name: String,
    pub role: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AuthResponse {
    pub user: AuthUser,
}

#[derive(Debug, Clone)]
pub struct CleanRegisterInput {
    pub username: String,
    pub email: String,
    pub display_name: String,
    pub password: String,
}

pub fn clean_register_input(input: RegisterInput) -> Result<CleanRegisterInput, AuthError> {
    let username = input.username.trim().to_owned();
    let email = input.email.trim().to_lowercase();
    let display_name = input.display_name.trim().to_owned();

    if !(3..=24).contains(&username.len())
        || !username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err(AuthError::invalid_input(
            "用户名需为 3–24 位字母、数字或下划线",
        ));
    }
    if !valid_email(&email) {
        return Err(AuthError::invalid_input("请输入有效的邮箱地址"));
    }
    if !(2..=32).contains(&display_name.encode_utf16().count()) {
        return Err(AuthError::invalid_input("姓名需为 2–32 个字符"));
    }
    validate_password(&input.password)?;

    Ok(CleanRegisterInput {
        username,
        email,
        display_name,
        password: input.password,
    })
}

fn valid_email(email: &str) -> bool {
    if email.encode_utf16().count() > 254 || email.chars().any(char::is_whitespace) {
        return false;
    }
    let mut parts = email.split('@');
    let Some(local) = parts.next() else {
        return false;
    };
    let Some(domain) = parts.next() else {
        return false;
    };
    if parts.next().is_some() || local.is_empty() {
        return false;
    }
    let Some((domain_name, suffix)) = domain.rsplit_once('.') else {
        return false;
    };
    !domain_name.is_empty() && !suffix.is_empty()
}

pub fn validate_password(password: &str) -> Result<(), AuthError> {
    let length = password.encode_utf16().count();
    if length < 8 {
        return Err(AuthError::invalid_input("密码至少需要 8 个字符"));
    }
    if length > 128 {
        return Err(AuthError::invalid_input("密码不能超过 128 个字符"));
    }
    if !password.bytes().any(|byte| byte.is_ascii_alphabetic())
        || !password.bytes().any(|byte| byte.is_ascii_digit())
    {
        return Err(AuthError::invalid_input("密码必须同时包含字母和数字"));
    }
    Ok(())
}

fn scrypt_hasher() -> Result<Scrypt, AuthError> {
    Params::new_with_output_len(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, SCRYPT_OUTPUT_LEN)
        .map(Scrypt::new_with_params)
        .map_err(|_| AuthError::internal())
}

pub fn hash_password(password: &str) -> Result<String, AuthError> {
    scrypt_hasher()?
        .hash_password(password.as_bytes())
        .map(|hash| hash.to_string())
        .map_err(|_| AuthError::internal())
}

pub fn verify_password(password: &str, encoded: &str) -> bool {
    let Ok(hash) = PasswordHash::new(encoded) else {
        return false;
    };
    let Ok(hasher) = scrypt_hasher() else {
        return false;
    };
    hasher.verify_password(password.as_bytes(), &hash).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_policy_matches_the_web_service() {
        assert!(validate_password("short1").is_err());
        assert!(validate_password("onlyletters").is_err());
        assert!(validate_password(&format!("A1{}", "x".repeat(127))).is_err());
        assert!(validate_password("ValidFire2026").is_ok());
    }

    #[test]
    fn password_hash_is_phc_scrypt_and_verifies_in_constant_time_api() {
        let password = "FireRobot2026";
        let hash = hash_password(password).expect("hash password");
        assert_ne!(hash, password);
        assert!(hash.starts_with("$scrypt$ln=14,r=8,p=1$"));
        assert!(verify_password(password, &hash));
        assert!(!verify_password("WrongPassword1", &hash));
    }

    #[test]
    fn registration_normalizes_fields_and_rejects_invalid_input() {
        let clean = clean_register_input(RegisterInput {
            username: " operator_01 ".into(),
            email: " Operator@Example.COM ".into(),
            display_name: " 操作员一号 ".into(),
            password: "FireRobot2026".into(),
        })
        .expect("valid input");
        assert_eq!(clean.username, "operator_01");
        assert_eq!(clean.email, "operator@example.com");
        assert_eq!(clean.display_name, "操作员一号");

        assert!(clean_register_input(RegisterInput {
            username: "bad-name".into(),
            email: "operator@example.com".into(),
            display_name: "操作员".into(),
            password: "FireRobot2026".into(),
        })
        .is_err());
    }
}
