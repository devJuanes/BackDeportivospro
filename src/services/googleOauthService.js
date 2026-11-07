/**
 * Intercambio OAuth Google (authorization code + PKCE) con client_secret en servidor.
 * El front nunca debe enviar el secret.
 */

function getGoogleClientConfig() {
  const clientId = String(
    process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || "",
  ).trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  return { clientId, clientSecret };
}

function isGoogleOauthConfigured() {
  const { clientId, clientSecret } = getGoogleClientConfig();
  return Boolean(clientId && clientSecret);
}

/**
 * @param {{ code: string, codeVerifier: string, redirectUri: string }} input
 * @returns {Promise<{ idToken: string, accessToken?: string, expiresIn?: number }>}
 */
async function exchangeAuthorizationCode(input) {
  const code = String(input?.code || "").trim();
  const codeVerifier = String(input?.codeVerifier || "").trim();
  const redirectUri = String(input?.redirectUri || "").trim();

  if (!code || !codeVerifier || !redirectUri) {
    const err = new Error("Faltan datos para completar el acceso con Google.");
    err.status = 400;
    err.code = "missing_params";
    throw err;
  }

  const { clientId, clientSecret } = getGoogleClientConfig();
  if (!clientId || !clientSecret) {
    const err = new Error(
      "El acceso con Google no está configurado en el servidor. Intenta más tarde.",
    );
    err.status = 503;
    err.code = "google_not_configured";
    throw err;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const raw = String(json.error_description || json.error || "");
    const err = new Error(mapGoogleTokenError(raw));
    err.status = 400;
    err.code = String(json.error || "token_exchange_failed");
    err.detail = raw;
    throw err;
  }

  const idToken = typeof json.id_token === "string" ? json.id_token : "";
  if (!idToken) {
    const err = new Error("No pudimos validar tu cuenta de Google. Intenta de nuevo.");
    err.status = 502;
    err.code = "missing_id_token";
    throw err;
  }

  return {
    idToken,
    accessToken: typeof json.access_token === "string" ? json.access_token : undefined,
    expiresIn: typeof json.expires_in === "number" ? json.expires_in : undefined,
  };
}

function mapGoogleTokenError(raw) {
  const t = String(raw || "").toLowerCase();
  if (t.includes("client_secret")) {
    return "El acceso con Google no está listo aún. Intenta más tarde o usa correo y contraseña.";
  }
  if (t.includes("redirect_uri")) {
    return "La redirección de Google no coincide. Vuelve a intentar desde winquina.com.";
  }
  if (t.includes("invalid_grant") || t.includes("code")) {
    return "La sesión de Google expiró o ya se usó. Vuelve a intentar con Google.";
  }
  if (t.includes("access_denied")) {
    return "Cancelaste el acceso con Google.";
  }
  return "No pudimos completar el acceso con Google. Intenta de nuevo.";
}

module.exports = {
  exchangeAuthorizationCode,
  isGoogleOauthConfigured,
  getGoogleClientConfig,
  mapGoogleTokenError,
};
