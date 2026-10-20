import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { runSharedHost } from "../provider/runner/shared-host.ts";
import { RunnerRpcChannel } from "../provider/host/runner-rpc-channel.ts";
import type { RunnerProcessOptions } from "../provider/host/runner-process.ts";
import type { RunnerEvent } from "../provider/host/types.ts";
import type { DurableView } from "../provider/runner/runtime-types.ts";

type Recovery = {
  onDisconnect(error: Error): void;
  onReconnect(view: DurableView): Promise<void>;
};

/** Shared-only client. Reconnect attaches to the SAME socket, never retries a command. */
export class SharedHostClient {
  public exited = false;
  private input = new PassThrough();
  private readonly channel = new RunnerRpcChannel();
  private readonly done: Promise<void>;
  private readonly lifetime = new AbortController();
  private detached = false;
  private latestConversationIds: readonly number[] = [];
  private latestView?: DurableView;
  public get view(): DurableView | undefined { return this.latestView; }
  private connected = false;
  private connectionReady!: Promise<void>;
  private connectionResolve!: () => void;
  private connectionReject!: (error: Error) => void;
  public get conversationIds(): readonly number[] { return this.latestConversationIds; }

  constructor(socketPath: string, cwd: string,
    callbacks: Pick<RunnerProcessOptions, 'onEvent' | 'onChannelMessage' | 'onError' | 'onExit'>,
    onConversationIds?: (ids: readonly number[]) => void,
    recovery?: Recovery) {
    this.resetReady();
    this.done = this.run(socketPath, cwd, callbacks, onConversationIds, recovery).then(() => {
      this.exited = true;
      this.connectionReject(new Error('Shared host client detached'));
      this.channel.failAll(new Error('Shared host client detached'));
      callbacks.onExit?.(0, null);
    }, error => {
      this.exited = true;
      const failure = error instanceof Error ? error : new Error('Shared host client failed');
      this.connectionReject(failure);
      this.channel.failAll(failure);
      callbacks.onError?.(failure);
    });
  }

  private resetReady(): void {
    this.connectionReady = new Promise((resolve, reject) => { this.connectionResolve = resolve; this.connectionReject = reject; });
    void this.connectionReady.catch(() => {});
  }

  public async whenConnected(): Promise<void> { await this.connectionReady; }

  private async run(socketPath: string, cwd: string,
    callbacks: Pick<RunnerProcessOptions, 'onEvent' | 'onChannelMessage' | 'onError' | 'onExit'>,
    onConversationIds?: (ids: readonly number[]) => void, recovery?: Recovery): Promise<void> {
    let reconnect = false, initialReady = false, backoff = 250;
    while (!this.detached) {
      let accepting = !reconnect, transportFailed = false, buffered: RunnerEvent[] = [], bufferedBytes = 0;
      let authorization: Promise<void> = Promise.resolve(), refused: Error | undefined;
      try {
        await runSharedHost(socketPath, cwd, this.input, frame => {
          if (!frame || typeof frame !== 'object' || !('type' in frame) || typeof frame.type !== 'string') return;
          const event: RunnerEvent = { ...frame, type: frame.type };
          if (this.channel.handleIncoming(event) || this.detached) return;
          if (accepting) callbacks.onEvent?.(event);
          else {
            bufferedBytes += Buffer.byteLength(JSON.stringify(event));
            if (bufferedBytes > 8 * 1024 * 1024) throw new Error('Shared reconnect event buffer exceeds bound');
            buffered.push(event);
          }
        }, frame => {
          if (this.detached) return;
          this.connected = true; // Authority RPCs may run; controls still await connectionReady.
          if (!reconnect) {
            initialReady = true;
            callbacks.onChannelMessage?.(frame);
            this.connectionResolve();
          } else {
            authorization = (async () => {
              await recovery!.onReconnect((frame as { view: DurableView }).view);
              if (this.detached || !this.connected) return;
              accepting = true;
              for (const event of buffered) callbacks.onEvent?.(event);
              buffered = [];
              this.connectionResolve();
              backoff = 250;
            })().catch(error => {
              // A lost authority RPC is not an authority denial. Recheck it on the next transport.
              if (!transportFailed) refused = error instanceof Error ? error : new Error('Shared reconnect authorization failed');
              this.input.end();
            });
          }
        }, ids => {
          if (this.detached) return;
          this.latestConversationIds = ids;
          onConversationIds?.(ids);
        }, view => { this.latestView = view; });
        if (!this.detached && !refused) throw new Error('Shared host disconnected');
      } catch (error) {
        transportFailed = true;
        this.connected = false;
        const failure = error instanceof Error ? error : new Error('Shared host client failed');
        this.channel.failAll(failure); // An uncertain prompt/steer/abort is NEVER replayed.
        await authorization;
        if (refused) throw refused;
        if (this.detached) break;
        if (!recovery || !initialReady) throw failure;
        recovery.onDisconnect(failure);
        if (!reconnect || accepting) this.resetReady();
        reconnect = true;
        try { await delay(backoff, undefined, { signal: this.lifetime.signal }); }
        catch { break; }
        backoff = Math.min(backoff * 2, 5000);
        this.input = new PassThrough();
      }
      if (refused) throw refused;
    }
  }

  public request(command: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
    if (this.exited || !this.connected || this.input.writableEnded) return Promise.reject(new Error('Shared host client is not connected'));
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
  public kill(): void { this.detached = true; this.connected = false; this.lifetime.abort(); this.input.end(); }
  public async closeGracefully(): Promise<void> { this.kill(); await this.done; }
}
