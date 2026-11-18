import { EventEmitter } from 'node:events';
import type { Response } from 'express';

export type AppEventType =
  | 'task:created'
  | 'task:updated'
  | 'task:deleted'
  | 'message:created'
  | 'ping';

export interface AppEvent {
  type: AppEventType;
  taskId?: string;
  payload?: unknown;
  timestamp: string;
}

class AppEventBus extends EventEmitter {
  private sseClients = new Set<Response>();

  addSseClient(res: Response): void {
    this.sseClients.add(res);
    res.on('close', () => {
      this.sseClients.delete(res);
    });
  }

  broadcast(type: AppEventType, taskId?: string, payload?: unknown): void {
    const event: AppEvent = {
      type,
      taskId,
      payload,
      timestamp: new Date().toISOString(),
    };
    this.emit(type, event);
    const data = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(data);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }
}

export const eventBus = new AppEventBus();
