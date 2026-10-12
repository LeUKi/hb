CREATE INDEX `activities_admin_created_idx` ON `activities` (`created_at` DESC, `id` DESC) WHERE `deleted_at` IS NULL;--> statement-breakpoint
CREATE INDEX `users_created_idx` ON `users` (`created_at` DESC, `id` DESC);--> statement-breakpoint
CREATE INDEX `payment_tasks_admin_time_idx` ON `payment_tasks` (`created_at` DESC, `id` DESC);--> statement-breakpoint
CREATE INDEX `payment_tasks_admin_status_time_idx` ON `payment_tasks` (`status`, `created_at` DESC, `id` DESC);--> statement-breakpoint
CREATE INDEX `payment_tasks_admin_mode_status_time_idx` ON `payment_tasks` (`mode`, `status`, `created_at` DESC, `id` DESC);--> statement-breakpoint
CREATE INDEX `login_setting_changes_time_idx` ON `login_setting_changes` (`created_at` DESC, `id` DESC);
