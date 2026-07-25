-- Migration number: 0003 	 2026-07-19

-- Works: the abstract book (e.g. المغني). A book row is one *copy/scan* of a
-- work; multiple copies (different scans, volumes, editions) share one work_id.
-- Legacy books have work_id NULL and render standalone until manually assigned.
CREATE TABLE works (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,            -- the title
  author     TEXT,                     -- null until known
  created_at INTEGER NOT NULL
);

-- Copy -> work link. Nullable: NULL = ungrouped/flat.
ALTER TABLE books ADD COLUMN work_id TEXT REFERENCES works(id);
CREATE INDEX idx_books_work ON books (work_id);

-- Tags live on the work (all copies of a work share them). Many-to-many.
CREATE TABLE tags (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE work_tags (
  work_id TEXT NOT NULL REFERENCES works(id),
  tag_id  TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (work_id, tag_id)
);
CREATE INDEX idx_work_tags_tag ON work_tags (tag_id);
