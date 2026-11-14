import { blockedHost, type Lookup } from "@coderbabasi/core";

export type SafeResponse = { url: string; status: number; contentType: string; body: Buffer; truncated: boolean };

export type SafeFetchOptions = {
  fetchImpl?: typeof fetch;
  lookup?: Lookup;
  maxBytes?: number;
  timeoutMs?: number;
  accept?: string;
};

const MAX_REDIRECTS = 5;

/** Fetches a public URL, refusing private and local addresses on every redirect hop. */
export async function safeFetch(input: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let url = new URL(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    for (let hop = 0; ; hop++) {
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Only http and https URLs are allowed, not ${url.protocol}`);
      if (url.username || url.password) throw new Error("URLs with a username or password aren't allowed.");
      const blocked = await blockedHost(url.hostname, opts.lookup);
      if (blocked) throw new Error(`Can't read ${url.toString()}: ${blocked}.`);
      const response = await fetchImpl(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "CoderBaba (+https://coderbaba.si)", accept: opts.accept ?? "*/*" },
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects.");
        url = new URL(location, url);
        continue;
      }
      const { body, truncated } = await readLimited(response, opts.maxBytes ?? 5_000_000);
      return { url: url.toString(), status: response.status, contentType: (response.headers.get("content-type") ?? "").toLowerCase(), body, truncated };
    }
  } finally {
    clearTimeout(timer);
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<{ body: Buffer; truncated: boolean }> {
  if (!response.body) return { body: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      chunks.push(Buffer.from(value.subarray(0, value.byteLength - (total - maxBytes))));
      await reader.cancel();
      return { body: Buffer.concat(chunks), truncated: true };
    }
    chunks.push(Buffer.from(value));
  }
  return { body: Buffer.concat(chunks), truncated: false };
}
