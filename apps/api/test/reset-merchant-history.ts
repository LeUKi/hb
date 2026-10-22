/** Reset only test fixtures; production never removes identity, configuration history or 开奖证明. */
export async function resetMerchantHistory(db: D1Database) {
  const triggers = await db
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('merchant_client_ids_no_delete','merchant_config_changes_no_delete','payment_identity_corrections_no_delete','activity_random_proofs_no_delete')",
    )
    .all<{ name: string; sql: string }>();
  await db.batch([
    ...triggers.results.map((trigger) =>
      db.prepare(`DROP TRIGGER "${trigger.name}"`),
    ),
    db.prepare("DELETE FROM payment_identity_corrections"),
    db.prepare("DELETE FROM merchant_config_changes"),
    db.prepare("DELETE FROM merchant_client_ids"),
    db.prepare("DELETE FROM activity_random_proofs"),
    ...triggers.results.map((trigger) => db.prepare(trigger.sql)),
  ]);
}
