CREATE TABLE `error_sample` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`route` text NOT NULL,
	`status` integer NOT NULL,
	`message` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_run` (
	`name` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`ran_at` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE `metric_rollup` (
	`day` text NOT NULL,
	`metric` text NOT NULL,
	`dim` text DEFAULT '' NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `metric`, `dim`)
);
