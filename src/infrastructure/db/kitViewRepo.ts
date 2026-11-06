/**
 * Modals the brain stored for a `jv:modal:<id>` button to open.
 *
 * Read once per click, written once per modal, so there is no cache.
 */
import { randomBytes } from "node:crypto";
import type { DbClient } from "./client.ts";
import type { KitView } from "../../domain/kitEvents.ts";

export type KitViewRepo = {
  /** Stores the view and returns the id its button points at. */
  save: (view: KitView, at: number) => string;
  get: (id: string) => KitView | undefined;
};

type Row = { view: string };

export const createKitViewRepo = (db: DbClient): KitViewRepo => {
  const insertStmt = db.query("INSERT INTO kit_views (id, view, created_at) VALUES ($id, $view, $at)");
  const getStmt = db.query<Row, [string]>("SELECT view FROM kit_views WHERE id = ?");
  return {
    save: (view, at) => {
      const id = randomBytes(6).toString("hex");
      insertStmt.run({ $id: id, $view: JSON.stringify(view), $at: at });
      return id;
    },
    get: (id) => {
      const row = getStmt.get(id);
      if (!row) return undefined;
      try {
        return JSON.parse(row.view) as KitView;
      } catch {
        return undefined;
      }
    },
  };
};
