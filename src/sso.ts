/**
 * P8 #72 — SSO/SAML configuration for Enterprise tier.
 * License-keyed SAML/OIDC provider config. Restricts dashboard access by org.
 */

export interface SsoConfig {
  provider: 'saml' | 'oidc';
  entityId?: string;
  ssoUrl: string;
  certificate?: string;
  clientId?: string;
  clientSecret?: string;
  issuer?: string;
  callbackUrl?: string;
  allowedDomains?: string[];
}

export interface SsoSession {
  userId: string;
  email: string;
  teamId: string;
  provider: string;
  expiresAt: number;
}

export function validateSsoConfig(cfg: SsoConfig): string[] {
  const errors: string[] = [];
  if (cfg.provider === 'saml') {
    if (!cfg.ssoUrl) errors.push('ssoUrl required for SAML');
    if (!cfg.certificate) errors.push('certificate required for SAML');
  }
  if (cfg.provider === 'oidc') {
    if (!cfg.clientId) errors.push('clientId required for OIDC');
    if (!cfg.issuer) errors.push('issuer required for OIDC');
  }
  return errors;
}
