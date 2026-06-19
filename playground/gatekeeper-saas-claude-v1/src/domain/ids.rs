//! Opaque newtype identifiers, shared system-wide. Each wraps a single opaque
//! `String` value and is serialized transparently as that string.

use serde::{Deserialize, Serialize};

macro_rules! id_newtype {
    ($name:ident, $doc:literal) => {
        #[doc = $doc]
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            /// Wrap an opaque id value.
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            /// Borrow the underlying id string.
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }
    };
}

id_newtype!(CustomerId, "Newtype identifier for a Customer.");
id_newtype!(BillingAccountId, "Newtype identifier for a BillingAccount.");
id_newtype!(ContactId, "Newtype identifier for a Contact.");
id_newtype!(ApiKeyId, "Newtype identifier for an API key credential.");
id_newtype!(PlanId, "Newtype identifier for a Plan.");
id_newtype!(TierId, "Newtype identifier for a plan Tier.");
id_newtype!(SubscriptionId, "Newtype identifier for a Subscription.");
