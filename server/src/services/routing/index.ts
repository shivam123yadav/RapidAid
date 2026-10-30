import { env } from '../../config/env.js';
import { OsrmRoutingProvider } from './osrmProvider.js';
import { MockRoutingProvider } from './mockProvider.js';
import type { RoutingProvider } from './types.js';

export * from './types.js';
export * from './deviation.js';
export * from './osrmProvider.js';
export * from './mockProvider.js';

let activeProvider: RoutingProvider | null = null;

export function getRoutingProvider(): RoutingProvider {
  if (activeProvider) return activeProvider;

  if (env.ROUTING_PROVIDER_TYPE === 'mock') {
    activeProvider = new MockRoutingProvider();
  } else {
    activeProvider = new OsrmRoutingProvider(env.ROUTING_PROVIDER_URL, env.ROUTING_TIMEOUT_MS);
  }

  return activeProvider;
}

export function setRoutingProvider(provider: RoutingProvider | null): void {
  activeProvider = provider;
}

export function resetRoutingProvider(): void {
  activeProvider = null;
}
