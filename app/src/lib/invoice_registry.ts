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
    }
  ]
};
