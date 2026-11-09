-- AlterTable
ALTER TABLE `connected_accounts` ADD COLUMN `cap_bytes` BIGINT NULL,
    ADD COLUMN `paused_until` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `files` ADD COLUMN `enc_version` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `encrypted_size_bytes` BIGINT NULL,
    ADD COLUMN `wrapped_file_key` TEXT NULL;

-- AlterTable
ALTER TABLE `upload_sessions` ADD COLUMN `file_id` CHAR(36) NULL,
    ADD COLUMN `wrapped_file_key` TEXT NULL;

-- AlterTable
ALTER TABLE `users` ADD COLUMN `must_change_password` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `role` VARCHAR(32) NOT NULL DEFAULT 'member',
    ADD COLUMN `storage_limit_bytes` BIGINT NULL;

-- CreateTable
CREATE TABLE `app_settings` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `default_account_cap_bytes` BIGINT NULL,
    `master_key_fingerprint` VARCHAR(128) NULL,
    `routing_mode` VARCHAR(32) NOT NULL DEFAULT 'most_available',
    `priority_account_ids` JSON NOT NULL,
    `round_robin_cursor` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `file_replicas` (
    `id` CHAR(36) NOT NULL,
    `file_id` CHAR(36) NOT NULL,
    `connected_account_id` CHAR(36) NOT NULL,
    `provider_file_id` VARCHAR(191) NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'healthy',
    `size_bytes` BIGINT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `file_replicas_connected_account_id_status_idx`(`connected_account_id`, `status`),
    UNIQUE INDEX `file_replicas_file_id_connected_account_id_key`(`file_id`, `connected_account_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `upload_session_replicas` (
    `id` CHAR(36) NOT NULL,
    `upload_session_id` CHAR(36) NOT NULL,
    `connected_account_id` CHAR(36) NOT NULL,
    `session_uri_encrypted` TEXT NULL,
    `s3_upload_id` VARCHAR(255) NULL,
    `provider_file_id` VARCHAR(191) NULL,
    `reserved_bytes` BIGINT NOT NULL,
    `part_etags` JSON NULL,

    INDEX `upload_session_replicas_upload_session_id_idx`(`upload_session_id`),
    INDEX `upload_session_replicas_connected_account_id_idx`(`connected_account_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `orphan_blobs` (
    `id` CHAR(36) NOT NULL,
    `connected_account_id` CHAR(36) NOT NULL,
    `provider_file_id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `orphan_blobs_connected_account_id_idx`(`connected_account_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `repair_jobs` (
    `id` CHAR(36) NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'running',
    `processed` INTEGER NOT NULL DEFAULT 0,
    `failed` INTEGER NOT NULL DEFAULT 0,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finished_at` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `file_replicas` ADD CONSTRAINT `file_replicas_file_id_fkey` FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `file_replicas` ADD CONSTRAINT `file_replicas_connected_account_id_fkey` FOREIGN KEY (`connected_account_id`) REFERENCES `connected_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `upload_session_replicas` ADD CONSTRAINT `upload_session_replicas_upload_session_id_fkey` FOREIGN KEY (`upload_session_id`) REFERENCES `upload_sessions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `orphan_blobs` ADD CONSTRAINT `orphan_blobs_connected_account_id_fkey` FOREIGN KEY (`connected_account_id`) REFERENCES `connected_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
