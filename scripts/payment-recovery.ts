// Local maintenance only. Never reads credentials or calls an upstream endpoint.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixed = {
  taskId: "871d607b-77bc-4653-9fdd-ad69bc4bf49a",
  source: "acceptance",
  acceptanceId: "hb-ldc-acceptance-20261004-tester7369",
  merchantId: "00000000-0000-4000-8000-000000000001",
  clientId: "0000000000000000000000000000000000000000000000000000000000000000",
  businessNo: "hb-ldc-acceptance-20261004-tester7369",
  recipientId: "100001",
  recipientUsername: "tester7369",
  amountMinor: 10,
  mode: "real",
};
// The original snapshot stays unchanged. This case-only correction was supplied
// by the user for the same stable recipient ID after the explicit rejection.
const correctedUsername = "Tester7369";
const modes = [
  "--plan",
  "--check-local",
  "--grant-local",
  "--revoke-local",
  "--probe-local",
  "--correct-username-local",
  "--verify-backoffice-local",
];
const mode = process.argv[2] ?? "--plan";
if (
  !modes.includes(mode) ||
  (process.argv.length > 3 && mode !== "--verify-backoffice-local")
)
  throw new Error(
    `Usage: bun scripts/payment-recovery.ts ${modes.join(" | ")} [evidence.json]`,
  );
if (
  mode === "--verify-backoffice-local" &&
  (!process.argv[3] || process.argv.length !== 4)
)
  throw new Error("A local, sanitized backend evidence JSON file is required");

function databases(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return databases(path);
    return entry.name.endsWith(".sqlite") && entry.name !== "metadata.sqlite"
      ? [path]
      : [];
  });
}

const paths = databases(join(root, ".wrangler/state/v3/d1"));
if (paths.length !== 1)
  throw new Error("Expected exactly one local D1 database");
const program = `
import hashlib,json,pathlib,sqlite3,sys,time
arg=json.load(sys.stdin);fixed=arg['fixed'];mode=arg['mode'];now=int(time.time()*1000)
digest=hashlib.sha256(json.dumps(fixed,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
corrected=dict(fixed);corrected['recipientUsername']=arg['correctedUsername']
corrected_digest=hashlib.sha256(json.dumps(corrected,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
readonly=mode in ('--plan','--check-local')
c=sqlite3.connect('file:'+arg['database']+('?mode=ro' if readonly else '?mode=rw'),uri=True,timeout=15)
c.row_factory=sqlite3.Row
c.execute('PRAGMA foreign_keys=ON')
try:
 if not readonly:c.execute('BEGIN IMMEDIATE')
 row=c.execute('SELECT * FROM payment_tasks WHERE id=?',(fixed['taskId'],)).fetchone()
 if row is None:raise ValueError('Original payment task is missing; never create a replacement')
 names={'taskId':'id','source':'source','acceptanceId':'acceptance_id','merchantId':'merchant_id','clientId':'client_id','businessNo':'business_no','recipientId':'recipient_id','recipientUsername':'recipient_username','amountMinor':'amount_minor','mode':'mode'}
 if any(row[col]!=fixed[key] for key,col in names.items()):raise ValueError('Immutable payment identity differs')
 acceptance=c.execute('SELECT send_consumed_at FROM payment_acceptances WHERE id=?',(fixed['acceptanceId'],)).fetchone()
 if not acceptance or acceptance[0] is None:raise ValueError('Original first-send history is missing')
 grant=c.execute('SELECT * FROM payment_retry_grants WHERE task_id=?',(fixed['taskId'],)).fetchone()
 if grant and (grant['parameter_digest']!=digest or grant['policy']!='same_order_v1' or grant['max_additional_sends']!=5):raise ValueError('Existing authorization differs')
 correction=c.execute('SELECT * FROM payment_username_corrections WHERE task_id=?',(fixed['taskId'],)).fetchone()
 if correction and (correction['original_username']!=fixed['recipientUsername'] or correction['corrected_username']!=arg['correctedUsername'] or correction['original_parameter_digest']!=digest or correction['corrected_parameter_digest']!=corrected_digest):raise ValueError('Existing username correction differs')
 if mode=='--correct-username-local' and not correction:
  if not grant or grant['revoked_at'] is not None or grant['expires_at']<=now or grant['used_additional_sends']>=grant['max_additional_sends']:raise ValueError('An unexpired original recovery budget is required')
  if fixed['recipientUsername']==arg['correctedUsername'] or fixed['recipientUsername'].lower()!=arg['correctedUsername'].lower():raise ValueError('Only the explicitly supplied case correction is allowed')
  lease=c.execute('SELECT lease_token FROM merchants WHERE id=?',(fixed['merchantId'],)).fetchone()
  if not lease or lease[0] is not None:raise ValueError('A merchant operation is active; retry after it finishes')
  if row['send_block_reason']!='recipient' or row['status']=='confirmed' or row['order_observed_at'] is not None or row['external_order_id'] is not None or row['send_acknowledged_at'] is not None:raise ValueError('Only an unobserved order rejected for recipient matching may be corrected')
  c.execute('INSERT INTO payment_username_corrections(task_id,original_username,corrected_username,original_parameter_digest,corrected_parameter_digest,created_at) VALUES(?,?,?,?,?,?)',(fixed['taskId'],fixed['recipientUsername'],arg['correctedUsername'],digest,corrected_digest,now))
  correction=c.execute('SELECT * FROM payment_username_corrections WHERE task_id=?',(fixed['taskId'],)).fetchone()
 effective_digest=corrected_digest if correction else digest
 if mode=='--grant-local' and not grant:
  lease=c.execute('SELECT lease_token FROM merchants WHERE id=?',(fixed['merchantId'],)).fetchone()
  if not lease or lease[0] is not None:raise ValueError('A merchant operation is active; retry authorization after it finishes')
  c.execute("INSERT INTO payment_retry_grants(task_id,parameter_digest,created_at,expires_at) VALUES(?,?,?,?)",(fixed['taskId'],digest,now,now+86400000))
  c.execute("UPDATE payment_tasks SET next_action='query',next_query_at=MAX(?,COALESCE(query_retry_after_at,0)),next_run_at=MAX(?,COALESCE(query_retry_after_at,0)),next_send_at=COALESCE(next_send_at,?),recovery_version=recovery_version+1 WHERE id=? AND status!='confirmed'",(now,now,now+10000,fixed['taskId']))
 if mode=='--revoke-local' and grant:
  c.execute('UPDATE payment_retry_grants SET revoked_at=COALESCE(revoked_at,?) WHERE task_id=?',(now,fixed['taskId']))
 if mode=='--probe-local':
  if row['status']!='confirmed' or not row['external_order_id']:raise ValueError('Original order must first be independently confirmed')
  if not grant or grant['revoked_at'] is not None or grant['expires_at']<=now:raise ValueError('Authorization is absent, revoked or expired')
  if correction:
   receipt=c.execute("SELECT 1 FROM payment_attempts WHERE task_id=? AND operation='send' AND purpose='recovery' AND outcome='succeeded' AND finished_at=? AND recipient_username=? AND parameter_digest=?",(fixed['taskId'],row['send_acknowledged_at'],arg['correctedUsername'],effective_digest)).fetchone()
   if not receipt:raise ValueError('A corrected send receipt is required to prove the probe repeats the confirmed request')
  existing=c.execute('SELECT * FROM payment_duplicate_probes WHERE task_id=?',(fixed['taskId'],)).fetchone()
  if not existing:
   c.execute('INSERT INTO payment_duplicate_probes(task_id,baseline_external_order_id,parameter_digest,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?)',(fixed['taskId'],row['external_order_id'],effective_digest,now,now,now))
  elif existing['baseline_external_order_id']!=row['external_order_id'] or existing['parameter_digest']!=effective_digest:raise ValueError('Probe identity differs')
 if mode=='--verify-backoffice-local':
  proof=json.loads(pathlib.Path(arg['evidence']).read_text())
  probe=c.execute('SELECT * FROM payment_duplicate_probes WHERE task_id=?',(fixed['taskId'],)).fetchone()
  if not probe or not probe['protocol_verified_at'] or not probe['permit_consumed_at']:raise ValueError('Protocol confirmation is incomplete')
  if probe['status'] not in ('awaiting_evidence','passed'):raise ValueError('Probe is not ready for backend evidence')
  for key in ('taskId','clientId','businessNo','amountMinor','recipientId'):
   if proof.get(key)!=fixed[key]:raise ValueError('Backend evidence identity differs')
  if proof.get('externalOrderId')!=probe['baseline_external_order_id'] or proof.get('matchingOrderCount')!=1 or proof.get('noSecondCorrespondingDebit') is not True:raise ValueError('Backend evidence does not confirm uniqueness')
  checked=proof.get('checkedAtMs')
  if not isinstance(checked,int) or checked<probe['protocol_verified_at'] or checked<probe['permit_consumed_at'] or checked>now or now-checked>3600000:raise ValueError('Backend evidence timestamp is stale or invalid')
  if not proof.get('evidenceFiles'):raise ValueError('Backend evidence file references are missing')
  hashes=[]
  for path in proof['evidenceFiles']:
   p=pathlib.Path(path)
   if not p.is_absolute() or not p.is_file() or p.stat().st_size==0:raise ValueError('Backend evidence file missing or empty')
   hashes.append({'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
  evidence_digest=hashlib.sha256(json.dumps({'proof':proof,'files':hashes},ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
  if probe['backend_evidence_digest'] is not None and probe['backend_evidence_digest']!=evidence_digest:raise ValueError('Previously recorded backend evidence differs')
  lease=c.execute('SELECT lease_token FROM merchants WHERE id=?',(fixed['merchantId'],)).fetchone()
  if not lease or lease[0] is not None:raise ValueError('A merchant operation is still active; record evidence after reconciliation')
  c.execute("UPDATE payment_duplicate_probes SET backend_verified_at=COALESCE(backend_verified_at,?),backend_evidence_digest=COALESCE(backend_evidence_digest,?),status='passed',reason=NULL,updated_at=? WHERE task_id=?",(checked,evidence_digest,now,fixed['taskId']))
  c.execute('UPDATE merchants SET active_task_id=NULL,paused_reason=NULL,updated_at=? WHERE id=? AND active_task_id=? AND lease_token IS NULL',(now,fixed['merchantId'],fixed['taskId']))
 if not readonly:c.commit()
 task=c.execute('SELECT id,status,reason,attempt_count,reconciliation_count,unknown_outcome,external_order_id,next_action,next_send_at,send_block_reason,order_evidence FROM payment_tasks WHERE id=?',(fixed['taskId'],)).fetchone()
 grant=c.execute('SELECT * FROM payment_retry_grants WHERE task_id=?',(fixed['taskId'],)).fetchone()
 probe=c.execute('SELECT * FROM payment_duplicate_probes WHERE task_id=?',(fixed['taskId'],)).fetchone()
 print(json.dumps({'mode':mode,'fixed':fixed,'parameterDigest':digest,'effectiveRecipientUsername':arg['correctedUsername'] if correction else fixed['recipientUsername'],'effectiveParameterDigest':effective_digest,'usernameCorrection':dict(correction) if correction else None,'firstSendConsumedAt':acceptance[0],'task':dict(task),'retryAuthorization':dict(grant) if grant else None,'duplicateProbe':dict(probe) if probe else None,'networkRequests':0},ensure_ascii=False,indent=2))
finally:c.close()
`;
try {
  const output = execFileSync("python3", ["-c", program], {
    input: JSON.stringify({
      mode,
      fixed,
      correctedUsername,
      database: paths[0],
      evidence: process.argv[3],
    }),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  process.stdout.write(output);
} catch {
  // Python reports only predefined diagnostic text, never credentials or SQL data.
  process.exitCode = 1;
}
