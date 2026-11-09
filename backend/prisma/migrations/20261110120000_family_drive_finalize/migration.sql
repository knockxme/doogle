-- DropForeignKey
ALTER TABLE `auth_handoffs` DROP FOREIGN KEY `auth_handoffs_user_id_fkey`;

-- DropForeignKey
ALTER TABLE `files` DROP FOREIGN KEY `files_connected_account_id_fkey`;

-- DropForeignKey
ALTER TABLE `upload_routing_policies` DROP FOREIGN KEY `upload_routing_policies_user_id_fkey`;

-- DropIndex
DROP INDEX `files_connected_account_id_idx` ON `files`;

-- DropIndex
DROP INDEX `files_provider_file_id_idx` ON `files`;

-- AlterTable
ALTER TABLE `files` DROP COLUMN `connected_account_id`,
    DROP COLUMN `provider`,
    DROP COLUMN `provider_file_id`,
    MODIFY `encrypted_size_bytes` BIGINT NOT NULL,
    MODIFY `wrapped_file_key` TEXT NOT NULL;

-- DropTable
DROP TABLE `auth_handoffs`;

-- DropTable
DROP TABLE `upload_routing_policies`;

