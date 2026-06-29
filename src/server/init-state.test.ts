import { describe, it, expect, beforeEach } from 'vitest';
import { getOrcdClient, getClientByNode, setClientForNode, listNodeClients, clearNodeClients } from './init-state';

class FakeClient { constructor(public nodeName: string) {} }

describe('init-state node registry', () => {
  beforeEach(() => clearNodeClients());

  it('stores and retrieves clients by node name', () => {
    setClientForNode('local', new FakeClient('local') as never);
    setClientForNode('gpubox', new FakeClient('gpubox') as never);
    expect(getClientByNode('local')?.nodeName).toBe('local');
    expect(getClientByNode('gpubox')?.nodeName).toBe('gpubox');
    expect(listNodeClients().length).toBe(2);
  });

  it('getOrcdClient returns the local client for back-compat', () => {
    setClientForNode('local', new FakeClient('local') as never);
    expect(getOrcdClient()?.nodeName).toBe('local');
  });
});
