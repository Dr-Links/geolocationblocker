<?php

// Optional analytics (sessions, page-view events), consent records, local geo table.

$t = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

return [
    "CREATE TABLE IF NOT EXISTS visitor_sessions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        workspace_id BIGINT UNSIGNED NOT NULL,
        website_id BIGINT UNSIGNED NOT NULL,
        visitor_id BIGINT UNSIGNED NOT NULL,
        started_at DATETIME NOT NULL,
        last_activity_at DATETIME NOT NULL,
        ended_at DATETIME NULL,
        page_views INT UNSIGNED NOT NULL DEFAULT 0,
        KEY idx_vsess_visitor (visitor_id, last_activity_at),
        KEY idx_vsess_ws_time (workspace_id, last_activity_at),
        CONSTRAINT fk_vsess_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        CONSTRAINT fk_vsess_site FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE,
        CONSTRAINT fk_vsess_visitor FOREIGN KEY (visitor_id) REFERENCES visitors(id) ON DELETE CASCADE
    ) $t",

    "CREATE TABLE IF NOT EXISTS visitor_events (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        workspace_id BIGINT UNSIGNED NOT NULL,
        website_id BIGINT UNSIGNED NOT NULL,
        visitor_id BIGINT UNSIGNED NOT NULL,
        session_id BIGINT UNSIGNED NULL,
        event_uid CHAR(32) NOT NULL,
        event_type VARCHAR(20) NOT NULL,
        page_path VARCHAR(512) NOT NULL,
        page_title VARCHAR(200) NULL,
        referrer_origin VARCHAR(255) NULL,
        occurred_at DATETIME NOT NULL,
        created_at DATETIME NOT NULL,
        UNIQUE KEY uq_event_uid (visitor_id, event_uid),
        KEY idx_event_visitor_time (visitor_id, occurred_at),
        KEY idx_event_ws_time (workspace_id, created_at),
        CONSTRAINT fk_event_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        CONSTRAINT fk_event_site FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE,
        CONSTRAINT fk_event_visitor FOREIGN KEY (visitor_id) REFERENCES visitors(id) ON DELETE CASCADE,
        CONSTRAINT fk_event_session FOREIGN KEY (session_id) REFERENCES visitor_sessions(id) ON DELETE SET NULL
    ) $t",

    // Proof of consent decisions. visitor_id is nulled (not cascaded) when a
    // visitor profile is deleted so the decision record can follow its own retention.
    "CREATE TABLE IF NOT EXISTS consent_records (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        workspace_id BIGINT UNSIGNED NOT NULL,
        website_id BIGINT UNSIGNED NOT NULL,
        visitor_id BIGINT UNSIGNED NULL,
        category VARCHAR(20) NOT NULL,
        decision VARCHAR(16) NOT NULL,
        policy_version VARCHAR(32) NOT NULL,
        source VARCHAR(20) NOT NULL,
        recorded_at DATETIME NOT NULL,
        withdrawn_at DATETIME NULL,
        KEY idx_consent_visitor (visitor_id, recorded_at),
        KEY idx_consent_ws_time (workspace_id, recorded_at),
        CONSTRAINT fk_consent_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        CONSTRAINT fk_consent_site FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE,
        CONSTRAINT fk_consent_visitor FOREIGN KEY (visitor_id) REFERENCES visitors(id) ON DELETE SET NULL
    ) $t",

    // Optional local IP-to-country ranges imported from a CSV (bin/console geo:import).
    "CREATE TABLE IF NOT EXISTS geo_ip_ranges (
        ip_start VARBINARY(16) NOT NULL,
        ip_end VARBINARY(16) NOT NULL,
        country_code CHAR(2) NOT NULL,
        PRIMARY KEY (ip_start)
    ) $t",
];
