import { Firestore, type Settings } from '@google-cloud/firestore';

export interface ChannelGatewayFirestoreConfig {
  projectId?: string;
  databaseId?: string;
  preferRest?: boolean;
}

/**
 * Server-side Firestore construction only. Credentials are intentionally not
 * accepted here; production must use Application Default Credentials or the
 * runtime's managed identity.
 */
export function createChannelGatewayFirestore(config: ChannelGatewayFirestoreConfig = {}): Firestore {
  const settings: Settings = {
    ...(config.projectId ? { projectId: config.projectId } : {}),
    ...(config.databaseId ? { databaseId: config.databaseId } : {}),
    ...(config.preferRest === undefined ? { preferRest: true } : { preferRest: config.preferRest })
  };
  return new Firestore(settings);
}
