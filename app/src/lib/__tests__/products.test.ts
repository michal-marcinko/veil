import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addProductToCache,
  buildProductSpec,
  buildProductUrl,
  decodeProductSpec,
  encodeProductSpec,
  extractArweaveTxId,
  fetchProductSpec,
  formatProductAmount,
  parseAmountToBaseUnits,
  PRODUCT_SPEC_VERSION,
  readProductsCache,
  removeProductFromCache,
  uploadProductSpec,
  validateProductSpec,
  writeProductsCache,
  type ProductCacheEntry,
  type ProductSpec,
} from "@/lib/products";

const VALID_PUBKEY_A = "8sLbNZoA1cfnvMJLPfp98ZLAnFhDi2YgrMbjSx5JrBjF";
const VALID_PUBKEY_B = "GZNvMz5oRLU3Pbz1cSj4tjU3eY9pj6jrKZkPTkc5oM6X";
const VALID_MINT = "So11111111111111111111111111111111111111112";

function baseSpec(overrides: Partial<ProductSpec> = {}): ProductSpec {
  return {
    version: PRODUCT_SPEC_VERSION,
    name: "Pro plan",
    description: "Annual subscription",
    amountBaseUnits: "1500000000",
    mint: VALID_MINT,
    decimals: 9,
    symbol: "SOL",
    ownerWallet: VALID_PUBKEY_A,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("validateProductSpec", () => {
  it("accepts a fully-formed spec and returns it normalized", () => {
    const spec = baseSpec({ name: "  Spaces  ", description: "  trim me  " });
    const result = validateProductSpec(spec);
    expect(result.name).toBe("Spaces");
    expect(result.description).toBe("trim me");
    expect(result.version).toBe(PRODUCT_SPEC_VERSION);
  });

  it("rejects unknown / missing version", () => {
    expect(() => validateProductSpec({ ...baseSpec(), version: 2 } as any)).toThrow(
      /Unsupported product spec version/,
    );
    const { version, ...rest } = baseSpec();
    void version;
    expect(() => validateProductSpec(rest)).toThrow(/Unsupported product spec version/);
  });

  it("rejects empty / oversize name", () => {
    expect(() => validateProductSpec(baseSpec({ name: "" }))).toThrow(/required/);
    expect(() => validateProductSpec(baseSpec({ name: "   " }))).toThrow(/required/);
    expect(() => validateProductSpec(baseSpec({ name: "x".repeat(121) }))).toThrow(/120/);
  });

  it("rejects non-positive amounts and non-integer strings", () => {
    expect(() => validateProductSpec(baseSpec({ amountBaseUnits: "0" }))).toThrow(
      /greater than zero/,
    );
    expect(() => validateProductSpec(baseSpec({ amountBaseUnits: "1.5" }))).toThrow(
      /non-negative integer/,
    );
    expect(() => validateProductSpec(baseSpec({ amountBaseUnits: "-1" }))).toThrow(
      /non-negative integer/,
    );
    expect(() =>
      validateProductSpec(baseSpec({ amountBaseUnits: 5 } as any)),
    ).toThrow(/decimal string/);
  });

  it("rejects malformed mint or owner", () => {
    expect(() => validateProductSpec(baseSpec({ mint: "not-a-key" }))).toThrow(/Mint/);
    expect(() => validateProductSpec(baseSpec({ ownerWallet: "abc" }))).toThrow(/Owner/);
  });

  it("rejects javascript: image URL but accepts https://", () => {
    expect(() =>
      validateProductSpec(baseSpec({ imageUrl: "javascript:alert(1)" })),
    ).toThrow(/http/);
    expect(() =>
      validateProductSpec(baseSpec({ imageUrl: "https://example.com/x.png" })),
    ).not.toThrow();
  });

  it("treats empty string description / imageUrl as omitted", () => {
    const result = validateProductSpec(baseSpec({ description: "   ", imageUrl: "  " }));
    expect(result.description).toBeUndefined();
    expect(result.imageUrl).toBeUndefined();
  });
});

describe("buildProductSpec", () => {
  it("stamps createdAt and converts amount", () => {
    const before = Date.now();
    const spec = buildProductSpec({
      name: "Hat",
      amountBaseUnits: 250_000n,
      mint: VALID_MINT,
      decimals: 6,
      symbol: "USDC",
      ownerWallet: VALID_PUBKEY_A,
    });
    const after = Date.now();
    expect(spec.amountBaseUnits).toBe("250000");
    expect(spec.createdAt).toBeGreaterThanOrEqual(before);
    expect(spec.createdAt).toBeLessThanOrEqual(after);
    expect(spec.description).toBeUndefined();
    expect(spec.imageUrl).toBeUndefined();
  });
});

describe("encode/decode roundtrip", () => {
  it("encodes to UTF-8 JSON bytes and decodes back to an equal spec", () => {
    const original = baseSpec({
      description: "Multi-line\nstring with emoji",
      imageUrl: "https://example.com/a.png",
    });
    const bytes = encodeProductSpec(original);
    // jsdom + vitest sometimes hand back a Uint8Array whose [Symbol.toStringTag]
    // matches but whose constructor identity differs across realms. Use the
    // duck-typed check instead of `instanceof`.
    expect(Object.prototype.toString.call(bytes)).toBe("[object Uint8Array]");
    expect(bytes.length).toBeGreaterThan(0);
    const decoded = decodeProductSpec(bytes);
    expect(decoded).toEqual(original);
  });

  it("rejects non-JSON bytes with a readable error", () => {
    const garbage = new TextEncoder().encode("not json {{{");
    expect(() => decodeProductSpec(garbage)).toThrow(/JSON/);
  });

  it("rejects validly-parsed JSON that fails spec validation", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ version: 999 }));
    expect(() => decodeProductSpec(bytes)).toThrow(/version/);
  });
});

describe("extractArweaveTxId", () => {
  it("extracts the 43-char tx id from a typical URI", () => {
    const id = "abcDEFghiJKLmnoPQRstuVWXyz0123456789_-_-_AB";
    expect(extractArweaveTxId(`https://arweave.net/${id}`)).toBe(id);
    expect(extractArweaveTxId(`https://arweave.net/${id}/index.html`)).toBe(id);
    expect(extractArweaveTxId(`arweave.net/${id}`)).toBe(id);
  });

  it("returns null for unparseable URIs", () => {
    expect(extractArweaveTxId("")).toBeNull();
    expect(extractArweaveTxId("not a url")).toBeNull();
    expect(extractArweaveTxId("https://arweave.net/short")).toBeNull();
  });
});

describe("buildProductUrl", () => {
  it("builds a canonical /buy/<txId> URL with no double slashes", () => {
    const id = "a".repeat(43);
    expect(buildProductUrl("https://veil.app", id)).toBe(`https://veil.app/buy/${id}`);
    expect(buildProductUrl("https://veil.app/", id)).toBe(`https://veil.app/buy/${id}`);
    expect(buildProductUrl("http://localhost:3000", id)).toBe(
      `http://localhost:3000/buy/${id}`,
    );
  });
});

describe("formatProductAmount + parseAmountToBaseUnits", () => {
  it("formats 9-decimal SOL with at least 2 fraction digits", () => {
    expect(formatProductAmount("1500000000", 9)).toBe("1.50");
    expect(formatProductAmount("1234567890", 9)).toBe("1.23456789");
    expect(formatProductAmount("100000000", 9)).toBe("0.10");
  });

  it("formats 6-decimal USDC", () => {
    expect(formatProductAmount("250000", 6)).toBe("0.25");
    expect(formatProductAmount("12345670", 6)).toBe("12.34567");
  });

  it("parseAmountToBaseUnits rejects malformed input", () => {
    expect(parseAmountToBaseUnits("", 6)).toBeNull();
    expect(parseAmountToBaseUnits("abc", 6)).toBeNull();
    expect(parseAmountToBaseUnits("1.1234567", 6)).toBeNull(); // too many fraction digits
    expect(parseAmountToBaseUnits("1.5", 6)).toBe(1_500_000n);
    expect(parseAmountToBaseUnits("0.000001", 6)).toBe(1n);
  });
});

// ---------------------------------------------------------------------------
// localStorage cache
// ---------------------------------------------------------------------------

describe("products cache (localStorage)", () => {
  beforeEach(() => {
    // jsdom in this project doesn't ship a working localStorage — stub a
    // minimal in-memory replacement on `window` for each test. Mirrors
    // the pattern used by compliance-grants.test.ts.
    const store = new Map<string, string>();
    const stub = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => {
        store.clear();
      },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    };
    Object.defineProperty(window, "localStorage", {
      value: stub,
      writable: true,
      configurable: true,
    });
    (globalThis as any).localStorage = stub;
  });
  afterEach(() => {
    (window as any).localStorage = undefined;
    (globalThis as any).localStorage = undefined;
  });

  function entry(overrides: Partial<ProductCacheEntry> = {}): ProductCacheEntry {
    return {
      id: "id_" + Math.random().toString(36).slice(2, 7),
      arweaveTxId: "tx_" + Math.random().toString(36).slice(2, 7).padEnd(40, "x"),
      name: "Item",
      amountBaseUnits: "1000",
      symbol: "USDC",
      decimals: 6,
      createdAt: Date.now(),
      ...overrides,
    };
  }

  it("read returns [] when no key exists", () => {
    expect(readProductsCache(VALID_PUBKEY_A)).toEqual([]);
  });

  it("write + read round-trips entries", () => {
    const a = entry({ name: "A" });
    const b = entry({ name: "B" });
    writeProductsCache(VALID_PUBKEY_A, [a, b]);
    expect(readProductsCache(VALID_PUBKEY_A)).toEqual([a, b]);
  });

  it("scopes per wallet — A's entries don't leak to B", () => {
    writeProductsCache(VALID_PUBKEY_A, [entry({ name: "A1" })]);
    expect(readProductsCache(VALID_PUBKEY_B)).toEqual([]);
  });

  it("survives malformed storage payloads (returns [])", () => {
    window.localStorage.setItem(`veil:products:${VALID_PUBKEY_A}`, "not json");
    expect(readProductsCache(VALID_PUBKEY_A)).toEqual([]);
    window.localStorage.setItem(
      `veil:products:${VALID_PUBKEY_A}`,
      JSON.stringify({ not: "an array" }),
    );
    expect(readProductsCache(VALID_PUBKEY_A)).toEqual([]);
  });

  it("addProductToCache dedupes by arweaveTxId and keeps newest first", () => {
    const older = entry({ name: "Old", createdAt: 1 });
    const newer = entry({ ...older, name: "New", createdAt: 2 });
    addProductToCache(VALID_PUBKEY_A, older);
    const list = addProductToCache(VALID_PUBKEY_A, newer);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("New");
  });

  it("addProductToCache sorts unrelated entries by createdAt DESC", () => {
    const a = entry({ name: "A", createdAt: 100 });
    const b = entry({ name: "B", createdAt: 200 });
    addProductToCache(VALID_PUBKEY_A, a);
    const list = addProductToCache(VALID_PUBKEY_A, b);
    expect(list.map((e) => e.name)).toEqual(["B", "A"]);
  });

  it("removeProductFromCache removes only the matching tx id", () => {
    const a = entry({ name: "A" });
    const b = entry({ name: "B" });
    writeProductsCache(VALID_PUBKEY_A, [a, b]);
    const after = removeProductFromCache(VALID_PUBKEY_A, a.arweaveTxId);
    expect(after.map((e) => e.name)).toEqual(["B"]);
    // Idempotent: removing again is a no-op, no throw.
    expect(removeProductFromCache(VALID_PUBKEY_A, a.arweaveTxId)).toEqual(after);
  });
});

// ---------------------------------------------------------------------------
// uploadProductSpec / fetchProductSpec — exercise via fetch mocks so we
// don't actually hit Arweave or the dev server.
// ---------------------------------------------------------------------------

describe("uploadProductSpec / fetchProductSpec", () => {
  const TX_ID = "X".repeat(43);
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("upload returns the parsed tx id and full URI", async () => {
    global.fetch = (async (input: any) => {
      if (typeof input === "string" && input.includes("arweave-upload")) {
        return new Response(
          JSON.stringify({ id: TX_ID, uri: `https://arweave.net/${TX_ID}` }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${input}`);
    }) as any;

    const result = await uploadProductSpec(baseSpec());
    expect(result.arweaveTxId).toBe(TX_ID);
    expect(result.uri).toBe(`https://arweave.net/${TX_ID}`);
  });

  it("upload throws if the helper returns a malformed URI", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ id: "x", uri: "not-an-arweave-uri" }), {
        status: 200,
      })) as any;
    await expect(uploadProductSpec(baseSpec())).rejects.toThrow(/unparseable/);
  });

  it("fetch decodes a valid spec from arweave.net", async () => {
    const spec = baseSpec();
    const bytes = encodeProductSpec(spec);
    global.fetch = (async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith(TX_ID)) {
        return new Response(bytes, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as any;
    const fetched = await fetchProductSpec(TX_ID);
    expect(fetched).toEqual(spec);
  });

  it("fetch rejects malformed tx id without hitting the network", async () => {
    let called = false;
    global.fetch = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as any;
    await expect(fetchProductSpec("too-short")).rejects.toThrow(/Invalid Arweave/);
    expect(called).toBe(false);
  });
});
