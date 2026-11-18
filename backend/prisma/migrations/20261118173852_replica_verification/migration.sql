-- AlterTable
ALTER TABLE `file_replicas` ADD COLUMN `last_verified_at` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `file_replicas_status_last_verified_at_idx` ON `file_replicas`(`status`, `last_verified_at`);
