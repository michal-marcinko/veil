export async function uploadCiphertext(ciphertext: Uint8Array): Promise<{ id: string; uri: string }> {
  const res = await fetch("/api/arweave-upload", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: ciphertext,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "unknown" }));
    throw new Error(`Arweave upload failed: ${err.error}`);
  }
  return res.json();
}

/**
 * Upload with optional Bundlr/Arweave tags so the upload is discoverable
 * via GraphQL later (e.g. cross-device payroll-run sync). Tag names are
 * whitelisted server-side — see `app/api/arweave-upload/route.ts` for
 * the allowed set.
 *
 * Tags are passed via an `X-Veil-Tags` header containing
 * base64(JSON.stringify([{name, value}, …])) — we use a header rather
 * than wrapping the body so the binary payload still streams as-is.
 */
export async function uploadCiphertextWithTags(
  ciphertext: Uint8Array,
  tags: Array<{ name: string; value: string }>,
): Promise<{ id: string; uri: string }> {
  // Browser btoa doesn't accept Uint8Arrays — JSON.stringify gives us a
  // safe ASCII subset for free, so plain btoa works.
  const headerValue = btoa(JSON.stringify(tags));
  const res = await fetch("/api/arweave-upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Veil-Tags": headerValue,
    },
    body: ciphertext,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "unknown" }));
    throw new Error(`Arweave upload failed: ${err.error}`);
  }
  return res.json();
}

export async function fetchCiphertext(uri: string): Promise<Uint8Array> {
  const res = await fetch(uri);
  if (!res.ok) {
    throw new Error(`Failed to fetch Arweave content: ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Query Arweave (or Bundlr's testnet GraphQL) for transactions tagged
 * with `name=value`. Returns transaction IDs in chronological order
 * (newest first per Arweave's default).
 *
 * Used by the cross-device payroll-run sync: the wallet derives an
 * opaque tag from its master signature and queries for all blobs
 * carrying it. Without the master sig nobody else can compute the
 * tag, so the listing itself is private.
 *
 * Endpoint selection mirrors the upload route:
 *   - Mainnet uploads land on arweave.net → query arweave.net/graphql
 *   - Devnet uploads land on devnet.bundlr.network → query that node's
 *     GraphQL (arweave.net wouldn't see them because Bundlr-devnet
 *     never settles to L1).
 */
export async function queryArweaveByTag(
  tagName: string,
  tagValue: string,
  opts?: { first?: number },
): Promise<string[]> {
  const network =
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_SOLANA_NETWORK || "devnet"
      : "devnet";
  const endpoint =
    network === "mainnet"
      ? "https://arweave.net/graphql"
      : "https://devnet.bundlr.network/graphql";

  // GraphQL variables — never interpolate the user-supplied tag value
  // into the query string. Even though our tag values are SHA-256 hex
  // (no special chars), parameterized queries are the right shape.
  const query = `
    query VeilTagQuery($tagName: String!, $tagValue: String!, $first: Int!) {
      transactions(
        tags: [{ name: $tagName, values: [$tagValue] }]
        first: $first
      ) {
        edges { node { id } }
      }
    }
  `;
  const variables = {
    tagName,
    tagValue,
    first: opts?.first ?? 100,
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Arweave GraphQL ${endpoint} returned ${res.status}`);
  }
  const json = (await res.json()) as {
    errors?: Array<{ message: string }>;
    data?: { transactions?: { edges?: Array<{ node?: { id?: string } }> } };
  };
  if (json.errors && json.errors.length > 0) {
    throw new Error(`Arweave GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  const edges = json.data?.transactions?.edges ?? [];
  const ids: string[] = [];
  for (const e of edges) {
    if (e?.node?.id && typeof e.node.id === "string") ids.push(e.node.id);
  }
  return ids;
}

/**
 * Build the gateway URL for a tx ID, mirroring the upload route's
 * choice. Centralised here so callers don't have to recompute the
 * mainnet-vs-devnet branch.
 */
export function arweaveGatewayUrl(txId: string): string {
  const network =
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_SOLANA_NETWORK || "devnet"
      : "devnet";
  return network === "mainnet"
    ? `https://arweave.net/${txId}`
    : `https://devnet.bundlr.network/${txId}`;
}
