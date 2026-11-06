import type { TenantDO } from './tenant';

export interface Env {
  TENANT: DurableObjectNamespace<TenantDO>;
  ASSETS: Fetcher;
  APKS?: R2Bucket;
  PUBLIC_URL: string;
  APK_VERSION?: string;
  APK_SIGNATURE_CHECKSUM?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  FCM_CLIENT_CONFIG?: string;
  INSECURE_DEV_COOKIES?: string;
  // secrets
  BOOTSTRAP_TOKEN?: string;
  FCM_SERVICE_ACCOUNT?: string;
  SIEM_WEBHOOK_SECRET?: string;
}
