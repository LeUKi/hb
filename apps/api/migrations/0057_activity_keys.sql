-- 判定器的密钥参数 (docs/judge-key-design.md, 2026-11-01): a 代码判定红包's
-- 密钥 as its sender filled them, encrypted, never given to the code; the
-- gateway adds each to requests to its own address. Gone once it is over.
CREATE TABLE `activity_keys` (
	`activity_id` text PRIMARY KEY NOT NULL,
	`names` text NOT NULL,
	`ciphertext` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "activity_keys_shape" CHECK(json_valid("activity_keys"."names") AND json_type("activity_keys"."names") = 'array'
        AND json_array_length("activity_keys"."names") BETWEEN 1 AND 3
        AND typeof("activity_keys"."updated_at") = 'integer')
);
