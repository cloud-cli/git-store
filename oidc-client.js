import * as oidc from "openid-client";

/** Build protocol and introspection configurations from the issuer's discovered metadata. */
export function createOidcConfigurations(
  serverMetadata,
  { clientId, clientSecret, jwksUri } = {},
) {
  let issuer;
  try {
    issuer = new URL(serverMetadata.issuer);
  } catch {
    throw new Error("OIDC issuer metadata must contain an absolute issuer URL");
  }
  if (!/^https?:$/.test(issuer.protocol)) {
    throw new Error("OIDC issuer must use HTTP or HTTPS");
  }

  const metadata = { ...serverMetadata };
  if (jwksUri) {
    const jwks = new URL(jwksUri);
    if (jwks.origin !== issuer.origin) {
      throw new Error("OIDC JWKS endpoint must share the issuer origin");
    }
    metadata.jwks_uri = jwks.toString();
  }
  if (!metadata.introspection_endpoint) {
    metadata.introspection_endpoint = new URL(
      "/oauth/introspect",
      issuer,
    ).toString();
  }

  return {
    oidc: new oidc.Configuration(
      metadata,
      clientId,
      clientSecret,
      oidc.ClientSecretPost(clientSecret),
    ),
    introspection: new oidc.Configuration(
      metadata,
      clientId,
      clientSecret,
      oidc.ClientSecretBasic(clientSecret),
    ),
  };
}
