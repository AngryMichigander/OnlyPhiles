const JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SEC = 60;
const jwksCache = new Map();

export function clearJwksCache() {
  jwksCache.clear();
}

function base64UrlToBytes(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const b64 = (str + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64UrlToJson(str) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(str)));
}

async function defaultFetchJwks(teamDomain) {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
  return await res.json();
}

async function getJwks(teamDomain, fetchJwks, now) {
  const cached = jwksCache.get(teamDomain);
  if (cached && (now - cached.fetchedAt) < JWKS_TTL_MS) {
    return cached.jwks;
  }
  const jwks = await fetchJwks(teamDomain);
  jwksCache.set(teamDomain, { fetchedAt: now, jwks });
  return jwks;
}

export async function verifyAccessJwt(token, opts) {
  const { teamDomain, audience, fetchJwks = defaultFetchJwks, now = Date.now() } = opts || {};
  if (!teamDomain) throw new Error("teamDomain is required");
  if (!audience) throw new Error("audience is required");
  if (typeof token !== "string") throw new Error("token must be a string");

  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  const [headerB64, payloadB64, sigB64] = parts;

  let header;
  try {
    header = base64UrlToJson(headerB64);
  } catch {
    throw new Error("invalid JWT header");
  }
  if (header.alg !== "RS256") throw new Error(`unsupported alg: ${header.alg}`);
  if (!header.kid) throw new Error("JWT header missing kid");

  const jwks = await getJwks(teamDomain, fetchJwks, now);
  const jwk = jwks.keys?.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error(`no JWK matches kid: ${header.kid}`);

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sigBytes = base64UrlToBytes(sigB64);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    sigBytes,
    signed,
  );
  if (!valid) throw new Error("JWT signature verification failed");

  let claims;
  try {
    claims = base64UrlToJson(payloadB64);
  } catch {
    throw new Error("invalid JWT payload");
  }

  const expectedIss = `https://${teamDomain}`;
  if (claims.iss !== expectedIss) throw new Error(`unexpected iss: ${claims.iss}`);

  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(audience)) {
    throw new Error(`aud mismatch: expected ${audience}, got ${claims.aud}`);
  }

  const nowSec = Math.floor(now / 1000);
  if (typeof claims.exp !== "number" || claims.exp < nowSec) {
    throw new Error("JWT expired");
  }
  if (typeof claims.iat === "number" && claims.iat > nowSec + CLOCK_SKEW_SEC) {
    throw new Error("JWT issued in the future");
  }
  if (typeof claims.nbf === "number" && claims.nbf > nowSec + CLOCK_SKEW_SEC) {
    throw new Error("JWT not yet valid (nbf)");
  }

  return claims;
}
