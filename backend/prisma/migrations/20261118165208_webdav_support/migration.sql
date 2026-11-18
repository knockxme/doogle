-- AlterTable
ALTER TABLE `files` ADD COLUMN `content_modified_at` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `upload_sessions` ADD COLUMN `last_activity_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- AlterTable
ALTER TABLE `users` ADD COLUMN `dav_enabled` BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX `files_user_id_folder_id_name_idx` ON `files`(`user_id`, `folder_id`, `name`);

-- CreateIndex
CREATE INDEX `folders_user_id_parent_id_name_idx` ON `folders`(`user_id`, `parent_id`, `name`);

-- Existing files: content time is when they were uploaded.
UPDATE `files` SET `content_modified_at` = `created_at` WHERE `content_modified_at` IS NULL;
