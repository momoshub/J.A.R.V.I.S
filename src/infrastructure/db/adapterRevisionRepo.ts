/**
 * Adapter revisions - every committed state of the memory directory.
 *
 * A snapshot per commit, so a curation that went wrong is `adapter revert <n>`
 * rather than a reconstruction from memory. The thing being undone is usually a
 * refine pass that merged two notes badly or dropped one it should have kept,
 * and noticing that happens days later.
 */
import type { DbClient } from "./client.ts";

export type AdapterRevision = {
  readonly id: number;
  readonly createdAt: number;
  readonly createdBy: string;
  readonly reason: string;
  readonly files: ReadonlyMap<string, string>;
};

type Row = {
  id: number;
  created_at: number;
  created_by: string;
  reason: string;
  files: string;
};

/** Summary of a revision, without carrying its whole snapshot around. */
export type AdapterRevisionInfo = Omit<AdapterRevision, "files"> & { readonly fileCount: number };

const toRevision = (row: Row): AdapterRevision => ({
  id: row.id,
  createdAt: row.created_at,
  createdBy: row.created_by,
  reason: row.reason,
  files: new Map(Object.entries(JSON.parse(row.files) as Record<string, string>)),
});

export type AdapterRevisionRepo = {
  readonly record: (
    files: ReadonlyMap<string, string>,
    reason: string,
    createdBy: string,
    createdAt: number,
  ) => AdapterRevisionInfo;
  readonly list: (limit?: number) => AdapterRevisionInfo[];
  readonly get: (id: number) => AdapterRevision | undefined;
  readonly latest: () => AdapterRevision | undefined;
};

export const createAdapterRevisionRepo = (db: DbClient): AdapterRevisionRepo => {
  const insertStmt = db.query<Row, { $files: string; $reason: string; $createdBy: string; $createdAt: number }>(
    `INSERT INTO adapter_revisions (files, reason, created_by, created_at)
     VALUES ($files, $reason, $createdBy, $createdAt) RETURNING *`,
  );
  const listStmt = db.query<Row, { $limit: number }>(
    "SELECT * FROM adapter_revisions ORDER BY id DESC LIMIT $limit",
  );
  const getStmt = db.query<Row, { $id: number }>("SELECT * FROM adapter_revisions WHERE id = $id");
  const latestStmt = db.query<Row, []>("SELECT * FROM adapter_revisions ORDER BY id DESC LIMIT 1");

  const info = (row: Row): AdapterRevisionInfo => ({
    id: row.id,
    createdAt: row.created_at,
    createdBy: row.created_by,
    reason: row.reason,
    fileCount: Object.keys(JSON.parse(row.files) as Record<string, string>).length,
  });

  return {
    record: (files, reason, createdBy, createdAt) =>
      info(
        insertStmt.get({
          $files: JSON.stringify(Object.fromEntries(files)),
          $reason: reason,
          $createdBy: createdBy,
          $createdAt: createdAt,
        }) as Row,
      ),
    list: (limit = 20) => listStmt.all({ $limit: limit }).map(info),
    get: (id) => {
      const row = getStmt.get({ $id: id });
      return row ? toRevision(row) : undefined;
    },
    latest: () => {
      const row = latestStmt.get();
      return row ? toRevision(row) : undefined;
    },
  };
};
