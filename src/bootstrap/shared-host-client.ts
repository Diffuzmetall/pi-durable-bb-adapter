import { PassThrough } from 'node:stream';
import { runSharedHost } from "../provider/runner/shared-host.ts";
import { RunnerRpcChannel } from "../provider/host/runner-rpc-channel.ts";
import type { RunnerProcessOptions } from "../provider/host/runner-process.ts";
import type { RunnerEvent } from "../provider/host/types.ts";

/**
 * Shared-only BB CLIENT. Reuses existing transport/RPC correlation; no subprocess,
 * Harness/storage import, model loop or descriptor-missing fallback is possible.
 */
export class SharedHostClient {
  public exited = false;
  private readonly input = new PassThrough();
  private readonly channel = new RunnerRpcChannel();
  private readonly done: Promise<void>;
  private detached = false;
  private latestConversationIds: readonly number[] = [];
  public get conversationIds(): readonly number[] { return this.latestConversationIds; }

  constructor(socketPath: string, cwd: string,
    callbacks: Pick<RunnerProcessOptions, 'onEvent' | 'onChannelMessage' | 'onError' | 'onExit'>,
    onConversationIds?: (ids: readonly number[]) => void) {
    this.done = runSharedHost(socketPath, cwd, this.input, frame => {
      if (!frame || typeof frame !== 'object' || !('type' in frame) || typeof frame.type !== 'string') return;
      const event: RunnerEvent = { ...frame, type: frame.type };
      if (!this.channel.handleIncoming(event) && !this.detached) callbacks.onEvent?.(event);
    }, frame => { if (!this.detached) callbacks.onChannelMessage?.(frame); }, onConversationIds ? ids => {
      if (this.detached || this.exited) return;
      if (ids.length === this.latestConversationIds.length && ids.every((id, index) => id === this.latestConversationIds[index])) return;
      this.latestConversationIds = ids;
      onConversationIds(ids);
    } : undefined).then(() => {
      this.exited = true;
      this.channel.failAll(new Error('Shared host client detached'));
      callbacks.onExit?.(0, null);
    }, error => {
      this.exited = true;
      const failure = error instanceof Error ? error : new Error('Shared host client failed');
      this.channel.failAll(failure);
      callbacks.onError?.(failure);
    });
  }

  public request(command: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
    if (this.exited || this.input.writableEnded) return Promise.reject(new Error('Shared host client is not connected'));
    return this.channel.createRequest(command, timeoutMs, payload => {
      this.input.write(JSON.stringify(payload) + '\n');
    });
  }
  public async requestOk(command: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
    const result = await this.request(command, timeoutMs);
    if (result && typeof result === 'object') {
      if ('success' in result && result.success === false)
        throw new Error('error' in result && typeof result.error === 'string' ? result.error : 'Shared request refused');
      if ('data' in result && result.data !== undefined) return result.data;
      if ('result' in result) return result.result;
    }
    return result;
  }
  public kill(): void { this.detached = true; this.input.end(); } // Detach only; NEVER native abort/close.
  public async closeGracefully(): Promise<void> { this.kill(); await this.done; }
}
