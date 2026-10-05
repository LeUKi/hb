ALTER TABLE `payment_duplicate_probes` ADD `backend_evidence_digest` text;
--> statement-breakpoint
CREATE TRIGGER payment_duplicate_probes_backend_evidence BEFORE UPDATE ON payment_duplicate_probes
WHEN (NEW.status='passed' AND (NEW.backend_evidence_digest IS NULL OR length(NEW.backend_evidence_digest)!=64
 OR NEW.backend_evidence_digest GLOB '*[^0-9a-f]*' OR NEW.backend_verified_at<NEW.protocol_verified_at))
 OR (OLD.backend_evidence_digest IS NOT NULL AND OLD.backend_evidence_digest IS NOT NEW.backend_evidence_digest)
BEGIN SELECT RAISE(ABORT, 'backend attestation digest and ordering must be preserved'); END;
