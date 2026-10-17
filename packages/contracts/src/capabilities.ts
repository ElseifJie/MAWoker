export interface FeatureCapability {
  available: boolean;
}

export interface FeatureCapabilities {
  skills: FeatureCapability;
  mcpServers: FeatureCapability;
  vaults: FeatureCapability;
  memoryStores: FeatureCapability;
}

export const capabilities: FeatureCapabilities = {
  skills: { available: true },
  mcpServers: { available: false },
  vaults: { available: false },
  memoryStores: { available: false },
};
