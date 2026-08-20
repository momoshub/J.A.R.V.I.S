/**
 * Learnings repository - durable facts E.V. carries into every reply, curated
 * from the dashboard.
 */
import type { DbClient } from "./client.ts";
import type { Learning } from "../../domain/types.ts";

type Row = {
  id: number;
  content: string;
  created_by: string;
  created_at: number;
};

const toLearning = (row: Row): Learning => ({
  id: row.id,
  content: row.content,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

export type LearningsRepo = {
  list: () => Learning[];
  add: (content: string, createdBy: string, createdAt: number) => Learning;
  update: (id: number, content: string) => void;
  remove: (id: number) => void;
};

export const createLearningsRepo = (db: DbClient): LearningsRepo => {
  const listStmt = db.query<Row, []>(
    "SELECT * FROM learnings ORDER BY created_at ASC, id ASC",
  );
  const insertStmt = db.query(
    `INSERT INTO learnings (content, created_by, created_at)
     VALUES ($content, $createdBy, $createdAt) RETURNING *`,
  );
  const updateStmt = db.query(
    "UPDATE learnings SET content = $content WHERE id = $id",
  );
  const removeStmt = db.query("DELETE FROM learnings WHERE id = $id");

  return {
    list: () => listStmt.all().map(toLearning),
    add: (content, createdBy, createdAt) => {
      const row = insertStmt.get({
        $content: content,
        $createdBy: createdBy,
        $createdAt: createdAt,
      }) as Row;
      return toLearning(row);
    },
    update: (id, content) => {
      updateStmt.run({ $id: id, $content: content });
    },
    remove: (id) => {
      removeStmt.run({ $id: id });
    },
  };
};
