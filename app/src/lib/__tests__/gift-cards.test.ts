import { describe, expect, it } from "vitest";
import {
  buildGiftQuickShareTargets,
  decodeGiftMetadata,
  deriveGiftShadow,
  encodeGiftMetadata,
  GIFT_MESSAGE_MAX_CHARS,
  generateGiftUrl,
  parseGiftUrlFragment,
  type GiftMetadata,
} from "../gift-cards";
import {
  generateEphemeralKeypair,
  encodeEphemeralPrivateKey,
} from "../payroll-claim-links";

const SAMPLE_META: GiftMetadata = {
  amount: "0.50",
  symbol: "SOL",
  mint: "So11111111111111111111111111111111111111112",
  amountBaseUnits: "500000000",
  message: "Happy birthday!",
  sender: "Alice",
  recipientName: "Sarah",
};

describe("encodeGiftMetadata + decodeGiftMetadata", () => {
  it("roundtrips all fields losslessly", () => {
    const encoded = encodeGiftMetadata(SAMPLE_META);
    const decoded = decodeGiftMetadata(encoded);
    expect(decoded).toEqual(SAMPLE_META);
  });

  it("uses URL-safe base64 (no +, /, or = chars)", () => {
    const encoded = encodeGiftMetadata(SAMPLE_META);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("survives unicode / emoji in the message", () => {
    const meta: GiftMetadata = {
      ...SAMPLE_META,
      message: "Mahalo nui loa — saudações ❤️ 🎁",
    };
    const encoded = encodeGiftMetadata(meta);
    const decoded = decodeGiftMetadata(encoded);
    expect(decoded.message).toBe(meta.message);
  });

  it("truncates messages longer than the cap", () => {
    const long = "a".repeat(GIFT_MESSAGE_MAX_CHARS + 100);
    const encoded = encodeGiftMetadata({ ...SAMPLE_META, message: long });
    const decoded = decodeGiftMetadata(encoded);
    expect(decoded.message).toHaveLength(GIFT_MESSAGE_MAX_CHARS);
  });

  it("throws on malformed JSON", () => {
    expect(() => decodeGiftMetadata("bm90LWpzb24")).toThrow();
  });
});

describe("generateGiftUrl", () => {
  it("formats /gift/<token>#k=<priv>&m=<meta>", () => {
    const kp = generateEphemeralKeypair();
    const url = generateGiftUrl({
      baseUrl: "https://veil.app",
      ephemeralAddress: kp.address,
      ephemeralPrivateKey: kp.privateKey,
      metadata: SAMPLE_META,
    });
    expect(url).toMatch(
      new RegExp(
        `^https://veil\\.app/gift/${kp.address}#k=[A-Za-z0-9_-]+&m=[A-Za-z0-9_-]+$`,
      ),
    );
  });

  it("trims trailing slash from baseUrl so the URL has no //", () => {
    const kp = generateEphemeralKeypair();
    const url = generateGiftUrl({
      baseUrl: "https://veil.app/",
      ephemeralAddress: kp.address,
      ephemeralPrivateKey: kp.privateKey,
      metadata: SAMPLE_META,
    });
    expect(url).toMatch(/^https:\/\/veil\.app\/gift\//);
    expect(url).not.toMatch(/\/\/gift/);
  });

  it("rejects an empty ephemeralAddress", () => {
    const kp = generateEphemeralKeypair();
    expect(() =>
      generateGiftUrl({
        baseUrl: "https://veil.app",
        ephemeralAddress: "",
        ephemeralPrivateKey: kp.privateKey,
        metadata: SAMPLE_META,
      }),
    ).toThrow(/ephemeralAddress/);
  });
});

describe("parseGiftUrlFragment", () => {
  it("recovers the private key and metadata from a generated URL", () => {
    const kp = generateEphemeralKeypair();
    const url = generateGiftUrl({
      baseUrl: "https://veil.app",
      ephemeralAddress: kp.address,
      ephemeralPrivateKey: kp.privateKey,
      metadata: SAMPLE_META,
    });
    const fragment = url.slice(url.indexOf("#"));
    const parsed = parseGiftUrlFragment(fragment);
    expect(Array.from(parsed.privateKey)).toEqual(Array.from(kp.privateKey));
    expect(parsed.metadata).toEqual(SAMPLE_META);
  });

  it("throws when k= is missing entirely", () => {
    expect(() => parseGiftUrlFragment("#m=eyJmb28iOjF9")).toThrow(/k=/);
  });

  it("returns null metadata when m= is malformed but key is fine", () => {
    const kp = generateEphemeralKeypair();
    const encoded = encodeEphemeralPrivateKey(kp.privateKey);
    const parsed = parseGiftUrlFragment(`#k=${encoded}&m=not-base64-at-all!@#`);
    expect(parsed.metadata).toBeNull();
    expect(Array.from(parsed.privateKey)).toEqual(Array.from(kp.privateKey));
  });

  it("tolerates a fragment with no leading #", () => {
    const kp = generateEphemeralKeypair();
    const encoded = encodeEphemeralPrivateKey(kp.privateKey);
    const parsed = parseGiftUrlFragment(`k=${encoded}`);
    expect(Array.from(parsed.privateKey)).toEqual(Array.from(kp.privateKey));
  });
});

describe("deriveGiftShadow", () => {
  it("rebuilds the same address that the URL token carries", () => {
    const kp = generateEphemeralKeypair();
    const url = generateGiftUrl({
      baseUrl: "https://veil.app",
      ephemeralAddress: kp.address,
      ephemeralPrivateKey: kp.privateKey,
      metadata: SAMPLE_META,
    });
    const fragment = url.slice(url.indexOf("#"));
    const parsed = parseGiftUrlFragment(fragment);
    const shadow = deriveGiftShadow(parsed.privateKey);
    expect(shadow.address).toBe(kp.address);
  });
});

describe("buildGiftQuickShareTargets", () => {
  const targets = buildGiftQuickShareTargets({
    giftUrl: "https://veil.app/gift/ABC#k=xyz&m=abc",
    amountDisplay: "0.50",
    symbol: "SOL",
    recipientName: "Sarah",
  });

  it("produces a Twitter intent URL containing the gift URL", () => {
    expect(targets.twitter).toMatch(/^https:\/\/twitter\.com\/intent\/tweet\?/);
    expect(decodeURIComponent(targets.twitter)).toContain(
      "https://veil.app/gift/ABC",
    );
  });

  it("produces a mailto: link with subject + body", () => {
    expect(targets.email).toMatch(/^mailto:\?subject=/);
    expect(decodeURIComponent(targets.email)).toContain("Sarah");
    expect(decodeURIComponent(targets.email)).toContain("0.50 SOL");
  });

  it("produces an sms: link with the gift URL in the body", () => {
    expect(targets.sms).toMatch(/^sms:\?&body=/);
    expect(decodeURIComponent(targets.sms)).toContain(
      "https://veil.app/gift/ABC",
    );
  });

  it("falls back to a generic recipient when no name is given", () => {
    const t = buildGiftQuickShareTargets({
      giftUrl: "https://veil.app/gift/X",
      amountDisplay: "1.00",
      symbol: "USDC",
    });
    expect(decodeURIComponent(t.email)).toContain("for you");
  });
});
