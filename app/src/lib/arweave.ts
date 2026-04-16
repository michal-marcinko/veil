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

export async function fetchCiphertext(uri: string): Promise<Uint8Array> {
  const res = await fetch(uri);
  if (!res.ok) {
    throw new Error(`Failed to fetch Arweave content: ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}
