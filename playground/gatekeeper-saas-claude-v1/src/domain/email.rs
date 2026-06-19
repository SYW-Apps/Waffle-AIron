//! Validated email address newtype. Shared system-wide; used for billing and
//! contact emails. Serializes transparently as its string form and validates on
//! deserialization / construction.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Email(String);

impl Email {
    /// Construct a validated `Email`, rejecting addresses that are not minimally
    /// RFC5322-shaped (`local@domain` with a dotted domain).
    pub fn parse(value: impl Into<String>) -> Result<Self, InvalidEmail> {
        let value = value.into();
        if is_valid(&value) {
            Ok(Self(value))
        } else {
            Err(InvalidEmail(value))
        }
    }

    /// Borrow the underlying address string.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Error returned when an email address fails validation.
#[derive(Debug, Clone, thiserror::Error)]
#[error("invalid email address: {0}")]
pub struct InvalidEmail(pub String);

fn is_valid(value: &str) -> bool {
    let mut parts = value.split('@');
    let (local, domain) = match (parts.next(), parts.next(), parts.next()) {
        (Some(local), Some(domain), None) => (local, domain),
        _ => return false,
    };
    !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
}

impl TryFrom<String> for Email {
    type Error = InvalidEmail;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Email::parse(value)
    }
}

impl From<Email> for String {
    fn from(email: Email) -> Self {
        email.0
    }
}

impl std::fmt::Display for Email {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_well_formed_address() {
        assert!(Email::parse("billing@example.com").is_ok());
    }

    #[test]
    fn rejects_missing_at_or_domain_dot() {
        assert!(Email::parse("nope").is_err());
        assert!(Email::parse("a@localhost").is_err());
        assert!(Email::parse("@example.com").is_err());
        assert!(Email::parse("a@b@c.com").is_err());
    }
}
