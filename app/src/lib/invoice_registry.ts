/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/invoice_registry.json`.
 */
export type InvoiceRegistry = {
  "address": "54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo",
  "metadata": {
    "name": "invoiceRegistry",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "cancelInvoice",
      "discriminator": [
        88,
        158,
        54,
        49,
        53,
        26,
        92,
        68
      ],
      "accounts": [
        {
          "name": "invoice",
          "writable": true
        },
        {
          "name": "creator",
          "signer": true,
          "relations": [
            "invoice"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "cancelPaymentIntent",
      "docs": [
        "Release a `PaymentIntentLock` after a failed payment attempt. Refunds",
        "the lock's rent to the original payer. Only the payer can call this —",
        "they're the one who paid the rent and they're the only party who knows",
        "whether their second/third tx in the batch actually landed.",
        "",
        "Used when the shielded-pay batched flow has the lock tx confirm but",
        "the subsequent createBuffer or deposit tx fail. Without this, the",
        "invoice would be permanently locked and the payer would lose the rent.",
        "",
        "Status check: only releasable while the invoice is still Pending.",
        "Once the invoice is marked Paid (mark_paid succeeded), cancellation",
        "is forbidden — by then the lock represents a real settlement and",
        "removing it would let an attacker pay the invoice twice."
      ],
      "discriminator": [
        179,
        158,
        125,
        231,
        73,
        7,
        32,
        95
      ],
      "accounts": [
        {
          "name": "invoice",
          "relations": [
            "lock"
          ]
        },
        {
          "name": "lock",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  116,
                  101,
                  110,
                  116,
                  95,
                  108,
                  111,
                  99,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "invoice"
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true,
          "relations": [
            "lock"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "createInvoice",
      "discriminator": [
        154,
        170,
        31,
        135,
        134,
        100,
        156,
        146
      ],
      "accounts": [
        {
          "name": "invoice",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  118,
                  111,
                  105,
                  99,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "creator"
              },
              {
                "kind": "arg",
                "path": "nonce"
              }
            ]
          }
        },
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "nonce",
          "type": {
            "array": [
              "u8",
              8
            ]
          }
        },
        {
          "name": "metadataHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "metadataUri",
          "type": "string"
        },
        {
          "name": "mint",
          "type": "pubkey"
        },
        {
          "name": "expiresAt",
          "type": {
            "option": "i64"
          }
        }
      ]
    },
    {
      "name": "createInvoiceRestricted",
      "discriminator": [
        137,
        203,
        155,
        244,
        127,
        40,
        184,
        27
      ],
      "accounts": [
        {
          "name": "invoice",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  118,
                  111,
                  105,
                  99,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "creator"
              },
              {
                "kind": "arg",
                "path": "nonce"
              }
            ]
          }
        },
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "nonce",
          "type": {
            "array": [
              "u8",
              8
            ]
          }
        },
        {
          "name": "metadataHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "metadataUri",
          "type": "string"
        },
        {
          "name": "mint",
          "type": "pubkey"
        },
        {
          "name": "expiresAt",
          "type": {
            "option": "i64"
          }
        },
        {
          "name": "payer",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "lockPaymentIntent",
      "docs": [
        "Acquires a single-use payment-intent lock for `invoice`. The lock is a",
        "PDA seeded by `invoice.key()` so its `init` constraint enforces",
        "one-shot semantics: a second attempt to lock the same invoice fails",
        "with `Allocate: account ... already in use` and the entire enclosing",
        "transaction (including any subsequent funds-movement CPIs) reverts.",
        "",
        "VeilPay's `pay_invoice` calls this BEFORE the Umbra deposit CPIs so",
        "the lock acquisition is atomic with the funds movement — closing the",
        "\"pay twice before mark_paid lands\" race that the prior architecture",
        "permitted.",
        "",
        "When `invoice.payer` is `Some(restricted)`, only that payer may",
        "acquire the lock — surfacing the previously-defined-but-unused",
        "`NotPayer` error code as a real on-chain check."
      ],
      "discriminator": [
        96,
        172,
        233,
        81,
        188,
        200,
        139,
        94
      ],
      "accounts": [
        {
          "name": "invoice"
        },
        {
          "name": "lock",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  116,
                  101,
                  110,
                  116,
                  95,
                  108,
                  111,
                  99,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "invoice"
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "markPaid",
      "discriminator": [
        51,
        120,
        9,
        160,
        70,
        29,
        18,
        205
      ],
      "accounts": [
        {
          "name": "invoice",
          "writable": true
        },
        {
          "name": "creator",
          "signer": true,
          "relations": [
            "invoice"
          ]
        }
      ],
      "args": [
        {
          "name": "utxoCommitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "invoice",
      "discriminator": [
        51,
        194,
        250,
        114,
        6,
        104,
        18,
        164
      ]
    },
    {
      "name": "paymentIntentLock",
      "discriminator": [
        191,
        42,
        144,
        103,
        55,
        2,
        67,
        222
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "uriTooLong",
      "msg": "Metadata URI exceeds maximum length"
    },
    {
      "code": 6001,
      "name": "invalidStatus",
      "msg": "Invoice is not in a state that allows this operation"
    },
    {
      "code": 6002,
      "name": "notCreator",
      "msg": "Only the creator can perform this action"
    },
    {
      "code": 6003,
      "name": "notPayer",
      "msg": "Only the designated payer can perform this action"
    }
  ],
  "types": [
    {
      "name": "invoice",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "payer",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "metadataHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "metadataUri",
            "type": "string"
          },
          {
            "name": "utxoCommitment",
            "type": {
              "option": {
                "array": [
                  "u8",
                  32
                ]
              }
            }
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "invoiceStatus"
              }
            }
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "paidAt",
            "type": {
              "option": "i64"
            }
          },
          {
            "name": "expiresAt",
            "type": {
              "option": "i64"
            }
          },
          {
            "name": "nonce",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "invoiceStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "pending"
          },
          {
            "name": "paid"
          },
          {
            "name": "cancelled"
          },
          {
            "name": "expired"
          }
        ]
      }
    },
    {
      "name": "paymentIntentLock",
      "docs": [
        "Single-use lock PDA proving \"this invoice has had a payment attempt\".",
        "Seeded by `invoice.key()` under the invoice-registry program. The `init`",
        "constraint on its derive struct gives free idempotency — re-init fails",
        "with the system-program \"account already in use\" error, which Anchor",
        "surfaces as a tx-level revert that rolls back any sibling CPIs in the",
        "same transaction.",
        "",
        "Why a separate account instead of a flag on `Invoice`? Two reasons:",
        "1. Adding a field to `Invoice` would break deserialization of every",
        "existing devnet invoice (constraint from the rollout).",
        "2. The `init` rejection is the safety guarantee. Mutating a flag in",
        "the same tx that performs the deposit CPIs would still race with",
        "a second tx that reads the flag, sees Pending, and proceeds —",
        "because flag-write and deposit-CPI live in the same tx but",
        "flag-check happens at tx-build time off-chain."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "invoice",
            "type": "pubkey"
          },
          {
            "name": "payer",
            "type": "pubkey"
          },
          {
            "name": "lockedAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ]
};
