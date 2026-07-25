// Tag helpers. Tags are shared across works via the work_tags join; they are
// created on write (by name) and never explicitly managed by the client.

// Ensure each name exists in `tags` (create-on-write) and return the id for each
// distinct, non-empty name in input order.
async function ensureTags({
  env,
  names,
}: {
  env: Env;
  names: string[];
}): Promise<string[]> {
  const distinct = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (distinct.length === 0) return [];

  const statements = distinct.map((name) =>
    // UNIQUE(name) makes this idempotent; a fresh id is only used when new.
    env.DB.prepare(
      "INSERT INTO tags (id, name) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
    ).bind(crypto.randomUUID(), name),
  );
  await env.DB.batch(statements);

  const placeholders = distinct.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, name FROM tags WHERE name IN (${placeholders})`,
  )
    .bind(...distinct)
    .all<{ id: string; name: string }>();
  const byName = new Map(results.map((r) => [r.name, r.id]));
  return distinct.map((n) => byName.get(n)).filter((id): id is string => !!id);
}

// Replace a work's full tag set with the given names (create-on-write). Clears
// existing links first, so passing [] removes all tags. Does not garbage-collect
// now-unreferenced tag rows — harmless, and keeps a stable tag vocabulary.
export async function setWorkTags({
  env,
  workId,
  names,
}: {
  env: Env;
  workId: string;
  names: string[];
}): Promise<void> {
  const tagIds = await ensureTags({ env, names });
  const statements = [
    env.DB.prepare("DELETE FROM work_tags WHERE work_id = ?").bind(workId),
    ...tagIds.map((tagId) =>
      env.DB.prepare(
        "INSERT INTO work_tags (work_id, tag_id) VALUES (?, ?)",
      ).bind(workId, tagId),
    ),
  ];
  await env.DB.batch(statements);
}

// Read a work's tag names.
export async function getWorkTags({
  env,
  workId,
}: {
  env: Env;
  workId: string;
}): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT t.name FROM work_tags wt JOIN tags t ON wt.tag_id = t.id
      WHERE wt.work_id = ? ORDER BY t.name`,
  )
    .bind(workId)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}
