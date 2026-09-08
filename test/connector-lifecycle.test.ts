import { describe, expect, it } from 'vitest';
import {
  ConnectorOperationError,
  type Connector,
  type OutboundEvent,
} from '../src/connectors/types.js';

describe('connector lifecycle primitives', () => {
  it('carries retry and reauthentication policy on operational errors', () => {
    const error = new ConnectorOperationError('microblog shelves: HTTP 401', false, true);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: 'microblog shelves: HTTP 401',
      retryable: false,
      needsReauth: true,
    });
  });

  it('accepts event-aware optional hooks without changing existing connectors', () => {
    const event: OutboundEvent = {
      kind: 'progress',
      document: 'd',
      percentage: 0,
      timestamp: 1,
    };
    const connector = {
      shouldPush: (ev: OutboundEvent) => (ev.percentage ?? 0) > 0,
      createBook: async () => ({ externalId: '9', confidence: 1 }),
    } satisfies Pick<Connector, 'shouldPush' | 'createBook'>;

    expect(connector.shouldPush(event)).toBe(false);
  });
});
