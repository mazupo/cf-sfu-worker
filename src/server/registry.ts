import { DurableObject } from "cloudflare:workers";

/** The one Registry of this worker. Each deployment has its own Durable Object namespace. */
export const REGISTRY_NAME = "registry";

/** What a room holds now, as the Room knows it. */
export type RoomSummary = {
  /** Viewers with an open socket. */
  viewers: number;
  /** Viewers whose socket closed and who may still come back. */
  away: number;
  /** Viewers that joined with data channels. */
  ipcViewers: number;
  /** Member devices. The Room knows a device's state only while someone watches it. */
  devices: { deviceId: string; state: string | null }[];
};

export type RegistryRoom = RoomSummary & { roomId: string; updatedAt: number };

/**
 * Remembers which rooms have viewers or devices, for the dashboard. Durable Objects cannot list
 * their instances, so each Room reports here when it changes, and once a minute while it is in use.
 */
export class Registry extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID`,
    );
  }

  /** A room's latest state. `null`: the room is empty. */
  async report(roomId: string, summary: RoomSummary | null): Promise<void> {
    if (!summary) {
      this.sql.exec("DELETE FROM rooms WHERE room_id = ?", roomId);
      return;
    }
    this.sql.exec(
      `INSERT INTO rooms (room_id, summary, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (room_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at`,
      roomId,
      JSON.stringify(summary),
      Date.now(),
    );
  }

  async rooms(): Promise<RegistryRoom[]> {
    return this.sql
      .exec<{ room_id: string; summary: string; updated_at: number }>("SELECT * FROM rooms ORDER BY room_id")
      .toArray()
      .map((row) => ({ roomId: row.room_id, updatedAt: row.updated_at, ...(JSON.parse(row.summary) as RoomSummary) }));
  }
}
