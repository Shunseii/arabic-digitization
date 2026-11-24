import { describe, expect, it } from "vitest";
import { signScanUrl, verifyScanSignature } from "../src/lib/scanUrl";

const MASTER_KEY = "test-master-key";
const NOW = 1_800_000_000;

async function signed(fileId = "file-1", expiresAt = NOW + 600) {
  const url = new URL(
    await signScanUrl({
      baseUrl: "https://api.test",
      masterKey: MASTER_KEY,
      fileId,
      expiresAt,
    }),
  );
  return {
    url,
    exp: url.searchParams.get("exp") ?? undefined,
    sig: url.searchParams.get("sig") ?? undefined,
  };
}

const verify = (args: {
  fileId?: string;
  exp: string | undefined;
  sig: string | undefined;
  masterKey?: string;
  nowSeconds?: number;
}) =>
  verifyScanSignature({
    masterKey: args.masterKey ?? MASTER_KEY,
    fileId: args.fileId ?? "file-1",
    exp: args.exp,
    sig: args.sig,
    nowSeconds: args.nowSeconds ?? NOW,
  });

describe("signed scan links", () => {
  it("builds a /scan link with exp and sig", async () => {
    const { url } = await signed();
    expect(url.origin).toBe("https://api.test");
    expect(url.pathname).toBe("/scan/file-1");
    expect(url.searchParams.get("exp")).toBe(String(NOW + 600));
  });

  it("accepts its own signature before expiry", async () => {
    const { exp, sig } = await signed();
    expect(await verify({ exp, sig })).toBe(true);
  });

  it("rejects an expired link", async () => {
    const { exp, sig } = await signed();
    expect(await verify({ exp, sig, nowSeconds: NOW + 601 })).toBe(false);
  });

  it("rejects a link for another file", async () => {
    const { exp, sig } = await signed();
    expect(await verify({ fileId: "file-2", exp, sig })).toBe(false);
  });

  it("rejects an extended expiry", async () => {
    const { sig } = await signed();
    expect(await verify({ exp: String(NOW + 99_999), sig })).toBe(false);
  });

  it("rejects a link signed with another master key", async () => {
    const { exp, sig } = await signed();
    expect(await verify({ exp, sig, masterKey: "rotated" })).toBe(false);
  });

  it("rejects missing or malformed parameters", async () => {
    const { sig } = await signed();
    expect(await verify({ exp: undefined, sig })).toBe(false);
    expect(await verify({ exp: "soon", sig })).toBe(false);
    expect(await verify({ exp: String(NOW + 600), sig: undefined })).toBe(
      false,
    );
  });
});
