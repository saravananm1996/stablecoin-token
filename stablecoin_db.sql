-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1
-- Generation Time: Jun 12, 2026 at 07:10 AM
-- Server version: 10.4.32-MariaDB
-- PHP Version: 8.2.12

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `stablecoin_db`
--

DELIMITER $$
--
-- Procedures
--
CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_apply_tds` (IN `p_transaction_id` BIGINT, IN `p_rate_percent` DECIMAL(7,4))   BEGIN
  DECLARE v_amount DECIMAL(36,18);
  DECLARE v_tds DECIMAL(36,18);
  DECLARE v_user_id BIGINT;

  IF p_rate_percent < 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TDS rate must be non-negative';
  END IF;

  START TRANSACTION;
    SELECT amount, user_id INTO v_amount, v_user_id FROM transactions
      WHERE id = p_transaction_id FOR UPDATE;

    IF v_amount IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Transaction not found';
    END IF;

    SET v_tds = ROUND(v_amount * p_rate_percent / 100, 18);

    INSERT INTO tds_records (transaction_id, user_id, rate_percent, tds_amount, remarks, created_at)
      VALUES (p_transaction_id, v_user_id, p_rate_percent, v_tds, CONCAT('Applied via sp_apply_tds rate=', CAST(p_rate_percent AS CHAR)), NOW());

    UPDATE transactions SET tds_amount = v_tds WHERE id = p_transaction_id;
  COMMIT;
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_burn` (IN `p_user_id` BIGINT, IN `p_from_address` VARCHAR(100), IN `p_amount` DECIMAL(36,18), IN `p_admin_id` BIGINT, IN `p_note` TEXT)   BEGIN
  DECLARE v_tx_uuid CHAR(36);
  DECLARE v_token_symbol VARCHAR(32) DEFAULT 'FXC';
  DECLARE v_balance DECIMAL(36,18);

  IF p_amount <= 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Amount must be greater than zero';
  END IF;

  SET v_tx_uuid = LOWER(UUID());

  START TRANSACTION;
    -- lock and read balance
    SELECT balance INTO v_balance FROM balances
      WHERE user_id = p_user_id AND token_symbol = v_token_symbol FOR UPDATE;

    IF v_balance IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'No balance record found for user';
    END IF;

    IF v_balance < p_amount THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Insufficient balance for burn';
    END IF;

    -- insert transaction record
    INSERT INTO transactions
      (tx_uuid, user_id, from_address, to_address, amount, token_symbol, txn_type, status, meta_json, created_at, updated_at)
    VALUES
      (v_tx_uuid, p_user_id, p_from_address, NULL, p_amount, v_token_symbol, 'burn', 'confirmed', JSON_OBJECT('note', p_note), NOW(), NOW());

    -- update balance
    UPDATE balances
      SET balance = balance - p_amount,
          available_balance = GREATEST(available_balance - p_amount, 0),
          updated_at = NOW()
    WHERE user_id = p_user_id AND token_symbol = v_token_symbol;

    -- audit
    INSERT INTO audit_logs (admin_id, action_type, detail_json, created_at)
      VALUES (p_admin_id, 'burn', JSON_OBJECT('user_id', p_user_id, 'from_address', p_from_address, 'amount', CAST(p_amount AS CHAR), 'tx_uuid', v_tx_uuid, 'note', p_note), NOW());
  COMMIT;
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_internal_transfer` (IN `p_from_user` BIGINT, IN `p_to_user` BIGINT, IN `p_amount` DECIMAL(36,18), IN `from_address` VARCHAR(250), IN `to_address` VARCHAR(250), IN `p_admin_id` BIGINT, IN `p_note` TEXT)   BEGIN
  DECLARE v_tx_uuid CHAR(36);
  DECLARE v_token_symbol VARCHAR(32) DEFAULT 'FXC';
  DECLARE v_from_balance DECIMAL(36,18);

  IF p_from_user = p_to_user THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Sender and receiver cannot be the same';
  END IF;

  IF p_amount <= 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Amount must be greater than zero';
  END IF;

  SET v_tx_uuid = LOWER(UUID());

  START TRANSACTION;
    -- lock sender balance
    SELECT balance INTO v_from_balance FROM balances
      WHERE user_id = p_from_user AND token_symbol = v_token_symbol FOR UPDATE;

    IF v_from_balance IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Sender balance record not found';
    END IF;

    IF v_from_balance < p_amount THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Insufficient balance for internal transfer';
    END IF;

    -- debit sender
    UPDATE balances
      SET balance = balance - p_amount,
          available_balance = GREATEST(available_balance - p_amount, 0),
          updated_at = NOW()
    WHERE user_id = p_from_user AND token_symbol = v_token_symbol;

    -- credit receiver (insert if missing)
    INSERT INTO balances (user_id, token_symbol, balance, available_balance, updated_at)
      VALUES (p_to_user, v_token_symbol, p_amount, p_amount, NOW())
    ON DUPLICATE KEY UPDATE
      balance = balance + p_amount,
      available_balance = available_balance + p_amount,
      updated_at = NOW();

    -- create transaction record (single tx_uuid for both sides)
    INSERT INTO transactions
      (tx_uuid, user_id,to_user_id,from_address, to_address, amount, token_symbol, txn_type, status, meta_json, created_at, updated_at)
    VALUES
      (v_tx_uuid, p_from_user, p_to_user,from_address, to_address, p_amount, v_token_symbol, 'transfer', 'confirmed', JSON_OBJECT('to_user', p_to_user, 'note', p_note), NOW(), NOW());

    -- audit
    INSERT INTO audit_logs (admin_id, action_type, detail_json, created_at)
      VALUES (p_admin_id, 'internal_transfer', JSON_OBJECT('from_user', p_from_user, 'to_user', p_to_user, 'amount', CAST(p_amount AS CHAR), 'tx_uuid', v_tx_uuid, 'note', p_note), NOW());
  COMMIT;
END$$

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_mint` (IN `p_user_id` BIGINT, IN `p_to_address` VARCHAR(100), IN `p_amount` DECIMAL(36,18), IN `p_admin_id` BIGINT, IN `p_note` TEXT)   BEGIN
  DECLARE v_tx_uuid CHAR(36);
  DECLARE v_token_symbol VARCHAR(32) DEFAULT 'FXC';

  IF p_amount <= 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Amount must be greater than zero';
  END IF;

  SET v_tx_uuid = LOWER(UUID());

  START TRANSACTION;
    -- create transaction record (confirmed immediately for centralized ledger)
    INSERT INTO transactions
      (tx_uuid, user_id, from_address, to_address, amount, token_symbol, txn_type, status, meta_json, created_at, updated_at)
    VALUES
      (v_tx_uuid, p_user_id, NULL, p_to_address, p_amount, v_token_symbol, 'mint', 'confirmed', JSON_OBJECT('note', p_note), NOW(), NOW());

    -- upsert balances (create if missing)
    INSERT INTO balances (user_id, token_symbol, balance, available_balance, updated_at)
      VALUES (p_user_id, v_token_symbol, p_amount, p_amount, NOW())
    ON DUPLICATE KEY UPDATE
      balance = balance + p_amount,
      available_balance = available_balance + p_amount,
      updated_at = NOW();

    -- audit log
    INSERT INTO audit_logs (admin_id, action_type, detail_json, created_at)
      VALUES (p_admin_id, 'mint', JSON_OBJECT('user_id', p_user_id, 'to_address', p_to_address, 'amount', CAST(p_amount AS CHAR), 'tx_uuid', v_tx_uuid, 'note', p_note), NOW());
  COMMIT;
END$$

DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `audit_logs`
--

CREATE TABLE `audit_logs` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `admin_id` bigint(20) UNSIGNED DEFAULT NULL,
  `action_type` varchar(100) NOT NULL,
  `detail_json` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `audit_logs`
--

INSERT INTO `audit_logs` (`id`, `admin_id`, `action_type`, `detail_json`, `created_at`) VALUES
(1, NULL, 'internal_transfer', NULL, '2025-11-06 12:36:46'),
(2, NULL, 'internal_transfer', NULL, '2025-11-12 12:02:20'),
(3, NULL, 'internal_transfer', NULL, '2025-11-12 12:13:26'),
(4, NULL, 'burn', '{\"user_id\": \"1\", \"from_address\": \"0xCA1bfEBB900c62f12F85DbBBaC05d1c7e0dD028D\", \"amount\": \"100.000000000000000000\", \"tx_uuid\": \"9940a613-c9f2-11f0-bdef-f8cab8068df2\", \"note\": \"Token Burn\"}', '2025-11-25 17:03:37'),
(5, NULL, 'burn', '{\"user_id\": \"1\", \"from_address\": \"0xCA1bfEBB900c62f12F85DbBBaC05d1c7e0dD028D\", \"amount\": \"500.000000000000000000\", \"tx_uuid\": \"a55e1b4a-c9f2-11f0-bdef-f8cab8068df2\", \"note\": \"Token Burn\"}', '2025-11-25 17:03:57'),
(6, NULL, 'internal_transfer', '{\"from_user\": \"3\", \"to_user\": \"1\", \"amount\": \"500.000000000000000000\", \"tx_uuid\": \"58da8689-cb7d-11f0-81cf-f8cab8068df2\", \"note\": \"internal transfer\"}', '2025-11-27 16:09:27'),
(7, NULL, 'internal_transfer', '{\"from_user\": \"3\", \"to_user\": \"1\", \"amount\": \"200.000000000000000000\", \"tx_uuid\": \"64f3bda6-cb7d-11f0-81cf-f8cab8068df2\", \"note\": \"internal transfer\"}', '2025-11-27 16:09:47'),
(8, NULL, 'internal_transfer', '{\"from_user\": \"3\", \"to_user\": \"1\", \"amount\": \"150.000000000000000000\", \"tx_uuid\": \"2ff4c968-cb7e-11f0-81cf-f8cab8068df2\", \"note\": \"internal transfer\"}', '2025-11-27 16:15:27'),
(9, NULL, 'internal_transfer', '{\"from_user\": \"4\", \"to_user\": \"1\", \"amount\": \"300.000000000000000000\", \"tx_uuid\": \"3ec2af56-cb7e-11f0-81cf-f8cab8068df2\", \"note\": \"internal transfer\"}', '2025-11-27 16:15:52'),
(10, NULL, 'internal_transfer', '{\"from_user\": \"4\", \"to_user\": \"1\", \"amount\": \"100.000000000000000000\", \"tx_uuid\": \"43a05929-cb7e-11f0-81cf-f8cab8068df2\", \"note\": \"internal transfer\"}', '2025-11-27 16:16:00'),
(11, NULL, 'mint', '{\"user_id\": \"2\", \"to_address\": \"0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4\", \"amount\": \"250.000000000000000000\", \"tx_uuid\": \"9eb18d6a-cf60-11f0-9783-f8cab8068df2\", \"note\": \"Token Mint\"}', '2025-12-02 14:53:53'),
(12, NULL, 'burn', '{\"user_id\": \"4\", \"from_address\": \"0x7a5469Aa979E34B7C54937822ec1BD6b7864CA91\", \"amount\": \"500.000000000000000000\", \"tx_uuid\": \"c75046bb-cf60-11f0-9783-f8cab8068df2\", \"note\": \"Token Burn\"}', '2025-12-02 14:55:01'),
(13, NULL, 'burn', '{\"user_id\": \"2\", \"from_address\": \"0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4\", \"amount\": \"250.000000000000000000\", \"tx_uuid\": \"998dd785-cf61-11f0-9783-f8cab8068df2\", \"note\": \"Token Burn\"}', '2025-12-02 15:00:54'),
(14, NULL, 'burn', '{\"user_id\": \"2\", \"from_address\": \"0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4\", \"amount\": \"250.000000000000000000\", \"tx_uuid\": \"f5ddda9d-cf61-11f0-9783-f8cab8068df2\", \"note\": \"Token Burn\"}', '2025-12-02 15:03:29'),
(15, NULL, 'burn', '{\"user_id\": \"2\", \"from_address\": \"0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4\", \"amount\": \"250.000000000000000000\", \"tx_uuid\": \"078bc572-cf62-11f0-9783-f8cab8068df2\", \"note\": \"Token Burn\"}', '2025-12-02 15:03:58'),
(16, NULL, 'burn', '{\"user_id\": \"2\", \"from_address\": \"0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4\", \"amount\": \"250.000000000000000000\", \"tx_uuid\": \"2709931c-cf62-11f0-9783-f8cab8068df2\", \"note\": \"Token Burn\"}', '2025-12-02 15:04:51'),
(17, NULL, 'burn', '{\"user_id\": \"2\", \"from_address\": \"0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4\", \"amount\": \"200.000000000000000000\", \"tx_uuid\": \"38e9e438-cf62-11f0-9783-f8cab8068df2\", \"note\": \"Token Burn\"}', '2025-12-02 15:05:21'),
(18, NULL, 'burn', '{\"user_id\": \"2\", \"from_address\": \"0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4\", \"amount\": \"10.000000000000000000\", \"tx_uuid\": \"a263514d-cf62-11f0-9783-f8cab8068df2\", \"note\": \"Token Burn\"}', '2025-12-02 15:08:18'),
(19, NULL, 'burn', '{\"user_id\": \"4\", \"from_address\": \"0x7a5469Aa979E34B7C54937822ec1BD6b7864CA91\", \"amount\": \"56.000000000000000000\", \"tx_uuid\": \"0071f51c-cf63-11f0-9783-f8cab8068df2\", \"note\": \"Token Burn\"}', '2025-12-02 15:10:56'),
(20, NULL, 'mint', '{\"user_id\": \"2\", \"to_address\": \"0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4\", \"amount\": \"100.000000000000000000\", \"tx_uuid\": \"5371f34b-cf63-11f0-9783-f8cab8068df2\", \"note\": \"Token Mint\"}', '2025-12-02 15:13:15'),
(21, NULL, 'mint', '{\"user_id\": \"2\", \"to_address\": \"0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4\", \"amount\": \"50.000000000000000000\", \"tx_uuid\": \"1328f3c5-cf64-11f0-9783-f8cab8068df2\", \"note\": \"Token Mint\"}', '2025-12-02 15:18:37'),
(22, NULL, 'mint', '{\"user_id\": \"2\", \"to_address\": \"0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4\", \"amount\": \"100.000000000000000000\", \"tx_uuid\": \"5b923837-cf6e-11f0-9783-f8cab8068df2\", \"note\": \"Token Mint\"}', '2025-12-02 16:32:13'),
(23, NULL, 'internal_transfer', '{\"from_user\": \"1\", \"to_user\": \"5\", \"amount\": \"640.000000000000000000\", \"tx_uuid\": \"b520cdd0-d289-11f0-abca-f8cab8068df2\", \"note\": \"internal transfer\"}', '2025-12-06 15:25:33'),
(24, NULL, 'internal_transfer', '{\"from_user\": \"5\", \"to_user\": \"1\", \"amount\": \"40.000000000000000000\", \"tx_uuid\": \"a94fc0d7-d28a-11f0-abca-f8cab8068df2\", \"note\": \"internal transfer\"}', '2025-12-06 15:32:23'),
(25, NULL, 'internal_transfer', '{\"from_user\": \"1\", \"to_user\": \"5\", \"amount\": \"20.000000000000000000\", \"tx_uuid\": \"1ace1b12-d28c-11f0-abca-f8cab8068df2\", \"note\": \"internal transfer\"}', '2025-12-06 15:42:43'),
(26, NULL, 'internal_transfer', '{\"from_user\": \"1\", \"to_user\": \"5\", \"amount\": \"60.000000000000000000\", \"tx_uuid\": \"34491a49-d28c-11f0-abca-f8cab8068df2\", \"note\": \"internal transfer\"}', '2025-12-06 15:43:26'),
(27, NULL, 'mint', '{\"user_id\": \"3\", \"to_address\": \"3\", \"amount\": \"100.000000000000000000\", \"tx_uuid\": \"63f3541c-d4d1-11f0-82fc-f8cab8068df2\", \"note\": \"Token Mint\"}', '2025-12-09 13:03:42'),
(28, NULL, 'burn', '{\"user_id\": \"3\", \"from_address\": \"3\", \"amount\": \"10.000000000000000000\", \"tx_uuid\": \"7d673109-d4d1-11f0-82fc-f8cab8068df2\", \"note\": \"Token Burn\"}', '2025-12-09 13:04:25'),
(29, NULL, 'burn', '{\"user_id\": \"3\", \"from_address\": \"3\", \"amount\": \"10.000000000000000000\", \"tx_uuid\": \"7d6c6d8b-d4d1-11f0-82fc-f8cab8068df2\", \"note\": \"Token Burn\"}', '2025-12-09 13:04:25'),
(30, NULL, 'internal_transfer', '{\"from_user\": \"1\", \"to_user\": \"2\", \"amount\": \"100.000000000000000000\", \"tx_uuid\": \"82b58f99-d4d1-11f0-82fc-f8cab8068df2\", \"note\": \"internal transfer\"}', '2025-12-09 13:04:34'),
(31, NULL, 'burn', '{\"user_id\": \"3\", \"from_address\": \"3\", \"amount\": \"100.000000000000000000\", \"tx_uuid\": \"85a2cc91-d4d1-11f0-82fc-f8cab8068df2\", \"note\": \"Token Burn\"}', '2025-12-09 13:04:38');

-- --------------------------------------------------------

--
-- Table structure for table `balances`
--

CREATE TABLE `balances` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `user_id` bigint(20) UNSIGNED NOT NULL,
  `token_symbol` varchar(32) NOT NULL DEFAULT 'STBL',
  `balance` decimal(36,18) NOT NULL DEFAULT 0.000000000000000000,
  `available_balance` decimal(36,18) NOT NULL DEFAULT 0.000000000000000000,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `balances`
--

INSERT INTO `balances` (`id`, `user_id`, `token_symbol`, `balance`, `available_balance`, `updated_at`) VALUES
(1, 1, 'FXC', 9998860.000000000000000000, 9998860.000000000000000000, '2025-12-09 13:04:34'),
(2, 2, 'FXC', 400.000000000000000000, 400.000000000000000000, '2025-12-09 13:04:34'),
(4, 3, 'FXC', 930.000000000000000000, 930.000000000000000000, '2025-12-09 13:04:38'),
(9, 4, 'FXC', 44.000000000000000000, 44.000000000000000000, '2025-12-02 15:10:56'),
(11, 5, 'FXC', 680.000000000000000000, 680.000000000000000000, '2025-12-06 15:43:26');

-- --------------------------------------------------------

--
-- Table structure for table `bank_account`
--

CREATE TABLE `bank_account` (
  `bank_acc_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `account_holder_name` varchar(100) NOT NULL,
  `account_no` varchar(100) NOT NULL,
  `ifsc` varchar(100) NOT NULL,
  `bank_name` varchar(100) NOT NULL,
  `branch_name` varchar(250) DEFAULT NULL,
  `attachment` varchar(200) DEFAULT NULL,
  `status` int(11) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `bank_account`
--

INSERT INTO `bank_account` (`bank_acc_id`, `user_id`, `account_holder_name`, `account_no`, `ifsc`, `bank_name`, `branch_name`, `attachment`, `status`, `created_at`) VALUES
(1, 2, '12345678', '78987900', 'IBTD23634', 'Indian bank', '', NULL, 1, '2025-12-02 06:50:57'),
(2, 3, 'test', '123213', 'afasdfsadfsd', 'Indian banks', 'adsfasdfsssss', NULL, 1, '2025-12-09 05:46:45');

-- --------------------------------------------------------

--
-- Table structure for table `config`
--

CREATE TABLE `config` (
  `id` int(10) UNSIGNED NOT NULL,
  `key_name` varchar(191) NOT NULL,
  `value` text DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `config`
--

INSERT INTO `config` (`id`, `key_name`, `value`, `updated_at`) VALUES
(1, 'default_token_symbol', 'STBL', '2025-10-31 10:29:20');

-- --------------------------------------------------------

--
-- Table structure for table `deposit`
--

CREATE TABLE `deposit` (
  `deposit_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `transaction_id` varchar(100) DEFAULT NULL,
  `amount` decimal(36,18) NOT NULL,
  `attachment` varchar(200) DEFAULT NULL,
  `status` int(11) NOT NULL,
  `approved_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `deposit`
--

INSERT INTO `deposit` (`deposit_id`, `user_id`, `transaction_id`, `amount`, `attachment`, `status`, `approved_at`, `created_at`) VALUES
(1, 5, '118265484283', 500.000000000000000000, '5-1764666459344-d998fabd.png', 0, NULL, '2025-12-02 09:07:39');

-- --------------------------------------------------------

--
-- Table structure for table `kyc_documents`
--

CREATE TABLE `kyc_documents` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `user_id` bigint(20) UNSIGNED NOT NULL,
  `doc_type` varchar(100) NOT NULL,
  `doc_path` varchar(1024) NOT NULL,
  `status` enum('uploaded','verified','rejected') NOT NULL DEFAULT 'uploaded',
  `uploaded_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `mint_requests`
--

CREATE TABLE `mint_requests` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `requested_by` bigint(20) UNSIGNED DEFAULT NULL,
  `to_address` varchar(100) NOT NULL,
  `amount` decimal(36,18) NOT NULL,
  `status` enum('queued','sent','confirmed','failed') NOT NULL DEFAULT 'queued',
  `onchain_tx_hash` varchar(100) DEFAULT NULL,
  `attempts` int(11) NOT NULL DEFAULT 0,
  `meta_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `onchain_events`
--

CREATE TABLE `onchain_events` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `block_number` bigint(20) UNSIGNED DEFAULT NULL,
  `tx_hash` varchar(100) NOT NULL,
  `event_name` varchar(100) NOT NULL,
  `from_address` varchar(100) DEFAULT NULL,
  `to_address` varchar(100) DEFAULT NULL,
  `amount` decimal(36,18) NOT NULL DEFAULT 0.000000000000000000,
  `processed` tinyint(1) NOT NULL DEFAULT 0,
  `log_index` int(11) DEFAULT NULL,
  `raw_log` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `tds_records`
--

CREATE TABLE `tds_records` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `transaction_id` bigint(20) UNSIGNED NOT NULL,
  `user_id` bigint(20) UNSIGNED NOT NULL,
  `rate_percent` decimal(5,2) NOT NULL DEFAULT 0.00,
  `tds_amount` decimal(36,18) NOT NULL DEFAULT 0.000000000000000000,
  `remarks` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `transactions`
--

CREATE TABLE `transactions` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `tx_uuid` char(36) NOT NULL,
  `user_id` bigint(20) UNSIGNED DEFAULT NULL,
  `to_user_id` int(11) DEFAULT NULL,
  `from_address` varchar(100) DEFAULT NULL,
  `to_address` varchar(100) DEFAULT NULL,
  `amount` decimal(36,18) NOT NULL DEFAULT 0.000000000000000000,
  `token_symbol` varchar(32) NOT NULL DEFAULT 'STBL',
  `txn_type` enum('deposit','withdrawal','transfer','mint','burn','adjustment') NOT NULL,
  `status` enum('pending','confirmed','failed','reconciled') NOT NULL DEFAULT 'pending',
  `onchain_tx_hash` varchar(100) DEFAULT NULL,
  `tds_amount` decimal(36,18) DEFAULT 0.000000000000000000,
  `meta_json` text DEFAULT NULL,
  `fee` decimal(36,18) DEFAULT 0.000000000000000000,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `confirmations` int(11) DEFAULT 0,
  `idempotency_key` varchar(128) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `transactions`
--

INSERT INTO `transactions` (`id`, `tx_uuid`, `user_id`, `to_user_id`, `from_address`, `to_address`, `amount`, `token_symbol`, `txn_type`, `status`, `onchain_tx_hash`, `tds_amount`, `meta_json`, `fee`, `created_at`, `updated_at`, `confirmations`, `idempotency_key`) VALUES
(1, 'f3d478a0-ba0d-11f0-8112-94e8d4b5cad8', 1, NULL, NULL, '0xCA1bfEBB900c62f12F85DbBBaC05d1c7e0dD028D', 10000000.000000000000000000, 'FXC', 'mint', 'confirmed', NULL, 0.000000000000000000, NULL, 0.000000000000000000, '2025-11-05 11:39:13', '2025-11-12 12:08:49', 0, 'mint-1-1762322953625'),
(2, '288764a5-badf-11f0-8112-94e8d4b5cad8', 1, NULL, NULL, NULL, 5.000000000000000000, 'FXC', 'transfer', 'confirmed', NULL, 0.000000000000000000, NULL, 0.000000000000000000, '2025-11-06 12:36:46', '2025-11-12 12:08:47', 0, NULL),
(4, '48ad625e-bee5-11f0-8112-94e8d4b5cad8', 3, NULL, NULL, '0x84A06C67886f088081e61f931949E76136F91d4A', 1000.000000000000000000, 'FXC', 'mint', 'confirmed', NULL, 0.000000000000000000, NULL, 0.000000000000000000, '2025-11-11 15:30:42', '2025-11-12 12:08:43', 0, NULL),
(5, '55924bfc-bee6-11f0-8112-94e8d4b5cad8', 3, NULL, NULL, NULL, 100.000000000000000000, 'FXC', 'burn', 'confirmed', NULL, 0.000000000000000000, NULL, 0.000000000000000000, '2025-11-11 15:38:13', '2025-11-28 12:32:25', 0, NULL),
(6, '0ae99ab3-bee7-11f0-8112-94e8d4b5cad8', 3, NULL, NULL, NULL, 100.000000000000000000, 'FXC', 'burn', 'confirmed', NULL, 0.000000000000000000, NULL, 0.000000000000000000, '2025-11-11 15:43:17', '2025-11-12 12:08:38', 0, NULL),
(7, '1863af49-bee7-11f0-8112-94e8d4b5cad8', 3, NULL, NULL, '0x84A06C67886f088081e61f931949E76136F91d4A', 1000.000000000000000000, 'FXC', 'mint', 'confirmed', NULL, 0.000000000000000000, NULL, 0.000000000000000000, '2025-11-11 15:43:40', '2025-11-12 12:08:35', 0, NULL),
(8, '1fb73dc1-bee7-11f0-8112-94e8d4b5cad8', 3, NULL, NULL, NULL, 100.000000000000000000, 'FXC', 'burn', 'confirmed', NULL, 0.000000000000000000, NULL, 0.000000000000000000, '2025-11-11 15:43:52', '2025-11-12 12:08:33', 0, NULL),
(9, '57906fe9-bf91-11f0-8112-94e8d4b5cad8', 1, 2, '0xCA1bfEBB900c62f12F85DbBBaC05d1c7e0dD028D', '0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4', 5.000000000000000000, 'FXC', 'transfer', 'confirmed', NULL, 0.000000000000000000, NULL, 0.000000000000000000, '2025-11-12 12:02:20', '2025-11-12 12:08:30', 0, NULL),
(10, 'ecebb68b-bf91-11f0-8112-94e8d4b5cad8', 2, NULL, NULL, '0x84A06C67886f088081e61f931949E76136F91d4A', 1000.000000000000000000, 'FXC', 'mint', 'confirmed', NULL, 0.000000000000000000, NULL, 0.000000000000000000, '2025-11-12 12:06:31', '2025-11-12 12:08:17', 0, NULL),
(11, 'e4474365-bf92-11f0-8112-94e8d4b5cad8', 1, 4, '0xCA1bfEBB900c62f12F85DbBBaC05d1c7e0dD028D', '0x7a5469Aa979E34B7C54937822ec1BD6b7864CA91', 1000.000000000000000000, 'FXC', 'transfer', 'confirmed', NULL, 0.000000000000000000, NULL, 0.000000000000000000, '2025-11-12 12:13:26', '2025-11-12 12:13:26', 0, NULL),
(12, '9940a613-c9f2-11f0-bdef-f8cab8068df2', 1, NULL, '0xCA1bfEBB900c62f12F85DbBBaC05d1c7e0dD028D', NULL, 100.000000000000000000, 'FXC', 'burn', 'confirmed', NULL, 0.000000000000000000, '{\"note\": \"Token Burn\"}', 0.000000000000000000, '2025-11-25 17:03:37', '2025-11-25 17:03:37', 0, NULL),
(13, 'a55e1b4a-c9f2-11f0-bdef-f8cab8068df2', 1, NULL, '0xCA1bfEBB900c62f12F85DbBBaC05d1c7e0dD028D', NULL, 500.000000000000000000, 'FXC', 'burn', 'confirmed', NULL, 0.000000000000000000, '{\"note\": \"Token Burn\"}', 0.000000000000000000, '2025-11-25 17:03:57', '2025-11-25 17:03:57', 0, NULL),
(14, '58da8689-cb7d-11f0-81cf-f8cab8068df2', 3, 1, '0x84A06C67886f088081e61f931949E76136F91d4A', '0xCA1bfEBB900c62f12F85DbBBaC05d1c7e0dD028D', 500.000000000000000000, 'FXC', 'transfer', 'confirmed', NULL, 0.000000000000000000, '{\"to_user\": \"1\", \"note\": \"internal transfer\"}', 0.000000000000000000, '2025-11-27 16:09:27', '2025-11-27 16:09:27', 0, NULL),
(15, '64f3bda6-cb7d-11f0-81cf-f8cab8068df2', 3, 1, '0x84A06C67886f088081e61f931949E76136F91d4A', '0xCA1bfEBB900c62f12F85DbBBaC05d1c7e0dD028D', 200.000000000000000000, 'FXC', 'transfer', 'confirmed', NULL, 0.000000000000000000, '{\"to_user\": \"1\", \"note\": \"internal transfer\"}', 0.000000000000000000, '2025-11-27 16:09:47', '2025-11-27 16:09:47', 0, NULL),
(16, '2ff4c968-cb7e-11f0-81cf-f8cab8068df2', 3, 1, '0x84A06C67886f088081e61f931949E76136F91d4A', '0xCA1bfEBB900c62f12F85DbBBaC05d1c7e0dD028D', 150.000000000000000000, 'FXC', 'transfer', 'confirmed', NULL, 0.000000000000000000, '{\"to_user\": \"1\", \"note\": \"internal transfer\"}', 0.000000000000000000, '2025-11-27 16:15:27', '2025-11-27 16:15:27', 0, NULL),
(17, '3ec2af56-cb7e-11f0-81cf-f8cab8068df2', 4, 1, '0x7a5469Aa979E34B7C54937822ec1BD6b7864CA91', '0xCA1bfEBB900c62f12F85DbBBaC05d1c7e0dD028D', 300.000000000000000000, 'FXC', 'transfer', 'confirmed', NULL, 0.000000000000000000, '{\"to_user\": \"1\", \"note\": \"internal transfer\"}', 0.000000000000000000, '2025-11-27 16:15:52', '2025-11-27 16:15:52', 0, NULL),
(18, '43a05929-cb7e-11f0-81cf-f8cab8068df2', 4, 1, '0x7a5469Aa979E34B7C54937822ec1BD6b7864CA91', '0xCA1bfEBB900c62f12F85DbBBaC05d1c7e0dD028D', 100.000000000000000000, 'FXC', 'transfer', 'confirmed', NULL, 0.000000000000000000, '{\"to_user\": \"1\", \"note\": \"internal transfer\"}', 0.000000000000000000, '2025-11-27 16:16:00', '2025-11-27 16:16:00', 0, NULL),
(19, '9eb18d6a-cf60-11f0-9783-f8cab8068df2', 2, NULL, NULL, '0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4', 250.000000000000000000, 'FXC', 'mint', 'confirmed', NULL, 0.000000000000000000, '{\"note\": \"Token Mint\"}', 0.000000000000000000, '2025-12-02 14:53:53', '2025-12-02 14:53:53', 0, NULL),
(20, 'c75046bb-cf60-11f0-9783-f8cab8068df2', 4, NULL, '0x7a5469Aa979E34B7C54937822ec1BD6b7864CA91', NULL, 500.000000000000000000, 'FXC', 'burn', 'confirmed', NULL, 0.000000000000000000, '{\"note\": \"Token Burn\"}', 0.000000000000000000, '2025-12-02 14:55:01', '2025-12-02 14:55:01', 0, NULL),
(21, '998dd785-cf61-11f0-9783-f8cab8068df2', 2, NULL, '0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4', NULL, 250.000000000000000000, 'FXC', 'burn', 'confirmed', NULL, 0.000000000000000000, '{\"note\": \"Token Burn\"}', 0.000000000000000000, '2025-12-02 15:00:54', '2025-12-02 15:00:54', 0, NULL),
(22, 'f5ddda9d-cf61-11f0-9783-f8cab8068df2', 2, NULL, '0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4', NULL, 250.000000000000000000, 'FXC', 'burn', 'confirmed', NULL, 0.000000000000000000, '{\"note\": \"Token Burn\"}', 0.000000000000000000, '2025-12-02 15:03:29', '2025-12-02 15:03:29', 0, NULL),
(23, '078bc572-cf62-11f0-9783-f8cab8068df2', 2, NULL, '0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4', NULL, 250.000000000000000000, 'FXC', 'burn', 'confirmed', NULL, 0.000000000000000000, '{\"note\": \"Token Burn\"}', 0.000000000000000000, '2025-12-02 15:03:58', '2025-12-02 15:03:58', 0, NULL),
(24, '2709931c-cf62-11f0-9783-f8cab8068df2', 2, NULL, '0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4', NULL, 250.000000000000000000, 'FXC', 'burn', 'confirmed', NULL, 0.000000000000000000, '{\"note\": \"Token Burn\"}', 0.000000000000000000, '2025-12-02 15:04:51', '2025-12-02 15:04:51', 0, NULL),
(25, '38e9e438-cf62-11f0-9783-f8cab8068df2', 2, NULL, '0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4', NULL, 200.000000000000000000, 'FXC', 'burn', 'confirmed', NULL, 0.000000000000000000, '{\"note\": \"Token Burn\"}', 0.000000000000000000, '2025-12-02 15:05:21', '2025-12-02 15:05:21', 0, NULL),
(26, 'a263514d-cf62-11f0-9783-f8cab8068df2', 2, NULL, '0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4', NULL, 10.000000000000000000, 'FXC', 'burn', 'confirmed', NULL, 0.000000000000000000, '{\"note\": \"Token Burn\"}', 0.000000000000000000, '2025-12-02 15:08:18', '2025-12-02 15:08:18', 0, NULL),
(27, '0071f51c-cf63-11f0-9783-f8cab8068df2', 4, NULL, '0x7a5469Aa979E34B7C54937822ec1BD6b7864CA91', NULL, 56.000000000000000000, 'FXC', 'burn', 'confirmed', NULL, 0.000000000000000000, '{\"note\": \"Token Burn\"}', 0.000000000000000000, '2025-12-02 15:10:56', '2025-12-02 15:10:56', 0, NULL),
(28, '5371f34b-cf63-11f0-9783-f8cab8068df2', 2, NULL, NULL, '0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4', 100.000000000000000000, 'FXC', 'mint', 'confirmed', NULL, 0.000000000000000000, '{\"note\": \"Token Mint\"}', 0.000000000000000000, '2025-12-02 15:13:15', '2025-12-02 15:13:15', 0, NULL),
(29, '1328f3c5-cf64-11f0-9783-f8cab8068df2', 2, NULL, NULL, '0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4', 50.000000000000000000, 'FXC', 'mint', 'confirmed', NULL, 0.000000000000000000, '{\"note\": \"Token Mint\"}', 0.000000000000000000, '2025-12-02 15:18:37', '2025-12-02 15:18:37', 0, NULL),
(30, '5b923837-cf6e-11f0-9783-f8cab8068df2', 2, NULL, NULL, '0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4', 100.000000000000000000, 'FXC', 'mint', 'confirmed', NULL, 0.000000000000000000, '{\"note\": \"Token Mint\"}', 0.000000000000000000, '2025-12-02 16:32:13', '2025-12-02 16:32:13', 0, NULL),
(31, 'b520cdd0-d289-11f0-abca-f8cab8068df2', 1, 5, '0xCA1bfEBB900c62f12F85DbBBaC05d1c7e0dD028D', '0x319cf102a31b98E18C6389d0B2Ec951490F2aD40', 640.000000000000000000, 'FXC', 'transfer', 'confirmed', NULL, 0.000000000000000000, '{\"to_user\": \"5\", \"note\": \"internal transfer\"}', 0.000000000000000000, '2025-12-06 15:25:33', '2025-12-06 15:25:33', 0, NULL),
(32, 'a94fc0d7-d28a-11f0-abca-f8cab8068df2', 5, 1, '0x319cf102a31b98E18C6389d0B2Ec951490F2aD40', '0xCA1bfEBB900c62f12F85DbBBaC05d1c7e0dD028D', 40.000000000000000000, 'FXC', 'transfer', 'confirmed', NULL, 0.000000000000000000, '{\"to_user\": \"1\", \"note\": \"internal transfer\"}', 0.000000000000000000, '2025-12-06 15:32:23', '2025-12-06 15:32:23', 0, NULL),
(33, '1ace1b12-d28c-11f0-abca-f8cab8068df2', 1, 5, '0xCA1bfEBB900c62f12F85DbBBaC05d1c7e0dD028D', '0x319cf102a31b98E18C6389d0B2Ec951490F2aD40', 20.000000000000000000, 'FXC', 'transfer', 'confirmed', NULL, 0.000000000000000000, '{\"to_user\": \"5\", \"note\": \"internal transfer\"}', 0.000000000000000000, '2025-12-06 15:42:43', '2025-12-06 15:42:43', 0, NULL),
(34, '34491a49-d28c-11f0-abca-f8cab8068df2', 1, 5, '0xCA1bfEBB900c62f12F85DbBBaC05d1c7e0dD028D', '0x319cf102a31b98E18C6389d0B2Ec951490F2aD40', 60.000000000000000000, 'FXC', 'transfer', 'confirmed', NULL, 0.000000000000000000, '{\"to_user\": \"5\", \"note\": \"internal transfer\"}', 0.000000000000000000, '2025-12-06 15:43:26', '2025-12-06 15:43:26', 0, NULL),
(35, '63f3541c-d4d1-11f0-82fc-f8cab8068df2', 3, NULL, NULL, '3', 100.000000000000000000, 'FXC', 'mint', 'confirmed', NULL, 0.000000000000000000, '{\"note\": \"Token Mint\"}', 0.000000000000000000, '2025-12-09 13:03:42', '2025-12-09 13:03:42', 0, NULL),
(36, '7d673109-d4d1-11f0-82fc-f8cab8068df2', 3, NULL, '3', NULL, 10.000000000000000000, 'FXC', 'burn', 'confirmed', NULL, 0.000000000000000000, '{\"note\": \"Token Burn\"}', 0.000000000000000000, '2025-12-09 13:04:25', '2025-12-09 13:04:25', 0, NULL),
(37, '7d6c6d8b-d4d1-11f0-82fc-f8cab8068df2', 3, NULL, '3', NULL, 10.000000000000000000, 'FXC', 'burn', 'confirmed', NULL, 0.000000000000000000, '{\"note\": \"Token Burn\"}', 0.000000000000000000, '2025-12-09 13:04:25', '2025-12-09 13:04:25', 0, NULL),
(38, '82b58f99-d4d1-11f0-82fc-f8cab8068df2', 1, 2, '0xCA1bfEBB900c62f12F85DbBBaC05d1c7e0dD028D', '0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4', 100.000000000000000000, 'FXC', 'transfer', 'confirmed', NULL, 0.000000000000000000, '{\"to_user\": \"2\", \"note\": \"internal transfer\"}', 0.000000000000000000, '2025-12-09 13:04:34', '2025-12-09 13:04:34', 0, NULL),
(39, '85a2cc91-d4d1-11f0-82fc-f8cab8068df2', 3, NULL, '3', NULL, 100.000000000000000000, 'FXC', 'burn', 'confirmed', NULL, 0.000000000000000000, '{\"note\": \"Token Burn\"}', 0.000000000000000000, '2025-12-09 13:04:38', '2025-12-09 13:04:38', 0, NULL);

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

CREATE TABLE `users` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `email` varchar(255) NOT NULL,
  `password_hash` varchar(255) DEFAULT NULL,
  `phone` varchar(30) DEFAULT NULL,
  `fullname` varchar(255) DEFAULT NULL,
  `kyc_status` enum('none','pending','verified','rejected') NOT NULL DEFAULT 'none',
  `twofa_enabled` tinyint(1) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `is_admin` tinyint(1) NOT NULL DEFAULT 0,
  `profile_image` varchar(250) DEFAULT NULL,
  `aadhar_front` varchar(250) DEFAULT NULL,
  `pancard_no` varchar(250) DEFAULT NULL,
  `pancard_image` varchar(250) DEFAULT NULL,
  `aadhar_back` varchar(250) DEFAULT NULL,
  `verification_code` varchar(200) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `users`
--

INSERT INTO `users` (`id`, `email`, `password_hash`, `phone`, `fullname`, `kyc_status`, `twofa_enabled`, `is_active`, `created_at`, `updated_at`, `is_admin`, `profile_image`, `aadhar_front`, `pancard_no`, `pancard_image`, `aadhar_back`, `verification_code`) VALUES
(1, 'admin@gmail.com', '12341234', '9999999999', 'admin', 'none', 0, 1, '2025-11-05 10:46:06', '2025-12-09 13:00:44', 1, NULL, NULL, '', NULL, NULL, NULL),
(2, 'test1@gmail.com', '12345678', '987654', 'Tester', 'verified', 0, 1, '2025-11-06 11:30:48', '2025-12-17 16:56:16', 0, NULL, '2-1765970776435-0a1ae093.jpg', '', '2-1765970776458-515ac575.jpg', '2-1765970776445-38a7f385.jpg', NULL),
(3, 'p.murugan103@gmail.com', '12341234', '987654321', 'Murugan', 'verified', 0, 1, '2025-11-11 15:21:50', '2025-12-18 10:17:06', 0, NULL, '1-1765270751095-85c50e7d.png', 'ALF12345dsf', '1-1765270751100-e5e7bca6.jpeg', '1-1765270751098-834e32f9.png', NULL),
(4, 'raja@gmail.com', 'o6f4A7#7wvmu', '2232323', 'raja', 'pending', 0, 1, '2025-11-12 12:10:10', '2025-12-18 10:38:30', 0, '4-1764053362443-f4044b7e.jpg', '4-1764053362449-eec4fd99.png', '', NULL, '4-1764053362453-9a851b32.png', NULL),
(5, 'saravananm4396@gmail.com', 'Test@123', '6381912930', 'Saravanan', 'verified', 0, 0, '2025-11-25 11:06:30', '2025-12-18 10:17:11', 0, '5-1764049166093-cb5b56cc.jpg', '5-1764049166542-4c0448bd.png', 'ALF12345dsfF', NULL, '5-1764049166847-49140b45.png', NULL);

-- --------------------------------------------------------

--
-- Table structure for table `user_wallets`
--

CREATE TABLE `user_wallets` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `user_id` bigint(20) UNSIGNED NOT NULL,
  `address` varchar(100) NOT NULL,
  `wallet_type` enum('external','custodial') NOT NULL DEFAULT 'external',
  `label` varchar(255) DEFAULT NULL,
  `is_primary` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `wallets`
--

CREATE TABLE `wallets` (
  `id` bigint(20) NOT NULL,
  `user_id` bigint(20) NOT NULL,
  `address` varchar(66) NOT NULL,
  `encrypted_private_key` text NOT NULL,
  `mnemonic` text DEFAULT NULL,
  `enc_iv` varbinary(16) NOT NULL,
  `enc_tag` varbinary(250) NOT NULL,
  `enc_salt` varbinary(16) DEFAULT NULL,
  `kdf` varchar(32) DEFAULT 'aes-256-gcm',
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `notes` text DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `wallets`
--

INSERT INTO `wallets` (`id`, `user_id`, `address`, `encrypted_private_key`, `mnemonic`, `enc_iv`, `enc_tag`, `enc_salt`, `kdf`, `created_at`, `updated_at`, `notes`) VALUES
(1, 1, '0xCA1bfEBB900c62f12F85DbBBaC05d1c7e0dD028D', '0xafac9ed61f54b095622de87de8d36f846ee23ce3313b521dfcfa77dd030ae609', 'scene easily fresh festival brain leg wonder obscure cannon open reunion layer', '', '', NULL, 'aes-256-gcm', '2025-11-05 05:19:31', '2025-11-05 05:19:31', NULL),
(2, 2, '0x6BAD04E23cF5037661961c672fbdfCc4A16eBAd4', 'ctk3ssjVxDkIuJPZNzDrNMBTzLEjqvqEVmtbzTlw/lZwB/IDeo2RLvAE4ulVZt4vWWkbuBjMQzTmm4JrXtBErqUD', 'hip rabbit olympic sunset agent before focus bird dilemma course roast rice', 0x78695a6e4b6e4b4a67393043497a5047, 0x67583439687470444447416a43767273626f73362b773d3d, NULL, 'aes-256-gcm', '2025-11-06 06:46:53', '2025-11-06 06:46:53', NULL),
(3, 3, '0x84A06C67886f088081e61f931949E76136F91d4A', 'Qi6YgLDzzDNylgR22lBP7PygJeHXjiYD9vj6Syt1UvKLvtqhtjl9N2+YKBtXQ2/haZ3EbiDY7qCDeSuaBqh5IHRM', 'explain draw approve pride coral myth hour slender try plunge voice captain', 0x4b573554576a583174565844694f6735, 0x613639554f4c4d434d77546e6468614a674232594c673d3d, NULL, 'aes-256-gcm', '2025-11-11 09:51:50', '2025-11-11 09:51:50', NULL),
(4, 4, '0x7a5469Aa979E34B7C54937822ec1BD6b7864CA91', 'Rv18Oi3k19GYbXbkALC8194MLDFm/nqx4Clgifz0vcIGI77AVhJ0A/sz549GtDLKJrP5Y3TfhSJroLK5ElpCQRJD', 'side tennis umbrella decrease soccer decide hedgehog interest minimum chronic laptop culture', 0x5174664a783432695633706751395932, 0x4b596f6e4d4f4e49576f542b78397236456e73472f413d3d, NULL, 'aes-256-gcm', '2025-11-12 06:40:10', '2025-11-12 06:40:10', NULL),
(5, 5, '0x319cf102a31b98E18C6389d0B2Ec951490F2aD40', 'JAU84oGpoczcYD5umAlNV4yvzrl4iZuIfwmls1KgDNOWmm/e1YKvWjIAoyuTZvGccpyNt6LHyPfxLb3FKTyttBS2', 'fee actor leaf nose salute flush blue exclude heart deputy hello burger', 0x47647452524955352b74513537416235, 0x56716e676763676b36416256736457617a70364250513d3d, NULL, 'aes-256-gcm', '2025-11-25 05:38:02', '2025-11-25 05:38:02', NULL);

-- --------------------------------------------------------

--
-- Table structure for table `withdrawal`
--

CREATE TABLE `withdrawal` (
  `withdrawal_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `request_id` varchar(100) DEFAULT NULL,
  `amount` decimal(36,18) NOT NULL,
  `status` int(11) NOT NULL,
  `approved_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `withdrawal`
--

INSERT INTO `withdrawal` (`withdrawal_id`, `user_id`, `request_id`, `amount`, `status`, `approved_at`, `created_at`) VALUES
(1, 3, '808233', 500.000000000000000000, 0, NULL, '2025-11-27 10:39:27'),
(2, 3, '262605', 200.000000000000000000, 1, '2025-11-27 16:50:23', '2025-11-27 10:39:47'),
(3, 3, '476709', 150.000000000000000000, 1, '2025-11-27 16:36:29', '2025-11-27 10:45:27'),
(4, 4, '404715', 300.000000000000000000, 0, NULL, '2025-11-27 10:45:52'),
(5, 4, '928867', 100.000000000000000000, 0, NULL, '2025-11-27 10:46:00');

--
-- Indexes for dumped tables
--

--
-- Indexes for table `audit_logs`
--
ALTER TABLE `audit_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_audit_admin` (`admin_id`);

--
-- Indexes for table `balances`
--
ALTER TABLE `balances`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_balance_user_token` (`user_id`,`token_symbol`),
  ADD KEY `idx_balances_user` (`user_id`);

--
-- Indexes for table `bank_account`
--
ALTER TABLE `bank_account`
  ADD PRIMARY KEY (`bank_acc_id`);

--
-- Indexes for table `config`
--
ALTER TABLE `config`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `key_name` (`key_name`);

--
-- Indexes for table `deposit`
--
ALTER TABLE `deposit`
  ADD PRIMARY KEY (`deposit_id`);

--
-- Indexes for table `kyc_documents`
--
ALTER TABLE `kyc_documents`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_kyc_user` (`user_id`);

--
-- Indexes for table `mint_requests`
--
ALTER TABLE `mint_requests`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_mint_status` (`status`),
  ADD KEY `fk_mint_requested_by` (`requested_by`);

--
-- Indexes for table `onchain_events`
--
ALTER TABLE `onchain_events`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_onchain_tx_hash_index` (`tx_hash`,`log_index`),
  ADD KEY `idx_onchain_processed` (`processed`);

--
-- Indexes for table `tds_records`
--
ALTER TABLE `tds_records`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_tds_tx` (`transaction_id`),
  ADD KEY `idx_tds_user` (`user_id`);

--
-- Indexes for table `transactions`
--
ALTER TABLE `transactions`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_tx_uuid` (`tx_uuid`),
  ADD UNIQUE KEY `ux_transactions_idempotency` (`idempotency_key`),
  ADD KEY `idx_tx_user` (`user_id`),
  ADD KEY `idx_tx_onchain_hash` (`onchain_tx_hash`);

--
-- Indexes for table `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `email` (`email`);

--
-- Indexes for table `user_wallets`
--
ALTER TABLE `user_wallets`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_address` (`address`),
  ADD KEY `idx_user_wallets_user` (`user_id`);

--
-- Indexes for table `wallets`
--
ALTER TABLE `wallets`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `address` (`address`),
  ADD KEY `idx_wallets_user` (`user_id`);

--
-- Indexes for table `withdrawal`
--
ALTER TABLE `withdrawal`
  ADD PRIMARY KEY (`withdrawal_id`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `audit_logs`
--
ALTER TABLE `audit_logs`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=32;

--
-- AUTO_INCREMENT for table `balances`
--
ALTER TABLE `balances`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=27;

--
-- AUTO_INCREMENT for table `bank_account`
--
ALTER TABLE `bank_account`
  MODIFY `bank_acc_id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;

--
-- AUTO_INCREMENT for table `config`
--
ALTER TABLE `config`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT for table `deposit`
--
ALTER TABLE `deposit`
  MODIFY `deposit_id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT for table `kyc_documents`
--
ALTER TABLE `kyc_documents`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `mint_requests`
--
ALTER TABLE `mint_requests`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `onchain_events`
--
ALTER TABLE `onchain_events`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `tds_records`
--
ALTER TABLE `tds_records`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `transactions`
--
ALTER TABLE `transactions`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=40;

--
-- AUTO_INCREMENT for table `users`
--
ALTER TABLE `users`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=6;

--
-- AUTO_INCREMENT for table `user_wallets`
--
ALTER TABLE `user_wallets`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `wallets`
--
ALTER TABLE `wallets`
  MODIFY `id` bigint(20) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=6;

--
-- AUTO_INCREMENT for table `withdrawal`
--
ALTER TABLE `withdrawal`
  MODIFY `withdrawal_id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=6;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `audit_logs`
--
ALTER TABLE `audit_logs`
  ADD CONSTRAINT `fk_audit_admin` FOREIGN KEY (`admin_id`) REFERENCES `users` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `balances`
--
ALTER TABLE `balances`
  ADD CONSTRAINT `fk_balances_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `kyc_documents`
--
ALTER TABLE `kyc_documents`
  ADD CONSTRAINT `fk_kyc_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `mint_requests`
--
ALTER TABLE `mint_requests`
  ADD CONSTRAINT `fk_mint_requested_by` FOREIGN KEY (`requested_by`) REFERENCES `users` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `tds_records`
--
ALTER TABLE `tds_records`
  ADD CONSTRAINT `fk_tds_transaction` FOREIGN KEY (`transaction_id`) REFERENCES `transactions` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_tds_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `user_wallets`
--
ALTER TABLE `user_wallets`
  ADD CONSTRAINT `fk_user_wallets_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
