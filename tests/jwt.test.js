import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { verifyAccessJwt, clearJwksCache } from "../worker/lib/jwt.js";

const TEAM_DOMAIN = "test.cloudflareaccess.com";
const AUDIENCE = "test-aud-tag";
const ISS = `https://${TEAM_DOMAIN}`;
const NOW = 1735689600000;
const NOW_SEC = Math.floor(NOW / 1000);

let keyPair;
let jwks;

beforeAll(async () => {
  keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  jwk.kid = "test-kid-1";
  jwk.use = "sig";
  jwk.alg = "RS256";
  jwks = { keys: [jwk] };
});

beforeEach(() => clearJwksCache());

function base64UrlEncode(input) {
  let str;
  if (input instanceof Uint8Array) {
    str = String.fromCharCode(...input);
  } else if (typeof input === "string") {
    str = input;
  } else {
    str = JSON.stringify(input);
  }
  return btoa(str).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function makeToken(claims, { kid = "test-kid-1", alg = "RS256" } = {}) {
  const header = { alg, kid, typ: "JWT" };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(claims));
  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keyPair.privateKey,
      signed,
    ),
  );
  const sigB64 = base64UrlEncode(sig);
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

const fetchJwks = async () => jwks;
const baseClaims = () => ({
  iss: ISS,
  aud: AUDIENCE,
  sub: "user1",
  email: "alice@example.com",
  exp: NOW_SEC + 3600,
  iat: NOW_SEC,
});

describe("verifyAccessJwt", () => {
  it("accepts a properly signed token with valid claims and returns claims", async () => {
    const token = await makeToken(baseClaims());
    const claims = await verifyAccessJwt(token, {
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      fetchJwks,
      now: NOW,
    });
    expect(claims.email).toBe("alice@example.com");
    expect(claims.sub).toBe("user1");
  });

  it("accepts a token where aud is an array containing the expected value", async () => {
    const token = await makeToken({
      ...baseClaims(),
      aud: ["other-aud", AUDIENCE, "third-aud"],
    });
    const claims = await verifyAccessJwt(token, {
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      fetchJwks,
      now: NOW,
    });
    expect(claims.email).toBe("alice@example.com");
  });

  it("rejects a token signed by a different key", async () => {
    const otherKeyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const otherJwk = await crypto.subtle.exportKey("jwk", otherKeyPair.publicKey);
    otherJwk.kid = "test-kid-1";
    const otherJwks = { keys: [otherJwk] };

    const token = await makeToken(baseClaims());
    await expect(
      verifyAccessJwt(token, {
        teamDomain: TEAM_DOMAIN,
        audience: AUDIENCE,
        fetchJwks: async () => otherJwks,
        now: NOW,
      }),
    ).rejects.toThrow("signature verification failed");
  });

  it("rejects expired tokens", async () => {
    const token = await makeToken({
      ...baseClaims(),
      exp: NOW_SEC - 100,
      iat: NOW_SEC - 3700,
    });
    await expect(
      verifyAccessJwt(token, {
        teamDomain: TEAM_DOMAIN,
        audience: AUDIENCE,
        fetchJwks,
        now: NOW,
      }),
    ).rejects.toThrow("JWT expired");
  });

  it("rejects wrong audience", async () => {
    const token = await makeToken({ ...baseClaims(), aud: "wrong-aud" });
    await expect(
      verifyAccessJwt(token, {
        teamDomain: TEAM_DOMAIN,
        audience: AUDIENCE,
        fetchJwks,
        now: NOW,
      }),
    ).rejects.toThrow("aud mismatch");
  });

  it("rejects wrong issuer", async () => {
    const token = await makeToken({
      ...baseClaims(),
      iss: "https://other.cloudflareaccess.com",
    });
    await expect(
      verifyAccessJwt(token, {
        teamDomain: TEAM_DOMAIN,
        audience: AUDIENCE,
        fetchJwks,
        now: NOW,
      }),
    ).rejects.toThrow("unexpected iss");
  });

  it("rejects unknown kid", async () => {
    const token = await makeToken(baseClaims(), { kid: "unknown-kid" });
    await expect(
      verifyAccessJwt(token, {
        teamDomain: TEAM_DOMAIN,
        audience: AUDIENCE,
        fetchJwks,
        now: NOW,
      }),
    ).rejects.toThrow("no JWK matches kid");
  });

  it("rejects unsupported algorithm", async () => {
    const headerB64 = base64UrlEncode(
      JSON.stringify({ alg: "HS256", kid: "test-kid-1", typ: "JWT" }),
    );
    const payloadB64 = base64UrlEncode(JSON.stringify(baseClaims()));
    const token = `${headerB64}.${payloadB64}.fake`;
    await expect(
      verifyAccessJwt(token, {
        teamDomain: TEAM_DOMAIN,
        audience: AUDIENCE,
        fetchJwks,
        now: NOW,
      }),
    ).rejects.toThrow("unsupported alg");
  });

  it("rejects header missing kid", async () => {
    const headerB64 = base64UrlEncode(
      JSON.stringify({ alg: "RS256", typ: "JWT" }),
    );
    const payloadB64 = base64UrlEncode(JSON.stringify(baseClaims()));
    const token = `${headerB64}.${payloadB64}.fake`;
    await expect(
      verifyAccessJwt(token, {
        teamDomain: TEAM_DOMAIN,
        audience: AUDIENCE,
        fetchJwks,
        now: NOW,
      }),
    ).rejects.toThrow("missing kid");
  });

  it("rejects malformed JWT", async () => {
    await expect(
      verifyAccessJwt("nodot", {
        teamDomain: TEAM_DOMAIN,
        audience: AUDIENCE,
        fetchJwks,
        now: NOW,
      }),
    ).rejects.toThrow("malformed JWT");
    await expect(
      verifyAccessJwt("only.two", {
        teamDomain: TEAM_DOMAIN,
        audience: AUDIENCE,
        fetchJwks,
        now: NOW,
      }),
    ).rejects.toThrow("malformed JWT");
  });

  it("requires teamDomain and audience opts", async () => {
    const token = await makeToken(baseClaims());
    await expect(
      verifyAccessJwt(token, { audience: AUDIENCE, fetchJwks, now: NOW }),
    ).rejects.toThrow("teamDomain is required");
    await expect(
      verifyAccessJwt(token, { teamDomain: TEAM_DOMAIN, fetchJwks, now: NOW }),
    ).rejects.toThrow("audience is required");
  });

  it("caches JWKS for repeated calls within TTL", async () => {
    let fetchCount = 0;
    const trackingFetch = async () => {
      fetchCount++;
      return jwks;
    };
    const token = await makeToken(baseClaims());

    await verifyAccessJwt(token, {
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      fetchJwks: trackingFetch,
      now: NOW,
    });
    await verifyAccessJwt(token, {
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      fetchJwks: trackingFetch,
      now: NOW + 1000,
    });
    expect(fetchCount).toBe(1);
  });

  it("refetches JWKS after TTL expires", async () => {
    let fetchCount = 0;
    const trackingFetch = async () => {
      fetchCount++;
      return jwks;
    };
    const token = await makeToken({ ...baseClaims(), exp: NOW_SEC + 7200 });

    await verifyAccessJwt(token, {
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      fetchJwks: trackingFetch,
      now: NOW,
    });
    await verifyAccessJwt(token, {
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      fetchJwks: trackingFetch,
      now: NOW + JWKS_TTL_MS_FOR_TEST + 1,
    });
    expect(fetchCount).toBe(2);
  });

  it("rejects token with future iat beyond clock skew", async () => {
    const token = await makeToken({
      ...baseClaims(),
      iat: NOW_SEC + 120,
    });
    await expect(
      verifyAccessJwt(token, {
        teamDomain: TEAM_DOMAIN,
        audience: AUDIENCE,
        fetchJwks,
        now: NOW,
      }),
    ).rejects.toThrow("issued in the future");
  });

  it("rejects token with nbf in the future beyond clock skew", async () => {
    const token = await makeToken({
      ...baseClaims(),
      nbf: NOW_SEC + 120,
    });
    await expect(
      verifyAccessJwt(token, {
        teamDomain: TEAM_DOMAIN,
        audience: AUDIENCE,
        fetchJwks,
        now: NOW,
      }),
    ).rejects.toThrow("not yet valid");
  });
});

const JWKS_TTL_MS_FOR_TEST = 60 * 60 * 1000;
