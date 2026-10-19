import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, isAbsolute } from 'node:path';
import type { ConversationId } from '@earendil-works/pi-durable';
import type { NativeChildRegistrationRequest } from "./subagent.ts";

const PROTOCOL = 'bb-native-child-registration/v1';
const MAX_FRAME_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

export type NativeChildRegistrationReceipt = Readonly<{
  requestId: string;
  conversationId: ConversationId;
  providerId: string;
  sessionId: string;
  /** Trusted parent from the active mapped provider slot; not returned by Core. */
  parentThreadId: string;
  /** Exact threadId returned by the authenticated register-existing route. */
  threadId: string;
}>;

type ResultFrame = {
  protocol: typeof PROTOCOL;
  type: 'result';
  id: string;
  success: boolean;
  receipt?: NativeChildRegistrationReceipt;
  error?: string;
};

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateReceipt(frame: ResultFrame, id: string, request: NativeChildRegistrationRequest): NativeChildRegistrationReceipt {
  const receipt = frame.receipt;
  if (frame.protocol !== PROTOCOL || frame.type !== 'result' || frame.id !== id || frame.success !== true ||
      !receipt || receipt.requestId !== request.requestId || receipt.conversationId !== request.conversationId ||
      ![receipt.providerId, receipt.sessionId, receipt.parentThreadId, receipt.threadId].every(nonEmpty)) {
    throw new Error(typeof frame.error === 'string' && frame.error ? frame.error : 'Native child RPC returned an invalid or uncorrelated result');
  }
  return receipt;
}

/** One request per private Unix-socket connection; caller identity is derived by the provider server, never sent by the extension. */
export async function registerNativeChildOverSocket(
  socketPath: string,
  request: NativeChildRegistrationRequest,
): Promise<NativeChildRegistrationReceipt> {
  if (!isAbsolute(socketPath) || !nonEmpty(request.requestId) ||
      !Number.isSafeInteger(request.conversationId) || request.conversationId <= 0 ||
      (request.title !== undefined && (!nonEmpty(request.title) || request.title.length > 500))) {
    throw new TypeError('Native child RPC requires an absolute socket and valid child request identity');
  }
  const [socketInfo, directoryInfo] = await Promise.all([lstat(socketPath), lstat(dirname(socketPath))]);
  const uid = process.getuid?.();
  if (!socketInfo.isSocket() || !directoryInfo.isDirectory() || uid === undefined ||
      socketInfo.uid !== uid || directoryInfo.uid !== uid ||
      (socketInfo.mode & 0o077) !== 0 || (directoryInfo.mode & 0o077) !== 0) {
    throw new Error('Native child RPC socket must be private and user-owned');
  }

  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    let settled = false;
    const finish = (error?: Error, receipt?: NativeChildRegistrationReceipt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(receipt!);
    };
    const timer = setTimeout(() => finish(new Error('Native child RPC timed out')), REQUEST_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(JSON.stringify({ protocol: PROTOCOL, type: 'register-existing', id,
        requestId: request.requestId, conversationId: request.conversationId,
        ...(request.title === undefined ? {} : { title: request.title }) }) + '\n');
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
        finish(new Error('Native child RPC response exceeds the frame limit'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      if (buffer.slice(newline + 1).trim()) {
        finish(new Error('Native child RPC returned multiple frames for one request'));
        return;
      }
      try {
        finish(undefined, validateReceipt(JSON.parse(line) as ResultFrame, id, request));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once('error', error => finish(error));
    socket.once('close', () => {
      if (!settled) finish(new Error('Native child RPC closed without a result'));
    });
  });
}
