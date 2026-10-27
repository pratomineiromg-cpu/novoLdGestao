import { DatabaseState } from '../IRepository';

export const createEmptyDatabaseState = (): DatabaseState => ({
  tenant: {
    id: 't-pratomineiro',
    name: 'Restaurante Prato Mineiro',
    createdAt: new Date(),
    updatedAt: new Date()
  },
  users: [],
  contacts: [],
  conversations: [],
  messages: [],
  pendingMessages: [],
  opportunities: [],
  campaigns: [],
  dispatchQueue: [],
  orders: [],
  orderItems: [],
  timeline: [],
  products: [],
  customerProfiles: [],
  customerAddresses: []
});
